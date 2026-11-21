import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { preparationFixture } from './preparationFixture.js';
import { SwapManager } from '../src/core/SwapManager.js';
import { createOperatorApi as createApi } from '../src/api/operatorServer.js';
import { createOwnedReverseApi, sessionOwnerAuthenticator } from '../src/api/ownedReverse.js';
import { createOwnedReverseGateway } from '../src/api/ownedReverseGateway.js';

const tokenA = 'ab'.repeat(32); const tokenB = 'cd'.repeat(32); const origin = 'http://localhost:3000';
const csrf = 'ef'.repeat(32);
const sessions = {
  async get(req: import('node:http').IncomingMessage) {
    const cookie = req.headers.cookie;
    if (![tokenA, tokenB].some(t => cookie === 'swap_session=' + t)) return undefined;
    return { account: { id: cookie === 'swap_session=' + tokenA ? 'alice' : 'bob', role: 'USER' }, csrfToken: csrf };
  },
  verifyCsrf(req: import('node:http').IncomingMessage, session: { csrfToken: string }) {
    return req.headers.origin === origin && req.headers['x-csrf-token'] === session.csrfToken;
  },
};
const auth = () => sessionOwnerAuthenticator(sessions);
async function fixture(clientAddress?: string) {
  const f = await preparationFixture(); const prepared = await f.harness().prepare(); const id = prepared.request.swapId;
  let server: Server | undefined; let api: ReturnType<typeof createOwnedReverseApi>; let url = ''; let executions = 0; let reconciliations = 0; let time = Date.now();
  let effect: () => Promise<void> = async () => {};
  const execute = async () => {
    executions++; const disk = JSON.parse(await readFile(join(f.directory, 'state.json'), 'utf8'));
    assert.equal(Object.values<{ status: string; kind: string }>(disk.ownedReverse.requests).filter(v => v.kind === 'EXECUTE')[0]!.status, 'INTENT');
    await effect();
    await f.store.transaction(db => { const s = db.swaps[id]!; s.state = 'COMPLETED'; s.revision++;
      s.clientPayment = { hash: s.contract.paymentHash, status: 'SUCCEEDED', feeLimitSats: 100, feeSats: 0 };
      s.lockup = { txid: '11'.repeat(32), vout: 0, hex: 'private-transaction-must-not-project' };
      s.claimTxid = '22'.repeat(32); });
    const s = f.store.read().swaps[id]!; return { id, revision: s.revision, state: s.state };
  };
  const recovery = { async reconcile(swapId: string, expected: number) {
    reconciliations++; assert.equal(swapId, id); assert.equal(expected, f.store.read().swaps[id]!.revision);
    await f.store.transaction(db => { db.swaps[id]!.state = 'MANUAL_REVIEW'; db.swaps[id]!.revision++; });
    const s = f.store.read().swaps[id]!; return { id, state: s.state, revision: s.revision, next: 'MANUAL_REVIEW' as const };
  } };
  const mount = async (approved = true) => {
    api = createOwnedReverseApi(f.store, auth(), { origin, recovery, now: () => time });
    await api.bind('alice', id, f.spec.claimDestination);
    if (approved) api.approve({ ownerId: 'alice', swapId: id, expectedRevision: prepared.request.expectedRevision,
      termsDigest: 'ef'.repeat(32), expiresAt: time + 300000, execute });
    server = createApi(new SwapManager(f.store), async () => ({ onchainSats: 0, incomingSats: 0 }), undefined, undefined, undefined, api);
    if (clientAddress) server.prependListener('request', req => { Object.defineProperty(req.socket, 'remoteAddress', { value: clientAddress, configurable: true }); });
    server.listen(0, '127.0.0.1'); await once(server, 'listening'); url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  };
  await mount();
  const request = (path: string, options: { method?: string; token?: string | null; key?: string; data?: unknown; origin?: string; headers?: Record<string, string> } = {}) => fetch(url + path, {
    method: options.method ?? 'GET', headers: { ...(options.token === null ? {} : { cookie: 'swap_session=' + (options.token ?? tokenA) }),
      ...(options.data !== undefined ? { 'content-type': 'application/json' } : {}), ...(options.key ? { 'idempotency-key': options.key } : {}),
      origin: options.origin ?? origin, 'x-csrf-token': csrf, ...options.headers }, ...(options.data !== undefined ? { body: JSON.stringify(options.data) } : {}) });
  return { f, id, prepared, request, get api() { return api; }, executions: () => executions, reconciliations: () => reconciliations,
    effect: (fn: typeof effect) => { effect = fn; }, advance: (ms: number) => { time += ms; },
    restart: async () => { await new Promise<void>(r => server!.close(() => r())); await api.drain(); await f.reopen(); await mount(false); },
    cleanup: async () => { await new Promise<void>(r => server!.close(() => r())); await api.drain(); await f.cleanup(); } };
}

