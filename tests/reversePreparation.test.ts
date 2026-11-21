import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture as contractFixture, routingFixture } from './helpers.js';
import { Store } from '../src/persistence/Store.js';
import { updateSwapRevision } from '../src/core/SwapStateMachine.js';
import { createReversePreparation, preparationDigest, type PreparationSpec, type PreparationAdapters, type PreparationApproval } from '../src/core/ReversePreparation.js';
import { controlledRunDigest, createControlledReverseBackend } from '../src/core/ControlledReverseBackend.js';
import type { Invoice } from '../src/lightning/LndClient.js';

import { preparationFixture as fixture } from './preparationFixture.js';

test('the selected Lightning amount binds invoice, fees and on-chain principal', async () => {
  for (const amount of [11000, 25000, 50000]) {
    const x = await fixture(amount);
    try {
      const result = await x.harness().prepare(); const quote = result.plan.quote;
      assert.equal(quote.invoiceSats, amount);
      assert.equal(quote.serviceFeeSats, 500 + Math.ceil(amount / 200));
      assert.equal(quote.amountSats, amount - quote.serviceFeeSats);
      assert.equal(quote.amountSats - quote.claimFeeSats, amount - quote.serviceFeeSats - 500);
      assert.equal(x.posts(), 1);
      await x.reopen(); assert.deepEqual(await x.harness().prepare(), result); assert.equal(x.posts(), 1);
    } finally { await x.cleanup(); }
  }
});

test('one exact quote supplies the plan, swap, durable invoice intent and stable unapproved execution request', async () => {
  const x = await fixture();
  try {
    const result = await x.harness().prepare(); const db = x.store.read(); const swap = db.swaps[result.request.swapId]!;
    assert.equal(result.status, 'PREPARED_UNPAID_NOT_AUTHORIZED'); assert.equal(result.plan.executionApproved, false);
    assert.equal(Object.keys(db.quotes).length, 1); assert.equal(Object.keys(db.swaps).length, 1);
    assert.deepEqual(result.plan.quote, swap.quote); assert.deepEqual(result.plan.quote, db.quotes[swap.quote.id]);
    assert.equal(result.request.planDigest, controlledRunDigest(result.plan, result.input, swap.id, result.scope.isolationId));
    assert.ok(result.request.expiresAt <= swap.quote.expiresAt); assert.equal(result.request.expectedRevision, swap.revision);
    assert.equal(x.posts(), 1); assert.equal(x.calls(), 1); assert.equal(swap.clientPayment, undefined);
    assert.equal(db.controlledExecutions, undefined); assert.equal(x.record().status, 'READY');
    await x.reopen(); assert.deepEqual(await x.harness().prepare(), result); assert.equal(x.calls(), 1);
    assert.equal((await readFile(join(x.directory, 'state.json'), 'utf8')).includes('preimage'), false);
  } finally { await x.cleanup(); }
});

test('missing, altered or expired preparation authority is inert and cannot be enabled by a plan-field toggle', async () => {
  const x = await fixture();
  try {
    for (const a of [undefined, { ...x.approval, id: randomUUID() }, { ...x.approval, specDigest: '00'.repeat(32) },
      { ...x.approval, expiresAt: 1 }]) {
      const harness = createReversePreparation(x.store, x.spec, x.adapters, a);
      await assert.rejects(harness.prepare());
    }
    assert.throws(() => createReversePreparation(x.store, { ...x.spec, executionApproved: true } as never, x.adapters, x.approval));
    assert.equal(x.reads.length, 0); assert.deepEqual(x.store.read().quotes, {}); assert.equal(x.calls(), 0);
  } finally { await x.cleanup(); }
});

