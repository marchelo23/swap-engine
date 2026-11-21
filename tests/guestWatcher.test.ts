import { randomBytes, randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Transaction } from 'bitcoinjs-lib';
import { setup, privateTestDirectory, routingFixture } from './helpers.js';
import { GuestReverse, type GuestPreparationFactory, type GuestReverseClients } from '../src/guest/GuestReverse.js';
import { controlledGuestExecution, type GuestExecution } from '../src/guest/GuestExecution.js';
import type { SwapPorts } from '../src/core/SwapCoordinator.js';
import { SwapManager } from '../src/core/SwapManager.js';
import { createReverseTestPlan } from '../src/core/ReverseTestPlan.js';
import { preparationDigest } from '../src/core/ReversePreparation.js';
import { buildHtlc } from '../src/bitcoin/HtlcBuilder.js';
import { createClaim } from '../src/bitcoin/ClaimManager.js';
import { Store } from '../src/persistence/Store.js';
import { updateSwapRevision } from '../src/core/SwapStateMachine.js';
import type { Invoice } from '../src/lightning/LndClient.js';

const GUEST_INVOICE_SATS = 50000;

async function fixture(options: { withExecution?: boolean } = {}) {
  const f = await setup(); const runsDirectory = await privateTestDirectory('guest-watch-runs'); const routing = routingFixture();
  let invoiceState: Invoice['state'] = 'OPEN'; let calls = 0;
  const ledger = new Map<string, { hex: string; confirmations: number }>(); const actions: string[] = [];
  const invoice = (): Invoice => ({ state: invoiceState, r_hash: Buffer.from(f.contract.paymentHash, 'hex').toString('base64'),
    value: String(GUEST_INVOICE_SATS), amt_paid_sat: invoiceState === 'SETTLED' ? String(GUEST_INVOICE_SATS) : '0',
    payment_request: 'lnbcrt' + 'c'.repeat(30),
    htlcs: invoiceState === 'ACCEPTED' ? [{ state: 'ACCEPTED', expiration_height: 210, amt_msat: String(GUEST_INVOICE_SATS * 1000) }] : [] });
  const clients: GuestReverseClients = {
    bitcoin: { origin: routing.bitcoinOrigin, call: async () => { throw new Error('unexpected Core call'); },
      confirmed: async txid => ledger.get(txid) ?? { hex: '', confirmations: 0 } },
    provider: { origin: routing.providerOrigin, call: async () => { throw new Error('unexpected provider call'); },
      assertRegtest: async () => ({ chains: [{ chain: 'bitcoin', network: 'regtest' }], synced_to_chain: true }) },
    payer: { origin: routing.payerOrigin, call: async () => { throw new Error('unexpected payer call'); },
      assertRegtest: async () => ({ chains: [{ chain: 'bitcoin', network: 'regtest' }], synced_to_chain: true }) },
    invoices: { origin: routing.providerOrigin, create: async () => { throw new Error('unexpected invoice create'); },
      lookup: async () => ({ status: 'PRESENT' as const, invoice: invoice() }) },
    tip: async () => 100, now: () => 1000,
  };
  const execution: GuestExecution = {
    async fund(store, swap) { actions.push('fund'); return updateSwapRevision(store, swap.id, swap.revision, value => {
      if (value.state !== 'INVOICE_CREATED') throw new Error('guest funding state changed');
      if (!value.clientPayment) value.clientPayment = { hash: value.contract.paymentHash, status: 'IN_FLIGHT', feeLimitSats: 0 };
      value.state = 'LOCKUP_BROADCAST';
    }); },
    async confirm(store, swap) { actions.push('confirm'); return updateSwapRevision(store, swap.id, swap.revision, value => { value.state = 'LOCKUP_CONFIRMED'; }); },
    async settle(store, swap, _plan, txid) { actions.push('settle'); invoiceState = 'SETTLED';
      return updateSwapRevision(store, swap.id, swap.revision, value => { value.state = 'LIGHTNING_SETTLED'; value.claimTxid = txid; }); },
    async markPaid(store, swap) { actions.push('markPaid'); return updateSwapRevision(store, swap.id, swap.revision, value => {
      if (value.clientPayment) value.clientPayment.status = 'SUCCEEDED';
    }); },
    async complete(store, swap) { actions.push('complete'); return updateSwapRevision(store, swap.id, swap.revision, value => { value.state = 'COMPLETED'; }); },
    async expire(store, swap) { actions.push('expire'); return updateSwapRevision(store, swap.id, swap.revision, value => { value.state = 'EXPIRED'; }); },
  };
  const preparation: GuestPreparationFactory = (store, spec) => ({ async prepare() {
    calls++;
    const manager = new SwapManager(store);
    const quote = await manager.quoteInvoice(spec.sourceAmountSats!, 1000);
    const plan = createReverseTestPlan(quote, spec.tipHeight, spec.client, spec.refundPublicKey,
      { claim: spec.claimDestination, refund: spec.refundDestination }, { provider: spec.providerNode, payer: spec.payerNode }, spec.routing);
    const swap = await manager.create(quote.id, `guest-${spec.id}`, plan.contract, spec.tipHeight,
      { onchainSats: 1000000, incomingSats: 1000000 }, 1000);
    await store.transaction(db => {
      const current = db.swaps[swap.id]!; current.invoice = 'lnbcrt' + 'c'.repeat(30); current.state = 'INVOICE_CREATED';
      current.pendingAction = undefined; current.revision++;
      (db.reversePreparations ??= {})[spec.id] = { specDigest: preparationDigest(spec), attemptId: 'synthetic', status: 'READY',
        plan, swapId: swap.id, invoiceAttempt: { attemptId: 'synthetic', revision: current.revision, wireAuthorized: true } };
    });
    return { plan, swapId: swap.id, invoice: 'lnbcrt' + 'c'.repeat(30), invoiceExpiresAt: 1000 + 3_600_000 };
  } });
  const policy = { mode: 'regtest' as const, isolationId: randomUUID(), providerNode: '02' + '11'.repeat(32),
    payerNode: '03' + '22'.repeat(32), routing, refundPublicKey: f.contract.refundPublicKey,
    refundDestination: f.destination, funding: { txid: 'ab'.repeat(32), vout: 0, valueSats: 100000 }, runsDirectory };
  const service = new GuestReverse(f.store, policy, clients, { preparation,
    broadcast: async hex => Transaction.fromHex(hex).getId(), execution: options.withExecution ? execution : undefined });
  const token = randomBytes(32).toString('base64url'); const auth = `Bearer ${token}`;
  const quote = await service.quote(auth, 'guest-quote-key', { destination: f.destination, amountSats: GUEST_INVOICE_SATS,
    paymentHash: f.contract.paymentHash, claimPublicKey: f.contract.claimPublicKey });
  return { f, service, quote, auth, token, runsDirectory, ledger, actions,
    prepare: (key = 'guest-prepare-key') => service.prepare(quote.id, auth, key, { recoveryCommitment: 'ab'.repeat(32) }),
    setInvoice: (state: Invoice['state']) => { invoiceState = state; }, calls: () => calls,
    cleanup: async () => { await f.cleanup(); await rm(runsDirectory, { recursive: true, force: true }); } };
}

