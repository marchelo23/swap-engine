import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer, request, type Server } from 'node:http';
import { mkdtemp, rmdir, unlink, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createUnifiedRegtestServer } from '../scripts/serve-unified-regtest.js';
import { createRegtestBalanceExtension } from '../scripts/unified-regtest-balances.js';

async function listen(server: Server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return (server.address() as AddressInfo).port;
}

test('one origin serves the existing Admin session and the capability-only Guest API', async t => {
  const observed: { target: string; url?: string; origin?: string; cookie?: string; authorization?: string }[] = [];
  const backend = (target: string) => createServer((req, res) => {
    observed.push({ target, url: req.url, origin: req.headers.origin, cookie: req.headers.cookie,
      authorization: req.headers.authorization });
    req.resume();
    res.writeHead(200, { 'set-cookie': ['session=fixture; Path=/; HttpOnly'], 'content-type': 'application/json' });
    res.end('{}');
  });
  const admin = backend('admin');
  const guest = backend('guest');
  const adminOrigin = `http://127.0.0.1:${await listen(admin)}`;
  const guestOrigin = `http://127.0.0.1:${await listen(guest)}`;
  const browserOrigin = 'http://127.0.0.1:31998';
  const gateway = createUnifiedRegtestServer({ browserOrigin, adminOrigin, guestOrigin });
  const port = await listen(gateway);
  t.after(() => Promise.all([gateway, admin, guest].map(server => new Promise<void>(resolve => server.close(() => resolve())))));
  const send = (path: string, method: string, origin?: string) => new Promise<{ code?: number; cookie?: string[] }>((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port, path, method,
      headers: { host: '127.0.0.1:31998', cookie: 'session=admin', authorization: 'Bearer recovery',
        ...(origin ? { origin } : {}) } }, res => {
      res.resume();
      res.on('end', () => resolve({ code: res.statusCode, cookie: res.headers['set-cookie'] }));
    });
    req.on('error', reject);
    req.end();
  });

  assert.equal((await send('/v1/auth/session', 'GET')).code, 200);
  assert.ok((await send('/v1/reverse/preparations', 'POST', browserOrigin)).cookie);
  assert.deepEqual(await send('/v1/guest/quotes/id/prepare', 'POST', browserOrigin), { code: 200, cookie: undefined });
  assert.equal((await send('/v1/guest/estimate?amountSats=50000', 'GET')).code, 200);
  assert.equal((await send('/v1/reverse/preparations', 'POST', 'https://other.example')).code, 403);
  assert.equal((await send('/v1/guest/quotes', 'POST')).code, 403);
  assert.deepEqual(observed, [
    { target: 'admin', url: '/v1/auth/session', origin: undefined, cookie: 'session=admin', authorization: undefined },
    { target: 'admin', url: '/v1/reverse/preparations', origin: adminOrigin, cookie: 'session=admin', authorization: undefined },
    { target: 'guest', url: '/v1/guest/quotes/id/prepare', origin: guestOrigin, cookie: undefined, authorization: 'Bearer recovery' },
    { target: 'guest', url: '/v1/guest/estimate?amountSats=50000', origin: undefined, cookie: undefined, authorization: 'Bearer recovery' },
  ]);
});

test('wallet balance readers only run after the Admin API authorizes Operations', async t => {
  let calls = 0;
  const admin = createServer((req, res) => {
    res.writeHead(req.headers.cookie === 'session=admin' ? 200 : 401, { 'content-type': 'application/json' });
    res.end('{"rails":[]}');
  });
  const guest = createServer((_, res) => res.end());
  const browserOrigin = 'http://127.0.0.1:31998';
  const gateway = createUnifiedRegtestServer({ browserOrigin,
    adminOrigin: `http://127.0.0.1:${await listen(admin)}`, guestOrigin: `http://127.0.0.1:${await listen(guest)}`,
    async extendBalances(report) { calls++; return { report, extended: true }; },
  });
  const port = await listen(gateway);
  t.after(() => Promise.all([gateway, admin, guest].map(server => new Promise<void>(resolve => server.close(() => resolve())))));
  const read = (cookie?: string) => new Promise<{ status?: number; body: string }>((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port, path: '/v1/operations/balances',
      headers: { host: '127.0.0.1:31998', ...(cookie ? { cookie } : {}) } }, res => {
      let body = '';
      res.setEncoding('utf8').on('data', chunk => body += chunk);
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.end();
  });
  assert.equal((await read()).status, 401);
  assert.equal(calls, 0);
  const result = await read('session=admin');
  assert.equal(result.status, 200);
  assert.deepEqual(JSON.parse(result.body), { report: { rails: [] }, extended: true });
  assert.equal(calls, 1);
});

test('Liquid cards use two verified wallets and retain explicitly zero balances', async t => {
  const asset = 'a'.repeat(64);
  const genesis = 'b'.repeat(64);
  const parent = '0f9188f13cb7b2c71f2a335e3a4fc328bf5beb436012afca590b1a11466e2206';
  const directory = await mkdtemp(join(tmpdir(), 'unified-elements-'));
  const cookie = join(directory, 'cookie');
  await writeFile(cookie, 'test:fixture', { mode: 0o600 });
  t.after(async () => { await unlink(cookie); await rmdir(directory); });
  const elements = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const { method } = JSON.parse(raw);
    const wallet = req.url?.split('/').at(-1);
    const results: Record<string, unknown> = {
      getblockchaininfo: { chain: 'elementsregtest', blocks: 2, bestblockhash: 'c'.repeat(64), initialblockdownload: false },
      getblockhash: genesis,
      getsidechaininfo: { parent_blockhash: parent, pegged_asset: asset },
      getwalletinfo: { walletname: wallet },
      listunspent: wallet === 'provider' ? [{ asset, txid: 'd'.repeat(64), vout: 0, amount: 21,
        confirmations: 2, spendable: true, safe: true }] : [],
    };
    res.end(JSON.stringify({ result: results[method as string], error: null }));
  });
  const port = await listen(elements);
  t.after(() => new Promise<void>(resolve => elements.close(() => resolve())));
  const extend = createRegtestBalanceExtension({
    APP_ENV: 'liquid-regtest', DEPLOYMENT_ID: 'test-unified', SPEND_POLICY: 'disabled',
    LIQUID_NETWORK: 'elementsregtest', ELEMENTS_RPC_URL: `http://127.0.0.1:${port}`,
    ELEMENTS_COOKIE_PATH: cookie, ELEMENTS_WALLET: 'provider', LIQUID_POLICY_ASSET: asset,
    LIQUID_PARENT_GENESIS_HASH: parent, LIQUID_GENESIS_HASH: genesis, LIQUID_CONFIRMATION_POLICY: 'read-only',
    UNIFIED_LIQUID_ALICE_WALLET: 'alice', UNIFIED_LIQUID_PROVIDER_WALLET: 'provider',
  })!;
  const report = await extend({ network: 'regtest', capturedAt: new Date().toISOString(),
    core: { confirmedSats: null, unconfirmedSats: null }, alice: null, provider: null, rails: [] });
  assert.deepEqual(report.rails, [
    { rail: 'liquid', account: 'alice', status: 'available', reason: null,
      balances: { assetId: asset, confirmedSats: 0, unconfirmedSats: 0 } },
    { rail: 'liquid', account: 'provider', status: 'available', reason: null,
      balances: { assetId: asset, confirmedSats: 2_100_000_000, unconfirmedSats: 0 } },
  ]);
  assert.equal(report.liquid?.spendableBaseUnits, 2_100_000_000);
});