test('foreign chains, wrong identities, channel substitution and missing custody fail before invoice creation', async () => {
  const changes: Array<(x: Awaited<ReturnType<typeof fixture>>) => void> = [
    x => { x.chain.chain = 'main'; }, x => { x.chain.blocks = 111; }, x => { x.chain.initialblockdownload = true; },
    x => { x.pInfo.identity_pubkey = x.spec.payerNode; }, x => { x.aInfo.wallet_synced = false; },
    x => { x.pChannels.channels[0]!.chan_id = '67890'; }, x => { x.aChannels.channels[0]!.channel_point = 'ff'.repeat(32) + ':0'; },
    x => { x.pChannels.channels[0]!.remote_pubkey = x.spec.providerNode; }, x => { x.aChannels.channels[0]!.active = false; },
    x => { x.keys.paymentHash = '00'.repeat(32); }, x => { x.keys.claimPublicKey = x.spec.refundPublicKey; },
    x => { x.keys.refundPublicKey = x.spec.client.claimPublicKey; },
  ];
  for (const change of changes) {
    const x = await fixture();
    try { change(x); await assert.rejects(x.harness().prepare()); assert.equal(x.calls(), 0); assert.equal(x.record().status, 'UNKNOWN');
      await assert.rejects(x.harness().prepare()); assert.equal(Object.keys(x.store.read().quotes).length, 0);
    } finally { await x.cleanup(); }
  }
});

test('identity, expiry, endpoint and exact quote changes during credential loading cannot reach the POST', async () => {
  for (const point of ['expiry', 'endpoint', 'node', 'channel', 'quote id', 'quote expiry', 'fee', 'revision'] as const) {
    const x = await fixture();
    try {
      x.credentials(async () => {
        if (point === 'expiry') x.setTime(x.approval.expiresAt + 1);
        else if (point === 'endpoint') x.provider.origin = 'https://127.0.0.1:8082';
        else if (point === 'node') x.aInfo.identity_pubkey = x.spec.providerNode;
        else if (point === 'channel') x.aChannels.channels[0]!.chan_id = '67890';
        else await x.store.transaction(db => {
          const swap = db.swaps[x.record().swapId!]!;
          if (point === 'quote id') swap.quote.id = randomUUID();
          if (point === 'quote expiry') swap.quote.expiresAt++;
          if (point === 'fee') swap.quote.serviceFeeSats++;
          if (point === 'revision') swap.revision++;
        });
      });
      await assert.rejects(x.harness().prepare()); assert.equal(x.calls(), 1); assert.equal(x.posts(), 0);
      await assert.rejects(async () => x.harness().prepare()); assert.equal(x.calls(), 1);
    } finally { await x.cleanup(); }
  }
});

test('concurrent preparation instances reserve one store and create one quote, swap and invoice', async () => {
  const x = await fixture();
  try {
    const result = await Promise.allSettled([x.harness().prepare(), x.harness().prepare()]);
    assert.equal(result.filter(r => r.status === 'fulfilled').length, 1);
    assert.equal(x.posts(), 1); assert.equal(x.calls(), 1); assert.equal(Object.keys(x.store.read().quotes).length, 1);
  } finally { await x.cleanup(); }
});

test('a lost invoice reply survives store reopen and recovers exact existing evidence without another create', async () => {
  const x = await fixture();
  try {
    x.lose(); await assert.rejects(x.harness().prepare(), e => !String(e).includes('synthetic-lost-reply'));
    const before = x.store.read(); const swap = before.swaps[x.record().swapId!]!;
    assert.equal(swap.pendingAction, 'CREATE_INVOICE'); assert.equal(swap.invoice, undefined);
    await x.reopen(); await assert.rejects(x.harness().prepare());
    const result = await x.harness().recover(swap.revision);
    assert.equal(result.status, 'PREPARED_UNPAID_NOT_AUTHORIZED'); assert.equal(x.posts(), 1); assert.equal(x.calls(), 1);
    assert.deepEqual(result.plan.quote, x.store.read().swaps[swap.id]!.quote);
    assert.deepEqual(await x.harness().recover(result.request.expectedRevision), result);
  } finally { await x.cleanup(); }
});

