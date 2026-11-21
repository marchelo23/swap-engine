import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { Transaction } from 'bitcoinjs-lib';
import { setup, routingFixture } from './helpers.js';
import { SwapCoordinator } from '../src/core/SwapCoordinator.js';
import { Store } from '../src/persistence/Store.js';
import { createReverseTestPlan } from '../src/core/ReverseTestPlan.js';
import { createControlledReverseBackend, controlledRunDigest, type ControlledRunApproval,
  type ControlledRunReadiness, type ControlledRunRuntime } from '../src/core/ControlledReverseBackend.js';
import { createClaim } from '../src/bitcoin/ClaimManager.js';
import type { PaymentEvidence } from '../src/core/ReverseTestRunner.js';
import { updateSwapRevision } from '../src/core/SwapStateMachine.js';

// All ledgers, readiness/custody evidence, payer actions and mining are offline fakes.
// Synthetic signatures supplement tests; these fixtures do not establish Core consensus.
async function fixture() {
  const f = await setup(); let store = f.store; let tip = 100; let held = false;
  const invoice = 'lnbcrt' + 'a'.repeat(30);
  const lookup = f.ports.invoice;
  f.ports.invoice = async hash => ({ ...await lookup(hash), payment_request: invoice,
    ...(held ? {} : { state: 'OPEN' as const, amt_paid_sat: '0', htlcs: [] }) });
  f.ports.createInvoice = async () => invoice; f.ports.tip = async () => tip;
  await new SwapCoordinator(store, f.ports).issueInvoice(f.swap.id);
  const plan = createReverseTestPlan(f.quote, tip, { paymentHash: f.contract.paymentHash, claimPublicKey: f.contract.claimPublicKey },
    f.contract.refundPublicKey, { claim: f.destination, refund: f.destination },
    { provider: f.contract.claimPublicKey, payer: f.contract.refundPublicKey }, routingFixture());
  const input = { txid: 'ab'.repeat(32), vout: 0 };
  const isolationId = randomUUID();
  const approval: ControlledRunApproval = { id: randomUUID(), swapId: f.swap.id,
    expectedRevision: store.read().swaps[f.swap.id]!.revision, isolationId,
    planDigest: controlledRunDigest(plan, input, f.swap.id, isolationId), scope: 'isolated-regtest-reverse',
    expiresAt: Date.now() + 60000, maxBlocks: 2 };
  let ready: ControlledRunReadiness = { network: 'regtest', isolationId,
    providerNode: plan.providerNode, payerNode: plan.payerNode, tipHeight: tip,
    claimPublicKey: plan.contract.claimPublicKey, refundPublicKey: plan.contract.refundPublicKey, paymentHash: plan.contract.paymentHash,
    funding: { ...input, valueSats: 100000, confirmed: true, safe: true, spendable: true },
    decodedInvoice: { destination: plan.providerNode, payment_hash: plan.contract.paymentHash, num_satoshis: '50750',
      num_msat: '50750000', timestamp: String(Math.floor(Date.now() / 1000)), expiry: '3600', cltv_expiry: '80' } };
  const calls = { inspect: 0, start: 0, stop: 0, mine: 0, claim: 0 };
  let resolvePayment!: (evidence: PaymentEvidence) => void;
  const payment = new Promise<PaymentEvidence>(resolve => { resolvePayment = resolve; });
  const settle = f.ports.settle;
  f.ports.settle = async secret => { await settle(secret);
    resolvePayment({ hash: f.contract.paymentHash, status: 'SUCCEEDED', valueSats: 50750, feeSats: 0 }); };
  const runtime: ControlledRunRuntime = { ports: f.ports,
    inspect: async () => { calls.inspect++; return structuredClone(ready); },
    mineOne: async txid => { calls.mine++; tip++; f.ledger.get(txid)!.confirmations = 1; },
    controls: { claimDestination: f.destination,
      startPayment: async () => {
        const disk = JSON.parse(await readFile(join(f.directory, 'state.json'), 'utf8'));
        assert.equal(disk.controlledExecutions[approval.id].status, 'INTENT');
        assert.equal(disk.swaps[f.swap.id].clientPayment.status, 'INTENT');
        calls.start++; held = true; return { result: payment, stopClient: () => { calls.stop++; } };
      },
      waitAccepted: async () => {}, signClaim: async () => createClaim(f.spend, f.preimage),
      broadcastClaim: async raw => { calls.claim++; const tx = Transaction.fromHex(raw);
        f.ledger.set(tx.getId(), { hex: raw, confirmations: 0 }); return tx.getId(); },
      findClaim: async swap => swap.clientClaimIntent!.txid,
    } };
  const backend = (authorized: ControlledRunApproval | undefined = approval) => createControlledReverseBackend(store, plan, input, runtime, authorized);
  return { f, plan, input, approval, calls, runtime, backend,
    get store() { return store; }, setReady: (patch: Partial<ControlledRunReadiness>) => { ready = { ...ready, ...patch }; },
    getReady: () => structuredClone(ready), setTip: (height: number) => { tip = height; },
    reopen: async () => { await store.close(); store = await Store.open(f.directory); },
    cleanup: async () => { await store.close(); await rm(f.directory, { recursive: true }); } };
}