async function seedLockup(x: Awaited<ReturnType<typeof fixture>>, options: { claim?: boolean; pending?: string } = {}) {
  const prepared = await x.prepare() as any;
  const run = await Store.open(join(x.runsDirectory, x.quote.id));
  let swapId = prepared.swapId; let revision: number; let claim: Transaction; let lockup: Transaction;
  try {
    const swap = run.read().swaps[swapId]!;
    const htlc = buildHtlc(x.f.contract);
    lockup = new Transaction(); lockup.version = 2; lockup.addInput(randomBytes(32), 0);
    lockup.addOutput(htlc.output, BigInt(swap.quote.amountSats));
    claim = createClaim({ contract: x.f.contract, lockupTxHex: lockup.toHex(), vout: 0, destination: x.f.destination,
      feeSats: swap.quote.claimFeeSats, privateKey: x.f.claimKey.privateKey! }, x.f.preimage);
    await run.transaction(db => {
      const current = db.swaps[swapId]!; current.lockup = { txid: lockup.getId(), hex: lockup.toHex(), vout: 0 };
      current.state = 'LOCKUP_CONFIRMED'; current.revision++;
      if (options.pending) current.pendingAction = options.pending as typeof current.pendingAction;
      if (options.claim) { current.claimTxid = claim.getId();
        current.clientClaimIntent = { txid: claim.getId(), destination: x.f.destination, feeSats: current.quote.claimFeeSats, status: 'BROADCAST' }; }
    });
    revision = run.read().swaps[swapId]!.revision;
  } finally { await run.close(); }
  if (options.claim) x.ledger.set(claim.getId(), { hex: claim.toHex(), confirmations: 1 });
  x.setInvoice('ACCEPTED');
  return { swapId, revision, claim, lockup };
}

test('guest watcher is inert without an injected controlled execution', async () => {
  const x = await fixture(); try {
    await x.prepare(); x.setInvoice('ACCEPTED');
    const result = await x.service.runOnce();
    assert.equal(result.scanned, 1); assert.equal(result.updated, 0); assert.deepEqual(x.actions, []);
    const status = await x.service.status(x.quote.id, x.auth) as any;
    assert.equal(status.status, 'PAYMENT_ACCEPTED_NOT_SETTLED');
  } finally { await x.cleanup(); }
});

test('watcher funds once, confirms the lockup and never repeats a financial action', async () => {
  const x = await fixture({ withExecution: true }); try {
    await x.prepare(); x.setInvoice('ACCEPTED');
    await x.service.runOnce();
    assert.deepEqual(x.actions, ['fund', 'confirm']);
    const status = await x.service.status(x.quote.id, x.auth) as any;
    assert.equal(status.status, 'FUNDED_AWAITING_CLAIM'); assert.equal(status.swapState, 'LOCKUP_CONFIRMED');
    await x.service.runOnce();
    assert.deepEqual(x.actions, ['fund', 'confirm']);
  } finally { await x.cleanup(); }
});

