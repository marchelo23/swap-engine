import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ClientRequest, IncomingMessage } from 'node:http';
import { randomUUID } from 'node:crypto';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { HttpsLndInvoiceTransport, type InvoiceTransportIO } from '../src/lightning/LndInvoiceTransport.js';
import { createLndReversePreparation, createLndJitReaders } from '../src/core/LndReversePreparation.js';
import { createJustInTimeReverse } from '../src/core/JustInTimeReverse.js';
import { preparationDigest, type PreparationSpec } from '../src/core/ReversePreparation.js';
import { BitcoinConfirmationLookup } from '../src/bitcoin/BitcoinConfirmationLookup.js';
import { Store } from '../src/persistence/Store.js';
import { readinessFixture } from './readinessFixture.js';

type Wire = { url: URL; options: Parameters<InvoiceTransportIO['request']>[1]; body?: string; destroyed: boolean };
type Reply = { status?: number; json?: unknown; text?: string; mime?: string; emit?: (response: PassThrough) => void };
const paymentHash = 'ab'.repeat(32);
const paymentRequest = 'lnbcrt' + 'a'.repeat(30);
const absence = { code: 5, message: 'unable to locate invoice', details: [] };
const invoice = (hash = paymentHash) => ({ state: 'OPEN', r_hash: Buffer.from(hash, 'hex').toString('base64'), value: '50750',
  amt_paid_sat: '0', payment_request: paymentRequest, htlcs: [], r_preimage: 'must-not-propagate' });

function httpFixture() {
  const wires: Wire[] = []; const credentials: string[] = []; const events = new EventEmitter();
  let readerHook = async () => {}; let writerHook = async () => {};
  let respond: (wire: Wire) => Reply = wire => wire.options.method === 'POST' ? { json: { payment_request: paymentRequest } } : { status: 404, json: absence };
  const io = (role: string): InvoiceTransportIO => ({
    credentials: async () => { credentials.push(role); events.emit(role); await (role === 'read' ? readerHook() : writerHook());
      return { ca: Buffer.from('synthetic-ca'), macaroon: Buffer.from(role) }; },
    request: (url, options, callback) => {
      const entry: Wire = { url, options, destroyed: false }; wires.push(entry);
      const req = new EventEmitter() as ClientRequest; const res = new PassThrough();
      req.destroy = () => { entry.destroyed = true; res.destroy(); return req; };
      req.end = ((body?: string) => {
        entry.body = body; const reply = respond(entry);
        Object.assign(res, { statusCode: reply.status ?? 200, headers: { 'content-type': reply.mime ?? 'application/json' } });
        callback(res as unknown as IncomingMessage); events.emit('connected');
        queueMicrotask(() => { if (reply.emit) reply.emit(res); else res.end(reply.text ?? JSON.stringify(reply.json ?? {})); }); return req;
      }) as ClientRequest['end'];
      return req;
    },
  });
  const reader = io('read'); const writer = io('write');
  return { wires, credentials, events, reader, writer,
    transport: (write = true, deadline = 30000) => new HttpsLndInvoiceTransport('https://127.0.0.1:8080', 'never-read', 'never-read', undefined,
      { reader, ...(write ? { writer } : {}) }, deadline),
    respond: (fn: typeof respond) => { respond = fn; }, read: (fn: typeof readerHook) => { readerHook = fn; }, write: (fn: typeof writerHook) => { writerHook = fn; } };
}
const request = () => ({ hash: paymentHash, sats: 50750 as const, expirySeconds: 3600 as const, cltvDelta: 80 as const });

test('guarded invoice transport sends the selected bounded Lightning debit exactly', async () => {
  for (const sats of [11000, 25000, 50000, 50750, 1000000]) {
    const x = httpFixture(); x.respond(() => ({ json: { payment_request: paymentRequest } }));
    await x.transport().create({ ...request(), sats }, async () => {});
    assert.equal(JSON.parse(x.wires[0]!.body!).value, String(sats));
  }
  const x = httpFixture();
  for (const sats of [10999, 1000001]) await assert.rejects(x.transport().create({ ...request(), sats }, async () => {}));
  assert.equal(x.wires.length, 0);
});