test('local backend requires exact current authorization before inspecting nodes or recording any intent', async () => {
  const x = await fixture();
  try {
    for (const approval of [null, { ...x.approval, planDigest: '00'.repeat(32) },
      { ...x.approval, expiresAt: Date.now() - 1 }, { ...x.approval, swapId: randomUUID() },
      { ...x.approval, expectedRevision: x.approval.expectedRevision + 1 }]) {
      const backend = createControlledReverseBackend(x.store, x.plan, x.input, x.runtime, approval ?? undefined);
      await assert.rejects(backend.execute(x.f.swap.id, x.approval.expectedRevision), /authorization required/);
    }
    assert.equal(x.calls.inspect, 0); assert.equal(x.calls.start, 0);
    assert.equal(x.store.read().controlledExecutions, undefined);
    assert.throws(() => createControlledReverseBackend(x.store, { ...x.plan, quote: { ...x.plan.quote, claimFeeSats: 501 } },
      x.input, x.runtime, x.approval));
  } finally { await x.cleanup(); }
});

test('identity, custody, funding, CLTV, invoice and destination failures cannot reach payer execution', async () => {
  const cases: Array<(x: Awaited<ReturnType<typeof fixture>>) => void> = [
    x => x.setReady({ providerNode: x.plan.payerNode }), x => x.setReady({ payerNode: x.plan.providerNode }),
    x => x.setReady({ isolationId: randomUUID() }), x => x.setReady({ network: 'mainnet' as 'regtest' }),
    x => x.setReady({ paymentHash: '00'.repeat(32) }), x => x.setReady({ refundPublicKey: x.plan.contract.claimPublicKey }),
    x => x.setReady({ claimPublicKey: x.plan.contract.refundPublicKey }), x => x.setReady({ tipHeight: 121 }),
    x => x.setReady({ funding: { ...x.getReady().funding, spendable: false } }),
    x => x.setReady({ funding: { ...x.getReady().funding, confirmed: false } }),
    x => x.setReady({ funding: { ...x.getReady().funding, vout: 1 } }),
    x => x.setReady({ decodedInvoice: { ...(x.getReady().decodedInvoice as object), num_msat: '50750001' } }),
    x => { x.runtime.controls.claimDestination = 'another-destination'; },
  ];
  for (const change of cases) {
    const x = await fixture();
    try {
      change(x); await assert.rejects(x.backend().execute(x.f.swap.id, x.approval.expectedRevision));
      assert.equal(x.calls.start, 0); assert.equal(x.f.calls.funding, 0);
      assert.equal(x.store.read().controlledExecutions, undefined);
    } finally { await x.cleanup(); }
  }
});

test('authorized offline backend completes through the existing runner with durable one-shot and two-block budget', async () => {
  const x = await fixture();
  try {
    const result = await x.backend().execute(x.f.swap.id, x.approval.expectedRevision);
    assert.deepEqual(Object.keys(result).sort(), ['id', 'revision', 'state']);
    assert.equal(result.state, 'COMPLETED'); assert.equal(x.calls.start, 1);
    assert.equal(x.calls.mine, 2); assert.equal(x.f.calls.settle, 1);
    const record = x.store.read().controlledExecutions![x.approval.id]!;
    assert.equal(record.status, 'COMPLETED'); assert.equal(record.blocksRequested, 2);
    assert.equal((await readFile(join(x.f.directory, 'state.json'), 'utf8')).includes(x.f.preimage), false);
    await assert.rejects(x.backend().execute(x.f.swap.id, x.approval.expectedRevision), /reconciliation/);
    assert.equal(x.calls.start, 1); assert.equal(x.calls.mine, 2);
  } finally { await x.cleanup(); }
});

