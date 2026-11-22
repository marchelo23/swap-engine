import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { archivedPreparationSpecSchema } from '../src/operator/ArchiveEvidence.js';
import { preparationSpecSchema } from '../src/core/ReversePreparation.js';
import { routingFixture } from './helpers.js';

const address = 'bcrt1qz62y94lnjfj4sqmzwsap2fvleqxkua95znqfwj';
const spec = { id: randomUUID(), isolationId: randomUUID(), tipHeight: 100, wallet: 'lab-wallet',
  providerNode: '02' + '11'.repeat(32), payerNode: '03' + '22'.repeat(32), routing: routingFixture(),
  client: { paymentHash: 'ab'.repeat(32), claimPublicKey: '02' + '11'.repeat(32) },
  refundPublicKey: '03' + '22'.repeat(32), claimDestination: address, refundDestination: address,
  input: { txid: 'cd'.repeat(32), vout: 0, valueSats: 61000 } };

test('archives allow legacy wallet omission while live specs keep it required', () => {
  const { wallet: _wallet, ...legacy } = spec;
  assert.equal(preparationSpecSchema.safeParse(legacy).success, false);
  assert.equal(archivedPreparationSpecSchema.safeParse(legacy).success, true);
  assert.equal(archivedPreparationSpecSchema.safeParse(spec).success, true);
  assert.equal(archivedPreparationSpecSchema.safeParse({ ...legacy, wallet: 1 }).success, false);
});