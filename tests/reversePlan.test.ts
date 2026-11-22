import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fixture, routingFixture } from './helpers.js';
import { createReverseTestPlan, verifyReverseTestPlan } from '../src/core/ReverseTestPlan.js';
import { controlledRunDigest } from '../src/core/ControlledReverseBackend.js';

function plan() {
  const f = fixture();
  return createReverseTestPlan({ id: randomUUID(), amountSats: 50000, serviceFeeSats: 750, invoiceSats: 50750,
    claimFeeSats: 500, fundingReserveSats: 1000, expiresAt: Date.now() + 120000 }, 129,
    { paymentHash: f.contract.paymentHash, claimPublicKey: f.contract.claimPublicKey }, f.contract.refundPublicKey,
    { claim: f.destination, refund: f.destination }, { provider: f.contract.claimPublicKey, payer: f.contract.refundPublicKey }, routingFixture());
}
test('reverse test plan reconstructs exact contract and stays unapproved without secrets', () => {
  const p = plan(); assert.equal(p.contract.timeoutHeight, 159); assert.match(p.address, /^bcrt1/);
  assert.equal(p.executionApproved, false); assert.equal(p.quote.invoiceSats - (p.quote.amountSats - p.quote.claimFeeSats), 1250);
  assert.doesNotMatch(JSON.stringify(p), /privateKey|preimage|password|macaroon/);
});

test('routing is mandatory, canonical and cryptographically bound into the execution authorization', () => {
  const p = plan(); const swapId = randomUUID(); const isolationId = randomUUID(); const input = { txid: 'ab'.repeat(32), vout: 0 };
  const digest = controlledRunDigest(p, input, swapId, isolationId);
  for (const routing of [undefined, { ...p.routing, channelId: '' }, { ...p.routing, channelId: '0' },
    { ...p.routing, channelId: '012345' }, { ...p.routing, channelId: '18446744073709551616' },
    { ...p.routing, channelPoint: 'ef'.repeat(32) + ':4294967296' },
    { ...p.routing, payerOrigin: 'https://example.com' }, { ...p.routing, payerOrigin: p.routing.providerOrigin }]) {
    assert.throws(() => verifyReverseTestPlan({ ...p, routing }));
  }
  for (const changed of [{ ...p.routing, channelId: '12346' }, { ...p.routing, channelPoint: 'aa'.repeat(32) + ':0' },
    { ...p.routing, payerOrigin: 'https://127.0.0.1:8082' }, { ...p.routing, providerOrigin: 'https://127.0.0.1:8083' },
    { ...p.routing, bitcoinOrigin: 'http://127.0.0.1:18444' }]) {
    assert.notEqual(controlledRunDigest({ ...p, routing: changed }, input, swapId, isolationId), digest);
  }
});
test('reverse plan rejects altered amounts, keys, scripts, destination networks and implicit approval', () => {
  const p = plan();
  for (const changed of [{ ...p, network: 'mainnet' }, { ...p, executionApproved: true },
    { ...p, quote: { ...p.quote, invoiceSats: 50749 } }, { ...p, address: p.claimDestination },
    { ...p, contract: { ...p.contract, timeoutHeight: 160 } }, { ...p, providerNode: p.payerNode },
    { ...p, claimDestination: 'bc1-invalid-mainnet' },
    { ...p, claimDestination: 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kygt080' },
    { ...p, contract: { ...p.contract, refundPublicKey: p.contract.claimPublicKey } }]) {
    assert.throws(() => verifyReverseTestPlan(changed));
  }
});
