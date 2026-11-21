import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { setup } from './helpers.js';
import { createOperatorApi as createApi } from '../src/api/operatorServer.js';

test('controlled HTTP execution is unavailable without explicit local installation', async () => {
  const f = await setup(); const server = createApi(f.manager, async () => ({ onchainSats: 0, incomingSats: 0 }));
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  try {
    const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/swaps/${f.swap.id}/execute`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ expectedRevision: f.swap.revision }) });
    assert.equal(response.status, 503); assert.equal(f.store.read().swaps[f.swap.id]!.state, 'QUOTED');
  } finally { await new Promise<void>(r => server.close(() => r())); await f.cleanup(); }
});

test('operator HTTP capability requires bearer, exact revision and origin policy, and consumes only once including uncertainty', async () => {
  for (const uncertain of [false, true]) {
    const f = await setup(); const token = randomBytes(32).toString('hex'); let calls = 0;
    const server = createApi(f.manager, async () => ({ onchainSats: 0, incomingSats: 0 }), undefined, undefined,
      { swapId: f.swap.id, expectedRevision: f.swap.revision, token, async execute() {
        calls++; if (uncertain) throw Error('uncertain synthetic outcome');
        return { id: f.swap.id, state: 'COMPLETED', revision: f.swap.revision + 1 };
      } });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/swaps/${f.swap.id}/execute`;
    const request = (authorization = 'Bearer ' + token, revision = f.swap.revision, origin?: string) => fetch(url, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization, ...(origin ? { origin } : {}) }, body: JSON.stringify({ expectedRevision: revision }) });
    try {
      assert.equal((await request('Bearer invalid')).status, 403); assert.equal((await request(undefined, undefined, 'https://foreign.test')).status, 403);
      assert.equal((await request(undefined, f.swap.revision + 1)).status, 409); assert.equal(calls, 0);
      const results = await Promise.all([request(), request()]);
      assert.deepEqual(results.map(r => r.status).sort(), uncertain ? [409, 503] : [200, 409]); assert.equal(calls, 1);
      assert.equal((await request()).status, 409); assert.equal(calls, 1);
      assert.equal(JSON.stringify(await results.find(r => r.status !== 409)!.json()).includes(token), false);
    } finally { await new Promise<void>(r => server.close(() => r())); await f.cleanup(); }
  }
});
