import { randomBytes, randomUUID } from 'node:crypto';
import { readFile, rm } from 'node:fs/promises';
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
import { constructSpend, createClaim } from '../src/bitcoin/ClaimManager.js';
import { Store } from '../src/persistence/Store.js';
import { updateSwapRevision } from '../src/core/SwapStateMachine.js';
import type { Invoice } from '../src/lightning/LndClient.js';

const GUEST_INVOICE_SATS = 50000;

async function fixture(options: { withExecution?: boolean } = {}) {
  const f = await setup(); const runsDirectory = await privateTestDirectory('guest-watch-runs'); const routing = routingFixture();
  let invoiceState: Invoice['state'] = 'OPEN'; let calls = 0; let tip = 100; let lookupFails = false; let lockCalls = 0; let now = 1000;
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
      lookup: async () => { if (lookupFails) throw new Error('synthetic invoice RPC unavailable');
        return { status: 'PRESENT' as const, invoice: invoice() }; } },
    tip: async () => tip, now: () => now,
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
      { claim: spec.claimDestination, refund: spec.refundDestination }, { provider: spec.providerNode, payer: spec.payerNode }, spec.routing, spec.wallet);
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
  const policy = { mode: 'regtest' as const, wallet: 'guest-test-wallet', isolationId: randomUUID(), providerNode: '02' + '11'.repeat(32),
    payerNode: '03' + '22'.repeat(32), routing, refundPublicKey: f.contract.refundPublicKey,
    refundDestination: f.destination, funding: { txid: 'ab'.repeat(32), vout: 0, valueSats: 100000 }, runsDirectory };
  const service = new GuestReverse(f.store, policy, clients, { preparation,
    broadcast: async hex => Transaction.fromHex(hex).getId(), pauseFile: join(runsDirectory, 'pause.json'),
    lock: async work => { lockCalls++; return work(); }, execution: options.withExecution ? execution : undefined });
  const token = randomBytes(32).toString('base64url'); const auth = `Bearer ${token}`;
  const quote = await service.quote(auth, 'guest-quote-key', { destination: f.destination, amountSats: GUEST_INVOICE_SATS,
    paymentHash: f.contract.paymentHash, claimPublicKey: f.contract.claimPublicKey });
  return { f, service, quote, auth, token, runsDirectory, ledger, actions, pauseFile: join(runsDirectory, 'pause.json'),
    setTip: (value: number) => { tip = value; }, setLookupFails: (value: boolean) => { lookupFails = value; },
    setNow: (value: number) => { now = value; },
    lockCalls: () => lockCalls,
    prepare: (key = 'guest-prepare-key') => service.prepare(quote.id, auth, key, { recoveryCommitment: 'ab'.repeat(32) }),
    setInvoice: (state: Invoice['state']) => { invoiceState = state; }, calls: () => calls,
    cleanup: async () => { await f.cleanup(); await rm(runsDirectory, { recursive: true, force: true }); } };
}

test('expired uncertain preparation releases its input only after unpaid cancellation is observed', async () => {
  const x = await fixture({ withExecution: true });
  try {
    await x.prepare();
    await x.f.store.transaction(db => {
      const row = db.guestSwaps![x.quote.id]!;
      row.swapId = undefined;
      row.status = 'PREPARATION_UNKNOWN';
      delete row.funding; // Older records only retained the reservation.
    });
    x.setNow(x.quote.expiresAt + 1);
    await x.service.runOnce();
    assert.equal(x.f.store.read().guestSwaps![x.quote.id]!.status, 'PREPARATION_UNKNOWN');
    assert.equal(Object.values(x.f.store.read().guestFundingReservations!)[0]!.status, 'RESERVED');
    x.setInvoice('CANCELED');
    await x.service.runOnce();
    assert.equal(x.f.store.read().guestSwaps![x.quote.id]!.status, 'EXPIRED');
    assert.equal(Object.values(x.f.store.read().guestFundingReservations!)[0]!.status, 'RELEASED');
    assert.deepEqual(x.actions, []);
    await assert.rejects(readFile(x.pauseFile), { code: 'ENOENT' });
  } finally { await x.cleanup(); }
});

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

