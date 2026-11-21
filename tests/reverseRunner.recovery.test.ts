import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Transaction, address, networks, payments } from 'bitcoinjs-lib';
import { setup } from './helpers.js';
import { SwapCoordinator } from '../src/core/SwapCoordinator.js';
import { runControlledReverse, type ReverseTestControls, type PaymentEvidence } from '../src/core/ReverseTestRunner.js';
import { createClaim } from '../src/bitcoin/ClaimManager.js';
import type { Invoice } from '../src/lightning/LndClient.js';
import type { Swap } from '../src/core/SwapTypes.js';
import { transition, updateSwapRevision } from '../src/core/SwapStateMachine.js';

type StartHandle = { result: Promise<PaymentEvidence>; stopClient(): void };
type RunnerOptions = {
  startPayment?(swap: Swap): Promise<StartHandle>;
  waitAccepted?(swap: Swap): Promise<void>;
  signClaim?(swap: Swap): Promise<Transaction>;
  broadcastClaim?(hex: string): Promise<string>;
  findClaim?(swap: Swap): Promise<string>;
};

async function runnerFixture(options: RunnerOptions = {}) {
  const f = await setup();
  await new SwapCoordinator(f.store, f.ports).issueInvoice(f.swap.id);
  const lookup = f.ports.invoice;
  let beforePayment = true;
  let invoiceTransform: (invoice: Invoice) => Invoice = invoice => invoice;
  f.ports.invoice = async hash => {
    const invoice: Invoice = beforePayment
      ? { ...(await lookup(hash)), state: 'OPEN', amt_paid_sat: '0', htlcs: [] }
      : await lookup(hash);
    return invoiceTransform(invoice);
  };
  const counters = { started: 0, stopped: 0, mined: 0, claimBroadcasts: 0, settles: 0 };
  let evidence: PaymentEvidence = {
    hash: f.contract.paymentHash, status: 'SUCCEEDED', valueSats: f.quote.invoiceSats, feeSats: 0,
  };
  let resolvePayment!: (value: PaymentEvidence) => void;
  const payment = new Promise<PaymentEvidence>(resolve => { resolvePayment = resolve; });
  const settle = f.ports.settle;
  f.ports.settle = async preimage => {
    const result = await settle(preimage);
    counters.settles++;
    resolvePayment({ ...evidence });
    return result;
  };
  const controls: ReverseTestControls = {
    claimDestination: f.destination,
    startPayment: async swap => {
      counters.started++;
      beforePayment = false;
      const handle = options.startPayment
        ? await options.startPayment(swap)
        : { result: payment, stopClient: () => {} };
      return { result: handle.result, stopClient: () => { counters.stopped++; handle.stopClient(); } };
    },
    waitAccepted: async swap => { if (options.waitAccepted) await options.waitAccepted(swap); },
    mineFor: async txid => {
      counters.mined++;
      const entry = f.ledger.get(txid);
      assert.ok(entry, `missing ledger entry for ${txid}`);
      entry.confirmations = 1;
    },
    signClaim: async swap => options.signClaim ? options.signClaim(swap) : createClaim(f.spend, f.preimage),
    broadcastClaim: async hex => {
      counters.claimBroadcasts++;
      if (options.broadcastClaim) return options.broadcastClaim(hex);
      const tx = Transaction.fromHex(hex);
      assert.equal(f.store.read().swaps[f.swap.id]!.clientClaimIntent!.txid, tx.getId());
      f.ledger.set(tx.getId(), { hex, confirmations: 0 });
      return tx.getId();
    },
    findClaim: async swap => options.findClaim
      ? options.findClaim(swap)
      : f.store.read().swaps[f.swap.id]!.clientClaimIntent!.txid,
  };
  return {
    f, controls, counters,
    setInvoiceTransform: (fn: (invoice: Invoice) => Invoice) => { invoiceTransform = fn; },
    setEvidence: (patch: Partial<PaymentEvidence>) => { evidence = { ...evidence, ...patch }; },
  };
}

