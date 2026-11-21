import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { Transaction } from 'bitcoinjs-lib';
import { setup } from './helpers.js';
import { Store } from '../src/persistence/Store.js';
import { SwapCoordinator } from '../src/core/SwapCoordinator.js';
import { reconcileControlledReverse, resumeControlledReverse } from '../src/core/ReverseTestRunner.js';
import { updateSwapRevision } from '../src/core/SwapStateMachine.js';
import type { ReversePaymentStatus, Swap } from '../src/core/SwapTypes.js';
import { createClaim } from '../src/bitcoin/ClaimManager.js';
import { createRefund } from '../src/bitcoin/RefundManager.js';

async function recoveryFixture() {
  const f = await setup();
  let store = f.store;
  await new SwapCoordinator(store, f.ports).issueInvoice(f.swap.id);
  const get = () => store.read().swaps[f.swap.id]!;
  const edit = (fn: (swap: Swap) => void) => updateSwapRevision(store, f.swap.id, get().revision, fn);
  await edit(s => { s.clientPayment = { hash: f.contract.paymentHash, status: 'UNKNOWN', feeLimitSats: 100 }; });
  let payer: ReversePaymentStatus = { hash: f.contract.paymentHash, status: 'IN_FLIGHT', valueSats: f.quote.invoiceSats };
  const lookup = f.ports.invoice;
  let invoicePatch: Partial<Awaited<ReturnType<typeof lookup>>> = {};
  f.ports.invoice = async hash => ({ ...await lookup(hash), ...invoicePatch });
  const counters = { lookup: 0, sign: 0, broadcast: 0 };
  const controls = {
    lookupPayment: async (hash: string) => { counters.lookup++; assert.equal(hash, f.contract.paymentHash); return payer; },
    claimDestination: f.destination,
    signClaim: async () => { counters.sign++; return createClaim(f.spend, f.preimage); },
    broadcastClaim: async (hex: string) => {
      counters.broadcast++; const tx = Transaction.fromHex(hex);
      f.ledger.set(tx.getId(), { hex, confirmations: 0 }); return tx.getId();
    },
  };
  const reconcile = () => reconcileControlledReverse(store, f.ports, controls, f.swap.id, get().revision);
  const resume = () => resumeControlledReverse(store, f.ports, controls, f.swap.id, get().revision);
  const funding = async () => {
    await edit(s => { s.lockup = { txid: f.tx.getId(), hex: f.tx.toHex(), vout: 0 }; s.pendingAction = 'BROADCAST_LOCKUP'; });
    f.ledger.set(f.tx.getId(), { hex: f.tx.toHex(), confirmations: 1 });
  };
  const claim = async () => {
    await funding(); const tx = createClaim(f.spend, f.preimage);
    await edit(s => { s.clientClaimIntent = { txid: tx.getId(), destination: f.destination, feeSats: f.quote.claimFeeSats, status: 'UNKNOWN' }; });
    f.ledger.set(tx.getId(), { hex: tx.toHex(), confirmations: 1 }); return tx;
  };
  return { f, get, edit, controls, counters, reconcile, resume, funding, claim,
    get store() { return store; },
    payer: (patch: Partial<ReversePaymentStatus>) => { payer = { ...payer, ...patch }; },
    invoice: (patch: typeof invoicePatch) => { invoicePatch = patch; },
    reopen: async () => { await store.close(); store = await Store.open(f.directory); },
    cleanup: async () => { await store.close(); await rm(f.directory, { recursive: true, force: true }); },
  };
}

test('payment-only restart queries every persisted status by hash and idempotently recovers accepted evidence', async () => {
  for (const status of ['INTENT', 'IN_FLIGHT', 'UNKNOWN', 'FAILED', 'SUCCEEDED'] as const) {
    const x = await recoveryFixture(); try {
      await x.edit(s => { s.clientPayment!.status = status; });
      await x.reopen();
      await new SwapCoordinator(x.store, x.f.ports).recover();
      assert.equal(x.get().state, 'MANUAL_REVIEW');
      const first = await x.reconcile();
      assert.equal(first.next, 'FUND'); assert.equal(first.swap.clientPayment!.status, 'IN_FLIGHT');
      const again = await x.reconcile();
      assert.equal(again.swap.revision, first.swap.revision);
      assert.equal(again.swap.history.length, first.swap.history.length);
      assert.equal(x.counters.lookup, 2); assert.equal(x.f.calls.funding, 0); assert.equal(x.counters.sign, 0);
    } finally { await x.cleanup(); }
  }
});

