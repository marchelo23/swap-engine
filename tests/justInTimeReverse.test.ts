import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { preparationFixture } from './preparationFixture.js';
import { createJustInTimeReverse, type JitAuthorization, type JitExecutor, type JitExecution } from '../src/core/JustInTimeReverse.js';
import { SwapManager } from '../src/core/SwapManager.js';

async function fixture(sourceAmountSats?: number) {
  const x = await preparationFixture(sourceAmountSats); const prepared = await x.harness().prepare();
  let time = prepared.plan.quote.expiresAt + 1000; let monotonic = 0; let executions = 0; let stops = 0;
  const clock = { now: () => time, monotonic: () => monotonic };
  let effect: (context: JitExecution) => Promise<{ id: string; state: string; revision: number }> = async context => {
    context.guard();
    const disk = JSON.parse(await readFile(join(x.directory, 'state.json'), 'utf8'));
    assert.equal(disk.jitExecutions[authorization.id].status, 'EXECUTING');
    assert.deepEqual(disk.jitExecutions[authorization.id].approval, context.approval);
    const id = context.approval.swapId;
    await x.store.transaction(db => {
      const swap = db.swaps[id]!; swap.state = 'COMPLETED'; swap.revision++;
      (db.controlledExecutions ??= {})[context.approval.id] = { swapId: id, planDigest: context.approval.planDigest,
        isolationId: context.scope.isolationId, status: 'COMPLETED', blocksRequested: 2 };
    });
    return { id, state: 'COMPLETED', revision: x.store.read().swaps[id]!.revision };
  };
  const executor: JitExecutor = { async execute(context) { executions++; return effect(context); }, stopClient() { stops++; } };
  const make = (approval?: JitAuthorization, execute?: JitExecutor) => createJustInTimeReverse(x.store, x.spec, x.adapters, approval, execute, clock);
  const review = await make().review();
  const authorization: JitAuthorization = { id: randomUUID(), termsDigest: review.termsDigest, issuedAt: time, startBefore: time + 300000,
    scope: 'isolated-regtest-one-requote-and-execute', maxBlocks: 2, quoteLifetimeMs: 120000, executionWindowMs: 90000 };
  return { x, prepared, review, authorization, executor, make, clock, executions: () => executions, stops: () => stops,
    effect: (fn: typeof effect) => { effect = fn; }, advance(ms: number) { time += ms; monotonic += ms; },
    wall: (value: number) => { time = value; }, cleanup: x.cleanup };
}

test('JIT retains the selected invoice amount and deductions across execution and reopen', async () => {
  const f = await fixture(50000);
  try {
    const result = await f.make(f.authorization, f.executor).run();
    const quote = f.x.store.read().swaps[result.id]!.quote;
    assert.equal(quote.invoiceSats, 50000); assert.equal(quote.serviceFeeSats, 750);
    assert.equal(quote.amountSats - quote.claimFeeSats, 48750);
    await f.x.reopen(); assert.equal(f.x.store.read().swaps[result.id]!.quote.invoiceSats, 50000);
    assert.throws(() => f.make(f.authorization, f.executor)); assert.equal(f.executions(), 1);
  } finally { await f.cleanup(); }
});

test('expired handoff review retains one unpaid invoice and creates no quote, authority or execution', async () => {
  const f = await fixture(); try {
    const before = f.x.store.read(); assert.ok(f.prepared.request.expiresAt < f.clock.now());
    assert.equal(f.review.executionApproved, false); assert.equal(f.review.status, 'RETAINED_UNPAID_REQUIRES_JIT_AUTHORITY');
    await f.make().review(); await assert.rejects(f.make().run());
    assert.deepEqual(f.x.store.read(), before); assert.equal(f.x.calls(), 1); assert.equal(f.x.posts(), 1); assert.equal(f.executions(), 0);
  } finally { await f.cleanup(); }
});

test('explicit bounded envelope requotes identical terms and immediately executes existing invoice once', async () => {
  const f = await fixture(); try {
    const prep = f.x.record(); const swap = f.x.store.read().swaps[prep.swapId!]!;
    const result = await f.make(f.authorization, f.executor).run(); assert.equal(result.state, 'COMPLETED');
    const db = f.x.store.read(); const record = db.jitExecutions![f.authorization.id]!; const updated = db.swaps[swap.id]!;
    assert.equal(record.status, 'COMPLETED'); assert.equal(record.approval!.expiresAt, f.clock.now() + 90000);
    assert.equal(record.plan!.quote.expiresAt, f.clock.now() + 120000); assert.notEqual(updated.quote.id, swap.quote.id);
    for (const field of ['amountSats', 'invoiceSats', 'serviceFeeSats', 'fundingReserveSats', 'claimFeeSats'] as const)
      assert.equal(updated.quote[field], swap.quote[field]);
    assert.deepEqual(db.quotes[swap.quote.id], swap.quote); assert.deepEqual(f.x.record(), prep);
    assert.equal(updated.invoice, swap.invoice); assert.equal(updated.fingerprint, swap.fingerprint);
    assert.deepEqual(updated.contract, swap.contract); assert.equal(f.x.calls(), 1); assert.equal(f.executions(), 1);
    await f.x.reopen(); assert.throws(() => f.make(f.authorization, f.executor)); assert.equal(f.executions(), 1);
  } finally { await f.cleanup(); }
});

