import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ClientRequest, IncomingMessage } from 'node:http';
import { randomUUID } from 'node:crypto';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { ControlledLndPayer } from '../src/lightning/ControlledLndPayer.js';
import { HttpsLndPaymentTransport, trackPaymentPath, type PaymentTransportIO } from '../src/lightning/LndPaymentTransport.js';
import { createControlledReverseBackend, controlledRunDigest, type ControlledRunApproval } from '../src/core/ControlledReverseBackend.js';
import { createReverseTestPlan } from '../src/core/ReverseTestPlan.js';
import { SwapCoordinator } from '../src/core/SwapCoordinator.js';
import { Store } from '../src/persistence/Store.js';
import { updateSwapRevision } from '../src/core/SwapStateMachine.js';
import { createClaim } from '../src/bitcoin/ClaimManager.js';
import { Transaction } from 'bitcoinjs-lib';
import { setup, routingFixture } from './helpers.js';

async function fixture(deadlineMs = 1000) {
  const f = await setup(); let store = f.store; let held = false; let tip = 100;
  const invoice = 'lnbcrt' + 'a'.repeat(30);
  const originalLookup = f.ports.invoice;
  f.ports.createInvoice = async () => invoice;
  f.ports.invoice = async hash => ({ ...await originalLookup(hash), payment_request: invoice,
    ...(!held ? { state: 'OPEN' as const, amt_paid_sat: '0', htlcs: [] } : {}) });
  f.ports.tip = async () => tip;
  await new SwapCoordinator(store, f.ports).issueInvoice(f.swap.id);
  const initial = f.manager.get(f.swap.id)!;
  const plan = createReverseTestPlan(f.quote, 100, { paymentHash: f.contract.paymentHash, claimPublicKey: f.contract.claimPublicKey },
    f.contract.refundPublicKey, { claim: f.destination, refund: f.destination },
    { provider: f.contract.claimPublicKey, payer: f.contract.refundPublicKey }, routingFixture(), 'lqwd-lab');
  const input = { txid: 'ab'.repeat(32), vout: 0 }; const isolationId = randomUUID();
  const approval: ControlledRunApproval = { id: randomUUID(), swapId: f.swap.id, isolationId,
    expectedRevision: initial.revision, planDigest: controlledRunDigest(plan, input, f.swap.id, isolationId),
    scope: 'isolated-regtest-reverse', expiresAt: Date.now() + 60000, maxBlocks: 2 };
  const info = { identity_pubkey: plan.payerNode, synced_to_chain: true, wallet_synced: true,
    chains: [{ chain: 'bitcoin', network: 'regtest' }] };
  const decoded = { destination: plan.providerNode, payment_hash: plan.contract.paymentHash, num_satoshis: '50750',
    num_msat: '50750000', timestamp: String(Math.floor(Date.now() / 1000)), expiry: '3600', cltv_expiry: '80' };
  const reads: string[] = [];
  const channels = { channels: [{ active: true, chan_id: plan.routing.channelId, channel_point: plan.routing.channelPoint,
    remote_pubkey: plan.providerNode, zero_conf: false }] };
  const reader = { origin: 'https://127.0.0.1:8081', async call<T>(path: string): Promise<T> {
    reads.push(path); if (path === '/v1/getinfo') return structuredClone(info) as T;
    if (path === '/v1/channels') return structuredClone(channels) as T;
    assert.equal(path, `/v1/payreq/${invoice}`); return structuredClone(decoded) as T;
  } };
  const responses: PassThrough[] = []; const requests: Array<{ url: URL; options: Parameters<PaymentTransportIO['request']>[1]; body?: string; destroyed: boolean }> = [];
  let responseStatus = 200;
  let onRequest: (response: PassThrough) => void = response => { held = true; response.write(frame('IN_FLIGHT')); };
  let credentials = async () => {
    // Prove the on-disk attempt is committed before credential loading / transport creation.
    const db = JSON.parse(await readFile(join(f.directory, 'state.json'), 'utf8'));
    if (!requests.length) assert.equal(db.controlledExecutions[approval.id].payerSend.status, 'INTENT');
    return { ca: Buffer.from('synthetic-ca'), macaroon: Buffer.from('synthetic-test-token') };
  };
  const io: PaymentTransportIO = { credentials: () => credentials(), request: (url, options, callback) => {
    const entry = { url, options, body: undefined as string | undefined, destroyed: false }; requests.push(entry);
    const request = new EventEmitter() as ClientRequest;
    const response = new PassThrough(); Object.assign(response, { statusCode: responseStatus }); responses.push(response);
    request.destroy = () => { entry.destroyed = true; response.destroy(); return request; };
    request.end = ((body?: string) => {
      entry.body = body;
      callback(response as unknown as IncomingMessage);
      queueMicrotask(() => onRequest(response)); return request;
    }) as ClientRequest['end'];
    return request;
  } };
  const frame = (status: string, patch: Record<string, unknown> = {}) => JSON.stringify({ result: {
    payment_hash: f.contract.paymentHash, status, value_sat: '50750', value_msat: '50750000', fee_sat: '0', fee_msat: '0',
    failure_reason: status === 'FAILED' ? 'FAILURE_REASON_TIMEOUT' : 'FAILURE_REASON_NONE',
    ...(status === 'SUCCEEDED' ? { payment_preimage: f.preimage } : {}), ...patch,
    htlcs: status === 'INITIATED' ? [] : [{ attempt_id: '1', status, route: { total_amt_msat: '50750000', total_fees_msat: '0',
      hops: [{ chan_id: plan.routing.channelId, pub_key: plan.providerNode, amt_to_forward_msat: '50750000', fee_msat: '0' }] } }],
    ...(patch.htlcs !== undefined ? { htlcs: patch.htlcs } : {}),
  } }) + '\n';
  const payer = (guard?: () => void) => new ControlledLndPayer(store, plan, input, approval, reader, { origin: plan.routing.providerOrigin, lookup: hash => f.ports.invoice(hash) },
    new HttpsLndPaymentTransport('https://127.0.0.1:8081', 'never-read', 'never-read', io), deadlineMs, 1, guard);
  const reserve = async () => {
    await store.transaction(db => { (db.controlledExecutions ??= {})[approval.id] = { swapId: f.swap.id,
      planDigest: approval.planDigest, isolationId, status: 'INTENT', blocksRequested: 0 }; });
    await store.transaction(db => { Object.assign(db.controlledExecutions![approval.id]!, {
      routing: plan.routing, providerNode: plan.providerNode, payerNode: plan.payerNode }); });
    await updateSwapRevision(store, f.swap.id, initial.revision, s => {
      s.clientPayment = { hash: f.contract.paymentHash, status: 'INTENT', feeLimitSats: 100 };
    });
  };
  return { f, initial, plan, input, approval, info, channels, decoded, reader, requests, responses, reads, frame, payer, reserve,
    get store() { return store; }, setScript: (script: typeof onRequest) => { onRequest = script; },
    setStatus: (status: number) => { responseStatus = status; },
    setCredentials: (loader: typeof credentials) => { credentials = loader; },
    getRecord: () => store.read().controlledExecutions![approval.id]!,
    mine: async (txid: string) => { tip++; f.ledger.get(txid)!.confirmations = 1; },
    reopen: async () => { await store.close(); store = await Store.open(f.directory); },
    cleanup: async () => { await store.close(); await rm(f.directory, { recursive: true }); } };
}