test('explicit review refreshes only expired identical unused terms and never reopens an admitted execution', async () => {
  const x = await fixture(); try {
    const value = () => ({ ownerId: 'alice', swapId: x.id, expectedRevision: 3, termsDigest: 'ef'.repeat(32),
      expiresAt: Date.now() + 600000, execute: async () => ({ id: x.id, state: 'COMPLETED', revision: 3 }) });
    assert.throws(() => x.api.replaceExpiredApproval(value()));
    x.advance(300001);
    assert.throws(() => x.api.replaceExpiredApproval({ ...value(), ownerId: 'bob' }));
    assert.throws(() => x.api.replaceExpiredApproval({ ...value(), termsDigest: '00'.repeat(32) }));
    x.api.replaceExpiredApproval(value()); assert.equal(x.api.list('alice')[0]!.allowedActions.includes('EXECUTE'), true);
    await x.f.store.transaction(db => { db.ownedReverse!.requests['reserved'] = { ownerId: 'alice', swapId: x.id, kind: 'EXECUTE',
      fingerprint: '12'.repeat(32), attemptId: randomUUID(), expectedRevision: 3, createdAt: Date.now(), status: 'UNKNOWN' }; });
    x.advance(600001); assert.throws(() => x.api.replaceExpiredApproval({ ...value(), expiresAt: Date.now() + 1500000 }));
    assert.throws(() => x.api.revokeUnusedApproval(x.id)); assert.equal(x.executions(), 0);
  } finally { await x.cleanup(); }
});

test('owner status/list/revision and recovery do not leak or admit another user or anonymous caller', async () => {
  const x = await fixture(); try {
    for (const path of ['/v1/swaps', `/v1/swaps/${x.id}`, `/v1/swaps/${x.id}/revision`]) {
      assert.equal((await x.request(path, { token: null })).status, 401);
      assert.equal((await x.request(path, { token: '00'.repeat(32) })).status, 401);
    }
    const bob = await x.request('/v1/swaps', { token: tokenB }); assert.deepEqual((await bob.json()).swaps, []);
    for (const suffix of ['', '/revision', '/reconcile', '/execute']) {
      const r = await x.request(`/v1/swaps/${x.id}${suffix}`, { token: tokenB, method: ['reconcile', 'execute'].some(v => suffix.includes(v)) ? 'POST' : 'GET',
        ...(suffix === '/reconcile' || suffix === '/execute' ? { data: { expectedRevision: 3 }, key: 'other-user-key' } : {}) });
      assert.equal(r.status, 404);
    }
    const result = await (await x.request(`/v1/swaps/${x.id}`)).json();
    assert.equal(result.invoice, x.f.invoice.payment_request); assert.deepEqual(result.allowedActions, ['EXECUTE']);
    assert.equal(result.claim.netSats, 49500); assert.equal(result.quote.invoiceSats, 50750);
    assert.equal(JSON.stringify(result).includes('ownerId'), false); assert.equal(JSON.stringify(result).includes('attemptId'), false);
    assert.equal(x.executions(), 0); assert.equal(x.reconciliations(), 0);
    await assert.rejects(x.api.bind('bob', x.id, x.f.spec.claimDestination));
  } finally { await x.cleanup(); }
});