test('recovery reconciles an ambiguous funding broadcast from the exact confirmed lockup', async () => {
  const x = await fixture({ withExecution: true }); try {
    const seeded = await seedLockup(x, { claim: true });
    const run = await Store.open(join(x.runsDirectory, x.quote.id));
    try {
      await run.transaction(db => {
        const swap = db.swaps[seeded.swapId]!; const lockup = swap.lockup!;
        swap.fundingIntent = { txid: 'ab'.repeat(32), vout: 0, valueSats: 100000, scriptPubKey: '00',
          changeAddress: x.f.destination, principalSats: swap.quote.amountSats, maxFeeSats: 1000,
          signedHex: lockup.hex, fundingTxid: lockup.txid, fundingVout: lockup.vout };
        delete swap.lockup; delete swap.claimTxid; delete swap.clientClaimIntent;
        swap.state = 'MANUAL_REVIEW'; swap.pendingAction = 'BROADCAST_LOCKUP'; swap.revision++;
      });
    } finally { await run.close(); }
    x.ledger.set(seeded.lockup.getId(), { hex: seeded.lockup.toHex(), confirmations: 1 });
    await x.service.runOnce();
    const after = await Store.open(join(x.runsDirectory, x.quote.id));
    try { const swap = after.read().swaps[seeded.swapId]!;
      assert.equal(swap.state, 'LOCKUP_CONFIRMED'); assert.equal(swap.lockup?.txid, seeded.lockup.getId()); }
    finally { await after.close(); }
    assert.equal(x.actions.includes('fund') || x.actions.includes('settle'), false);
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

test('confirmed lockup with a lost broadcast reply clears BROADCAST_LOCKUP without rebroadcast', async () => {
  const x = await fixture({ withExecution: true }); try {
    const seeded = await seedLockup(x, { pending: 'BROADCAST_LOCKUP' });
    x.ledger.set(seeded.lockup.getId(), { hex: seeded.lockup.toHex(), confirmations: 1 });
    await x.service.runOnce();
    const run = await Store.open(join(x.runsDirectory, x.quote.id));
    try {
      const swap = run.read().swaps[seeded.swapId]!;
      assert.equal(swap.pendingAction, undefined); assert.equal(swap.state, 'LOCKUP_CONFIRMED');
      assert.equal(swap.lockup?.txid, seeded.lockup.getId());
    } finally { await run.close(); }
    assert.deepEqual(x.actions, []);
  } finally { await x.cleanup(); }
});

test('restart after markPaid completes without repeating the settlement acknowledgement', async () => {
  const x = await fixture({ withExecution: true }); try {
    const seeded = await seedLockup(x, { claim: true }); x.setInvoice('SETTLED');
    const run = await Store.open(join(x.runsDirectory, x.quote.id));
    try {
      await run.transaction(db => { const swap = db.swaps[seeded.swapId]!;
        swap.state = 'LIGHTNING_SETTLED'; swap.clientPayment = { hash: swap.contract.paymentHash, status: 'SUCCEEDED', feeLimitSats: 0 };
        swap.revision++; });
    } finally { await run.close(); }
    await x.service.runOnce();
    assert.deepEqual(x.actions, ['complete']);
    const after = await Store.open(join(x.runsDirectory, x.quote.id));
    try { assert.equal(after.read().swaps[seeded.swapId]!.state, 'COMPLETED'); } finally { await after.close(); }
  } finally { await x.cleanup(); }
});

test('recovery never treats a refund or malformed spend as the guest claim', async () => {
  const x = await fixture({ withExecution: true }); try {
    const seeded = await seedLockup(x);
    const refund = constructSpend({ contract: x.f.contract, lockupTxHex: seeded.lockup.toHex(), vout: 0,
      destination: x.f.destination, feeSats: 500, privateKey: x.f.refundKey.privateKey! }, 'refund');
    x.ledger.set(refund.getId(), { hex: refund.toHex(), confirmations: 1 });
    const run = await Store.open(join(x.runsDirectory, x.quote.id));
    try {
      await run.transaction(db => { const swap = db.swaps[seeded.swapId]!;
        swap.claimTxid = refund.getId(); swap.state = 'MANUAL_REVIEW'; swap.revision++; });
    } finally { await run.close(); }
    x.setInvoice('SETTLED');
    await x.service.runOnce();
    assert.deepEqual(x.actions, []);
    const after = await Store.open(join(x.runsDirectory, x.quote.id));
    try { assert.equal(after.read().swaps[seeded.swapId]!.state, 'MANUAL_REVIEW'); } finally { await after.close(); }
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
      let invoiceState: Invoice['state'] = 'ACCEPTED'; let fundCalls = 0; let broadcastCalls = 0; let settleCalls = 0; let lockCalls = 0;
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
      const execution = controlledGuestExecution(() => ports, { lock: async work => { lockCalls++; return work(); } });
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
      assert.ok(lockCalls >= 3);
    } finally { await run.close(); }
  } finally { await x.cleanup(); }
});

test('multiple pending swaps update one durable timer pause and terminal swaps release it', async () => {
  const x = await fixture(); try {
    await x.prepare('prepare-1');
    await x.f.store.transaction(db => { for (const reservation of Object.values(db.guestFundingReservations ?? {})) reservation.status = 'RELEASED'; });
    x.setTip(105);
    const token2 = randomBytes(32).toString('base64url'); const auth2 = `Bearer ${token2}`;
    const quote2 = await x.service.quote(auth2, 'guest-quote-key-2', {
      destination: x.f.destination, amountSats: GUEST_INVOICE_SATS,
      paymentHash: x.f.contract.paymentHash, claimPublicKey: x.f.contract.claimPublicKey });
    await x.service.prepare(quote2.id, auth2, 'prepare-2', { recoveryCommitment: 'cd'.repeat(32) });
    x.setInvoice('ACCEPTED');
    await x.service.reconcile();
    const paused = JSON.parse(await readFile(x.pauseFile, 'utf8')) as any;
    assert.equal(Object.keys(paused.activeSwapPolicy.swaps).length, 2);
    assert.match(paused.reason, /active-swap_2_earliest_130/);
    const records = Object.values(paused.activeSwapPolicy.swaps) as any[];
    const first = records.find(record => record.timeoutHeight === 130)!;
    const second = records.find(record => record.timeoutHeight === 135)!;
    const firstRun = await Store.open(join(x.runsDirectory, x.quote.id));
    try { await firstRun.transaction(db => { db.swaps[first.id]!.state = 'COMPLETED'; db.swaps[first.id]!.revision++; }); }
    finally { await firstRun.close(); }
    await x.service.reconcile();
    const after = JSON.parse(await readFile(x.pauseFile, 'utf8')) as any;
    assert.deepEqual(Object.keys(after.activeSwapPolicy.swaps), [second.id]);
    assert.match(after.reason, /earliest_135/);
    const secondRun = await Store.open(join(x.runsDirectory, quote2.id));
    try { await secondRun.transaction(db => { db.swaps[second.id]!.state = 'COMPLETED'; db.swaps[second.id]!.revision++; }); }
    finally { await secondRun.close(); }
    await x.service.refreshMiningPause();
    await assert.rejects(readFile(x.pauseFile), { code: 'ENOENT' });
  } finally { await x.cleanup(); }
});

test('RPC-unavailable reconciliation keeps a conservative pause marker and performs no actions', async () => {
  const x = await fixture({ withExecution: true }); try {
    await seedLockup(x, { claim: true });
    x.setLookupFails(true);
    await x.service.reconcile();
    const paused = JSON.parse(await readFile(x.pauseFile, 'utf8')) as any;
    const entries = Object.values(paused.activeSwapPolicy.swaps) as any[];
    assert.ok(entries.some(entry => entry.state === 'UNKNOWN' || entry.state === 'LOCKUP_CONFIRMED' || entry.state === 'CLAIM_DETECTED'));
    assert.deepEqual(x.actions, []);
  } finally { await x.cleanup(); }
});

test('a confirmed claim is not settled after the accepted LN HTLC deadline', async () => {
  const x = await fixture({ withExecution: true }); try {
    const seeded = await seedLockup(x, { claim: true }); x.setTip(205);
    await x.service.runOnce();
    assert.equal(x.actions.includes('settle'), false);
    const run = await Store.open(join(x.runsDirectory, x.quote.id));
    try { assert.equal(run.read().swaps[seeded.swapId]!.state, 'MANUAL_REVIEW'); } finally { await run.close(); }
  } finally { await x.cleanup(); }
});

test('evidence-only recovery settles a confirmed ambiguous claim without rebroadcast', async () => {
  const x = await fixture({ withExecution: true }); try {
    const seeded = await seedLockup(x, { claim: true });
    const run = await Store.open(join(x.runsDirectory, x.quote.id));
    try { await run.transaction(db => { const swap = db.swaps[seeded.swapId]!;
      swap.state = 'MANUAL_REVIEW'; swap.clientClaimIntent!.status = 'UNKNOWN'; swap.revision++; }); }
    finally { await run.close(); }
    await x.service.runOnce();
    assert.ok(x.actions.includes('settle'));
    const status = await x.service.status(x.quote.id, x.auth) as any;
    assert.notEqual(status.status, 'COMPLETED');
  } finally { await x.cleanup(); }
});

test('recovery completes an already-settled invoice with a confirmed exact claim', async () => {
  const x = await fixture({ withExecution: true }); try {
    const seeded = await seedLockup(x, { claim: true });
    const run = await Store.open(join(x.runsDirectory, x.quote.id));
    try { await run.transaction(db => { const swap = db.swaps[seeded.swapId]!; swap.state = 'MANUAL_REVIEW'; swap.revision++; }); }
    finally { await run.close(); }
    x.setInvoice('SETTLED');
    await x.service.runOnce();
    assert.ok(x.actions.includes('markPaid')); assert.ok(x.actions.includes('complete'));
    const status = await x.service.status(x.quote.id, x.auth) as any;
    assert.equal(status.status, 'COMPLETED');
  } finally { await x.cleanup(); }
});