test('real HTTPS request contract sends once asynchronously with TLS verification, fee bound and no remote cancellation', async () => {
  const x = await fixture();
  try {
    await x.reserve(); const client = x.payer(); const handle = await client.startPayment(x.initial);
    await client.waitAccepted(x.initial);
    assert.equal(x.requests.length, 1);
    const request = x.requests[0]!;
    assert.equal(request.url.href, 'https://127.0.0.1:8081/v2/router/send');
    assert.equal(request.options.method, 'POST'); assert.equal(request.options.rejectUnauthorized, true);
    assert.deepEqual(JSON.parse(request.body!), { payment_request: x.initial.invoice, timeout_seconds: 60, fee_limit_sat: '100',
      max_parts: 16, no_inflight_updates: false, allow_self_payment: false, amp: false, cancelable: false,
      outgoing_chan_ids: [x.plan.routing.channelId] });
    const line = x.frame('SUCCEEDED');
    x.responses[0]!.write(line.slice(0, 7)); x.responses[0]!.write(line.slice(7));
    const paid = await handle.result;
    assert.deepEqual(paid, { hash: x.f.contract.paymentHash, status: 'SUCCEEDED', valueSats: 50750, feeSats: 0 });
    assert.equal(x.getRecord().payerSend!.status, 'SUCCEEDED');
    assert.equal(JSON.stringify(paid).includes(x.f.preimage), false);
    handle.stopClient(); handle.stopClient(); assert.equal(x.requests.length, 1);
    await assert.rejects(x.payer().startPayment(x.initial), /reconcile instead of retrying/);
    assert.equal((await readFile(join(x.f.directory, 'state.json'), 'utf8')).includes(x.f.preimage), false);
  } finally { await x.cleanup(); }
});