test('unpaid invoice, independent decode, amount and readiness failures cannot produce a ready request or retry', async () => {
  for (const point of ['network', 'hash', 'value', 'paid', 'held', 'canceled', 'decode hash', 'decode amount', 'decode payee', 'decode expiry',
    'funding input', 'funding amount', 'readiness identity', 'readiness cltv'] as const) {
    const x = await fixture();
    try {
      if (point === 'network') x.badResponse('lnbc' + 'a'.repeat(30));
      if (point === 'hash') x.invoice.r_hash = Buffer.alloc(32).toString('base64');
      if (point === 'value') x.invoice.value = '50749';
      if (point === 'paid') x.invoice.amt_paid_sat = '1';
      if (point === 'held') x.invoice.htlcs = [{ state: 'ACCEPTED', expiration_height: 210, amt_msat: '50750000' }];
      if (point === 'canceled') x.invoice.state = 'CANCELED';
      if (point === 'decode hash') x.decoded.payment_hash = '00'.repeat(32);
      if (point === 'decode amount') x.decoded.num_msat = '50750001';
      if (point === 'decode payee') x.decoded.destination = x.spec.payerNode;
      if (point === 'decode expiry') x.decoded.timestamp = '0';
      x.inspect(async result => {
        if (point === 'funding input') result.funding.txid = '00'.repeat(32);
        if (point === 'funding amount') result.funding.valueSats++;
        if (point === 'readiness identity') result.providerNode = x.spec.payerNode;
        if (point === 'readiness cltv') (result.decodedInvoice as typeof x.decoded).cltv_expiry = '79';
      });
      await assert.rejects(x.harness().prepare()); assert.equal(x.record().executionRequest, undefined);
      await assert.rejects(x.harness().prepare()); assert.equal(x.posts(), 1);
    } finally { await x.cleanup(); }
  }
});

test('expired, missing or ambiguous recovery evidence remains unknown with no automatic renewal or second POST', async () => {
  for (const point of ['no wire', 'expiry', 'canceled', 'paid', 'wrong quote', 'stale revision'] as const) {
    const x = await fixture();
    try {
      if (point === 'no wire') x.credentials(async () => { throw Error('no send'); }); else x.lose();
      await assert.rejects(x.harness().prepare()); const record = x.record(); const swap = x.store.read().swaps[record.swapId!]!;
      if (point === 'expiry') x.setTime(x.approval.expiresAt + 1);
      if (point === 'canceled') x.invoice.state = 'CANCELED';
      if (point === 'paid') x.invoice.amt_paid_sat = '1';
      if (point === 'wrong quote') await x.store.transaction(db => { db.swaps[swap.id]!.quote.id = randomUUID(); });
      await assert.rejects(x.harness().recover(swap.revision + (point === 'stale revision' ? 1 : 0)));
      assert.equal(x.record().executionRequest, undefined); assert.equal(x.calls(), 1); assert.equal(x.posts(), point === 'no wire' ? 0 : 1);
      assert.equal(Object.keys(x.store.read().quotes).length, 1);
    } finally { await x.cleanup(); }
  }
});

test('transport guard cannot be omitted or used twice to obtain a prepared invoice', async () => {
  for (const point of ['omitted', 'repeated'] as const) {
    const x = await fixture();
    try {
      if (point === 'omitted') x.omitGuard(); else x.repeatGuard();
      await assert.rejects(x.harness().prepare()); assert.equal(x.record().status, 'UNKNOWN');
      await assert.rejects(x.harness().prepare()); assert.equal(x.calls(), 1); assert.equal(x.posts(), 0);
    } finally { await x.cleanup(); }
  }
});

test('actor changes after the remote POST survive publication and failure cleanup', async () => {
  const x = await fixture();
  try {
    x.reply(async () => {
      const swap = x.store.read().swaps[x.record().swapId!]!;
      await updateSwapRevision(x.store, swap.id, swap.revision, s => { s.quote.expiresAt++; });
    });
    await assert.rejects(x.harness().prepare()); const swap = x.store.read().swaps[x.record().swapId!]!;
    assert.equal(swap.pendingAction, 'CREATE_INVOICE'); assert.equal(swap.invoice, undefined);
    assert.equal(swap.quote.expiresAt, x.record().plan!.quote.expiresAt + 1); assert.equal(x.posts(), 1);
    await assert.rejects(x.harness().prepare()); assert.equal(x.calls(), 1);
  } finally { await x.cleanup(); }
});