test('missing, expired, future, mismatched and relaxed authority cannot mint a quote or call an executor', async () => {
  for (const change of ['missing', 'expired', 'future', 'digest', 'window', 'long-envelope', 'no-executor']) {
    const f = await fixture(); try {
      const before = f.x.store.read(); const auth = structuredClone(f.authorization);
      if (change === 'expired') auth.startBefore = f.clock.now();
      if (change === 'future') auth.issuedAt = f.clock.now() + 1;
      if (change === 'digest') auth.termsDigest = '00'.repeat(32);
      if (change === 'window') (auth as { executionWindowMs: number }).executionWindowMs++;
      if (change === 'long-envelope') auth.startBefore = auth.issuedAt + 600001;
      await assert.rejects(async () => f.make(change === 'missing' ? undefined : auth, change === 'no-executor' ? undefined : f.executor).run());
      assert.deepEqual(f.x.store.read(), before); assert.equal(f.executions(), 0); assert.equal(f.x.posts(), 1);
    } finally { await f.cleanup(); }
  }
});

test('changed invoice, custody, node, amount and expiry reject before consuming the envelope', async () => {
  for (const change of ['paid', 'accepted', 'canceled-htlc', 'canceled', 'invoice', 'custody', 'node', 'amount', 'expiry']) {
    const f = await fixture(); try {
      const before = f.x.store.read();
      if (change === 'paid') f.x.invoice.amt_paid_sat = '1';
      if (change === 'accepted') f.x.invoice.htlcs = [{ state: 'ACCEPTED', expiration_height: 210, amt_msat: '50750000' }];
      if (change === 'canceled-htlc') f.x.invoice.htlcs = [{ state: 'CANCELED', expiration_height: 210, amt_msat: '50750000' }];
      if (change === 'canceled') f.x.invoice.state = 'CANCELED';
      if (change === 'invoice') f.x.invoice.payment_request += 'a';
      if (change === 'custody') f.x.keys.claimPublicKey = f.x.spec.refundPublicKey;
      if (change === 'node') f.x.pInfo.identity_pubkey = f.x.spec.payerNode;
      if (change === 'amount') f.x.decoded.num_msat = '50750001';
      if (change === 'expiry') f.x.decoded.expiry = '120';
      await assert.rejects(f.make(f.authorization, f.executor).run());
      assert.deepEqual(f.x.store.read(), before); assert.equal(f.executions(), 0); assert.equal(f.x.calls(), 1);
    } finally { await f.cleanup(); }
  }
});

test('slow readiness, wrong input and revision conflicts consume attempt and cannot blindly retry after restart', async () => {
  for (const change of ['slow', 'input', 'revision']) {
    const f = await fixture(); try {
      f.x.inspect(async readiness => {
        if (change === 'slow') f.advance(30001);
        if (change === 'input') readiness.funding.vout++;
        if (change === 'revision') await f.x.store.transaction(db => { db.swaps[f.prepared.request.swapId]!.revision++; });
      });
      await assert.rejects(f.make(f.authorization, f.executor).run()); assert.equal(f.executions(), 0);
      assert.equal(f.x.store.read().jitExecutions![f.authorization.id]!.status, 'UNKNOWN');
      const quotes = f.x.store.read().quotes; await f.x.reopen();
      await assert.rejects(async () => f.make({ ...f.authorization, id: randomUUID() }, f.executor).run());
      assert.deepEqual(f.x.store.read().quotes, quotes); assert.equal(f.x.posts(), 1);
    } finally { await f.cleanup(); }
  }
});

test('parallel JIT attempts have one durable owner, quote and execution', async () => {
  const f = await fixture(); try {
    const first = f.make(f.authorization, f.executor); const second = f.make({ ...f.authorization, id: randomUUID() }, f.executor);
    const outcomes = await Promise.allSettled([first.run(), second.run()]);
    assert.equal(outcomes.filter(r => r.status === 'fulfilled').length, 1);
    assert.equal(f.executions(), 1); assert.equal(Object.keys(f.x.store.read().jitExecutions!).length, 1);
    assert.equal(Object.keys(f.x.store.read().quotes).length, 2); assert.equal(f.x.posts(), 1);
  } finally { await f.cleanup(); }
});

test('uncertain quote acknowledgment consumes intent without a second quote or executor call', async t => {
  const f = await fixture(); try {
    const realQuote = SwapManager.prototype.quote; let quotes = 0;
    t.mock.method(SwapManager.prototype, 'quote', async function(this: SwapManager, amount: number, now: number) {
      quotes++; await realQuote.call(this, amount, now); throw Error('lost quote reply');
    });
    await assert.rejects(f.make(f.authorization, f.executor).run()); assert.equal(f.executions(), 0);
    assert.equal(f.x.store.read().jitExecutions![f.authorization.id]!.status, 'UNKNOWN');
    await f.x.reopen(); assert.throws(() => f.make(f.authorization, f.executor)); assert.equal(quotes, 1); assert.equal(f.x.posts(), 1);
  } finally { await f.cleanup(); }
});