test('actual HTTPS unary contract creates exactly the guarded fixed hold invoice and projects only its request', async () => {
  const x = httpFixture(); let guards = 0;
  x.respond(() => ({ json: { payment_request: paymentRequest, add_index: '1', payment_addr: 'must-not-propagate' } }));
  const body = request(); const transport = x.transport();
  const creating = transport.create(body, async () => { guards++; assert.deepEqual(x.credentials, ['write']); assert.equal(x.wires.length, 0); });
  Object.assign(body, { sats: 1, hash: '00'.repeat(32) }); // Caller mutation cannot change the wire snapshot.
  assert.deepEqual(await creating, { payment_request: paymentRequest }); assert.equal(guards, 1);
  assert.equal(x.wires.length, 1); const wire = x.wires[0]!;
  assert.equal(wire.url.href, 'https://127.0.0.1:8080/v2/invoices/hodl');
  assert.equal(wire.options.method, 'POST'); assert.equal(wire.options.rejectUnauthorized, true);
  assert.deepEqual(wire.options.ca, Buffer.from('synthetic-ca'));
  assert.equal((wire.options.headers as Record<string, string>)['Grpc-Metadata-macaroon'], Buffer.from('write').toString('hex'));
  assert.deepEqual(JSON.parse(wire.body!), { hash: Buffer.from(paymentHash, 'hex').toString('base64'), value: '50750', expiry: '3600',
    cltv_expiry: '80', memo: 'LQWD regtest reverse swap' });
});

test('lookup recognizes only exact documented absence and sanitizes matching existing invoices', async () => {
  const x = httpFixture(); const transport = x.transport(false);
  for (const message of ['unable to locate invoice', 'there are no existing invoices']) {
    x.respond(() => ({ status: 404, json: { code: 5, message, details: [] } }));
    assert.deepEqual(await transport.lookup(paymentHash), { status: 'ABSENT' });
  }
  x.respond(() => ({ json: invoice() }));
  const found = await transport.lookup(paymentHash); assert.equal(found.status, 'PRESENT');
  assert.equal(JSON.stringify(found).includes('must-not-propagate'), false);
  assert.ok(x.credentials.every(role => role === 'read'));
  assert.ok(x.wires.every(w => w.options.method === 'GET' && w.body === undefined && w.url.pathname === `/v1/invoice/${paymentHash}`));
  await assert.rejects(transport.create(request(), async () => {})); assert.equal(x.wires.length, 3);
});

test('HTTP/authentication/proxy/status/identity errors are never classified as absence and never retried', async () => {
  const replies: Reply[] = [
    { status: 404, mime: 'text/html', text: '<html>not found</html>' }, { status: 404, json: {} },
    { status: 404, json: { code: 5, message: 'Not Found' } }, { status: 404, json: { code: '5', message: absence.message } },
    { status: 404, json: { ...absence, details: [{}] } }, { status: 404, json: { ...absence, extra: 'unsafe' } },
    ...[401, 403, 500, 302].map(status => ({ status, json: absence })),
    { json: absence }, { json: { error: 'secret-must-not-echo' } }, { json: invoice('cd'.repeat(32)) },
    { text: '' }, { text: '{' }, { text: 'x'.repeat(262145) },
    { emit: res => res.destroy(new Error('secret-must-not-echo')) },
  ];
  for (const reply of replies) {
    const x = httpFixture(); x.respond(() => reply);
    await assert.rejects(x.transport(false).lookup(paymentHash), e => !String(e).includes('secret-must-not-echo'));
    assert.equal(x.wires.length, 1); assert.deepEqual(x.credentials, ['read']);
  }
});

test('invalid requests, insecure endpoints, invalid bounds and missing guards fail before credentials', async () => {
  const x = httpFixture(); const transport = x.transport();
  for (const bad of [{ ...request(), sats: 1 }, { ...request(), expirySeconds: 1 }, { ...request(), cltvDelta: 79 },
    { ...request(), hash: 'AB'.repeat(32) }, { ...request(), preimage: 'not-allowed' }]) {
    await assert.rejects(transport.create(bad as never, async () => {}));
  }
  await assert.rejects(transport.create(request(), undefined as never)); await assert.rejects(transport.lookup('../pay'));
  for (const origin of ['http://127.0.0.1', 'https://example.com', 'https://' + 'user:password@127.0.0.1', 'https://127.0.0.1/path', 'https://127.0.0.1?query=1']) {
    assert.throws(() => new HttpsLndInvoiceTransport(origin, '', '', undefined, { reader: x.reader }));
  }
  assert.throws(() => x.transport(true, 60001)); assert.deepEqual(x.credentials, []); assert.deepEqual(x.wires, []);
});