test('existing hashes, uncertain absence and a competing invoice during credential loading never authorize creation', async () => {
  for (const point of ['present', 'unknown', 'lookup failure', 'changed before wire'] as const) {
    const x = await fixture();
    try {
      if (point === 'present') x.adapters.invoiceStatus = async () => 'PRESENT';
      if (point === 'unknown') x.adapters.invoiceStatus = async () => 'UNKNOWN';
      if (point === 'lookup failure') x.adapters.invoiceStatus = async () => { throw Error('secret-response'); };
      if (point === 'changed before wire') x.credentials(async () => { x.adapters.invoiceStatus = async () => 'PRESENT'; });
      await assert.rejects(x.harness().prepare(), e => !String(e).includes('secret-response'));
      assert.equal(x.posts(), 0); await assert.rejects(x.harness().prepare());
      assert.equal(x.calls(), point === 'changed before wire' ? 1 : 0);
    } finally { await x.cleanup(); }
  }
});

test('a READY request is rechecked without extending expiry or trusting changed invoice or funding evidence', async () => {
  for (const point of ['expired request', 'canceled invoice', 'changed request', 'funding amount', 'malformed funding flag', 'stale revision'] as const) {
    const x = await fixture();
    try {
      const prepared = await x.harness().prepare(); const request = structuredClone(x.record().executionRequest);
      if (point === 'expired request') x.setTime(prepared.request.expiresAt + 1);
      if (point === 'canceled invoice') x.invoice.state = 'CANCELED';
      if (point === 'changed request') x.invoice.payment_request = 'lnbcrt' + 'b'.repeat(30);
      if (point === 'funding amount') x.inspect(async result => { result.funding.valueSats++; });
      if (point === 'malformed funding flag') x.inspect(async result => { result.funding.safe = 'true' as never; });
      if (point === 'stale revision') await assert.rejects(x.harness().recover(prepared.request.expectedRevision + 1));
      else await assert.rejects(x.harness().prepare());
      assert.deepEqual(x.record().executionRequest, request); assert.equal(x.posts(), 1); assert.equal(x.calls(), 1);
      assert.equal(Object.keys(x.store.read().quotes).length, 1);
    } finally { await x.cleanup(); }
  }
});