test('UI admission enforces origin, strict body, exact approval and idempotency key without new quote side effects', async () => {
  const x = await fixture(); try {
    const before = x.f.store.read();
    assert.equal((await x.request('/v1/quotes', { method: 'POST', data: { amountSats: 50000 } })).status, 409);
    assert.equal((await x.request('/v1/swaps/reverse', { method: 'POST', data: { preparedSwapId: x.id, expectedRevision: 3 } })).status, 400);
    assert.equal((await x.request('/v1/swaps/reverse', { method: 'POST', key: 'body-injection', data: { preparedSwapId: x.id, expectedRevision: 3, ownerId: 'bob' } })).status, 400);
    assert.equal((await x.request(`/v1/swaps/${x.id}/execute`, { method: 'POST', key: 'stale-version', data: { expectedRevision: 4 } })).status, 409);
    assert.equal((await x.request(`/v1/swaps/${x.id}/execute`, { method: 'POST', key: 'foreign-origin', origin: 'https://foreign.test', data: { expectedRevision: 3 } })).status, 403);
    const allowed = await x.request(`/v1/swaps/${x.id}`, { origin }); assert.equal(allowed.headers.get('access-control-allow-origin'), origin);
    const cors = await x.request(`/v1/swaps/${x.id}/execute`, { method: 'OPTIONS', token: null, origin,
      headers: { 'access-control-request-method': 'POST', 'access-control-request-headers': 'x-csrf-token,content-type,idempotency-key' } }); assert.equal(cors.status, 204);
    assert.deepEqual(x.f.store.read(), before); x.advance(300001);
    assert.deepEqual((await (await x.request(`/v1/swaps/${x.id}`)).json()).allowedActions, []);
    assert.equal((await x.request(`/v1/swaps/${x.id}/execute`, { method: 'POST', key: 'expired-key', data: { expectedRevision: 3 } })).status, 409);
    assert.equal(x.executions(), 0);
  } finally { await x.cleanup(); }
});

test('concurrent UI submissions and aliases execute once and persist an exact replayable result across restart', async () => {
  const x = await fixture(); try {
    let entered!: () => void; let release!: () => void;
    const ready = new Promise<void>(r => { entered = r; }); const finish = new Promise<void>(r => { release = r; });
    x.effect(async () => { entered(); await finish; });
    const pending = x.request('/v1/swaps/reverse', { method: 'POST', key: 'one-screen-click', data: { preparedSwapId: x.id, expectedRevision: 3 } });
    await ready;
    const replay = await x.request(`/v1/swaps/${x.id}/execute`, { method: 'POST', key: 'one-screen-click', data: { expectedRevision: 3 } });
    assert.equal(replay.status, 202); assert.equal((await replay.json()).status, 'RUNNING');
    const status = await (await x.request(`/v1/swaps/${x.id}`)).json(); assert.equal(status.execution.status, 'RUNNING'); assert.deepEqual(status.allowedActions, []);
    assert.equal((await x.request(`/v1/swaps/${x.id}/reconcile`, { method: 'POST', key: 'racing-recovery', data: { expectedRevision: 3 } })).status, 409);
    assert.equal((await x.request(`/v1/swaps/${x.id}/execute`, { method: 'POST', key: 'second-payment-key', data: { expectedRevision: 3 } })).status, 409);
    release(); const first = await pending; assert.equal(first.status, 200); const receipt = await first.json();
    assert.equal(receipt.status, 'SUCCEEDED'); assert.equal(x.executions(), 1);
    assert.equal(JSON.stringify(await (await x.request(`/v1/swaps/${x.id}`)).json()).includes('private-transaction'), false);
    await x.restart();
    const cached = await x.request(`/v1/swaps/${x.id}/execute`, { method: 'POST', key: 'one-screen-click', data: { expectedRevision: 3 } });
    assert.equal(cached.status, 200); assert.deepEqual(await cached.json(), receipt); assert.equal(x.executions(), 1);
    assert.equal((await x.request(`/v1/swaps/${x.id}/execute`, { method: 'POST', key: 'one-screen-click', data: { expectedRevision: 4 } })).status, 409);
    assert.equal((await x.request(`/v1/swaps/${x.id}/execute`, { method: 'POST', key: 'new-key-after-done', data: { expectedRevision: 4 } })).status, 409);
  } finally { await x.cleanup(); }
});

test('uncertain execution never replays; authenticated idempotent recovery only observes evidence', async () => {
  const x = await fixture(); try {
    x.effect(async () => {
      await x.f.store.transaction(db => { const s = db.swaps[x.id]!; s.clientPayment = { hash: s.contract.paymentHash, status: 'UNKNOWN', feeLimitSats: 100 }; s.state = 'MANUAL_REVIEW'; s.revision++; });
      throw Error('private-remote-error-must-not-project');
    });
    const first = await x.request(`/v1/swaps/${x.id}/execute`, { method: 'POST', key: 'uncertain-effect', data: { expectedRevision: 3 } });
    assert.equal(first.status, 202); assert.equal((await first.json()).status, 'RECONCILIATION_REQUIRED');
    await x.restart();
    assert.equal((await x.request(`/v1/swaps/${x.id}/execute`, { method: 'POST', key: 'uncertain-effect', data: { expectedRevision: 3 } })).status, 202);
    assert.equal((await x.request(`/v1/swaps/${x.id}/execute`, { method: 'POST', key: 'never-blind-retry', data: { expectedRevision: 4 } })).status, 409);
    const r = await x.request(`/v1/swaps/${x.id}/reconcile`, { method: 'POST', key: 'observe-only-key', data: { expectedRevision: 4 } }); assert.equal(r.status, 200);
    const result = await r.json(); assert.equal(result.result.next, 'MANUAL_REVIEW');
    assert.deepEqual(await (await x.request(`/v1/swaps/${x.id}/reconcile`, { method: 'POST', key: 'observe-only-key', data: { expectedRevision: 4 } })).json(), result);
    assert.equal(x.executions(), 1); assert.equal(x.reconciliations(), 1);
    assert.equal((await (await x.request(`/v1/swaps/${x.id}`)).json()).execution.status, 'RECONCILIATION_REQUIRED');
  } finally { await x.cleanup(); }
});