test('bad POST replies, disconnects and failed guards provide uncertainty without a second request', async () => {
  for (const reply of [{ status: 500, json: { message: 'secret' } }, { json: { payment_request: 'lnbcwrong' } },
    { json: { payment_request: paymentRequest, error: 'secret' } }, { text: '{' }, { text: 'x'.repeat(262145) },
    { emit: (res: PassThrough) => res.destroy(new Error('secret')) }]) {
    const x = httpFixture(); x.respond(() => reply); let guards = 0;
    await assert.rejects(x.transport().create(request(), async () => { guards++; }), e => !String(e).includes('secret'));
    assert.equal(guards, 1); assert.equal(x.wires.length, 1);
  }
  const x = httpFixture(); await assert.rejects(x.transport().create(request(), async () => { throw Error('guard-secret'); }));
  assert.equal(x.wires.length, 0);
});

test('cancellation during credentials or guard work prevents any late POST', async () => {
  for (const point of ['credentials', 'guard'] as const) {
    const x = httpFixture(); const signal = new AbortController(); let release!: () => void; let reached!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; }); const entered = new Promise<void>(resolve => { reached = resolve; });
    if (point === 'credentials') x.write(async () => { reached(); await gate; });
    const result = x.transport().create(request(), async () => { if (point === 'guard') { reached(); await gate; } }, signal.signal);
    await entered; signal.abort(); await assert.rejects(result); release(); await new Promise(resolve => setImmediate(resolve));
    assert.equal(x.wires.length, 0);
  }
  const x = httpFixture(); const controller = new AbortController(); controller.abort();
  await assert.rejects(x.transport().lookup(paymentHash, controller.signal)); assert.equal(x.credentials.length, 0);
});

test('absolute deadline bounds silent responses as well as credentials before a wire request', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const x = httpFixture(); x.respond(() => ({ emit: () => {} })); const connected = once(x.events, 'connected');
  const result = x.transport(false, 30).lookup(paymentHash); await connected; t.mock.timers.tick(31);
  await assert.rejects(result); assert.equal(x.wires[0]!.destroyed, true);
  const y = httpFixture(); let release!: () => void; const entered = once(y.events, 'write');
  y.write(() => new Promise<void>(resolve => { release = resolve; }));
  const pending = y.transport(true, 30).create(request(), async () => {}); await entered; t.mock.timers.tick(31);
  await assert.rejects(pending); release(); await new Promise(resolve => setImmediate(resolve)); assert.equal(y.wires.length, 0);
});

