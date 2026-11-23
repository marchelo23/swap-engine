import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { join } from 'node:path';
import { test } from 'node:test';
import type { AddressInfo } from 'node:net';
import { createApi } from '../src/api/server.js';
import { provisionAccount } from '../scripts/provision-auth.js';
import { setup } from './helpers.js';
import { LiquidLightningRequest, liquidLightningUnavailable, verifyExactLiquidDebit,
  verifyLiquidLightningInvoice } from '../src/liquid/LightningAdmission.js';

const invoice = 'lnbcrt' + 'a'.repeat(50); // Synthetic; no signature verification or live payment claimed.
const request = { route: 'liquid-to-lightning', invoice, debitSats: 50_000 };
const now = 1_800_000_000_000;
const expected = { paymentHash: '11'.repeat(32), payeePublicKey: '02' + '22'.repeat(32),
  invoiceSats: 48_500, minFinalCltv: 40, quoteExpiresAt: now + 60_000 };
const decoded = { destination: expected.payeePublicKey, payment_hash: expected.paymentHash,
  num_satoshis: '48500', num_msat: '48500000', timestamp: String(now / 1000), expiry: '3600', cltv_expiry: '40' };

test('OFFLINE exact debit accounts for funding fee and owned change without hidden reserves', () => {
  const b = { debitSats: 50_000, inputSats: 100_000, ownChangeSats: 50_000, lockupSats: 49_500, networkFeeSats: 500 };
  assert.doesNotThrow(() => verifyExactLiquidDebit(b));
  for (const change of [{ inputSats: 100_001 }, { ownChangeSats: 49_999 }, { lockupSats: 50_000 },
    { networkFeeSats: 501 }, { networkFeeSats: -1 }, { debitSats: 50_000.1 },
    { inputSats: Number.MAX_SAFE_INTEGER + 1 }, { reserveSats: 500 }, { ownChangeSats: 200_000 }])
    assert.throws(() => verifyExactLiquidDebit({ ...b, ...change }));
});

test('OFFLINE invoice review binds hash, payee, integer amount, network, CLTV and expiry', () => {
  assert.doesNotThrow(() => verifyLiquidLightningInvoice(invoice, decoded, expected, now));
  for (const change of [{ payment_hash: '33'.repeat(32) }, { destination: '03' + '22'.repeat(32) },
    { num_satoshis: '0', num_msat: '0' }, { num_msat: '48500001' }, { cltv_expiry: '39' },
    { expiry: '60' }, { timestamp: String(now / 1000 - 3600) }, { timestamp: String(now / 1000 + 61) }])
    assert.throws(() => verifyLiquidLightningInvoice(invoice, { ...decoded, ...change }, expected, now));
  for (const otherNetwork of ['lnbc', 'lntb', 'lnsb'])
    assert.throws(() => verifyLiquidLightningInvoice(otherNetwork + invoice.slice(6), decoded, expected, now));
  assert.throws(() => verifyLiquidLightningInvoice(invoice, decoded, { ...expected, quoteExpiresAt: now }, now));
  assert.throws(() => verifyLiquidLightningInvoice(invoice, decoded,
    { ...expected, quoteExpiresAt: now + 3_540_000 }, now), /EXPIRY_MARGIN/);
});

test('request syntax never accepts another rail/network or client-provided fee/provider authority', () => {
  assert.ok(LiquidLightningRequest.safeParse(request).success);
  for (const value of [{ ...request, invoice: 'lnbc' + 'a'.repeat(50) }, { ...request, route: 'liquid-to-mainnet' },
    { ...request, debitSats: 0 }, { ...request, providerUrl: 'https://example.com' },
    { ...request, network: 'mainnet' }, { ...request, ownerId: 'other' }, { ...request, approved: true }])
    assert.equal(LiquidLightningRequest.safeParse(value).success, false);
  assert.equal(liquidLightningUnavailable().executionEnabled, false);
});

for (const environment of ['liquid-regtest', 'mainnet', 'simulation'] as const) {
  test(`OFFLINE ${environment}: auth and CSRF guard blocked Liquid routes; repeat requests cannot write or pay`, async () => {
    const f = await setup(); const storePath = join(f.directory, 'auth.json');
    const password = randomBytes(24).toString('base64url');
    await provisionAccount(storePath, 'member', 'USER', password);
    await provisionAccount(storePath, 'admin', 'ADMIN', password);
    let nodeCalls = 0; let genericQuotes = 0;
    f.manager.quoteDebit = async () => { genericQuotes++; throw new Error('Generic quotes must not handle Liquid'); };
    const snapshot = JSON.stringify(f.store.read());
    const server = createApi(f.manager, async () => { nodeCalls++; throw new Error('No node access allowed'); },
      undefined, 'simulation', { environment, auth: { storePath } });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      for (const path of ['quotes', 'swaps']) {
        assert.equal((await fetch(`${origin}/v1/liquid/lightning/${path}`, { method: 'POST',
          headers: { 'content-type': 'application/json' }, body: JSON.stringify(request) })).status, 401);
      }
      assert.equal((await fetch(`${origin}/v1/liquid/lightning/availability`)).status, 401);
      for (const username of ['member', 'admin']) {
        const login = await fetch(origin + '/v1/auth/login', { method: 'POST',
          headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ username, password }) });
        assert.equal(login.status, 200);
        const cookie = login.headers.get('set-cookie')!.split(';')[0]!;
        const { csrfToken } = await login.json() as { csrfToken: string };
        assert.deepEqual(await (await fetch(origin + '/v1/liquid/lightning/availability',
          { headers: { cookie } })).json(), liquidLightningUnavailable());
        for (const path of ['quotes', 'swaps']) {
          const url = `${origin}/v1/liquid/lightning/${path}`;
          const headers = { cookie, origin, 'content-type': 'application/json',
            'x-csrf-token': csrfToken, 'idempotency-key': 'liquid-review-001' };
          assert.equal((await fetch(url, { method: 'POST', headers: { cookie, origin, 'content-type': 'application/json' },
            body: JSON.stringify(request) })).status, 403);
          assert.equal((await fetch(url, { method: 'POST', headers: { ...headers, origin: 'https://evil.invalid' },
            body: JSON.stringify(request) })).status, 403);
          const noKey = await fetch(url, { method: 'POST', headers: { ...headers, 'idempotency-key': '' }, body: JSON.stringify(request) });
          assert.equal(noKey.status, 400);
          for (let retry = 0; retry < 2; retry++) {
            const rejected = await fetch(url, { method: 'POST', headers, body: JSON.stringify(request) });
            assert.equal(rejected.status, 503); assert.equal(rejected.headers.get('cache-control'), 'no-store');
            assert.deepEqual(await rejected.json(), { error: 'LIQUID_LIGHTNING_ATOMIC_ADAPTER_UNAVAILABLE' });
          }
          assert.equal((await fetch(url, { method: 'POST', headers,
            body: JSON.stringify({ ...request, invoice: 'lnbc' + 'a'.repeat(50) }) })).status, 400);
        }
      }
      assert.equal(nodeCalls, 0); assert.equal(genericQuotes, 0);
      assert.equal(JSON.stringify(f.store.read()), snapshot);
    } finally { await new Promise<void>(resolve => server.close(() => resolve())); await f.cleanup(); }
  });
}