test('explicit staged resume crosses funding, claim, settlement and completion restarts without resending or mining', async () => {
  const x = await recoveryFixture(); try {
    await x.reopen();
    assert.equal((await x.resume()).state, 'LOCKUP_BROADCAST');
    assert.equal((await x.reconcile()).next, 'MANUAL_REVIEW'); // broadcast ack alone
    assert.equal((await x.resume()).state, 'MANUAL_REVIEW');
    assert.equal(x.f.calls.funding, 1); assert.equal(x.f.calls.broadcast, 1);
    x.f.ledger.get(x.f.tx.getId())!.confirmations = 1;
    await x.reopen();
    assert.equal((await x.reconcile()).next, 'CLAIM');
    const broadcast = await x.resume(); const txid = broadcast.clientClaimIntent!.txid;
    assert.equal(broadcast.state, 'LOCKUP_CONFIRMED');
    assert.equal((await x.resume()).state, 'MANUAL_REVIEW'); // claim ack alone
    assert.equal(x.counters.broadcast, 1); assert.equal(x.counters.sign, 1);
    x.f.ledger.get(txid)!.confirmations = 1;
    await x.reopen();
    assert.equal((await x.reconcile()).next, 'SETTLE');
    assert.equal((await x.resume()).state, 'LIGHTNING_SETTLED');
    assert.equal(x.f.calls.settle, 1);
    x.payer({ status: 'SUCCEEDED', feeSats: 2 });
    await x.reopen();
    assert.equal((await x.resume()).state, 'COMPLETED');
    const done = x.get();
    assert.equal((await x.resume()).revision, done.revision);
    assert.equal(x.f.calls.settle, 1); assert.equal(x.counters.broadcast, 1);
    const persisted = await readFile(join(x.f.directory, 'state.json'), 'utf8');
    assert.equal(persisted.includes(x.f.preimage), false);
    assert.equal(persisted.includes(x.f.ledger.get(txid)!.hex), false);
  } finally { await x.cleanup(); }
});

test('unknown payment, absent evidence and mismatched payer/invoice evidence remain manual without actions', async () => {
  const cases: Array<(x: Awaited<ReturnType<typeof recoveryFixture>>) => void> = [
    x => x.payer({ status: 'UNKNOWN' }),
    x => x.payer({ hash: '00'.repeat(32) }),
    x => x.payer({ valueSats: 1 }),
    x => x.payer({ status: 'SUCCEEDED', feeSats: 101 }),
    x => x.payer({ status: 'SUCCEEDED', feeSats: -1 }),
    x => x.payer({ status: 'SUCCEEDED', feeSats: undefined }),
    x => x.invoice({ payment_request: 'another' }),
    x => x.invoice({ r_hash: Buffer.alloc(32).toString('base64') }),
    x => x.invoice({ value: '1' }),
    x => x.invoice({ htlcs: [] }),
    x => x.invoice({ htlcs: [{ state: 'ACCEPTED', expiration_height: 150, amt_msat: String(x.f.quote.invoiceSats * 1000) }] }),
    x => x.invoice({ state: 'OPEN', amt_paid_sat: '0', htlcs: [] }),
    x => { x.controls.lookupPayment = async () => { throw new Error('offline'); }; },
  ];
  for (const change of cases) {
    const x = await recoveryFixture(); try {
      change(x); assert.equal((await x.resume()).state, 'MANUAL_REVIEW');
      assert.equal(x.f.calls.funding, 0); assert.equal(x.f.calls.settle, 0); assert.equal(x.counters.broadcast, 0);
    } finally { await x.cleanup(); }
  }
});

