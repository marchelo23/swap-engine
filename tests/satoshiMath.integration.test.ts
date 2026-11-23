import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { createApi } from '../src/api/server.js';
import { setup } from './helpers.js';
import type { Quote } from '../src/core/SwapTypes.js';
import { validateQuoteFields, calculateNetReceivedSats, calculateTotalPaidSats,
  calculateServiceFee, calculateNetSatsLost, calculateUserCost, SatoshiMathError } from '../src/utils/satoshiMath.js';

const baseline: Quote = { id: 'accounting-review', amountSats: 50000, serviceFeeSats: 750,
  claimFeeSats: 500, invoiceSats: 50750, fundingReserveSats: 1000, expiresAt: 0 };
const helpers = [validateQuoteFields, calculateNetReceivedSats, calculateTotalPaidSats,
  calculateServiceFee, calculateNetSatsLost, calculateUserCost];

test('every accounting entry point rejects malformed monetary fields and inconsistent quotes', () => {
  const fields = ['amountSats', 'serviceFeeSats', 'invoiceSats', 'fundingReserveSats', 'claimFeeSats'] as const;
  for (const field of fields) {
    for (const value of [-1, 0.5, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      for (const helper of helpers) {
        assert.throws(() => helper({ ...baseline, [field]: value }), SatoshiMathError, `${helper.name}: ${field}=${value}`);
      }
    }
  }
  for (const changes of [{ amountSats: 9999 }, { amountSats: 1000001 }, { invoiceSats: 1 },
    { claimFeeSats: 50001 }, { serviceFeeSats: Number.MAX_SAFE_INTEGER, invoiceSats: Number.MAX_SAFE_INTEGER }]) {
    for (const helper of helpers) assert.throws(() => helper({ ...baseline, ...changes }), SatoshiMathError);
  }
});

test('accounting matches an independent bigint oracle through maximum safe invoice boundaries', () => {
  for (const amount of [10000, 50000, 1000000]) {
    for (const claim of [0, 1, amount]) {
      for (const service of [0, 1234, Number.MAX_SAFE_INTEGER - amount]) {
        const quote = { ...baseline, amountSats: amount, claimFeeSats: claim, serviceFeeSats: service,
          invoiceSats: amount + service, fundingReserveSats: Number.MAX_SAFE_INTEGER };
        const net = calculateNetReceivedSats(quote);
        const cost = calculateUserCost(quote);
        assert.equal(BigInt(net), BigInt(amount) - BigInt(claim));
        assert.equal(BigInt(cost), BigInt(service) + BigInt(claim));
        assert.equal(cost, calculateTotalPaidSats(quote) - net);
        assert.equal(cost, calculateNetSatsLost(quote));
        assert.ok(Number.isSafeInteger(net) && Number.isSafeInteger(cost));
      }
    }
  }
});

test('API fee values drive accounting and provider reserve never increases user cost', () => {
  for (const reserve of [0, 1000, Number.MAX_SAFE_INTEGER]) {
    const quote = { ...baseline, serviceFeeSats: 1234, claimFeeSats: 789, invoiceSats: 51234, fundingReserveSats: reserve };
    assert.equal(calculateNetReceivedSats(quote), 49211);
    assert.equal(calculateServiceFee(quote), 1234);
    assert.equal(calculateUserCost(quote), 2023);
    assert.equal(calculateNetSatsLost(quote), 2023);
  }
  // Pure accounting does not refresh, expire or otherwise mutate a quote.
  assert.equal(calculateUserCost(Object.freeze({ ...baseline })), 1250);
});

test('Qwen accounting consumes real POST /v1/quotes responses without changing the live gate', async () => {
  const f = await setup();
  const server = createApi(f.manager, async () => ({ onchainSats: 0, incomingSats: 0 }));
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    for (const amountSats of [10000, 10001, 50000, 1000000]) {
      const response = await fetch(`${base}/v1/quotes`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ amountSats }) });
      assert.equal(response.status, 201);
      const quote: Quote = await response.json();
      assert.equal(validateQuoteFields(quote), true);
      assert.equal(calculateNetReceivedSats(quote), quote.amountSats - quote.claimFeeSats);
      assert.equal(calculateTotalPaidSats(quote), amountSats);
      assert.equal(calculateUserCost(quote), quote.invoiceSats - calculateNetReceivedSats(quote));
      if (amountSats === 50000) {
        assert.equal(calculateNetReceivedSats(quote), 48750);
        assert.equal(calculateUserCost(quote), 1250);
      }
    }
    assert.equal((await (await fetch(`${base}/v1/health`)).json()).liveSwapsEnabled, false);
    assert.equal(Object.keys(f.store.read().swaps).length, 1);
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await f.cleanup();
  }
});