test('lost admission acknowledgment survives reopen as an orphaned intent without calling an executor', async t => {
  const x = await fixture(); try {
    const transaction = x.f.store.transaction.bind(x.f.store); let lost = false;
    t.mock.method(x.f.store, 'transaction', async (fn: Parameters<typeof transaction>[0]) => {
      const result = await transaction(fn);
      if (!lost && Object.values(x.f.store.read().ownedReverse?.requests ?? {}).some(r => r.kind === 'EXECUTE' && r.status === 'INTENT')) {
        lost = true; throw Error('lost durable admission acknowledgment');
      }
      return result;
    });
    assert.equal((await x.request(`/v1/swaps/${x.id}/execute`, { method: 'POST', key: 'crash-before-send', data: { expectedRevision: 3 } })).status, 503);
    assert.equal(x.executions(), 0); await x.restart();
    const replay = await x.request(`/v1/swaps/${x.id}/execute`, { method: 'POST', key: 'crash-before-send', data: { expectedRevision: 3 } });
    assert.equal(replay.status, 202); assert.equal((await replay.json()).status, 'RECONCILIATION_REQUIRED');
    assert.equal((await x.request(`/v1/swaps/${x.id}/execute`, { method: 'POST', key: 'no-second-attempt', data: { expectedRevision: 3 } })).status, 409);
    assert.equal(x.executions(), 0);
  } finally { await x.cleanup(); }
});

test('request cleanup does not overwrite a newer actor admission journal', async () => {
  const x = await fixture(); try {
    const actor = randomUUID();
    x.effect(async () => { await x.f.store.transaction(db => { const request = Object.values(db.ownedReverse!.requests)[0]!; request.attemptId = actor; }); throw Error('actor ownership changed'); });
    assert.equal((await x.request(`/v1/swaps/${x.id}/execute`, { method: 'POST', key: 'actor-journal-test', data: { expectedRevision: 3 } })).status, 202);
    const record = Object.values(x.f.store.read().ownedReverse!.requests)[0]!; assert.equal(record.attemptId, actor); assert.equal(record.status, 'INTENT');
    assert.equal(x.executions(), 1);
  } finally { await x.cleanup(); }
});

test('changed owner on an admission record fails closed without cleanup overwriting it or retrying', async () => {
  const x = await fixture(); try {
    x.effect(async () => {
      await x.f.store.transaction(db => { Object.values(db.ownedReverse!.requests)[0]!.ownerId = 'bob'; });
      throw Error('record ownership changed');
    });
    const response = await x.request(`/v1/swaps/${x.id}/execute`, { method: 'POST', key: 'owner-journal-test', data: { expectedRevision: 3 } });
    assert.equal(response.status, 409);
    const record = Object.values(x.f.store.read().ownedReverse!.requests)[0]!;
    assert.equal(record.ownerId, 'bob'); assert.equal(record.status, 'INTENT');
    assert.equal((await x.request(`/v1/swaps/${x.id}/execute`, { method: 'POST', key: 'no-owner-retry', data: { expectedRevision: 3 } })).status, 409);
    assert.equal(x.executions(), 1);
  } finally { await x.cleanup(); }
});