test('two runners racing before payment intent start at most one payer', async () => {
  const x = await runnerFixture({ waitAccepted: async () => { throw new Error('stop after payer admission'); } });
  try {
    const invoice = x.f.ports.invoice;
    let arrivals = 0;
    let release!: () => void;
    const barrier = new Promise<void>(resolve => { release = resolve; });
    x.f.ports.invoice = async hash => {
      const value = await invoice(hash);
      if (++arrivals === 2) release();
      await barrier;
      return value;
    };
    const outcomes = await Promise.allSettled([
      runControlledReverse(x.f.store, x.f.ports, x.controls, x.f.swap.id),
      runControlledReverse(x.f.store, x.f.ports, x.controls, x.f.swap.id),
    ]);
    assert.equal(arrivals, 2);
    assert.equal(outcomes.filter(result => result.status === 'rejected').length, 2);
    assert.equal(x.counters.started, 1);
    assert.equal(x.f.calls.funding, 0);
    assert.equal(x.f.store.read().swaps[x.f.swap.id]!.clientPayment?.status, 'UNKNOWN');
  } finally { await x.f.cleanup(); }
});

test('runner refuses canceled, expired, substituted, overpaid and already-held invoices before any payer or funding action', async () => {
  const cases: Array<{ name: string; change: (invoice: Invoice) => Invoice }> = [
    { name: 'canceled', change: invoice => ({ ...invoice, state: 'CANCELED' }) },
    { name: 'expired', change: invoice => ({ ...invoice, state: 'EXPIRED' as unknown as Invoice['state'] }) },
    { name: 'substituted payment request', change: invoice => ({ ...invoice, payment_request: 'substituted-invoice' }) },
    { name: 'substituted hash', change: invoice => ({ ...invoice, r_hash: Buffer.alloc(32).toString('base64') }) },
    { name: 'wrong value', change: invoice => ({ ...invoice, value: String(Number(invoice.value) + 1) }) },
    { name: 'partially paid', change: invoice => ({ ...invoice, amt_paid_sat: '1' }) },
    { name: 'accepted htlc', change: invoice => ({ ...invoice, htlcs: [{ state: 'ACCEPTED', expiration_height: 210, amt_msat: String(Number(invoice.value) * 1000) }] }) },
    { name: 'settled htlc', change: invoice => ({ ...invoice, htlcs: [{ state: 'SETTLED', expiration_height: 210, amt_msat: String(Number(invoice.value) * 1000) }] }) },
  ];
  for (const { name, change } of cases) {
    const x = await runnerFixture();
    try {
      x.setInvoiceTransform(change);
      await assert.rejects(runControlledReverse(x.f.store, x.f.ports, x.controls, x.f.swap.id), /unpaid open/, name);
      const swap = x.f.manager.get(x.f.swap.id)!;
      assert.equal(x.counters.started, 0, name);
      assert.equal(x.f.calls.funding, 0, name);
      assert.equal(swap.clientPayment, undefined, name);
      assert.equal(swap.clientClaimIntent, undefined, name);
      assert.equal(swap.state, 'INVOICE_CREATED', name);
    } finally { await x.f.cleanup(); }
  }
});

test('payer evidence hash, value and fee mismatches stop the client and never complete', async () => {
  const cases: Array<{ name: string; patch: Partial<PaymentEvidence> }> = [
    { name: 'hash mismatch', patch: { hash: '00'.repeat(32) } },
    { name: 'value mismatch', patch: { valueSats: 1 } },
    { name: 'fee above limit', patch: { feeSats: 101 } },
    { name: 'negative fee', patch: { feeSats: -1 } },
  ];
  for (const { name, patch } of cases) {
    const x = await runnerFixture();
    try {
      x.setEvidence(patch);
      await assert.rejects(runControlledReverse(x.f.store, x.f.ports, x.controls, x.f.swap.id), /Payer completion/, name);
      const swap = x.f.manager.get(x.f.swap.id)!;
      assert.equal(swap.state, 'MANUAL_REVIEW', name);
      assert.equal(swap.clientPayment!.status, 'UNKNOWN', name);
      assert.equal(swap.clientClaimIntent!.status, 'BROADCAST', name);
      assert.equal(x.counters.stopped, 1, name);
      assert.equal(x.counters.settles, 1, name);
      assert.equal(x.counters.claimBroadcasts, 1, name);
    } finally { await x.f.cleanup(); }
  }
});

