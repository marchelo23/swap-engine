import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { after, before, test, type TestContext } from 'node:test';
import { provisionAccount, readHiddenPassword } from '../scripts/provision-auth.js';
import { SessionResponse } from '../src/api/schemas.js';
import { createApi } from '../src/api/server.js';
import { hashPassword, verifyPassword } from '../src/auth/credentials.js';
import type { AuthOptions } from '../src/auth/session.js';
import { readAccounts } from '../src/auth/store.js';
import { setup } from './helpers.js';

const password = randomBytes(24).toString('base64url');
const adminPassword = randomBytes(24).toString('base64url');
let directory: string;
let storePath: string;

before(async () => {
  directory = await mkdtemp(join(tmpdir(), 'swap-auth-'));
  storePath = join(directory, 'users.json');
  await provisionAccount(storePath, 'member', 'USER', password);
  await provisionAccount(storePath, 'operator', 'ADMIN', adminPassword);
});
after(async () => { if (directory) await rm(directory, { recursive: true, force: true }); });

async function runtime(
  t: TestContext,
  options: AuthOptions = {},
  liquidity: Parameters<typeof createApi>[1] = async () => { throw new Error('No node connection used'); },
) {
  const f = await setup();
  t.after(f.cleanup);
  const server = createApi(f.manager, liquidity, undefined, 'simulation', { auth: { storePath, ...options } });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  function request(path: string, init?: RequestInit) { return fetch(origin + path, init); }
  function login(username: string, secret: string, headers?: Record<string, string>) {
    return request('/v1/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin, ...headers },
      body: JSON.stringify({ username, password: secret }),
    });
  }
  return { f, origin, request, login };
}

async function sessionFields(response: Response) {
  assert.equal(response.status, 200);
  const cookie = response.headers.get('set-cookie')!;
  assert.match(cookie, /^swap_session=[a-f0-9]{64}; Path=\/; Max-Age=\d+; HttpOnly; SameSite=Strict(?:; Secure)?$/);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const raw = await response.json();
  const session = SessionResponse.parse(raw);
  assert.deepEqual(Object.keys(session).sort(), ['csrfToken', 'expiresAt', 'user']);
  assert.deepEqual(Object.keys(session.user).sort(), ['id', 'role', 'username']);
  assert.match(session.csrfToken, /^[a-f0-9]{64}$/);
  const bearer = cookie.split(';')[0]!;
  assert(!JSON.stringify(session).includes(bearer.split('=')[1]!));
  return { cookie: bearer, session };
}

async function assertLoginFailure(response: Response) {
  assert.equal(response.status, 401);
  assert.equal(response.headers.get('set-cookie'), null);
  assert.deepEqual(await response.json(), { error: 'INVALID_CREDENTIALS' });
}

test('login and session use a generic credential failure and role guards protect the admin namespace', async t => {
  const { f, request, login, origin } = await runtime(t);
  assert.equal((await request('/v1/health')).status, 200);
  const preflight = await request('/v1/admin/status', { method: 'OPTIONS', headers: { origin: 'https://other.invalid' } });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('access-control-allow-origin'), null);
  assert.equal((await request('/v1/auth/session')).status, 401);
  assert.equal((await request('/v1/auth/logout', { method: 'POST' })).status, 401);
  assert.equal((await request('/v1/admin/status')).status, 401);
  await assertLoginFailure(await login('member', 'incorrect'));
  await assertLoginFailure(await login('unknown', password));
  await assertLoginFailure(await request('/v1/auth/login', {
    method: 'POST', headers: { 'content-type': 'application/json', origin }, body: '{',
  }));

  const user = await sessionFields(await login('MEMBER', password));
  assert.equal(user.session.user.username, 'member');
  assert.equal(user.session.user.role, 'USER');
  assert.deepEqual(await (await request('/v1/auth/session', { headers: { cookie: user.cookie } })).json(), user.session);
  assert.equal((await request('/v1/admin/status', { headers: { cookie: user.cookie } })).status, 403);
  const admin = await sessionFields(await login('operator', adminPassword));
  assert.equal(admin.session.user.role, 'ADMIN');
  assert.notEqual(admin.cookie, user.cookie);
  const response = await request('/v1/admin/status', { headers: { cookie: admin.cookie } });
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: 'SERVICE_UNAVAILABLE' });
  assert.equal((await request('/v1/admin/nested/path', { headers: { cookie: user.cookie } })).status, 403);
  for (const cookie of [user.cookie, admin.cookie]) {
    const hidden = await request(`/v1/swaps/${f.swap.id}`, { headers: { cookie } });
    assert.equal(hidden.status, 404);
    assert.deepEqual(await hidden.json(), { error: 'SWAP_NOT_FOUND' });
  }
});