test('uncertain preparation, mining and settlement are never blindly retried', async () => {
  for (const point of ['prepare', 'mining', 'settle'] as const) {
    const x = await recoveryFixture(); try {
      if (point === 'settle') { await x.claim(); await x.edit(s => { s.pendingAction = 'SETTLE'; }); }
      if (point === 'mining') {
        await x.funding(); await x.edit(s => { s.miningIntents = [{ txid: x.f.tx.getId(), fromHeight: 100, status: 'INTENT' }]; });
      }
      if (point === 'prepare') await x.edit(s => { s.pendingAction = 'PREPARE_LOCKUP'; });
      await x.reopen();
      assert.equal((await x.resume()).state, 'MANUAL_REVIEW');
      assert.equal(x.f.calls.funding, 0); assert.equal(x.f.calls.settle, 0); assert.equal(x.counters.broadcast, 0);
      if (point === 'settle') {
        x.invoice({ state: 'SETTLED' }); x.payer({ status: 'SUCCEEDED', feeSats: 0 });
        assert.equal((await x.resume()).state, 'COMPLETED');
        assert.equal(x.get().pendingAction, undefined); assert.equal(x.f.calls.settle, 0);
      }
    } finally { await x.cleanup(); }
  }
});

test('exact confirmed refund and observed cancellation reconcile a lost cancellation reply without another RPC', async () => {
  const x = await recoveryFixture(); try {
    await x.funding();
    const tx = createRefund({ ...x.f.spend, privateKey: x.f.refundKey.privateKey! }, 130);
    x.f.ledger.set(tx.getId(), { hex: tx.toHex(), confirmations: 1 });
    await x.edit(s => { s.refundTxid = tx.getId(); s.pendingAction = 'CANCEL_INVOICE'; });
    x.invoice({ state: 'CANCELED' }); x.payer({ status: 'FAILED' });
    let cancels = 0; x.f.ports.cancel = async () => { cancels++; throw new Error('must not retry'); };
    await x.reopen();
    assert.equal((await x.resume()).state, 'REFUNDED');
    assert.equal(x.get().pendingAction, undefined); assert.equal(cancels, 0);
    assert.equal((await x.reconcile()).swap.state, 'REFUNDED');
    x.f.ledger.get(tx.getId())!.confirmations = 0;
    assert.equal((await x.reconcile()).swap.state, 'MANUAL_REVIEW');
    assert.ok(x.get().lockup);
  } finally { await x.cleanup(); }
});

test('stale caller revisions and journal changes during payment lookup cannot commit reconciliation', async () => {
  const x = await recoveryFixture(); try {
    const revision = x.get().revision;
    await x.edit(s => { s.clientPayment!.status = 'INTENT'; });
    await assert.rejects(reconcileControlledReverse(x.store, x.f.ports, x.controls, x.f.swap.id, revision), /Stale/);
    assert.equal(x.counters.lookup, 0);
    x.controls.lookupPayment = async () => {
      await x.edit(s => { s.clientPayment!.status = 'FAILED'; });
      return { hash: x.f.contract.paymentHash, status: 'IN_FLIGHT', valueSats: x.f.quote.invoiceSats };
    };
    await assert.rejects(x.reconcile(), /Stale/);
    assert.equal(x.get().clientPayment!.status, 'FAILED');
    assert.equal(x.get().state, 'INVOICE_CREATED');
  } finally { await x.cleanup(); }
});

test('concurrent resume reservations allow only one new funding action across coordinator instances', async () => {
  const x = await recoveryFixture(); try {
    const revision = x.get().revision;
    const results = await Promise.allSettled([0, 1].map(() => resumeControlledReverse(x.store, x.f.ports, x.controls, x.f.swap.id, revision)));
    assert.ok(results.some(result => result.status === 'fulfilled'));
    assert.equal(x.f.calls.funding, 1); assert.equal(x.f.calls.broadcast, 1);
  } finally { await x.cleanup(); }
});