test('claim fee or destination substitution is rejected before broadcast and settlement', async () => {
  const cases: Array<{ name: string; sign: (x: Awaited<ReturnType<typeof runnerFixture>>) => Transaction }> = [
    {
      name: 'fee substitution',
      sign: x => createClaim({ ...x.f.spend, feeSats: x.f.quote.claimFeeSats + 1 }, x.f.preimage),
    },
    {
      name: 'destination substitution',
      sign: x => createClaim({
        ...x.f.spend,
        destination: payments.p2wpkh({ pubkey: x.f.refundKey.publicKey, network: networks.regtest }).address!,
      }, x.f.preimage),
    },
  ];
  for (const { name, sign } of cases) {
    const x = await runnerFixture();
    try {
      x.controls.signClaim = async () => sign(x);
      await assert.rejects(runControlledReverse(x.f.store, x.f.ports, x.controls, x.f.swap.id), /destination or fee/, name);
      const swap = x.f.manager.get(x.f.swap.id)!;
      assert.equal(swap.state, 'MANUAL_REVIEW', name);
      assert.equal(swap.clientClaimIntent, undefined, name);
      assert.equal(x.counters.claimBroadcasts, 0, name);
      assert.equal(x.counters.settles, 0, name);
      assert.equal(x.counters.mined, 1, name);
    } finally { await x.f.cleanup(); }
  }
});

test('unknown startPayment RPC outcome leaves an UNKNOWN durable payment and blocks a second attempt', async () => {
  const x = await runnerFixture({
    startPayment: async () => { throw new Error('Payer start RPC reply lost'); },
  });
  try {
    await assert.rejects(runControlledReverse(x.f.store, x.f.ports, x.controls, x.f.swap.id), /Payer start RPC reply lost/);
    const swap = x.f.manager.get(x.f.swap.id)!;
    assert.equal(swap.state, 'MANUAL_REVIEW');
    assert.equal(swap.clientPayment!.status, 'UNKNOWN');
    assert.equal(swap.pendingAction, undefined);
    assert.equal(swap.lockup, undefined);
    assert.equal(x.counters.started, 1);
    assert.equal(x.counters.stopped, 0);
    assert.equal(x.f.calls.funding, 0);
    await assert.rejects(runControlledReverse(x.f.store, x.f.ports, x.controls, x.f.swap.id), /reconcile/);
    assert.equal(x.counters.started, 1);
    assert.equal(x.f.calls.funding, 0);
  } finally { await x.f.cleanup(); }
});

test('unknown payer result outcome stops the client before any funding or claim action', async () => {
  const x = await runnerFixture({
    startPayment: async () => ({
      result: Promise.reject(new Error('Payer result RPC reply lost')), stopClient: () => {},
    }),
  });
  try {
    await assert.rejects(runControlledReverse(x.f.store, x.f.ports, x.controls, x.f.swap.id), /Payer outcome uncertain/);
    const swap = x.f.manager.get(x.f.swap.id)!;
    assert.equal(swap.state, 'MANUAL_REVIEW');
    assert.equal(swap.clientPayment!.status, 'UNKNOWN');
    assert.equal(swap.clientClaimIntent, undefined);
    assert.equal(x.counters.stopped, 1);
    assert.equal(x.counters.settles, 0);
    assert.equal(x.counters.claimBroadcasts, 0);
    assert.equal(x.f.calls.funding, 0);
  } finally { await x.f.cleanup(); }
});

