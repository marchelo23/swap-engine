import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { setup } from './helpers.js';
import { createApi } from '../src/api/server.js';
import { quoteTotals } from '../src/web/api.js';
import { canQuote, defaultPair, linkRail, rails, stepRail } from '../src/web/rails.js';

test('rail turns follow the cycle and linked selection always honors the explicit side', () => {
  assert.equal(stepRail('onchain', 1), 'lightning');
  assert.equal(stepRail('onchain', -1), 'ark');
  assert.equal(stepRail('liquid', 1), 'ark');
  assert.equal(stepRail('ark', 1), 'onchain');
  const forward = { send: 'onchain', receive: 'lightning' } as const;
  assert.deepEqual(linkRail(defaultPair, 'send', 'onchain'), forward);
  assert.deepEqual(linkRail(forward, 'receive', 'onchain'), defaultPair);
  for (const send of rails) for (const receive of rails) for (const rail of rails) {
    if (send === receive) continue;
    for (const side of ['send', 'receive'] as const) {
      const opposite = side === 'send' ? 'receive' : 'send';
      const next = linkRail({ send, receive }, side, rail);
      assert.equal(next[side], rail);
      assert.notEqual(next.send, next.receive);
      const prior = { send, receive }[opposite];
      const fallback = { lightning: 'liquid', liquid: 'onchain', onchain: 'lightning', ark: 'onchain' } as const;
      assert.equal(next[opposite], rail === prior ? fallback[rail] : prior);
      assert.equal(canQuote(next), next.send === 'lightning' && next.receive === 'onchain');
    }
  }
});

test('quote totals use integer API fees and exclude the provider funding reserve', async () => {
  const f = await setup();
  try {
    const quote = f.quote;
    assert.deepEqual(quoteTotals(quote, 50_000), { received: 49_500, lost: 1_250 });
    assert.deepEqual(quoteTotals({ ...quote, claimFeeSats: 789 }, 50_000), { received: 49_211, lost: 1_539 });
    for (const invalid of [{ ...quote, expiresAt: 0 }, { ...quote, amountSats: 60_000 },
      { ...quote, claimFeeSats: -1 }, { ...quote, invoiceSats: 1 }, { ...quote, claimFeeSats: 50_001 }]) {
      assert.throws(() => quoteTotals(invalid, 50_000));
    }
  } finally {
    await f.cleanup();
  }
});

test('same-origin frontend serves only allowlisted assets and uses the real quote route', async () => {
  const f = await setup();
  const server = createApi(f.manager, async () => ({ onchainSats: 0, incomingSats: 0 }));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    for (const [path, mime] of [['/', 'text/html'], ['/app.css', 'text/css'], ['/app.js', 'text/javascript'], ['/arkade-mark.svg', 'image/svg+xml']] as const) {
      const response = await fetch(base + path);
      assert.equal(response.status, 200);
      assert.ok(response.headers.get('content-type')!.startsWith(mime));
      assert.match(response.headers.get('content-security-policy')!, /default-src 'self'/);
      if (path === '/app.js') assert.match(await response.text(), /Bundled font licenses/);
      if (path === '/arkade-mark.svg') assert.equal(createHash('sha256').update(await response.text()).digest('hex'),
        'f03e402da01aba3eec43621a2ddcfb450775ca785c8dfa416daed17a1eabf2c7');
    }
    assert.equal((await fetch(base + '/config.ts')).status, 404);
    assert.equal((await fetch(base + '/app.js', { method: 'POST' })).status, 404);
    const response = await fetch(base + '/v1/quotes', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"amountSats":50000}',
    });
    assert.equal(response.status, 201);
    assert.deepEqual(quoteTotals(await response.json(), 50_000), { received: 49_500, lost: 1_250 });
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await f.cleanup();
  }
});