test('execution guard expiring during credential loading prevents the actual POST and retains uncertain one-shot intent', async () => {
  const x = await fixture(); try {
    await x.reserve(); let expired = false;
    x.setCredentials(async () => { expired = true; return { ca: Buffer.from('synthetic'), macaroon: Buffer.from('synthetic') }; });
    const client = x.payer(() => { if (expired) throw Error('execution deadline expired'); });
    const handle = await client.startPayment(x.initial); await assert.rejects(handle.result);
    assert.equal(x.requests.length, 0); assert.equal(x.getRecord().payerSend!.status, 'UNKNOWN');
    await x.reopen(); await assert.rejects(x.payer().startPayment(x.initial)); assert.equal(x.requests.length, 0);
  } finally { await x.cleanup(); }
});

test('runtime observation shutdown closes local streams without a remote cancellation or payment retry', async () => {
  const x = await fixture(); try {
    await x.reserve(); const client = x.payer(); const handle = await client.startPayment(x.initial);
    await client.waitAccepted(x.initial); client.stopObservations(); client.stopObservations(); await assert.rejects(handle.result);
    assert.equal(x.requests.length, 1); assert.equal(x.requests[0]!.destroyed, true);
    assert.equal(JSON.parse(x.requests[0]!.body!).cancelable, false);
    assert.equal(x.getRecord().payerSend!.status, 'UNKNOWN');
    await assert.rejects(x.payer().startPayment(x.initial)); assert.equal(x.requests.length, 1);
  } finally { await x.cleanup(); }
});

test('client cancellation closes the connection, persists uncertainty and restart only permits GET tracking', async () => {
  const x = await fixture();
  try {
    await x.reserve(); const client = x.payer(); const handle = await client.startPayment(x.initial);
    await client.waitAccepted(x.initial); handle.stopClient();
    await assert.rejects(handle.result, /uncertain or failed/);
    assert.equal(x.requests[0]!.destroyed, true); assert.equal(x.getRecord().payerSend!.status, 'UNKNOWN');
    await x.reopen();
    await assert.rejects(x.payer().startPayment(x.initial), /reconcile instead of retrying/);
    const saved = x.getRecord();
    x.setScript(response => { response.write(x.frame('SUCCEEDED')); });
    const tracked = await x.payer().trackExisting(x.f.contract.paymentHash).result;
    assert.equal(tracked.status, 'SUCCEEDED');
    assert.equal(x.requests.length, 2);
    assert.equal(x.requests[1]!.options.method, 'GET'); assert.equal(x.requests[1]!.body, undefined);
    assert.equal(x.requests[1]!.url.pathname + x.requests[1]!.url.search, trackPaymentPath(x.f.contract.paymentHash));
    assert.deepEqual(x.getRecord(), saved); // Tracking observes; it does not clear an ambiguous intent.
  } finally { await x.cleanup(); }
});