test('ambiguous pending actions are never retried by the watcher', async () => {
  const x = await fixture({ withExecution: true }); try {
    await seedLockup(x, { pending: 'BROADCAST_LOCKUP' });
    await x.service.runOnce();
    assert.deepEqual(x.actions, []);
  } finally { await x.cleanup(); }
});

test('restart reconciliation settles and completes from independent evidence without duplicate actions', async () => {
  const x = await fixture({ withExecution: true }); try {
    await seedLockup(x, { claim: true });
    await x.service.runOnce();
    assert.deepEqual(x.actions, ['settle']);
    await x.service.runOnce();
    assert.deepEqual(x.actions, ['settle', 'markPaid', 'complete']);
    await x.service.runOnce();
    assert.deepEqual(x.actions, ['settle', 'markPaid', 'complete']);
    const status = await x.service.status(x.quote.id, x.auth) as any;
    assert.equal(status.status, 'COMPLETED');
  } finally { await x.cleanup(); }
});

test('controlled guest execution uses the existing coordinator for fund/confirm/settle/complete', async () => {
  const x = await fixture(); try {
    const prepared = await x.prepare() as any;
    const run = await Store.open(join(x.runsDirectory, x.quote.id));
    try {
      const initial = run.read().swaps[prepared.swapId]!;
      const plan = run.read().reversePreparations![x.quote.id]!.plan!;
      const htlc = buildHtlc(initial.contract);
      const lockup = new Transaction(); lockup.version = 2; lockup.addInput(randomBytes(32), 0);
      lockup.addOutput(htlc.output, BigInt(initial.quote.amountSats));
      const claim = createClaim({ contract: initial.contract, lockupTxHex: lockup.toHex(), vout: 0,
        destination: x.f.destination, feeSats: initial.quote.claimFeeSats, privateKey: x.f.claimKey.privateKey! }, x.f.preimage);
      let invoiceState: Invoice['state'] = 'ACCEPTED'; let fundCalls = 0; let broadcastCalls = 0; let settleCalls = 0;
      const ledger = new Map<string, { hex: string; confirmations: number }>();
      const invoice = (): Invoice => ({ state: invoiceState, r_hash: Buffer.from(initial.contract.paymentHash, 'hex').toString('base64'),
        value: String(initial.quote.invoiceSats), amt_paid_sat: invoiceState === 'SETTLED' ? String(initial.quote.invoiceSats) : '0',
        payment_request: 'lnbcrt' + 'c'.repeat(30),
        htlcs: invoiceState === 'ACCEPTED' ? [{ state: 'ACCEPTED', expiration_height: 210,
          amt_msat: String(initial.quote.invoiceSats * 1000) }] : [] });
      const ports: SwapPorts = { assertRegtest: async () => {}, invoice: async () => invoice(),
        createInvoice: async () => { throw new Error('guest execution cannot create invoices'); },
        prepareLockup: async () => { fundCalls++; return { txid: lockup.getId(), hex: lockup.toHex(), vout: 0 }; },
        broadcast: async hex => { broadcastCalls++; ledger.set(lockup.getId(), { hex: lockup.toHex(), confirmations: 0 });
          return Transaction.fromHex(hex).getId(); },
        settle: async () => { settleCalls++; invoiceState = 'SETTLED'; },
        cancel: async () => {}, tip: async () => 100,
        confirmed: async txid => ledger.get(txid) ?? { hex: '', confirmations: 0 } };
      const execution = controlledGuestExecution(() => ports);
      let current = await execution.fund(run, initial, plan);
      assert.equal(current.state, 'LOCKUP_BROADCAST'); assert.equal(fundCalls, 1); assert.equal(broadcastCalls, 1);
      ledger.set(lockup.getId(), { hex: lockup.toHex(), confirmations: 1 });
      current = await execution.confirm(run, current, plan); assert.equal(current.state, 'LOCKUP_CONFIRMED');
      await run.transaction(db => { const value = db.swaps[current.id]!; value.claimTxid = claim.getId();
        value.clientClaimIntent = { txid: claim.getId(), destination: x.f.destination, feeSats: value.quote.claimFeeSats, status: 'BROADCAST' };
        value.revision++; });
      current = run.read().swaps[current.id]!; ledger.set(claim.getId(), { hex: claim.toHex(), confirmations: 1 });
      current = await execution.settle(run, current, plan, claim.getId());
      assert.equal(current.state, 'LIGHTNING_SETTLED'); assert.equal(settleCalls, 1);
      current = await execution.markPaid(run, current, invoice()); assert.equal(current.clientPayment?.status, 'SUCCEEDED');
      current = await execution.complete(run, current, plan); assert.equal(current.state, 'COMPLETED');
      current = await execution.complete(run, current, plan); assert.equal(current.state, 'COMPLETED');
    } finally { await run.close(); }
  } finally { await x.cleanup(); }
});