test('existing cookie session and CSRF are mandatory; bearer and forged identity cannot bypass them', async t => {
  const x = await fixture(); try {
    const before = x.f.store.read();
    const post = { method: 'POST', key: 'csrf-protected-click', data: { expectedRevision: 3 } };
    for (const headers of [{ 'x-csrf-token': '' }, { 'x-csrf-token': tokenA }]) {
      const r = await x.request(`/v1/swaps/${x.id}/execute`, { ...post, headers });
      assert.equal(r.status, 403); assert.equal((await r.json()).error, 'CSRF_REJECTED');
    }
    assert.equal((await x.request('/v1/swaps', { token: null, headers: { authorization: 'Bearer ' + tokenA, 'x-user-id': 'alice' } })).status, 401);
    const availability = await x.request('/v1/reverse/availability');
    assert.deepEqual(await availability.json(), { network: 'regtest', liveSwapsEnabled: false, controlledReverseConfigured: true,
      executionAvailable: true, recoveryAvailable: true, preparedSwapIds: [x.id] });
    t.mock.method(sessions, 'get', async () => undefined);
    assert.equal((await x.request('/v1/reverse/availability')).status, 401);
    assert.equal((await x.request(`/v1/swaps/${x.id}/execute`, post)).status, 401);
    assert.equal(x.executions(), 0); assert.deepEqual(x.f.store.read(), before);
  } finally { await x.cleanup(); }
});

test('existing app can serve an authenticated remote lab browser without weakening CSRF or ownership', async () => {
  const x = await fixture('192.168.56.1'); try {
    assert.equal((await x.request(`/v1/swaps/${x.id}`)).status, 200);
    assert.equal((await x.request(`/v1/swaps/${x.id}`, { token: tokenB })).status, 404);
    const post = { method: 'POST', key: 'remote-lab-click', data: { expectedRevision: 3 } };
    assert.equal((await x.request(`/v1/swaps/${x.id}/execute`, { ...post, headers: { 'x-csrf-token': '' } })).status, 403);
    assert.equal((await x.request(`/v1/swaps/${x.id}/execute`, { ...post, origin: 'https://foreign.test' })).status, 403);
    assert.equal((await x.request(`/v1/swaps/${x.id}/execute`, post)).status, 200); assert.equal(x.executions(), 1);
  } finally { await x.cleanup(); }
});

test('application gateway starts closed and shuts down only after in-flight journaled execution settles', async () => {
  const f = await preparationFixture(); const prepared = await f.harness().prepare(); const id = prepared.request.swapId;
  const gateway = createOwnedReverseGateway(sessions);
  const api = createOwnedReverseApi(f.store, auth(), { origin });
  const server = createApi(new SwapManager(f.store), async () => ({ onchainSats: 0, incomingSats: 0 }), undefined, undefined, undefined, gateway);
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const request = (path: string, init?: RequestInit) => fetch(url + path, { ...init, headers: { cookie: 'swap_session=' + tokenA,
    origin, 'x-csrf-token': csrf, ...init?.headers } });
  let stopped = false; let settled = false; let release!: () => void; let entered!: () => void;
  const enteredPromise = new Promise<void>(r => { entered = r; }); const finish = new Promise<void>(r => { release = r; });
  let serving: Promise<unknown> | undefined;
  try {
    assert.equal((await (await request('/v1/reverse/availability')).json()).executionAvailable, false);
    assert.equal((await request(`/v1/swaps/${id}`)).status, 503);
    await api.bind('alice', id, f.spec.claimDestination);
    api.approve({ ownerId: 'alice', swapId: id, expectedRevision: 3, termsDigest: 'ab'.repeat(32), expiresAt: Date.now() + 60000,
      async execute() {
        entered(); await finish;
        await f.store.transaction(db => { db.swaps[id]!.state = 'COMPLETED'; db.swaps[id]!.revision++; });
        const s = f.store.read().swaps[id]!; settled = true; return { id, state: s.state, revision: s.revision };
      } });
    serving = gateway.operatorIO.serve(f.store, api, 12345, () => { stopped = true; });
    assert.equal((await (await request('/v1/reverse/availability')).json()).executionAvailable, true);
    const pending = request(`/v1/swaps/${id}/execute`, { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': 'gateway-shutdown' }, body: JSON.stringify({ expectedRevision: 3 }) });
    await enteredPromise;
    let closed = false; const closing = gateway.close().then(() => { closed = true; });
    await new Promise(r => setImmediate(r)); assert.equal(stopped, true); assert.equal(settled, false); assert.equal(closed, false);
    assert.equal((await (await request('/v1/reverse/availability')).json()).executionAvailable, false);
    release(); assert.equal((await pending).status, 200); await closing; await serving;
    assert.equal(settled, true); assert.equal(Object.values(f.store.read().ownedReverse!.requests)[0]!.status, 'SUCCEEDED');
  } finally {
    release?.(); await gateway.close(); await serving;
    await new Promise<void>(r => server.close(() => r())); await f.cleanup();
  }
});