test('intent persistence consuming the preparation deadline cannot issue a late quote', async t => {
  const f = await fixture(); try {
    const transaction = f.x.store.transaction.bind(f.x.store); let delayed = false;
    t.mock.method(f.x.store, 'transaction', async (fn: Parameters<typeof transaction>[0]) => {
      const result = await transaction(fn);
      if (!delayed && f.x.store.read().jitExecutions?.[f.authorization.id]?.status === 'INTENT') {
        delayed = true; f.advance(30001);
      }
      return result;
    });
    await assert.rejects(f.make(f.authorization, f.executor).run());
    assert.equal(f.x.store.read().jitExecutions![f.authorization.id]!.status, 'UNKNOWN');
    assert.equal(Object.keys(f.x.store.read().quotes).length, 1); assert.equal(f.executions(), 0); assert.equal(f.x.posts(), 1);
  } finally { await f.cleanup(); }
});

test('a concurrent replacement of the archived quote survives requote installation and cannot authorize execution', async t => {
  const f = await fixture(); try {
    const quote = SwapManager.prototype.quote; const prior = f.prepared.plan.quote;
    const actor = { ...prior, expiresAt: prior.expiresAt + 1 };
    t.mock.method(SwapManager.prototype, 'quote', async function(this: SwapManager, amount: number, now: number) {
      const next = await quote.call(this, amount, now);
      await f.x.store.transaction(db => { db.quotes[prior.id] = actor; }); return next;
    });
    await assert.rejects(f.make(f.authorization, f.executor).run());
    assert.deepEqual(f.x.store.read().quotes[prior.id], actor); assert.equal(f.executions(), 0);
    assert.equal(f.x.store.read().jitExecutions![f.authorization.id]!.status, 'UNKNOWN'); assert.equal(f.x.posts(), 1);
  } finally { await f.cleanup(); }
});

test('ambiguous executor result and clock expiry never renew or replay authorization', async () => {
  for (const change of ['lost', 'deadline', 'backstep', 'false-complete']) {
    const f = await fixture(); try {
      f.effect(async context => {
        if (change === 'deadline') { f.advance(90001); context.guard(); }
        if (change === 'backstep') { f.wall(f.clock.now() - 1); context.guard(); }
        if (change === 'false-complete') return { id: context.approval.swapId, state: 'COMPLETED', revision: 42 };
        throw Error('ambiguous synthetic response');
      });
      await assert.rejects(f.make(f.authorization, f.executor).run());
      assert.equal(f.x.store.read().jitExecutions![f.authorization.id]!.status, 'UNKNOWN'); assert.equal(f.stops(), 1);
      await f.x.reopen(); await assert.rejects(async () => f.make({ ...f.authorization, id: randomUUID() }, f.executor).run());
      assert.equal(f.executions(), 1); assert.equal(f.x.calls(), 1);
    } finally { await f.cleanup(); }
  }
});

test('late executor completion is fenced and shuts down only the client observation', async t => {
  const f = await fixture(); try {
    t.mock.timers.enable({ apis: ['setTimeout'] }); let wake!: () => void; let entered!: () => void;
    const ready = new Promise<void>(resolve => { entered = resolve; }); let wireCalls = 0; let signal: AbortSignal | undefined;
    f.effect(async context => { signal = context.signal; entered(); await new Promise<void>(resolve => { wake = resolve; });
      context.guard(); wireCalls++; throw Error('unreachable'); });
    const pending = f.make(f.authorization, f.executor).run(); await ready;
    const rejected = assert.rejects(pending); t.mock.timers.tick(90001); await rejected;
    assert.equal(signal!.aborted, true); assert.equal(f.stops(), 1); wake(); await Promise.resolve();
    assert.equal(wireCalls, 0); assert.equal(f.x.store.read().jitExecutions![f.authorization.id]!.status, 'UNKNOWN');
  } finally { await f.cleanup(); }
});

test('catch cleanup retains a newer actor execution ledger and never retries', async () => {
  const f = await fixture(); try {
    f.effect(async () => {
      await f.x.store.transaction(db => { db.jitExecutions![f.authorization.id]!.startedAt++; });
      throw Error('actor changed the journal');
    });
    await assert.rejects(f.make(f.authorization, f.executor).run());
    const record = f.x.store.read().jitExecutions![f.authorization.id]!;
    assert.equal(record.status, 'EXECUTING'); assert.equal(record.startedAt, f.clock.now() + 1);
    await assert.rejects(async () => f.make(f.authorization, f.executor).run()); assert.equal(f.executions(), 1);
  } finally { await f.cleanup(); }
});