test('unknown funding preparation outcome retains PREPARE_LOCKUP and never broadcasts or pays twice', async () => {
  const x = await runnerFixture();
  let attempts = 0;
  x.f.ports.prepareLockup = async () => { attempts++; throw new Error('Funding prepare RPC reply lost'); };
  try {
    await assert.rejects(runControlledReverse(x.f.store, x.f.ports, x.controls, x.f.swap.id), /Funding prepare RPC reply lost/);
    const swap = x.f.manager.get(x.f.swap.id)!;
    assert.equal(swap.state, 'MANUAL_REVIEW');
    assert.equal(swap.pendingAction, 'PREPARE_LOCKUP');
    // Coordinator owns the newer uncertain intent; runner cleanup must not rewrite it.
    assert.equal(swap.clientPayment!.status, 'IN_FLIGHT');
    assert.equal(swap.lockup, undefined);
    assert.equal(attempts, 1);
    assert.equal(x.f.calls.funding, 0);
    assert.equal(x.counters.claimBroadcasts, 0);
    await assert.rejects(runControlledReverse(x.f.store, x.f.ports, x.controls, x.f.swap.id), /reconcile/);
    assert.equal(attempts, 1);
    assert.equal(x.counters.started, 1);
  } finally { await x.f.cleanup(); }
});

test('unknown funding broadcast outcome retains the signed lockup and BROADCAST_LOCKUP intent', async () => {
  const x = await runnerFixture();
  let attempts = 0;
  x.f.ports.broadcast = async () => { attempts++; throw new Error('Funding broadcast RPC reply lost'); };
  try {
    await assert.rejects(runControlledReverse(x.f.store, x.f.ports, x.controls, x.f.swap.id), /Funding broadcast RPC reply lost/);
    const swap = x.f.manager.get(x.f.swap.id)!;
    assert.equal(swap.state, 'MANUAL_REVIEW');
    assert.equal(swap.pendingAction, 'BROADCAST_LOCKUP');
    assert.ok(swap.lockup);
    assert.equal(swap.clientPayment!.status, 'IN_FLIGHT');
    assert.equal(attempts, 1);
    assert.equal(x.f.calls.funding, 1);
    assert.equal(x.counters.claimBroadcasts, 0);
    await assert.rejects(runControlledReverse(x.f.store, x.f.ports, x.controls, x.f.swap.id), /reconcile/);
    assert.equal(attempts, 1);
  } finally { await x.f.cleanup(); }
});

test('funding broadcast identity mismatch is treated as an unverified outcome and blocks the claim', async () => {
  const x = await runnerFixture();
  let attempts = 0;
  x.f.ports.broadcast = async () => { attempts++; return 'ab'.repeat(32); };
  try {
    await assert.rejects(runControlledReverse(x.f.store, x.f.ports, x.controls, x.f.swap.id), /Funding outcome unverified/);
    const swap = x.f.manager.get(x.f.swap.id)!;
    assert.equal(swap.state, 'MANUAL_REVIEW');
    assert.equal(swap.pendingAction, 'BROADCAST_LOCKUP');
    assert.ok(swap.lockup);
    assert.equal(attempts, 1);
    assert.equal(x.counters.claimBroadcasts, 0);
    assert.equal(x.counters.settles, 0);
  } finally { await x.f.cleanup(); }
});

test('unknown claim broadcast outcome leaves an UNKNOWN claim intent and blocks a second broadcast', async () => {
  const x = await runnerFixture({
    broadcastClaim: async () => { throw new Error('Claim broadcast RPC reply lost'); },
  });
  try {
    await assert.rejects(runControlledReverse(x.f.store, x.f.ports, x.controls, x.f.swap.id), /Claim broadcast RPC reply lost/);
    const swap = x.f.manager.get(x.f.swap.id)!;
    assert.equal(swap.state, 'MANUAL_REVIEW');
    assert.equal(swap.clientPayment!.status, 'UNKNOWN');
    assert.equal(swap.clientClaimIntent!.status, 'UNKNOWN');
    assert.ok(swap.clientClaimIntent!.txid);
    assert.equal(x.counters.claimBroadcasts, 1);
    assert.equal(x.counters.settles, 0);
    assert.equal(x.counters.mined, 1);
    await assert.rejects(runControlledReverse(x.f.store, x.f.ports, x.controls, x.f.swap.id), /reconcile/);
    assert.equal(x.counters.claimBroadcasts, 1);
    assert.equal(x.counters.started, 1);
  } finally { await x.f.cleanup(); }
});

