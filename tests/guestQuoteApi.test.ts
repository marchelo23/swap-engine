import { randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createApi } from '../src/api/server.js';
import { setup } from './helpers.js';

test('guest quote is opt-in, origin-bound and private to the capability; it cannot execute', async t => {
  const f = await setup(); t.after(f.cleanup);
  assert.throws(() => createApi(f.manager, async () => ({ onchainSats: 1, incomingSats: 1 }), undefined, 'simulation', { guestQuotes: true }));
  let reads = 0; let sufficient = true;
  const server = createApi(f.manager, async () => { reads++; return sufficient ? { onchainSats: 1000000, incomingSats: 1000000 } : { onchainSats: 1, incomingSats: 1 }; }, undefined, 'regtest', { guestQuotes: true });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise<void>((resolve, reject) => server.close(e => e ? reject(e) : resolve())));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const token = randomBytes(32).toString('base64url'); const authorization = `Bearer ${token}`;
  const body = JSON.stringify({ destination: f.destination, amountSats: 50000, paymentHash: f.contract.paymentHash, claimPublicKey: f.contract.claimPublicKey });
  const post = (headers: Record<string, string>, payload = body) => fetch(base + '/v1/guest/quotes', { method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': 'test-guest-quote', ...headers }, body: payload });
  assert.equal((await post({ authorization })).status, 403);
  assert.equal((await post({ authorization, origin: 'https://other.invalid' })).status, 403);
  assert.equal((await post({ origin: base })).status, 400);
  assert.equal((await post({ authorization, origin: base }, JSON.stringify({ ...JSON.parse(body), preimage: f.preimage }))).status, 400);
  assert.equal(reads, 0);
  sufficient = false; assert.equal((await post({ authorization, origin: base })).status, 503); sufficient = true;
  assert.equal(Object.keys(f.store.read().guestAdmissions ?? {}).length, 0);
  const before = JSON.stringify(f.store.read().swaps);
  const response = await post({ authorization, origin: base }); assert.equal(response.status, 201);
  assert.equal(response.headers.get('cache-control'), 'no-store'); const quote = await response.json();
  assert.equal(quote.invoiceSats, 50000); assert.equal(quote.amountSats - quote.claimFeeSats, 48750);
  assert.equal(quote.liquidity, 'UNRESERVED');
  assert.equal(JSON.stringify(quote).includes(token), false); assert.equal(JSON.stringify(quote).includes(f.preimage), false);
  const path = `/v1/guest/quotes/${quote.id}`;
  assert.equal((await fetch(base + path)).status, 404);
  assert.equal((await fetch(base + path, { headers: { authorization: `Bearer ${randomBytes(32).toString('base64url')}` } })).status, 404);
  assert.equal((await fetch(base + `/v1/guest/quotes/${randomUUID()}`, { headers: { authorization } })).status, 404);
  assert.equal((await fetch(base + path + '?token=secret', { headers: { authorization } })).status, 403);
  assert.deepEqual(await (await fetch(base + path, { headers: { authorization } })).json(), quote);
  assert.equal((await fetch(base + '/v1/swaps/reverse', { method: 'POST', headers: { authorization, origin: base, 'content-type': 'application/json' }, body: '{}' })).status, 401);
  assert.equal(JSON.stringify(f.store.read().swaps), before);
});

test('guest quote admission rate limit applies before node reads', async t => {
  const f = await setup(); t.after(f.cleanup); let reads = 0;
  const server = createApi(f.manager, async () => { reads++; return { onchainSats: 1000000, incomingSats: 1000000 }; }, undefined, 'regtest', { guestQuotes: true });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise<void>((resolve, reject) => server.close(e => e ? reject(e) : resolve())));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const send = () => fetch(base + '/v1/guest/quotes', { method: 'POST', headers: { origin: base, 'content-type': 'application/json', 'idempotency-key': 'test-rate-limit' }, body: '{}' });
  for (let n = 0; n < 10; n++) assert.equal((await send()).status, 400);
  assert.equal((await send()).status, 429); assert.equal(reads, 0);
});