test('concurrent backend requests can reserve only one execution and cannot pay twice', async () => {
  const x = await fixture();
  try {
    const result = await Promise.allSettled([x.backend(), x.backend()].map(backend => backend.execute(x.f.swap.id, x.approval.expectedRevision)));
    assert.equal(result.filter(r => r.status === 'fulfilled').length, 1);
    assert.equal(x.calls.start, 1); assert.equal(x.f.calls.funding, 1);
    assert.equal(Object.keys(x.store.read().controlledExecutions!).length, 1);
  } finally { await x.cleanup(); }
});

test('lost payer or mining outcomes survive restart and cannot replay execution or unused mining budget', async () => {
  for (const point of ['payer', 'mine', 'excess blocks'] as const) {
    const x = await fixture();
    try {
      if (point === 'payer') x.runtime.controls.startPayment = async () => { x.calls.start++; throw new Error('Unknown payer outcome'); };
      if (point === 'mine') x.runtime.mineOne = async () => { x.calls.mine++; throw new Error('Unknown mining outcome'); };
      if (point === 'excess blocks') x.runtime.mineOne = async () => { x.calls.mine++; x.setTip(102); };
      await assert.rejects(x.backend().execute(x.f.swap.id, x.approval.expectedRevision), /uncertain/);
      const record = x.store.read().controlledExecutions![x.approval.id]!;
      assert.equal(record.status, 'UNKNOWN'); assert.equal(record.blocksRequested, point === 'payer' ? 0 : 1);
      const calls = { ...x.calls };
      await x.reopen(); await new SwapCoordinator(x.store, x.f.ports).recover();
      assert.equal(x.store.read().swaps[x.f.swap.id]!.state, 'MANUAL_REVIEW');
      await assert.rejects(x.backend().execute(x.f.swap.id, x.approval.expectedRevision), /reconciliation/);
      assert.deepEqual(x.calls, calls);
      assert.equal(x.f.calls.settle, 0);
    } finally { await x.cleanup(); }
  }
});

test('crash between execution reservation and payment leaves a durable recovery barrier', async () => {
  const x = await fixture();
  try {
    let checks = 0;
    x.f.ports.assertRegtest = async () => { if (++checks === 2) throw new Error('Readiness lost before payment'); };
    await assert.rejects(x.backend().execute(x.f.swap.id, x.approval.expectedRevision), /uncertain/);
    assert.equal(x.calls.start, 0); assert.equal(x.store.read().swaps[x.f.swap.id]!.clientPayment, undefined);
    await x.reopen(); await new SwapCoordinator(x.store, x.f.ports).recover();
    assert.equal(x.store.read().swaps[x.f.swap.id]!.state, 'MANUAL_REVIEW');
    await assert.rejects(x.backend().execute(x.f.swap.id, x.approval.expectedRevision));
    assert.equal(x.calls.start, 0);
  } finally { await x.cleanup(); }
});

test('readiness cannot reserve a journal changed by another actor or a second active swap', async () => {
  for (const point of ['journal', 'another swap'] as const) {
    const x = await fixture();
    try {
      const inspect = x.runtime.inspect;
      x.runtime.inspect = async (plan, input) => {
        if (point === 'journal') await updateSwapRevision(x.store, x.f.swap.id, x.approval.expectedRevision, s => { s.clientPayment = {
          hash: s.contract.paymentHash, status: 'UNKNOWN', feeLimitSats: 100 }; });
        else await x.store.transaction(db => { const other = structuredClone(db.swaps[x.f.swap.id]!); other.id = randomUUID(); db.swaps[other.id] = other; });
        return inspect(plan, input);
      };
      await assert.rejects(x.backend().execute(x.f.swap.id, x.approval.expectedRevision));
      assert.equal(x.calls.start, 0); assert.equal(x.store.read().controlledExecutions, undefined);
    } finally { await x.cleanup(); }
  }
});
