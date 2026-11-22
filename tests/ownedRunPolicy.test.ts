import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { ownedRunPolicyBase, ownedRunPolicySchema } from '../src/operator/OwnedRunCustody.js';
import { routingFixture } from './helpers.js';

const policy = {
  ownerUsername: 'reviewer', ownerId: randomUUID(), authStorePath: '/tmp/auth.json', wallet: 'lab-wallet',
  origin: 'http://127.0.0.1:3201', port: 3201, backupDirectory: '/tmp/backups',
  tipHeight: 100, providerNode: '02' + '11'.repeat(32), payerNode: '03' + '22'.repeat(32),
  routing: routingFixture(), claimDestination: 'bcrt1qz62y94lnjfj4sqmzwsap2fvleqxkua95znqfwj',
  refundDestination: 'bcrt1qz62y94lnjfj4sqmzwsap2fvleqxkua95znqfwj',
  input: { txid: 'ab'.repeat(32), vout: 0, valueSats: 61000 },
  credentialPaths: { bitcoinCookiePath: '/tmp/cookie', providerCertPath: '/tmp/provider.cert',
    providerReadMacaroonPath: '/tmp/provider.read', payerCertPath: '/tmp/payer.cert',
    payerReadMacaroonPath: '/tmp/payer.read', providerInvoiceMacaroonPath: '/tmp/provider.invoices' },
};

test('owned run policy accepts validated loopback and binds origin port', () => {
  assert.ok(ownedRunPolicyBase.safeParse(policy).success);
  assert.equal(ownedRunPolicySchema.parse({ ...policy, origin: 'http://localhost:4321', port: 4321 }).port, 4321);
  assert.ok(ownedRunPolicySchema.safeParse({ ...policy, origin: 'http://[::1]:4321', port: 4321 }).success);
  for (const value of [{ ...policy, origin: 'http://127.0.0.1:3202' },
    { ...policy, origin: 'http://10.0.0.1:3201' }, { ...policy, origin: 'https://127.0.0.1:3201' },
    { ...policy, origin: 'http://127.0.0.1:3201/path' }, { ...policy, port: 0 }, { ...policy, port: 65536 }])
    assert.equal(ownedRunPolicySchema.safeParse(value).success, false);
});