test('public quotes work without CSRF for anonymous and signed-in callers and still validate input', async t => {
  const { f, request, login } = await runtime(t);
  function quote(body: string, cookie?: string) {
    const headers = new Headers({ 'content-type': 'application/json' });
    if (cookie) headers.set('cookie', cookie);
    return request('/v1/quotes', { method: 'POST', headers, body });
  }
  const anonymous = await quote('{"amountSats":50000}');
  assert.equal(anonymous.status, 201);
  assert.equal((await anonymous.json()).invoiceSats, 50_000);

  const { cookie } = await sessionFields(await login('member', password));
  const signedIn = await quote('{"amountSats":50000}', cookie);
  assert.equal(signedIn.status, 201);
  assert.equal((await signedIn.json()).invoiceSats, 50_000);
  const invalid = await quote('{"amountSats":50000,"preimage":"extra"}', cookie);
  assert.equal(invalid.status, 400);
  assert.deepEqual(await invalid.json(), { error: 'INVALID_REQUEST' });
  assert.equal(Object.keys(f.store.read().swaps).length, 1);
});

test('authenticated writes require the session-specific CSRF token and exact origin, and logout revokes the cookie', async t => {
  const { f, request, login, origin } = await runtime(t);
  await assertLoginFailure(await login('member', password, { origin: 'https://other.invalid' }));
  const { cookie, session } = await sessionFields(await login('member', password));
  const valid = { cookie, origin, 'x-csrf-token': session.csrfToken };
  const rejected: Record<string, string>[] = [
    { cookie, origin },
    { cookie, 'x-csrf-token': session.csrfToken },
    { ...valid, origin: `${origin}.invalid` },
    { ...valid, origin: 'null' },
    { ...valid, 'x-csrf-token': '0'.repeat(64) },
  ];
  for (const headers of rejected) {
    const response = await request('/v1/auth/logout', { method: 'POST', headers });
    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), { error: 'CSRF_REJECTED' });
  }
  await assertLoginFailure(await login('operator', adminPassword, { cookie }));
  const reverse = { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': 'auth-gate-1', ...valid },
    body: JSON.stringify({ quoteId: f.quote.id, paymentHash: f.contract.paymentHash, claimPublicKey: f.contract.claimPublicKey }) };
  assert.equal((await request('/v1/swaps/reverse', { ...reverse, headers: { ...reverse.headers, origin: 'https://other.invalid' } })).status, 403);
  const disabled = await request('/v1/swaps/reverse', reverse);
  assert.equal(disabled.status, 503);
  assert.deepEqual(await disabled.json(), { error: 'LIVE_SWAPS_DISABLED_OBSERVER_AND_RECOVERY_NOT_VERIFIED' });
  assert.equal(Object.keys(f.store.read().swaps).length, 1);
  const loggedOut = await request('/v1/auth/logout', { method: 'POST', headers: valid });
  assert.equal(loggedOut.status, 204);
  assert.match(loggedOut.headers.get('set-cookie')!, /^swap_session=; Path=\/; Max-Age=0; HttpOnly; SameSite=Strict$/);
  assert.equal((await request('/v1/auth/session', { headers: { cookie } })).status, 401);
});

test('only an administrator can query liquidity or invoke the node-read callback', async t => {
  let reads = 0;
  const { request, login } = await runtime(t, {}, async () => {
    reads++;
    return { onchainSats: 1_000_000, incomingSats: 1_000_000 };
  });
  const user = await sessionFields(await login('member', password));
  assert.equal((await request('/v1/liquidity')).status, 401);
  assert.equal((await request('/v1/liquidity', { headers: { cookie: user.cookie } })).status, 403);
  assert.equal(reads, 0);

  const admin = await sessionFields(await login('operator', adminPassword));
  const response = await request('/v1/liquidity', { headers: { cookie: admin.cookie } });
  assert.equal(response.status, 200);
  assert.deepEqual(Object.keys(await response.json()).sort(), ['incomingSats', 'onchainSats']);
  assert.equal(reads, 1);
});

test('sessions expire at the configured deadline and are lost on restart', async t => {
  let now = 1_000;
  const options = { now: () => now, sessionTtlMs: 2000 };
  const { request, login } = await runtime(t, options);
  const { cookie, session } = await sessionFields(await login('member', password));
  assert.equal(session.expiresAt, 3000);
  const restarted = await runtime(t, options);
  assert.equal((await restarted.request('/v1/auth/session', { headers: { cookie } })).status, 401);
  now = 2999;
  assert.equal((await request('/v1/auth/session', { headers: { cookie } })).status, 200);
  now++;
  assert.equal((await request('/v1/auth/session', { headers: { cookie } })).status, 401);
});

test('login rate limits share a source address across usernames and reset after the window', async t => {
  let now = 1_000;
  const { login } = await runtime(t, { now: () => now });
  for (let i = 0; i < 5; i++) await assertLoginFailure(await login(`unknown-${i}`, password));
  await assertLoginFailure(await login('member', password));
  now += 60_000;
  await sessionFields(await login('member', password));
});