test('an orphaned INTENT after a simulated crash allows tracking but never another send', async () => {
  const x = await fixture();
  try {
    await x.reserve();
    await x.store.transaction(db => { db.controlledExecutions![x.approval.id]!.payerSend = {
      attemptId: randomUUID(), hash: x.f.contract.paymentHash, status: 'INTENT' }; });
    await x.reopen();
    const saved = x.getRecord();
    const client = x.payer();
    await assert.rejects(client.startPayment(x.initial), /reconcile instead of retrying/);
    x.setScript(response => { response.write(x.frame('SUCCEEDED')); });
    assert.equal((await client.trackExisting(x.f.contract.paymentHash).result).status, 'SUCCEEDED');
    assert.equal(x.requests.length, 1); assert.equal(x.requests[0]!.options.method, 'GET');
    assert.deepEqual(x.getRecord(), saved);
  } finally { await x.cleanup(); }
});

test('HTTP errors, EOF, truncated frames, oversized data, invalid evidence and failed payments never retry', async () => {
  const scripts: Array<(x: Awaited<ReturnType<typeof fixture>>, response: PassThrough) => void> = [
    (_x, response) => response.end(), (x, response) => response.end(x.frame('SUCCEEDED').trim()),
    (_x, response) => response.write('x'.repeat(262145)),
    (_x, response) => response.write('{"error":{"message":"do-not-echo"}}\n'),
    (x, response) => response.write(x.frame('SUCCEEDED', { payment_hash: '00'.repeat(32) })),
    (x, response) => response.write(x.frame('SUCCEEDED', { value_msat: '50750001' })),
    (x, response) => response.write(x.frame('SUCCEEDED', { fee_sat: '100', fee_msat: '100001' })),
    (x, response) => response.write(x.frame('SUCCEEDED', { payment_preimage: '00'.repeat(32) })),
    (x, response) => response.write(x.frame('UNKNOWN')),
    (x, response) => response.write(x.frame('FAILED')),
    (x, response) => response.write(x.frame('FAILED', { failure_reason: 'FUTURE_UNSUPPORTED' })),
    (x, response) => { response.write(x.frame('IN_FLIGHT')); response.write(x.frame('INITIATED')); },
    (x, response) => { for (let i = 0; i < 129; i++) response.write(x.frame('IN_FLIGHT')); },
    (_x, response) => response.emit('error', new Error('do-not-echo')),
  ];
  for (const script of scripts) {
    const x = await fixture();
    try {
      await x.reserve(); x.setScript(response => script(x, response));
      const client = x.payer(); const handle = await client.startPayment(x.initial);
      await assert.rejects(handle.result, error => /uncertain or failed/.test(String(error)) && !String(error).includes('do-not-echo'));
      await assert.rejects(client.waitAccepted(x.initial));
      await assert.rejects(x.payer().startPayment(x.initial));
      assert.equal(x.requests.length, 1);
      assert.ok(['UNKNOWN', 'FAILED'].includes(x.getRecord().payerSend!.status));
    } finally { await x.cleanup(); }
  }
});

test('absolute timeout also bounds silent streams and in-flight observation', async t => {
  const x = await fixture(30);
  try {
    await x.reserve();
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const reached = new EventEmitter(); const connected = once(reached, 'connected');
    x.setScript(() => { reached.emit('connected'); });
    const client = x.payer(); const handle = await client.startPayment(x.initial);
    await connected; // Start the silent-stream deadline check after asynchronous preflight and disk IO.
    t.mock.timers.tick(31);
    await assert.rejects(client.waitAccepted(x.initial));
    await assert.rejects(handle.result);
    assert.equal(x.requests.length, 1); assert.equal(x.requests[0]!.destroyed, true);
    assert.equal(x.getRecord().payerSend!.status, 'UNKNOWN');
  } finally { await x.cleanup(); }
});

