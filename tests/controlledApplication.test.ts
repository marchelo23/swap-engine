import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { provisionAccount } from '../scripts/provision-auth.js';
import { readAccounts } from '../src/auth/store.js';
import { startApplication, controlledStartupArguments } from '../src/main.js';
import { createOwnedReverseApi, sessionOwnerAuthenticator } from '../src/api/ownedReverse.js';
import type { OperatorIO } from '../scripts/run-controlled-reverse.js';
import { preparationFixture } from './preparationFixture.js';

async function fixture(ambiguous = false) {
  const f = await preparationFixture(); const prepared = await f.harness().prepare(); const id = prepared.request.swapId;
  const origin = 'http://localhost:3000'; const storePath = join(f.directory, 'accounts.json');
  const password = randomBytes(24).toString('base64url');
  for (const [name, role] of [['alice', 'USER'], ['bob', 'USER'], ['operator', 'ADMIN']] as const)
    await provisionAccount(storePath, name, role, password);
  const alice = (await readAccounts(storePath)).find(a => a.username === 'alice')!;
  const args = ['--controlled-reverse', '--serve-jit', '--run-dir', f.directory, '--spec-sha256', 'ab'.repeat(32),
    '--action-config-sha256', 'cd'.repeat(32), '--backup-config-sha256', 'ef'.repeat(32), '--authorization-sha256', '12'.repeat(32), '--ui-config-sha256', '34'.repeat(32)];
  const env = { APP_MODE: 'regtest', DEPLOYMENT_ID: 'controlled-test', DATA_DIR: join(f.directory, 'application'), AUTH_STORE_PATH: storePath, AUTH_ORIGIN: origin };
  const report = { network: 'regtest' as const, capturedAt: '2026-11-18T12:00:00.000Z',
    core: { confirmedSats: 100000, unconfirmedSats: 0 }, provider: null, alice: null, rails: [] };
  let executions = 0; let recoveries = 0; let startups = 0; let balanceReads = 0;
  let effect: () => Promise<void> = async () => {};
  let app: Awaited<ReturnType<typeof startApplication>>; let base = '';
  const boot = async (install = true, failure = false, mode = 'regtest') => {
    let mounted!: () => void; const ready = new Promise<void>(r => { mounted = r; });
    const operator = async (_args: string[], io: Partial<OperatorIO> = {}) => {
      startups++; if (failure) { mounted(); throw Error('private-preparation-error-do-not-project'); }
      assert.ok(io.sessions); assert.ok(io.serve);
      const api = createOwnedReverseApi(f.store, sessionOwnerAuthenticator(io.sessions), { origin,
        recovery: { async reconcile(swapId, revision) {
          assert.equal(swapId, id); assert.equal(f.store.read().swaps[id]!.revision, revision); recoveries++;
          await f.store.transaction(db => { db.swaps[id]!.state = 'MANUAL_REVIEW'; db.swaps[id]!.revision++; });
          const s = f.store.read().swaps[id]!; return { id, state: s.state, revision: s.revision, next: 'MANUAL_REVIEW' };
        } } });
      await api.bind(alice.id, id, f.spec.claimDestination);
      if (!Object.keys(f.store.read().ownedReverse?.requests ?? {}).length) api.approve({ ownerId: alice.id, swapId: id,
        expectedRevision: prepared.request.expectedRevision, termsDigest: '56'.repeat(32), expiresAt: Date.now() + 60000,
        async execute() {
          executions++;
          const disk = JSON.parse(await readFile(join(f.directory, 'state.json'), 'utf8'));
          assert.equal(Object.values<{ status: string }>(disk.ownedReverse.requests)[0]!.status, 'INTENT');
          await effect();
          await f.store.transaction(db => { const s = db.swaps[id]!; s.state = ambiguous ? 'MANUAL_REVIEW' : 'COMPLETED'; s.revision++;
            s.clientPayment = { hash: s.contract.paymentHash, status: ambiguous ? 'UNKNOWN' : 'SUCCEEDED', feeLimitSats: 100 }; });
          if (ambiguous) throw Error('private-ambiguous-result');
          const s = f.store.read().swaps[id]!; return { id, state: s.state, revision: s.revision };
        } });
      const lifetime = io.serve(f.store, api, 3000, () => {}); mounted(); return lifetime;
    };
    app = await startApplication({ ...env, APP_MODE: mode, DATA_DIR: join(f.directory, mode === 'simulation' ? 'application-simulation' : 'application') }, install ? args : [], { operator, port: 0,
      reads: { liquidity: async () => ({ onchainSats: 100000, incomingSats: 100000 }),
        operations: async () => { balanceReads++; return report; } },
      identity: { environment: 'regtest', deploymentId: 'controlled-test',
        genesisHash: '0f9188f13cb7b2c71f2a335e3a4fc328bf5beb436012afca590b1a11466e2206',
        wallet: 'test-wallet', verified: {} } });
    base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
    if (install) await ready;
    if (failure) await assert.rejects(app.runtime!);
    return app;
  };
  const request = (path: string, headers: Record<string, string> = {}, body?: unknown, key = 'screen-click-0001') => fetch(base + path, {
    method: body === undefined ? 'GET' : 'POST', headers: { ...headers, ...(body !== undefined ? { 'content-type': 'application/json', 'idempotency-key': key } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const login = async (username = 'alice') => {
    const response = await request('/v1/auth/login', { origin }, { username, password }); assert.equal(response.status, 200);
    assert.match(response.headers.get('set-cookie')!, /HttpOnly; SameSite=Strict/);
    const session = await response.json(); return { origin, cookie: response.headers.get('set-cookie')!.split(';')[0]!, 'x-csrf-token': session.csrfToken as string };
  };
  return { f, id, env, args, report, boot, request, login, executions: () => executions, recoveries: () => recoveries,
    startups: () => startups, balanceReads: () => balanceReads, setEffect: (fn: typeof effect) => { effect = fn; },
    close: async () => { await app?.close(); }, cleanup: async () => { await app?.close(); await f.cleanup(); } };
}

test('real integrated regtest HTTP uses one Sessions instance for login, ownership, CSRF, Operations and durable execution', async () => {
  const x = await fixture(); try {
    await x.boot(); const alice = await x.login(); const bob = await x.login('bob'); const admin = await x.login('operator');
    assert.equal((await x.request('/v1/reverse/availability')).status, 401);
    assert.equal((await x.request(`/v1/swaps/${x.id}`, { authorization: 'Bearer forged', 'x-user-id': 'alice' })).status, 401);
    assert.equal((await x.request(`/v1/swaps/${x.id}`, bob)).status, 404);
    assert.equal((await x.request(`/v1/swaps/${x.id}`, admin)).status, 404);
    assert.equal((await (await x.request('/v1/swaps', bob)).json()).swaps.length, 0);
    assert.equal((await x.request('/v1/operations/balances', alice)).status, 403);
    assert.equal(x.balanceReads(), 0);
    assert.deepEqual(await (await x.request('/v1/operations/balances', admin)).json(), x.report);
    assert.match(await (await x.request('/')).text(), /Operations/);
    const availability = await (await x.request('/v1/reverse/availability', alice)).json();
    assert.equal(availability.executionAvailable, true); assert.equal(availability.liveSwapsEnabled, false);
    const data = { expectedRevision: 3 }; const path = `/v1/swaps/${x.id}/execute`;
    assert.equal((await x.request(path, { ...alice, 'x-csrf-token': '' }, data)).status, 403);
    assert.equal((await x.request(path, { ...alice, origin: 'https://foreign.invalid' }, data)).status, 403);
    assert.equal((await x.request(path, bob, data)).status, 404);
    assert.equal(x.executions(), 0);
    let entered!: () => void; let release!: () => void;
    const ready = new Promise<void>(r => { entered = r; }); const finish = new Promise<void>(r => { release = r; });
    x.setEffect(async () => { entered(); await finish; });
    const first = x.request(path, alice, data); await ready;
    const duplicate = await x.request('/v1/swaps/reverse', alice, { preparedSwapId: x.id, expectedRevision: 3 });
    assert.equal(duplicate.status, 202); assert.equal((await duplicate.json()).status, 'RUNNING');
    assert.equal((await x.request(path, alice, data, 'different-screen-key')).status, 409);
    release(); const receipt = await first; assert.equal(receipt.status, 200); const value = await receipt.json();
    assert.deepEqual(await (await x.request(path, alice, data)).json(), value); assert.equal(x.executions(), 1);
    assert.equal((await x.request('/v1/auth/logout', alice, {})).status, 204);
    assert.equal((await x.request(path, alice, data)).status, 401);
    await x.close(); await x.boot();
    assert.equal((await x.request('/v1/auth/session', alice)).status, 401);
    const relogged = await x.login(); assert.deepEqual(await (await x.request(path, relogged, data)).json(), value);
    assert.equal(x.executions(), 1); assert.equal(x.startups(), 2);
    assert.equal((await (await x.request('/v1/health')).json()).liveSwapsEnabled, false);
  } finally { await x.cleanup(); }
});

test('integrated restart reconciles ambiguous execution read-only and cannot repeat it through any alias or new key', async () => {
  const x = await fixture(true); try {
    await x.boot(); let alice = await x.login(); const path = `/v1/swaps/${x.id}/execute`;
    const first = await x.request(path, alice, { expectedRevision: 3 });
    assert.equal(first.status, 202); assert.equal((await first.json()).status, 'RECONCILIATION_REQUIRED');
    await x.close(); await x.boot(); alice = await x.login();
    assert.equal((await x.request(path, alice, { expectedRevision: 3 })).status, 202);
    assert.equal((await x.request('/v1/swaps/reverse', alice, { preparedSwapId: x.id, expectedRevision: 4 }, 'new-bypass-key')).status, 409);
    const recover = `/v1/swaps/${x.id}/reconcile`;
    const observed = await x.request(recover, alice, { expectedRevision: 4 }, 'read-only-recovery');
    assert.equal(observed.status, 200); const receipt = await observed.json(); assert.equal(receipt.result.next, 'MANUAL_REVIEW');
    assert.deepEqual(await (await x.request(recover, alice, { expectedRevision: 4 }, 'read-only-recovery')).json(), receipt);
    assert.equal(x.executions(), 1); assert.equal(x.recoveries(), 1);
    assert.equal((await (await x.request('/v1/reverse/availability', alice)).json()).executionAvailable, false);
  } finally { await x.cleanup(); }
});

test('application startup is default-closed, regtest-only and rejects execution flags or failed preparation without retry', async () => {
  const x = await fixture(); try {
    for (const mode of ['simulation', 'regtest'] as const) assert.equal(controlledStartupArguments([], mode), undefined);
    assert.throws(() => controlledStartupArguments(x.args, 'simulation'));
    assert.throws(() => controlledStartupArguments(['--controlled-reverse', '--execute-jit', ...x.args.slice(2)], 'regtest'));
    await assert.rejects(startApplication({ ...x.env, APP_MODE: 'simulation' }, x.args));
    await assert.rejects(startApplication({ ...x.env, ENABLE_LIVE_SWAPS: 'true' }, []));
    const simulation = await x.boot(false, false, 'simulation');
    const unavailable = createOwnedReverseApi(x.f.store, async () => undefined, { origin: 'http://localhost:3000' });
    await assert.rejects(simulation.server.controlled.operatorIO.serve(x.f.store, unavailable, 3000, () => {}));
    await x.close();
    await x.boot(false); const alice = await x.login();
    assert.equal((await (await x.request('/v1/reverse/availability', alice)).json()).executionAvailable, false);
    assert.equal(x.startups(), 0);
    await x.close(); await x.boot(true, true);
    const next = await x.login(); assert.equal((await (await x.request('/v1/reverse/availability', next)).json()).controlledReverseConfigured, false);
    assert.equal((await x.request('/v1/swaps/reverse', next, { quoteId: x.f.store.read().swaps[x.id]!.quote.id,
      paymentHash: x.f.spec.client.paymentHash, claimPublicKey: x.f.spec.client.claimPublicKey })).status, 503);
    assert.equal(x.startups(), 1); assert.equal(x.executions(), 0);
  } finally { await x.cleanup(); }
});

test('native regtest process starts the authenticated default-closed gateway and shuts down cleanly without node credentials', { skip: process.platform !== 'linux' }, async () => {
  const x = await fixture();
  const reservation = createServer(); reservation.listen(0, '127.0.0.1'); await once(reservation, 'listening');
  const port = (reservation.address() as AddressInfo).port; await new Promise<void>(r => reservation.close(() => r()));
  const child = spawn(process.execPath, ['node_modules/tsx/dist/cli.mjs', 'src/main.ts'], { cwd: process.cwd(),
    env: { ...process.env, ...x.env, PORT: String(port), ENABLE_LIVE_SWAPS: 'false',
      BITCOIN_RPC_URL: 'http://127.0.0.1:1', LND_REST_URL: 'https://127.0.0.1:2',
      BITCOIN_COOKIE_PATH: '/nonexistent-test-cookie', LND_TLS_CERT_PATH: '/nonexistent-test-cert', LND_MACAROON_PATH: '/nonexistent-test-macaroon' },
    stdio: ['ignore', 'pipe', 'pipe'] });
  const exited = once(child, 'exit'); let output = ''; let errors = '';
  child.stderr.on('data', bytes => { errors += bytes.toString(); });
  try {
    await new Promise<void>((ready, reject) => {
      const timeout = setTimeout(() => reject(Error('app startup did not complete')), 10000);
      child.once('exit', () => { clearTimeout(timeout); reject(Error('app exited before ready')); });
      child.stdout.on('data', bytes => {
        output += bytes.toString();
        if (output.includes('api_listening')) { clearTimeout(timeout); ready(); }
      });
    });
    const base = `http://127.0.0.1:${port}`;
    const health = await (await fetch(base + '/v1/health')).json(); assert.equal(health.mode, 'regtest'); assert.equal(health.liveSwapsEnabled, false);
    assert.equal((await fetch(base + '/v1/reverse/availability')).status, 401);
    child.kill('SIGTERM'); const [code, signal] = await exited;
    assert.equal(code, 0); assert.equal(signal, null); assert.equal(errors, '');
    const resumed = await startApplication({ ...x.env, BITCOIN_RPC_URL: 'http://127.0.0.1:1', LND_REST_URL: 'https://127.0.0.1:2' }, [], { port: 0 });
    await resumed.close(); // The actual process released its store writer lock.
    assert.equal(x.executions(), 0);
  } finally { child.kill('SIGTERM'); await exited; await x.cleanup(); }
});