async function concreteFixture(lostReply = false) {
  const x = await readinessFixture(); let store = x.f.store; let exists = false; let posts = 0;
  await store.transaction(db => { db.quotes = {}; db.swaps = {}; });
  const spec: PreparationSpec = { id: randomUUID(), isolationId: x.scope.isolationId, tipHeight: 100, wallet: 'lqwd-lab',
    providerNode: x.plan.providerNode, payerNode: x.plan.payerNode, routing: x.plan.routing,
    client: { paymentHash: x.keys.paymentHash, claimPublicKey: x.keys.claimPublicKey }, refundPublicKey: x.keys.refundPublicKey,
    claimDestination: x.plan.claimDestination, refundDestination: x.plan.refundDestination, input: { ...x.input, valueSats: 100000 } };
  const approval = { id: spec.id, scope: 'isolated-regtest-invoice-only' as const, specDigest: preparationDigest(spec), expiresAt: Date.now() + 120000 };
  const http = httpFixture();
  http.respond(wire => {
    if (wire.options.method === 'POST') {
      const record = store.read().reversePreparations![spec.id]!;
      assert.equal(record.invoiceAttempt!.wireAuthorized, true); posts++; exists = true;
      return lostReply ? { emit: response => response.destroy(new Error('synthetic-unknown')) } :
        { json: { payment_request: x.invoiceWire.payment_request, add_index: '1', payment_addr: 'must-not-propagate' } };
    }
    return exists ? { json: x.invoiceWire } : { status: 404, json: absence };
  });
  const transport = http.transport();
  const bitcoin = { ...x.bitcoin, confirmed: (id: string) => new BitcoinConfirmationLookup(x.bitcoin).confirmed(id) };
  const provider = { ...x.provider, assertRegtest: async () => ({ chains: [{ chain: 'bitcoin', network: 'regtest' }], synced_to_chain: true }) };
  const payer = { ...x.payer, assertRegtest: provider.assertRegtest };
  const clients = { bitcoin, provider, payer, invoices: transport, custody: x.custody };
  return { x, spec, approval, clients, http, posts: () => posts, get store() { return store; },
    prepare: () => createLndReversePreparation(store, spec, clients, approval, 'prepare'),
    recover: () => createLndReversePreparation(store, spec, { ...clients, invoices: http.transport(false) }, undefined, 'recover'),
    reopen: async () => { await store.close(); store = await Store.open(x.f.directory); },
    cleanup: async () => { await store.close(); await rm(x.f.directory, { recursive: true }); } };
}

test('concrete wiring uses the real inspector, custody and guarded HTTP contract while keeping execution absent', async () => {
  const c = await concreteFixture();
  try {
    const harness = c.prepare(); assert.ok('prepare' in harness);
    const result = await harness.prepare(); const swap = c.store.read().swaps[result.request.swapId]!;
    assert.deepEqual(result.plan.quote, swap.quote); assert.equal(swap.state, 'INVOICE_CREATED');
    assert.equal(c.posts(), 1); assert.equal(c.store.read().controlledExecutions, undefined);
    assert.deepEqual(c.x.f.calls, { funding: 0, broadcast: 0, settle: 0 });
    assert.equal(JSON.stringify(result).includes('must-not-propagate'), false);
    assert.equal((await readFile(join(c.x.f.directory, 'state.json'), 'utf8')).includes('not-returned'), false);
    assert.deepEqual(Object.keys(c.recover()), ['recover']);
    assert.deepEqual(await c.recover().recover(swap.revision), result); assert.equal(c.posts(), 1);
  } finally { await c.cleanup(); }
});

test('concrete lost HTTP reply survives reopen and permits only exact lookup adoption, never another invoice POST', async () => {
  const c = await concreteFixture(true);
  try {
    const creating = c.prepare(); assert.ok('prepare' in creating); await assert.rejects(creating.prepare());
    const state = c.store.read(); const record = state.reversePreparations![c.spec.id]!;
    assert.equal(record.status, 'UNKNOWN'); assert.equal(state.swaps[record.swapId!]!.pendingAction, 'CREATE_INVOICE');
    await c.reopen(); const repeated = c.prepare(); assert.ok('prepare' in repeated); await assert.rejects(repeated.prepare());
    const recovered = await c.recover().recover(state.swaps[record.swapId!]!.revision);
    assert.equal(recovered.status, 'PREPARED_UNPAID_NOT_AUTHORIZED'); assert.equal(c.posts(), 1);
    assert.equal(c.http.wires.filter(w => w.options.method === 'POST').length, 1);
  } finally { await c.cleanup(); }
});

test('a changed provider identity after an absence lookup cannot authorize creation', async () => {
  const c = await concreteFixture();
  try {
    c.http.read(async () => { c.x.providerInfo.identity_pubkey = c.spec.payerNode; });
    const harness = c.prepare(); assert.ok('prepare' in harness); await assert.rejects(harness.prepare());
    assert.equal(c.posts(), 0); assert.equal(c.http.credentials.includes('write'), false);
    assert.equal(c.store.read().reversePreparations![c.spec.id]!.status, 'UNKNOWN');
  } finally { await c.cleanup(); }
});

