import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, routingFixture } from './helpers.js';
import { createReverseTestPlan } from '../src/core/ReverseTestPlan.js';
import { invoiceOnlyPorts } from '../src/core/InvoiceOnlyPorts.js';
import { SwapCoordinator } from '../src/core/SwapCoordinator.js';
import { verifyDecodedHoldInvoice } from '../src/lightning/InvoiceVerification.js';
import type { Invoice } from '../src/lightning/LndClient.js';

const paymentRequest = 'lnbcrt' + 'a'.repeat(30); // Synthetic: payer signature decoding is mocked here.
const decoded = (hash: string, pubkey: string) => ({ destination: pubkey, payment_hash: hash, num_satoshis: '50750',
  num_msat: '50750000', timestamp: String(Math.floor(Date.now() / 1000)), expiry: '3600', cltv_expiry: '80' });

test('independent invoice checks reject amount, hash, payee, network, deadline and expiry substitution', () => {
  const expected = { paymentHash: 'ab'.repeat(32), payeePublicKey: '02' + 'cd'.repeat(32), invoiceSats: 50750, minFinalCltv: 80 };
  const correct = decoded(expected.paymentHash, expected.payeePublicKey);
  verifyDecodedHoldInvoice(paymentRequest, correct, expected);
  for (const changed of [{ ...correct, payment_hash: '00'.repeat(32) }, { ...correct, destination: 'other' },
    { ...correct, num_satoshis: '50749' }, { ...correct, num_msat: '50749999' }, { ...correct, num_satoshis: '050750' },
    { ...correct, cltv_expiry: '79' }, { ...correct, timestamp: '0' }, { ...correct, expiry: '3601' },
    { ...correct, timestamp: String(Math.floor(Date.now() / 1000) + 120) }]) {
    assert.throws(() => verifyDecodedHoldInvoice(paymentRequest, changed, expected));
  }
  assert.throws(() => verifyDecodedHoldInvoice('lnbc' + 'a'.repeat(30), correct, expected));
});

async function portsFixture() {
  const f = await setup(); let created = 0; let fail = false; let network = 'regtest';
  const plan = createReverseTestPlan(f.quote, 100, { paymentHash: f.contract.paymentHash, claimPublicKey: f.contract.claimPublicKey },
    f.contract.refundPublicKey, { claim: f.destination, refund: f.destination }, { provider: f.contract.claimPublicKey, payer: f.contract.refundPublicKey }, routingFixture(), 'lqwd-lab');
  const assertRegtest = async () => ({ chains: [{ chain: 'bitcoin', network: 'regtest' }], synced_to_chain: true });
  const provider = { assertRegtest,
    async call<T>(path: string): Promise<T> { assert.equal(path, '/v1/getinfo'); return { identity_pubkey: plan.providerNode, wallet_synced: true } as T; },
    async addHoldInvoice(hash: string, sats: number, expiry: number, cltv: number) {
      assert.deepEqual([hash, sats, expiry, cltv], [f.contract.paymentHash, 50750, 3600, 80]); created++;
      // Intent must already be durable before the remote request.
      assert.equal(f.manager.get(f.swap.id)!.pendingAction, 'CREATE_INVOICE');
      if (fail) throw new Error('Unknown creation outcome');
      return { payment_request: paymentRequest };
    },
    async lookup(): Promise<Invoice> { return { state: 'OPEN', r_hash: Buffer.from(f.contract.paymentHash, 'hex').toString('base64'),
      value: '50750', amt_paid_sat: '0', payment_request: paymentRequest }; },
  };
  const payer = { assertRegtest,
    async call<T>(path: string): Promise<T> {
      if (path === '/v1/getinfo') return { identity_pubkey: plan.payerNode, wallet_synced: true } as T;
      assert.equal(path, '/v1/payreq/' + paymentRequest);
      return decoded(f.contract.paymentHash, plan.providerNode) as T;
    },
  };
  const bitcoin = { async call<T>(): Promise<T> { return { chain: network, blocks: 100, initialblockdownload: false } as T; },
    async confirmed() { return { hex: '', confirmations: 0 }; } };
  return { f, plan, ports: invoiceOnlyPorts(bitcoin, provider, payer, plan), created: () => created,
    fail: () => { fail = true; }, foreign: () => { network = 'main'; } };
}

test('invoice-only capability verifies an unpaid invoice through the payer and cannot fund or pay', async () => {
  const f = await portsFixture(); try {
    const c = new SwapCoordinator(f.f.store, f.ports); const result = await c.issueInvoice(f.f.swap.id);
    assert.equal(result.state, 'INVOICE_CREATED'); assert.equal(f.created(), 1);
    await c.issueInvoice(f.f.swap.id); assert.equal(f.created(), 1);
    await assert.rejects(f.ports.prepareLockup(result), /disabled/);
    await assert.rejects(f.ports.broadcast(''), /disabled/);
    await assert.rejects(f.ports.settle(''), /disabled/);
    await assert.rejects(f.ports.cancel(f.plan.contract.paymentHash), /disabled/);
  } finally { await f.f.cleanup(); }
});

test('unknown hold-invoice creation retains its intent and never posts another invoice after recovery', async () => {
  const f = await portsFixture(); try {
    f.fail(); const c = new SwapCoordinator(f.f.store, f.ports);
    await assert.rejects(c.issueInvoice(f.f.swap.id), /Unknown creation/);
    assert.equal(f.f.manager.get(f.f.swap.id)!.pendingAction, 'CREATE_INVOICE');
    await c.recover(); await c.issueInvoice(f.f.swap.id);
    assert.equal(f.created(), 1); assert.equal(f.f.manager.get(f.f.swap.id)!.state, 'MANUAL_REVIEW');
  } finally { await f.f.cleanup(); }
});

test('invoice-only creation refuses the wrong Core network before making a POST', async () => {
  const f = await portsFixture(); try {
    f.foreign(); await assert.rejects(new SwapCoordinator(f.f.store, f.ports).issueInvoice(f.f.swap.id));
    assert.equal(f.created(), 0);
  } finally { await f.f.cleanup(); }
});