test('short ADMIN passwords require explicit lab provisioning and only work over direct loopback', async t => {
  const path = join(directory, `${randomUUID()}.json`);
  const shortPassword = randomBytes(2).toString('hex');
  const optIn = { allowShortLabPassword: true, env: { APP_MODE: 'simulation' } };
  await assert.rejects(provisionAccount(path, 'local-admin', 'ADMIN', shortPassword), /at least 12/);
  await assert.rejects(provisionAccount(path, 'local-admin', 'USER', shortPassword, optIn), /require an ADMIN/);
  await assert.rejects(provisionAccount(path, 'local-admin', 'ADMIN', shortPassword, {
    ...optIn, env: { APP_MODE: 'mainnet' },
  }), /Mainnet is rejected/);
  await assert.rejects(provisionAccount(path, 'local-admin', 'ADMIN', shortPassword, {
    ...optIn, env: { APP_MODE: 'regtest', AUTH_ORIGIN: 'https://public.example' },
  }), /requires? a direct loopback/);
  assert.deepEqual(await readAccounts(path), []);

  await provisionAccount(path, 'local-admin', 'ADMIN', shortPassword, optIn);
  const [account] = await readAccounts(path);
  assert.equal(account?.localLabOnly, true);
  assert.match(account!.passwordHash, /^scrypt-v1\$/);

  const { login, request } = await runtime(t, { storePath: path });
  const forwarded = { 'x-forwarded-host': 'public.example' };
  await assertLoginFailure(await login('local-admin', shortPassword, forwarded));
  const { cookie, session } = await sessionFields(await login('local-admin', shortPassword));
  assert.equal(session.user.role, 'ADMIN');
  assert.equal((await request('/v1/auth/session', { headers: { cookie, ...forwarded } })).status, 401);
  assert.equal((await request('/v1/auth/session', { headers: { cookie } })).status, 200);
  const publicOrigin = 'https://public.example';
  const publicRuntime = await runtime(t, { storePath: path, origin: publicOrigin });
  await assertLoginFailure(await publicRuntime.login('local-admin', shortPassword, { origin: publicOrigin }));
});

test('missing or malformed auth data fails closed and revokes access from existing sessions', async t => {
  const path = join(directory, `${randomUUID()}.json`);
  const { login, request } = await runtime(t, { storePath: path });
  await assertLoginFailure(await login('member', password));
  await provisionAccount(path, 'member', 'USER', password);
  const { cookie } = await sessionFields(await login('member', password));
  const users = await readAccounts(path);
  const malformed = JSON.stringify({ version: 1, users: [...users, {
    id: randomUUID(), username: 'invalid', role: 'ADMIN',
    passwordHash: 'scrypt-v1$999999999$bad',
  }] });
  await writeFile(path, malformed, { mode: 0o600 });
  await assertLoginFailure(await login('member', password));
  assert.equal((await request('/v1/auth/session', { headers: { cookie } })).status, 401);
  await assert.rejects(provisionAccount(path, 'another', 'USER', password));
  assert.equal(await readFile(path, 'utf8'), malformed);
});

test('provisioning hides typed passwords, stores salted hashes and preserves existing records', async () => {
  const input = Object.assign(new PassThrough(), {
    isTTY: true, isRaw: false, setRawMode(enabled: boolean) { this.isRaw = enabled; return this; },
  });
  const output = Object.assign(new PassThrough(), { isTTY: true });
  let terminalOutput = '';
  output.on('data', chunk => { terminalOutput += chunk.toString(); });
  const hidden = readHiddenPassword(input as unknown as NodeJS.ReadStream, output as unknown as NodeJS.WriteStream);
  input.write(`${password}x\x7f\r`);
  assert.equal(await hidden, password);
  assert.equal(input.isRaw, false);
  assert.equal(terminalOutput, 'Password (hidden): \n');

  const raw = await readFile(storePath, 'utf8');
  const users = await readAccounts(storePath);
  assert.deepEqual(users.map(({ username, role }) => ({ username, role })), [
    { username: 'member', role: 'USER' }, { username: 'operator', role: 'ADMIN' },
  ]);
  assert(!raw.includes(password) && !raw.includes(adminPassword));
  const hash = users[0]!.passwordHash;
  assert.match(hash, /^scrypt-v1\$[0-9a-f]{32}\$[0-9a-f]{64}$/);
  assert.notEqual(hash, await hashPassword(password));
  assert.equal(await verifyPassword(password, hash), true);
  assert.equal(await verifyPassword('incorrect', hash), false);
  await assert.rejects(provisionAccount(storePath, 'MEMBER', 'ADMIN', password), /already exists/);
  assert.equal(await readFile(storePath, 'utf8'), raw);
  if (process.platform !== 'win32') assert.equal((await stat(storePath)).mode & 0o777, 0o600);
});
