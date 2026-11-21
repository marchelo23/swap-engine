import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verifyApprovedPaymentRoutes } from '../src/lightning/LndRouteEvidence.js';

const expected = { channelId: '12345', providerNode: '02' + 'ab'.repeat(32), valueMsat: 50750000n };
const part = (id: string, amount: string, status = 'IN_FLIGHT') => ({ attempt_id: id, status,
  route: { total_amt_msat: amount, total_fees_msat: '0', hops: [{ chan_id: expected.channelId,
    pub_key: expected.providerNode, amt_to_forward_msat: amount, fee_msat: '0' }] } });

test('approved same-channel multipart evidence supports partial observations and exact final totals', () => {
  assert.equal(verifyApprovedPaymentRoutes({ htlcs: [part('1', '25000000')] }, expected, 'IN_FLIGHT', 0n).hasInFlight, true);
  assert.equal(verifyApprovedPaymentRoutes({ htlcs: [part('1', '25000000', 'SUCCEEDED'), part('2', '25750000', 'SUCCEEDED')] },
    expected, 'SUCCEEDED', 0n).hasInFlight, false);
  assert.equal(verifyApprovedPaymentRoutes({ htlcs: [] }, expected, 'INITIATED', 0n).hasInFlight, false);
  assert.equal(verifyApprovedPaymentRoutes({ htlcs: [] }, expected, 'IN_FLIGHT', 0n).hasInFlight, false);
});

test('duplicates, overpayment, partial success and missing routes never prove final payment success', () => {
  for (const htlcs of [[], [part('1', '1', 'SUCCEEDED')], [part('1', '50750001', 'SUCCEEDED')],
    [part('1', '50750000', 'SUCCEEDED'), part('1', '1', 'FAILED')],
    [part('1', '50750000', 'IN_FLIGHT')]]) {
    assert.throws(() => verifyApprovedPaymentRoutes({ htlcs }, expected, 'SUCCEEDED', 0n));
  }
  assert.throws(() => verifyApprovedPaymentRoutes({ htlcs: [part('1', '50750000', 'SUCCEEDED')] }, expected, 'SUCCEEDED', 1n));
});