test('HTTP status rejection and substituted invoice decoding produce no success or send retry', async () => {
  for (const point of ['http', 'decode'] as const) {
    const x = await fixture();
    try {
      await x.reserve();
      if (point === 'http') { x.setStatus(503); x.setScript(() => {}); }
      else x.decoded.payment_hash = '00'.repeat(32);
      const handle = await x.payer().startPayment(x.initial);
      await assert.rejects(handle.result, /uncertain or failed/);
      assert.equal(x.requests.length, point === 'http' ? 1 : 0);
      assert.equal(x.getRecord().payerSend!.status, 'UNKNOWN');
      await assert.rejects(x.payer().startPayment(x.initial));
    } finally { await x.cleanup(); }
  }
});

test('stop or journal conflict while credentials load prevents the later POST', async () => {
  for (const point of ['stop', 'conflict'] as const) {
    const x = await fixture();
    let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
    const reached = new EventEmitter();
    try {
      await x.reserve();
      x.setCredentials(async () => { reached.emit('load'); await gate; return { ca: Buffer.from('fake'), macaroon: Buffer.from('fake') }; });
      const loaded = once(reached, 'load'); const handle = await x.payer().startPayment(x.initial); await loaded;
      if (point === 'stop') handle.stopClient();
      else await x.store.transaction(db => { db.swaps[x.f.swap.id]!.clientPayment!.status = 'FAILED'; });
      release(); await assert.rejects(handle.result);
      assert.equal(x.requests.length, 0); assert.equal(x.getRecord().payerSend!.status, 'UNKNOWN');
    } finally { release(); await x.cleanup(); }
  }
});

test('missing intents and payer/decode identity mismatches cannot reach the send transport', async () => {
  const x = await fixture();
  try {
    await assert.rejects(x.payer().startPayment(x.initial)); assert.equal(x.requests.length, 0);
    await x.reserve(); x.info.identity_pubkey = x.plan.providerNode;
    const handle = await x.payer().startPayment(x.initial); await assert.rejects(handle.result);
    assert.equal(x.requests.length, 0); assert.equal(x.getRecord().payerSend!.status, 'UNKNOWN');
  } finally { await x.cleanup(); }
});

test('payer inspection cannot authorize a different send endpoint', async () => {
  const x = await fixture();
  try {
    x.reader.origin = 'https://127.0.0.1:8082';
    assert.throws(() => x.payer(), /endpoints must match/);
    assert.equal(x.requests.length, 0);
    assert.equal(x.store.read().controlledExecutions, undefined);
  } finally { await x.cleanup(); }
});

test('concurrent adapter instances consume the durable send intent only once', async () => {
  const x = await fixture();
  try {
    await x.reserve();
    const results = await Promise.allSettled([x.payer().startPayment(x.initial), x.payer().startPayment(x.initial)]);
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    const handle = (results.find(result => result.status === 'fulfilled') as PromiseFulfilledResult<Awaited<ReturnType<ControlledLndPayer['startPayment']>>>).value;
    handle.stopClient(); await assert.rejects(handle.result);
    assert.ok(x.requests.length <= 1); assert.equal(x.getRecord().payerSend!.status, 'UNKNOWN');
  } finally { await x.cleanup(); }
});