test('recovery fences a creator whose POST reply is still pending and preserves the recovered journal', async () => {
  const x = await fixture(); let release!: () => void;
  try {
    let reached!: () => void; const posted = new Promise<void>(resolve => { reached = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    x.reply(async () => { reached(); await gate; });
    const creating = x.harness().prepare(); void creating.catch(() => {}); await posted;
    const pending = x.store.read().swaps[x.record().swapId!]!;
    const recovered = await x.harness().recover(pending.revision); const before = x.store.read();
    release(); await assert.rejects(creating);
    assert.deepEqual(x.store.read().swaps, before.swaps); assert.equal(x.record().status, 'READY');
    assert.deepEqual(x.record().executionRequest, recovered.request); assert.equal(x.posts(), 1);
  } finally { release?.(); await x.cleanup(); }
});

test('two evidence recoveries cannot both adopt the same uncertain invoice revision', async () => {
  const x = await fixture();
  try {
    x.lose(); await assert.rejects(x.harness().prepare()); const revision = x.store.read().swaps[x.record().swapId!]!.revision;
    const results = await Promise.allSettled([x.harness().recover(revision), x.harness().recover(revision)]);
    assert.equal(results.filter(r => r.status === 'fulfilled').length, 1); assert.equal(x.record().status, 'READY');
    assert.equal(x.posts(), 1); assert.equal(x.calls(), 1);
  } finally { await x.cleanup(); }
});

test('quote expiry after invoice creation leaves evidence but cannot mint or renew an execution request', async () => {
  const x = await fixture();
  try {
    x.inspect(async () => { x.setTime(x.approval.expiresAt + 1); });
    await assert.rejects(x.harness().prepare()); const swap = x.store.read().swaps[x.record().swapId!]!;
    assert.equal(swap.state, 'INVOICE_CREATED'); assert.equal(x.record().executionRequest, undefined);
    await x.reopen(); await assert.rejects(x.harness().recover(swap.revision));
    assert.equal(Object.keys(x.store.read().quotes).length, 1); assert.equal(x.posts(), 1);
  } finally { await x.cleanup(); }
});

test('persisted routing substitutions and later swap revision conflicts cannot publish a ready request', async () => {
  for (const point of ['routing', 'after readiness'] as const) {
    const x = await fixture();
    try {
      if (point === 'routing') x.credentials(async () => { await x.store.transaction(db => {
        db.reversePreparations![x.spec.id]!.plan!.routing.channelId = '67890';
      }); });
      else x.inspect(async () => {
        const swap = x.store.read().swaps[x.record().swapId!]!;
        await updateSwapRevision(x.store, swap.id, swap.revision, s => { s.updatedAt++; });
      });
      await assert.rejects(x.harness().prepare()); assert.equal(x.record().executionRequest, undefined);
      assert.equal(x.posts(), point === 'routing' ? 0 : 1);
    } finally { await x.cleanup(); }
  }
});

test('the prepared exact quote and digest reach the existing backend readiness gate without any payment capability', async () => {
  const x = await fixture();
  try {
    const result = await x.harness().prepare(); let reached = 0;
    const blocked = async (): Promise<never> => { throw Error('money actions absent from test'); };
    const backend = createControlledReverseBackend(x.store, result.plan, result.input, {
      ports: { assertRegtest: async () => {}, invoice: blocked, tip: blocked, confirmed: blocked,
        createInvoice: blocked, prepareLockup: blocked, broadcast: blocked, settle: blocked, cancel: blocked },
      controls: { claimDestination: result.plan.claimDestination, startPayment: blocked, waitAccepted: blocked,
        signClaim: blocked, broadcastClaim: blocked, findClaim: blocked },
      inspect: async () => { reached++; throw Error('offline-readiness-boundary'); }, mineOne: blocked,
    }, result.request); // Explicit installation is test-local; the preparation harness never installs it.
    await assert.rejects(backend.execute(result.request.swapId, result.request.expectedRevision), /offline-readiness-boundary/);
    assert.equal(reached, 1); assert.equal(x.store.read().controlledExecutions, undefined);
    assert.equal(x.store.read().swaps[result.request.swapId]!.clientPayment, undefined);
  } finally { await x.cleanup(); }
});

test('invoice changes during concrete readiness cannot survive the final evidence pass', async () => {
  const x = await fixture();
  try {
    x.inspect(async () => { x.invoice.state = 'CANCELED'; });
    await assert.rejects(x.harness().prepare()); assert.equal(x.record().executionRequest, undefined);
    assert.equal(x.posts(), 1); await assert.rejects(x.harness().prepare()); assert.equal(x.calls(), 1);
  } finally { await x.cleanup(); }
});

test('an uncertain committed quote is retained across restart without another quote, swap or invoice', async () => {
  const x = await fixture();
  try {
    const transaction = x.store.transaction.bind(x.store); let lost = false;
    x.store.transaction = async fn => {
      const result = await transaction(fn); const db = x.store.read();
      if (!lost && Object.keys(db.quotes).length === 1 && !db.reversePreparations?.[x.spec.id]?.plan && !Object.keys(db.swaps).length) {
        lost = true; throw Error('simulated acknowledgement loss after durable quote');
      }
      return result;
    };
    await assert.rejects(x.harness().prepare()); assert.equal(lost, true);
    await x.reopen(); await assert.rejects(x.harness().prepare()); await assert.rejects(x.harness().recover(0));
    assert.equal(Object.keys(x.store.read().quotes).length, 1); assert.deepEqual(x.store.read().swaps, {});
    assert.equal(x.calls(), 0); assert.equal(x.posts(), 0); assert.equal(x.record().status, 'UNKNOWN');
  } finally { await x.cleanup(); }
});

test('the invoice transport receives an immutable exact amount/hash request', async () => {
  const x = await fixture();
  try {
    x.adapters.createInvoice = async request => {
      assert.equal(Object.isFrozen(request), true);
      Object.assign(request, { sats: 1 }); throw Error('must not reach send');
    };
    await assert.rejects(x.harness().prepare()); assert.equal(x.posts(), 0);
    assert.equal(x.record().invoiceAttempt!.wireAuthorized, false);
    await assert.rejects(x.harness().prepare()); assert.equal(x.record().executionRequest, undefined);
  } finally { await x.cleanup(); }
});