test('claim broadcast identity mismatch is recorded as UNKNOWN and never settles', async () => {
  const x = await runnerFixture({ broadcastClaim: async () => 'cd'.repeat(32) });
  try {
    await assert.rejects(runControlledReverse(x.f.store, x.f.ports, x.controls, x.f.swap.id), /Claim RPC identity mismatch/);
    const swap = x.f.manager.get(x.f.swap.id)!;
    assert.equal(swap.state, 'MANUAL_REVIEW');
    assert.equal(swap.clientClaimIntent!.status, 'UNKNOWN');
    assert.equal(x.counters.claimBroadcasts, 1);
    assert.equal(x.counters.settles, 0);
    assert.equal(x.counters.mined, 1);
  } finally { await x.f.cleanup(); }
});

test('crash between claim broadcast and observation keeps durable BROADCAST evidence without rebroadcast', async () => {
  const x = await runnerFixture({
    findClaim: async () => { throw new Error('Claim observation RPC reply lost'); },
  });
  try {
    await assert.rejects(runControlledReverse(x.f.store, x.f.ports, x.controls, x.f.swap.id), /Claim observation RPC reply lost/);
    const swap = x.f.manager.get(x.f.swap.id)!;
    const claimTxid = swap.clientClaimIntent!.txid;
    assert.equal(swap.state, 'MANUAL_REVIEW');
    assert.equal(swap.clientPayment!.status, 'UNKNOWN');
    assert.equal(swap.clientClaimIntent!.status, 'BROADCAST');
    assert.ok(claimTxid);
    assert.equal(x.counters.claimBroadcasts, 1);
    assert.equal(x.counters.settles, 0);
    assert.equal(x.counters.mined, 2);
    await assert.rejects(runControlledReverse(x.f.store, x.f.ports, x.controls, x.f.swap.id), /reconcile/);
    assert.equal(x.counters.claimBroadcasts, 1);
    assert.equal(x.counters.started, 1);
    assert.equal(x.f.manager.get(x.f.swap.id)!.clientClaimIntent!.txid, claimTxid);
  } finally { await x.f.cleanup(); }
});

test('restart with a durable pendingAction and payment intent escalates to manual review without retrying', async () => {
  const x = await runnerFixture();
  try {
    await x.f.store.transaction(db => {
      const swap = db.swaps[x.f.swap.id]!;
      swap.pendingAction = 'PREPARE_LOCKUP';
      swap.clientPayment = { hash: swap.contract.paymentHash, status: 'INTENT', feeLimitSats: 100 };
    });
    await new SwapCoordinator(x.f.store, x.f.ports).recover();
    const swap = x.f.manager.get(x.f.swap.id)!;
    assert.equal(swap.state, 'MANUAL_REVIEW');
    assert.equal(swap.pendingAction, 'PREPARE_LOCKUP');
    assert.equal(swap.clientPayment!.status, 'INTENT');
    await assert.rejects(runControlledReverse(x.f.store, x.f.ports, x.controls, x.f.swap.id), /reconcile/);
    assert.equal(x.counters.started, 0);
    assert.equal(x.f.calls.funding, 0);
    assert.equal(swap.lockup, undefined);
  } finally { await x.f.cleanup(); }
});

test('any durable clientPayment status blocks a restart before a new payer or funding action', async () => {
  for (const status of ['INTENT', 'IN_FLIGHT', 'SUCCEEDED', 'FAILED', 'UNKNOWN'] as const) {
    const x = await runnerFixture();
    try {
      await x.f.store.transaction(db => {
        db.swaps[x.f.swap.id]!.clientPayment = { hash: x.f.contract.paymentHash, status, feeLimitSats: 100 };
      });
      await assert.rejects(runControlledReverse(x.f.store, x.f.ports, x.controls, x.f.swap.id), /reconcile/, status);
      assert.equal(x.counters.started, 0, status);
      assert.equal(x.f.calls.funding, 0, status);
      assert.equal(x.f.manager.get(x.f.swap.id)!.state, 'INVOICE_CREATED', status);
    } finally { await x.f.cleanup(); }
  }
});