test('controlled backend and existing runner complete against the real payer transport with mocked LND frames', async () => {
  const x = await fixture();
  try {
    const payer = x.payer(); const settle = x.f.ports.settle;
    x.f.ports.settle = async preimage => { await settle(preimage); x.responses[0]!.write(x.frame('SUCCEEDED')); };
    const backend = createControlledReverseBackend(x.store, x.plan, x.input, { ports: x.f.ports,
      inspect: async () => ({ network: 'regtest', isolationId: x.approval.isolationId, providerNode: x.plan.providerNode,
        payerNode: x.plan.payerNode, tipHeight: 100, claimPublicKey: x.plan.contract.claimPublicKey,
        refundPublicKey: x.plan.contract.refundPublicKey, paymentHash: x.plan.contract.paymentHash,
        funding: { ...x.input, confirmed: true, safe: true, spendable: true, valueSats: 100000 }, decodedInvoice: x.decoded }),
      mineOne: x.mine, controls: { claimDestination: x.f.destination,
        startPayment: swap => payer.startPayment(swap), waitAccepted: swap => payer.waitAccepted(swap),
        signClaim: async () => createClaim(x.f.spend, x.f.preimage),
        broadcastClaim: async raw => { const tx = Transaction.fromHex(raw); x.f.ledger.set(tx.getId(), { hex: raw, confirmations: 0 }); return tx.getId(); },
        findClaim: async swap => swap.clientClaimIntent!.txid },
    }, x.approval);
    const result = await backend.execute(x.f.swap.id, x.approval.expectedRevision);
    assert.equal(result.state, 'COMPLETED'); assert.equal(x.getRecord().payerSend!.status, 'SUCCEEDED');
    assert.equal(x.requests.length, 1); assert.equal(x.f.calls.settle, 1);
    await assert.rejects(backend.execute(x.f.swap.id, x.approval.expectedRevision));
    assert.equal(x.requests.length, 1);
  } finally { await x.cleanup(); }
});

test('missing, duplicate, changed or inactive approved channels never reach the payer POST', async () => {
  for (const point of ['missing', 'duplicate', 'point', 'peer', 'inactive', 'legacy journal'] as const) {
    const x = await fixture();
    try {
      await x.reserve();
      if (point === 'missing') x.channels.channels.length = 0;
      if (point === 'duplicate') x.channels.channels.push({ ...x.channels.channels[0]! });
      if (point === 'point') x.channels.channels[0]!.channel_point = 'aa'.repeat(32) + ':0';
      if (point === 'peer') x.channels.channels[0]!.remote_pubkey = x.plan.payerNode;
      if (point === 'inactive') x.channels.channels[0]!.active = false;
      if (point === 'legacy journal') {
        await x.store.transaction(db => { delete db.controlledExecutions![x.approval.id]!.routing; });
        await assert.rejects(x.payer().startPayment(x.initial), /routing context/);
      } else await assert.rejects((await x.payer().startPayment(x.initial)).result);
      assert.equal(x.requests.length, 0);
    } finally { await x.cleanup(); }
  }
});

test('channel changes after credentials load and matching but unapproved endpoints cannot bypass authorization', async () => {
  const x = await fixture();
  try {
    await x.reserve();
    x.setCredentials(async () => {
      x.channels.channels[0]!.channel_point = 'aa'.repeat(32) + ':0';
      return { ca: Buffer.from('fake'), macaroon: Buffer.from('fake') };
    });
    await assert.rejects((await x.payer().startPayment(x.initial)).result);
    assert.equal(x.requests.length, 0);
    x.reader.origin = 'https://127.0.0.1:8082';
    assert.throws(() => new ControlledLndPayer(x.store, x.plan, x.input, x.approval, x.reader,
      { origin: x.plan.routing.providerOrigin, lookup: hash => x.f.ports.invoice(hash) },
      { origin: x.reader.origin, stream: async () => { throw new Error('must never execute'); } }), /approved plan/);
    assert.throws(() => new ControlledLndPayer(x.store, { ...x.plan, routing: { ...x.plan.routing, channelId: '67890' } },
      x.input, x.approval, { ...x.reader, origin: x.plan.routing.payerOrigin },
      { origin: x.plan.routing.providerOrigin, lookup: hash => x.f.ports.invoice(hash) },
      { origin: x.plan.routing.payerOrigin, stream: async () => {} }), /authorization/);
  } finally { await x.cleanup(); }
});