test('fresh funding and claim reorg checks fail closed, including a reorg during the final evidence pass', async () => {
  for (const point of ['funding', 'claim', 'final'] as const) {
    const x = await recoveryFixture(); try {
      const claim = await x.claim();
      x.invoice({ state: 'SETTLED' }); x.payer({ status: 'SUCCEEDED', feeSats: 0 });
      assert.equal((await x.reconcile()).swap.state, 'COMPLETED');
      await x.reopen();
      if (point === 'funding') x.f.ledger.get(x.f.tx.getId())!.confirmations = 0;
      if (point === 'claim') x.f.ledger.get(claim.getId())!.confirmations = 0;
      if (point === 'final') {
        const confirmed = x.f.ports.confirmed; let lookups = 0;
        x.f.ports.confirmed = async txid => {
          if (++lookups > 2) return { hex: '', confirmations: 0 };
          return confirmed(txid);
        };
      }
      assert.equal((await x.resume()).state, 'MANUAL_REVIEW');
      assert.ok(x.get().lockup); assert.ok(x.get().claimTxid); assert.equal(x.f.calls.settle, 0);
    } finally { await x.cleanup(); }
  }
});

test('wrong funding outpoint, forged witness and substituted claim output never reconcile', async () => {
  for (const point of ['outpoint', 'witness', 'destination'] as const) {
    const x = await recoveryFixture(); try {
      const claim = await x.claim();
      if (point === 'outpoint') await x.edit(s => { s.lockup!.vout = 1; });
      if (point === 'witness') {
        const forged = Transaction.fromHex(claim.toHex()); forged.ins[0]!.witness[0] = Buffer.alloc(71);
        x.f.ledger.set(claim.getId(), { hex: forged.toHex(), confirmations: 1 });
      }
      if (point === 'destination') await x.edit(s => { s.clientClaimIntent!.destination = 'invalid'; });
      assert.equal((await x.resume()).state, 'MANUAL_REVIEW');
      assert.equal(x.f.calls.settle, 0); assert.equal(x.counters.broadcast, 0);
    } finally { await x.cleanup(); }
  }
});

test('lost new funding or claim broadcast replies retain intents and stop staged resume', async () => {
  for (const point of ['prepare', 'funding broadcast', 'claim broadcast'] as const) {
    const x = await recoveryFixture(); try {
      if (point === 'prepare') x.f.ports.prepareLockup = async () => { throw new Error('lost prepare'); };
      if (point === 'funding broadcast') x.f.ports.broadcast = async () => { throw new Error('lost funding reply'); };
      if (point === 'claim broadcast') {
        await x.funding(); x.controls.broadcastClaim = async () => { x.counters.broadcast++; throw new Error('lost claim reply'); };
      }
      await assert.rejects(x.resume(), /lost/);
      assert.equal(x.get().state, 'MANUAL_REVIEW');
      if (point === 'prepare') assert.equal(x.get().pendingAction, 'PREPARE_LOCKUP');
      if (point === 'funding broadcast') assert.equal(x.get().pendingAction, 'BROADCAST_LOCKUP');
      if (point === 'claim broadcast') assert.equal(x.get().clientClaimIntent!.status, 'UNKNOWN');
      await x.reopen();
      assert.equal((await x.resume()).state, 'MANUAL_REVIEW');
      assert.equal(x.counters.broadcast, point === 'claim broadcast' ? 1 : 0);
    } finally { await x.cleanup(); }
  }
});

test('settlement acknowledgement without settled evidence remains manual and direct observation cannot retry', async () => {
  const x = await recoveryFixture(); try {
    const claim = await x.claim();
    x.f.ports.settle = async () => { x.f.calls.settle++; return {}; };
    assert.equal((await x.resume()).state, 'MANUAL_REVIEW');
    assert.equal(x.get().pendingAction, 'SETTLE');
    assert.equal(x.f.calls.settle, 1);
    // Even callers of the existing observer API cannot turn a persisted intent into a retry.
    await x.edit(s => { s.state = 'CLAIM_DETECTED'; });
    assert.equal((await new SwapCoordinator(x.store, x.f.ports).observeClaim(x.f.swap.id, claim.getId())).state, 'MANUAL_REVIEW');
    await x.reopen(); await x.resume();
    assert.equal(x.f.calls.settle, 1);
  } finally { await x.cleanup(); }
});