test('duplicate concurrent invocation is refused while the first run owns the durable payment intent', async () => {
  let release!: () => void;
  let reached!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const atGate = new Promise<void>(resolve => { reached = resolve; });
  const x = await runnerFixture({ waitAccepted: async () => { reached(); await gate; } });
  try {
    const first = runControlledReverse(x.f.store, x.f.ports, x.controls, x.f.swap.id);
    await atGate;
    assert.equal(x.f.manager.get(x.f.swap.id)!.clientPayment!.status, 'INTENT');
    await assert.rejects(runControlledReverse(x.f.store, x.f.ports, x.controls, x.f.swap.id), /reconcile/);
    assert.equal(x.counters.started, 1);
    assert.equal(x.f.calls.funding, 0);
    release();
    const result = await first;
    assert.equal(result.state, 'COMPLETED');
    assert.equal(x.counters.started, 1);
    assert.equal(x.counters.claimBroadcasts, 1);
    assert.equal(x.counters.settles, 1);
  } finally { await x.f.cleanup(); }
});

test('completed swap keeps durable payment and claim evidence and refuses another payment', async () => {
  const x = await runnerFixture();
  try {
    const result = await runControlledReverse(x.f.store, x.f.ports, x.controls, x.f.swap.id);
    assert.equal(result.state, 'COMPLETED');
    assert.equal(result.clientPayment!.status, 'SUCCEEDED');
    assert.equal(result.clientClaimIntent!.status, 'BROADCAST');
    await assert.rejects(runControlledReverse(x.f.store, x.f.ports, x.controls, x.f.swap.id), /reconcile/);
    assert.equal(x.counters.started, 1);
    assert.equal(x.counters.claimBroadcasts, 1);
    assert.equal(x.counters.settles, 1);
  } finally { await x.f.cleanup(); }
});

test('failed runner preserves every newer actor payment journal and never starts another payment', async () => {
  for (const status of ['FAILED', 'IN_FLIGHT', 'UNKNOWN', 'SUCCEEDED'] as const) {
    const x = await runnerFixture();
    const failure = new Error('Acceptance observation became uncertain');
    let concurrent: Swap | undefined;
    x.controls.waitAccepted = async () => {
      const current = x.f.manager.get(x.f.swap.id)!;
      concurrent = await updateSwapRevision(x.f.store, current.id, current.revision, s => {
        s.clientPayment!.status = status;
        if (status === 'SUCCEEDED') s.clientPayment!.feeSats = 3;
        s.pendingAction = 'PREPARE_LOCKUP';
        transition(s, 'MANUAL_REVIEW');
      });
      throw failure;
    };
    try {
      await assert.rejects(runControlledReverse(x.f.store, x.f.ports, x.controls, x.f.swap.id), error => error === failure);
      assert.deepEqual(x.f.manager.get(x.f.swap.id), concurrent, status);
      assert.equal(x.counters.stopped, 1);
      await assert.rejects(runControlledReverse(x.f.store, x.f.ports, x.controls, x.f.swap.id), /reconcile/);
      assert.equal(x.counters.started, 1);
      assert.deepEqual(x.f.calls, { funding: 0, broadcast: 0, settle: 0 });
    } finally { await x.f.cleanup(); }
  }
});

test('actor update queued during client cleanup wins the atomic failure-journal race', async () => {
  const failure = new Error('Acceptance lookup reply lost');
  let concurrent: Promise<Swap> | undefined;
  const x = await runnerFixture({ waitAccepted: async () => { throw failure; } });
  const start = x.controls.startPayment;
  x.controls.startPayment = async swap => {
    const handle = await start(swap);
    return { result: handle.result, stopClient: () => {
      handle.stopClient();
      const current = x.f.manager.get(x.f.swap.id)!;
      concurrent = updateSwapRevision(x.f.store, current.id, current.revision, s => {
        s.clientPayment!.status = 'FAILED';
        transition(s, 'MANUAL_REVIEW');
      });
    } };
  };
  try {
    await assert.rejects(runControlledReverse(x.f.store, x.f.ports, x.controls, x.f.swap.id), error => error === failure);
    assert.ok(concurrent);
    assert.deepEqual(x.f.manager.get(x.f.swap.id), await concurrent);
    await assert.rejects(runControlledReverse(x.f.store, x.f.ports, x.controls, x.f.swap.id), /reconcile/);
    assert.equal(x.counters.started, 1);
    assert.equal(x.f.calls.funding, 0);
  } finally { await concurrent; await x.f.cleanup(); }
});