test('unsupported or ambiguous first-hop evidence cannot complete or enable another send', async () => {
  const x0 = await fixture();
  const valid = JSON.parse(x0.frame('SUCCEEDED')).result.htlcs;
  await x0.cleanup();
  for (const point of ['missing', 'wrong channel', 'wrong peer', 'extra hop', 'amount', 'duplicate attempt', 'partial', 'still inflight', 'fee'] as const) {
    const x = await fixture();
    try {
      await x.reserve();
      const rows = structuredClone(valid);
      rows[0].route.hops[0].pub_key = x.plan.providerNode;
      if (point === 'missing') rows.length = 0;
      if (point === 'wrong channel') rows[0].route.hops[0].chan_id = '67890';
      if (point === 'wrong peer') rows[0].route.hops[0].pub_key = x.plan.payerNode;
      if (point === 'extra hop') rows[0].route.hops.push({ ...rows[0].route.hops[0] });
      if (point === 'amount') rows[0].route.total_amt_msat = '50750001';
      if (point === 'duplicate attempt') rows.push(structuredClone(rows[0]));
      if (point === 'partial') { rows[0].route.total_amt_msat = '1'; rows[0].route.hops[0].amt_to_forward_msat = '1'; }
      if (point === 'still inflight') rows[0].status = 'IN_FLIGHT';
      if (point === 'fee') rows[0].route.total_fees_msat = '1';
      x.setScript(response => { response.write(x.frame('SUCCEEDED', { htlcs: rows })); });
      await assert.rejects((await x.payer().startPayment(x.initial)).result);
      await assert.rejects(x.payer().startPayment(x.initial));
      assert.equal(x.requests.length, 1); assert.equal(x.getRecord().payerSend!.status, 'UNKNOWN');
    } finally { await x.cleanup(); }
  }
});

test('transport refuses omitted or broadened outgoing channel restrictions before credential reads', async () => {
  let reads = 0;
  const transport = new HttpsLndPaymentTransport('https://127.0.0.1:8081', 'unused', 'unused', {
    credentials: async () => { reads++; throw new Error('must not read'); }, request: () => { throw new Error('must not request'); },
  });
  const base = { payment_request: 'lnbcrt' + 'a'.repeat(30), timeout_seconds: 60, fee_limit_sat: '100', max_parts: 16,
    no_inflight_updates: false, allow_self_payment: false, amp: false, cancelable: false };
  for (const ids of [undefined, [], ['12345', '67890'], ['0'], ['012345'], [12345], ['18446744073709551616']]) {
    await assert.rejects(transport.stream('/v2/router/send', { ...base, outgoing_chan_ids: ids }, () => false,
      new AbortController().signal), /operation disabled/);
  }
  assert.equal(reads, 0);
});

test('transport snapshots the restricted request before asynchronous preflight can mutate the caller body', async () => {
  const controller = new AbortController(); let sent: string | undefined;
  const body = { payment_request: 'lnbcrt' + 'a'.repeat(30), timeout_seconds: 60, fee_limit_sat: '100', max_parts: 16,
    no_inflight_updates: false, allow_self_payment: false, amp: false, cancelable: false, outgoing_chan_ids: ['12345'] };
  const transport = new HttpsLndPaymentTransport('https://127.0.0.1:8081', 'unused', 'unused', {
    credentials: async () => ({ ca: Buffer.from('fake'), macaroon: Buffer.from('fake') }),
    request: () => {
      const request = new EventEmitter() as ClientRequest;
      request.destroy = () => request;
      request.end = ((serialized?: string) => {
        sent = serialized; queueMicrotask(() => controller.abort()); return request;
      }) as ClientRequest['end'];
      return request;
    },
  });
  await assert.rejects(transport.stream('/v2/router/send', body, () => false, controller.signal,
    async () => { body.outgoing_chan_ids.length = 0; }));
  assert.deepEqual(JSON.parse(sent!).outgoing_chan_ids, ['12345']);
});
