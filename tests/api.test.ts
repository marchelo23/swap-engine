import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { setup } from './helpers.js';
import { createApi } from '../src/api/server.js';
import { config } from '../src/config.js';
import { BitcoinRpcClient } from '../src/bitcoin/BitcoinRpcClient.js';
import { LndClient } from '../src/lightning/LndClient.js';

test('HTTP health is public, ownerless swap lookups are hidden, and operational routes require a session', async () => {
  const f = await setup();
  let liquidityReads = 0;
  const server = createApi(f.manager, async () => {
    liquidityReads++;
    return { onchainSats: 1e6, incomingSats: 1e6 };
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    assert.deepEqual(await (await fetch(`${url}/v1/health`)).json(), {
      status: 'components-only', liveSwapsEnabled: false, readOnly: true, network: 'regtest', mode: 'simulation',
    });
    const hidden = await fetch(`${url}/v1/swaps/${f.swap.id}`);
    const missing = await fetch(`${url}/v1/swaps/${'0'.repeat(36)}`);
    assert.equal(hidden.status, 404);
    assert.equal(missing.status, 404);
    assert.deepEqual(await hidden.json(), await missing.json());
    assert.equal((await fetch(`${url}/v1/liquidity`)).status, 401);
    assert.equal(liquidityReads, 0);
    const request = { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': 'api-request-1' }, body: JSON.stringify({ quoteId: f.quote.id, paymentHash: f.contract.paymentHash, claimPublicKey: f.contract.claimPublicKey }) };
    const rejected = await fetch(`${url}/v1/swaps/reverse`, request);
    assert.equal(rejected.status, 401);
    assert.deepEqual(await rejected.json(), { error: 'AUTH_REQUIRED' });
    assert.equal(Object.keys(f.store.read().swaps).length, 1);
  } finally { await new Promise<void>((resolve, reject) => server.close(e => e ? reject(e) : resolve())); await f.cleanup(); }
});
test('live mode cannot be enabled through environment flag', () => {
  const saved = process.env.ENABLE_LIVE_SWAPS;
  try { process.env.ENABLE_LIVE_SWAPS = 'true'; assert.throws(config, /unavailable/); }
  finally { if (saved === undefined) delete process.env.ENABLE_LIVE_SWAPS; else process.env.ENABLE_LIVE_SWAPS = saved; }
});
test('node clients reject public endpoints and insecure LND TLS', () => {
  assert.throws(() => new BitcoinRpcClient('http://example.com:18443', 'cookie'));
  assert.throws(() => new LndClient('http://127.0.0.1:8080', 'cert', 'macaroon'));
  assert.throws(() => new LndClient('https://example.com', 'cert', 'macaroon'));
});