test('legacy unversioned actor changes also survive failure cleanup without replay', async () => {
  const failure = new Error('Acceptance stream disconnected');
  const x = await runnerFixture();
  let concurrent: Swap | undefined;
  x.controls.waitAccepted = async () => {
    concurrent = await x.f.store.transaction(db => {
      const s = db.swaps[x.f.swap.id]!;
      s.clientPayment!.status = 'FAILED';
      return s; // Existing adapters can still mutate journals without a revision bump.
    });
    throw failure;
  };
  try {
    await assert.rejects(runControlledReverse(x.f.store, x.f.ports, x.controls, x.f.swap.id), error => error === failure);
    assert.deepEqual(x.f.manager.get(x.f.swap.id), concurrent);
    await assert.rejects(runControlledReverse(x.f.store, x.f.ports, x.controls, x.f.swap.id), /reconcile/);
    assert.equal(x.counters.started, 1);
    assert.equal(x.f.calls.funding, 0);
  } finally { await x.f.cleanup(); }
});

test('throwing client cleanup cannot prevent UNKNOWN payment journaling or hide the original ambiguity', async () => {
  const failure = new Error('Acceptance outcome unknown');
  const x = await runnerFixture({
    startPayment: async () => ({ result: new Promise<PaymentEvidence>(() => {}),
      stopClient: () => { throw new Error('Client cleanup failed'); } }),
    waitAccepted: async () => { throw failure; },
  });
  try {
    await assert.rejects(runControlledReverse(x.f.store, x.f.ports, x.controls, x.f.swap.id), error => error === failure);
    const failed = x.f.manager.get(x.f.swap.id)!;
    assert.equal(failed.state, 'MANUAL_REVIEW');
    assert.equal(failed.clientPayment!.status, 'UNKNOWN');
    await assert.rejects(runControlledReverse(x.f.store, x.f.ports, x.controls, x.f.swap.id), /reconcile/);
    assert.equal(x.counters.started, 1);
    assert.equal(x.f.calls.funding, 0);
  } finally { await x.f.cleanup(); }
});

test('payer observation failure during funding preparation stops the pending funding broadcast without retry', async () => {
  let rejectResult!: (error: Error) => void;
  const result = new Promise<PaymentEvidence>((_, reject) => { rejectResult = reject; });
  const x = await runnerFixture({ startPayment: async () => ({ result, stopClient: () => {} }) });
  const prepare = x.f.ports.prepareLockup;
  x.f.ports.prepareLockup = async swap => {
    const funding = await prepare(swap);
    rejectResult(new Error('Payment stream disconnected'));
    return funding;
  };
  try {
    await assert.rejects(runControlledReverse(x.f.store, x.f.ports, x.controls, x.f.swap.id), /Payer outcome uncertain/);
    const failed = x.f.manager.get(x.f.swap.id)!;
    assert.equal(failed.state, 'MANUAL_REVIEW'); assert.equal(failed.pendingAction, 'BROADCAST_LOCKUP');
    assert.ok(failed.lockup); assert.equal(x.f.calls.funding, 1); assert.equal(x.f.calls.broadcast, 0);
    assert.equal(x.counters.claimBroadcasts, 0); assert.equal(x.counters.settles, 0);
    await assert.rejects(runControlledReverse(x.f.store, x.f.ports, x.controls, x.f.swap.id), /reconcile/);
    assert.equal(x.counters.started, 1); assert.equal(x.f.calls.funding, 1);
  } finally { await x.f.cleanup(); }
});