test('a channel change after writer credentials load is stopped by the durable pre-wire guard', async () => {
  const c = await concreteFixture();
  try {
    c.http.write(async () => {
      const disk = JSON.parse(await readFile(join(c.x.f.directory, 'state.json'), 'utf8'));
      assert.equal(disk.reversePreparations[c.spec.id].invoiceAttempt.wireAuthorized, false);
      c.x.payerChannels.channels[0]!.chan_id = '67890';
    });
    const harness = c.prepare(); assert.ok('prepare' in harness); await assert.rejects(harness.prepare());
    assert.equal(c.posts(), 0); assert.equal(c.http.credentials.filter(role => role === 'write').length, 1);
    assert.equal(c.store.read().reversePreparations![c.spec.id]!.invoiceAttempt!.wireAuthorized, false);
    const again = c.prepare(); assert.ok('prepare' in again); await assert.rejects(again.prepare());
    assert.equal(c.http.credentials.filter(role => role === 'write').length, 1);
  } finally { await c.cleanup(); }
});

test('an authenticated HTTP failure cannot be mistaken for a fresh hash by concrete wiring', async () => {
  const c = await concreteFixture();
  try {
    c.http.respond(() => ({ status: 401, json: absence }));
    const harness = c.prepare(); assert.ok('prepare' in harness); await assert.rejects(harness.prepare());
    assert.equal(c.posts(), 0); assert.equal(c.http.credentials.includes('write'), false);
    assert.equal(Object.keys(c.store.read().quotes).length, 0);
  } finally { await c.cleanup(); }
});

test('lookup-only recovery retains a missing invoice intent and cannot recreate the invoice', async () => {
  const c = await concreteFixture(true);
  try {
    const harness = c.prepare(); assert.ok('prepare' in harness); await assert.rejects(harness.prepare());
    const record = c.store.read().reversePreparations![c.spec.id]!; const swap = c.store.read().swaps[record.swapId!]!;
    c.http.respond(() => ({ status: 404, json: absence }));
    await assert.rejects(c.recover().recover(swap.revision));
    assert.equal(c.posts(), 1); assert.equal(c.store.read().reversePreparations![c.spec.id]!.status, 'UNKNOWN');
    assert.equal(c.store.read().swaps[swap.id]!.pendingAction, 'CREATE_INVOICE');
    assert.equal(c.http.wires.filter(wire => wire.options.method === 'POST').length, 1);
  } finally { await c.cleanup(); }
});

test('retained JIT review uses only guarded GETs and rejects absent, uncertain or changed identity/endpoint evidence', async () => {
  for (const change of ['valid', 'absent', 'auth', 'identity', 'endpoint', 'hash']) {
    const c = await concreteFixture(); try {
      const preparation = c.prepare(); assert.ok('prepare' in preparation); await preparation.prepare();
      const transport = c.http.transport(false); const invoices = { origin: transport.origin, lookup: transport.lookup.bind(transport) };
      const readers = createLndJitReaders(c.store, c.spec, { ...c.clients, invoices });
      const before = c.store.read(); const wires = c.http.wires.length; const credentials = c.http.credentials.length;
      if (change === 'absent') c.http.respond(() => ({ status: 404, json: absence }));
      if (change === 'auth') c.http.respond(() => ({ status: 401, json: absence }));
      if (change === 'identity') c.http.read(async () => { c.x.providerInfo.identity_pubkey = c.spec.payerNode; });
      if (change === 'endpoint') invoices.origin = 'https://127.0.0.1:8888';
      const clock = { now: () => Date.now() + 130000, monotonic: () => performance.now() };
      const review = () => createJustInTimeReverse(c.store, c.spec, readers, undefined, undefined, clock).review();
      if (change === 'valid') assert.equal((await review()).executionApproved, false);
      else if (change === 'hash') await assert.rejects(readers.provider.lookup('00'.repeat(32)));
      else await assert.rejects(review());
      assert.deepEqual(c.store.read(), before); assert.equal(c.posts(), 1);
      assert.ok(c.http.wires.slice(wires).every(wire => wire.options.method === 'GET'));
      assert.ok(c.http.credentials.slice(credentials).every(role => role === 'read'));
      if (['hash', 'endpoint'].includes(change)) assert.equal(c.http.wires.length, wires);
    } finally { await c.cleanup(); }
  }
});
