import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { Store } from '../src/persistence/Store.js';
import { SwapManager } from '../src/core/SwapManager.js';
import { createApi } from '../src/api/server.js';
import { createOwnedPreparation, PreparationRejected, type PreparationFactory, type PreparedRuntime } from '../src/api/ownedPreparation.js';
import { createOwnedReverseApi, sessionOwnerAuthenticator } from '../src/api/ownedReverse.js';
import { provisionAccount } from '../scripts/provision-auth.js';
import { readAccounts } from '../src/auth/store.js';
import { preparationFixture } from './preparationFixture.js';
import { ownedStartupArguments } from '../src/main.js';
import { checkOwnedRuntime } from '../scripts/check-owned-runtime.js';

async function fixture() {
  const root = await preparationFixture(); const catalogPath = join(root.directory, 'catalog');
  await mkdir(catalogPath); let catalog = await Store.open(catalogPath);
  const accounts = join(root.directory, 'accounts.json'); const password = randomBytes(24).toString('base64url');
  for (const [username, role] of [['truja503', 'ADMIN'], ['otheradmin', 'ADMIN'], ['normaluser', 'USER']] as const) await provisionAccount(accounts, username, role, password);
  const owner = (await readAccounts(accounts)).find(a => a.username === 'truja503')!;
  const origin = 'http://localhost:3000'; let server: ReturnType<typeof createApi>; let base = '';
  const attempts = new Map<string, Awaited<ReturnType<typeof preparationFixture>>>();
  let creates = 0; let restores = 0; let executes = 0; let reviews = 0; let lose = false;
  let prepareHook = async () => {};
  const build = async (f: Awaited<ReturnType<typeof preparationFixture>>, fresh: boolean): Promise<PreparedRuntime> => {
    const id = f.record().swapId!;
    const api = createOwnedReverseApi(f.store, sessionOwnerAuthenticator(server.controlled.operatorIO.sessions), { origin });
    await api.bind(owner.id, id, f.spec.claimDestination);
    const authorize = async () => {
      reviews++;
      if (api.list(owner.id)[0]?.allowedActions.includes('EXECUTE')) return;
      api.replaceExpiredApproval({ ownerId: owner.id, swapId: id, expectedRevision: f.store.read().swaps[id]!.revision,
        termsDigest: '12'.repeat(32), expiresAt: Date.now() + 60000,
        async execute() {
          executes++; await f.store.transaction(db => { const s = db.swaps[id]!; s.state = 'COMPLETED'; s.revision++; });
          const s = f.store.read().swaps[id]!; return { id, revision: s.revision, state: s.state };
        } });
    };
    if (fresh) await authorize();
    return { swapId: id, api, authorize,
      terminal: async () => f.store.read().swaps[id]!.state === 'COMPLETED' ? 'COMPLETED' : undefined,
      close: async () => { await api.drain(); } };
  };
  const factory: PreparationFactory = {
    async prepare(id, entry) {
      creates++;
      const disk = JSON.parse(await readFile(join(catalogPath, 'state.json'), 'utf8'));
      assert.equal(disk.ownedPreparations[id].status, 'INTENT'); assert.equal(disk.ownedPreparations[id].attemptId, entry.attemptId);
      await prepareHook(); const f = await preparationFixture(entry.sourceAmountSats); attempts.set(id, f); await f.harness().prepare();
      if (lose) throw Error('synthetic-private-lost-preparation-ack'); return build(f, true);
    },
    async restore(id) { restores++; const f = attempts.get(id); return f ? build(f, false) : undefined; },
  };
  const boot = async () => {
    server = createApi(new SwapManager(catalog), async () => ({ onchainSats: 100000, incomingSats: 100000 }), undefined, 'regtest', { auth: { storePath: accounts, origin } });
    server.controlled.installPreparation(await createOwnedPreparation(catalog, server.controlled.operatorIO.sessions, factory,
      { mode: 'regtest', ownerId: owner.id, ownerUsername: 'truja503', origin, profileDigest: 'ab'.repeat(32) }));
    server.listen(0, '127.0.0.1'); await once(server, 'listening'); base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  };
  const request = (path: string, headers: Record<string, string> = {}, body?: unknown, key = 'durable-prepare-key') => fetch(base + path, {
    method: body === undefined ? 'GET' : 'POST', headers: { ...headers, ...(body === undefined ? {} : { 'content-type': 'application/json', 'idempotency-key': key }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const login = async (username = 'truja503') => {
    const r = await request('/v1/auth/login', { origin }, { username, password }); assert.equal(r.status, 200); const s = await r.json();
    return { origin, cookie: r.headers.get('set-cookie')!.split(';')[0]!, 'x-csrf-token': s.csrfToken as string };
  };
  const wait = async (id: string, headers: Record<string, string>) => {
    for (let n = 0; n < 200; n++) { const r = await (await request('/v1/reverse/preparations/' + id, headers)).json();
      if (r.status !== 'INTENT') return r; await new Promise(resolve => setTimeout(resolve, 10)); }
    throw Error('Preparation did not settle');
  };
  const stop = async () => { await server.controlled.close(); await new Promise<void>(r => server.close(() => r())); };
  await boot();
  return { request, login, wait, attempts, accounts, owner, catalogPath, get catalog() { return catalog; },
    counts: () => ({ creates, restores, executes, reviews }), lose: () => { lose = true; }, hook: (fn: typeof prepareHook) => { prepareHook = fn; },
    restart: async () => { await stop(); await catalog.close(); catalog = await Store.open(catalogPath); await boot(); },
    cleanup: async () => { await stop(); await catalog.close(); for (const f of attempts.values()) await f.cleanup(); await root.cleanup(); } };
}

test('admin preparation requires exact owner, cookie, origin, CSRF, amount and idempotency before any invoice capability', async () => {
  const x = await fixture(); try {
    const before = await readFile(x.accounts); const owner = await x.login(); const other = await x.login('otheradmin'); const user = await x.login('normaluser');
    for (const [headers, status] of [[{}, 401], [{ authorization: 'Bearer invented', 'x-user-id': x.owner.id }, 401], [other, 403], [user, 403],
      [{ ...owner, origin: 'http://evil.test' }, 403], [{ ...owner, 'x-csrf-token': '' }, 403]] as const) {
      assert.equal((await x.request('/v1/reverse/preparations', headers, { amountSats: 50000 })).status, status);
    }
    for (const body of [{ amountSats: 1 }, { amountSats: 50000, destination: 'attacker' }, { amountSats: 50000, feeLimit: 50000 }])
      assert.equal((await x.request('/v1/reverse/preparations', owner, body)).status, 400);
    assert.equal((await x.request('/v1/reverse/preparations', owner, { amountSats: 50000 }, 'bad')).status, 400);
    assert.deepEqual(x.counts(), { creates: 0, restores: 0, executes: 0, reviews: 0 }); assert.deepEqual(await readFile(x.accounts), before);
  } finally { await x.cleanup(); }
});

test('quote and durable preparation bind the selected debit and reject changed replay', async () => {
  const x = await fixture(); try {
    const h = await x.login();
    const quote = await x.request('/v1/quotes', h, { amountSats: 50000 }); assert.equal(quote.status, 201);
    const terms = await quote.json();
    assert.deepEqual([terms.invoiceSats, terms.serviceFeeSats, terms.claimFeeSats, terms.amountSats - terms.claimFeeSats], [50000, 750, 500, 48750]);
    assert.equal((await x.request('/v1/quotes', h, { amountSats: 50001 })).status, 400);
    const initial = await x.request('/v1/reverse/preparations', h, { amountSats: 25000 }, 'amount-binding-key');
    const admitted = await initial.json(); const ready = await x.wait(admitted.id, h); assert.equal(ready.status, 'READY');
    assert.equal(x.catalog.read().ownedPreparations![admitted.id]!.sourceAmountSats, 25000);
    const view = await (await x.request('/v1/swaps/' + ready.swapId, h)).json(); assert.equal(view.payment.valueSats, 25000);
    assert.equal((await x.request('/v1/reverse/preparations', h, { amountSats: 50000 }, 'amount-binding-key')).status, 409);
    assert.equal(x.counts().creates, 1);
  } finally { await x.cleanup(); }
});

test('parallel preparation keys create one invoice, explicit review never pays, and completed swap allows the next distinct attempt', async () => {
  const x = await fixture(); try {
    const h = await x.login(); const responses = await Promise.all(['first-prepare-key', 'other-prepare-key', 'first-prepare-key'].map(k => x.request('/v1/reverse/preparations', h, { amountSats: 50000 }, k)));
    const statuses = responses.map(r => r.status).sort();
    assert.ok(['200,202,409', '202,202,409', '202,409,409'].includes(statuses.join(',')), statuses.join(','));
    const accepted = await Promise.all(responses.filter(r => r.status === 200 || r.status === 202)
      .map(async response => ({ status: response.status, body: await response.json() as { id: string } })));
    const admitted = accepted.find(response => response.status === 202)!.body;
    for (const response of accepted) assert.equal(response.body.id, admitted.id);
    const ready = await x.wait(admitted.id, h); assert.equal(ready.status, 'READY'); assert.equal(x.counts().creates, 1); assert.equal(x.counts().executes, 0);
    assert.equal((await x.request('/v1/reverse/preparations/' + ready.id + '/review', h, {}, 'review-first-key')).status, 200);
    assert.equal((await x.request('/v1/reverse/preparations/' + ready.id + '/review', h, {}, 'review-first-key')).status, 200);
    assert.equal(x.counts().executes, 0);
    const view = await (await x.request('/v1/swaps/' + ready.swapId, h)).json();
    const executed = await x.request('/v1/swaps/reverse', h, { preparedSwapId: ready.swapId, expectedRevision: view.revision }, 'explicit-start-key'); assert.equal(executed.status, 200);
    assert.equal(x.counts().executes, 1);
    assert.equal((await x.request('/v1/swaps/reverse', h, { preparedSwapId: ready.swapId, expectedRevision: view.revision }, 'explicit-start-key')).status, 200);
    assert.equal(x.counts().executes, 1);
    const second = await x.request('/v1/reverse/preparations', h, { amountSats: 50000 }, 'next-prepare-key'); assert.equal(second.status, 202);
    const next = await x.wait((await second.json()).id, h); assert.notEqual(next.swapId, ready.swapId); assert.equal(x.counts().creates, 2);
    const history = await (await x.request('/v1/swaps', h)).json(); assert.equal(history.swaps.length, 2);
  } finally { await x.cleanup(); }
});

test('lost preparation reply and restart restore lookup-only with no duplicate invoice or automatically renewed execution', async () => {
  const x = await fixture(); try {
    const h = await x.login(); x.lose(); const first = await (await x.request('/v1/reverse/preparations', h, { amountSats: 50000 })).json();
    assert.equal((await x.wait(first.id, h)).status, 'UNKNOWN'); assert.equal(x.counts().creates, 1);
    await x.restart(); const again = await x.login();
    assert.equal((await x.request('/v1/reverse/preparations', again, { amountSats: 50000 })).status, 200);
    assert.equal((await x.request('/v1/reverse/preparations', again, { amountSats: 50000 }, 'blind-new-prepare-key')).status, 409);
    const availability = await (await x.request('/v1/reverse/availability', again)).json(); assert.equal(availability.executionAvailable, false);
    assert.equal(availability.preparedSwapIds.length, 1); assert.equal(x.counts().creates, 1); assert.equal(x.counts().executes, 0);
  } finally { await x.cleanup(); }
});

test('preparation catch preserves a concurrently replaced admission and cannot blindly start another attempt', async () => {
  const x = await fixture(); try {
    const h = await x.login(); x.hook(async () => { await x.catalog.transaction(db => { const r = Object.values(db.ownedPreparations!)[0]!; r.attemptId = 'different-actor'; }); throw Error('synthetic concurrent conflict'); });
    const admitted = await (await x.request('/v1/reverse/preparations', h, { amountSats: 50000 })).json();
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(x.catalog.read().ownedPreparations![admitted.id]!.attemptId, 'different-actor');
    assert.equal(x.catalog.read().ownedPreparations![admitted.id]!.status, 'INTENT');
    assert.equal((await x.request('/v1/reverse/preparations', h, { amountSats: 50000 }, 'blind-new-attempt')).status, 409);
    assert.equal(x.counts().creates, 1); assert.equal(x.counts().executes, 0);
  } finally { await x.cleanup(); }
});

test('lost durable admission acknowledgment survives restart and never calls the invoice preparer', async () => {
  const x = await fixture(); try {
    const h = await x.login(); const transaction = x.catalog.transaction.bind(x.catalog); let lose = true;
    x.catalog.transaction = async fn => { const result = await transaction(fn);
      if (lose && Object.keys(x.catalog.read().ownedPreparations ?? {}).length) { lose = false; throw Error('synthetic-lost-admission-ack'); }
      return result;
    };
    assert.equal((await x.request('/v1/reverse/preparations', h, { amountSats: 50000 })).status, 503);
    assert.equal(x.counts().creates, 0); await x.restart(); const fresh = await x.login();
    const replay = await (await x.request('/v1/reverse/preparations', fresh, { amountSats: 50000 })).json(); assert.equal(replay.status, 'UNKNOWN');
    assert.equal((await x.request('/v1/reverse/preparations', fresh, { amountSats: 50000 }, 'new-key-cannot-retry')).status, 409);
    assert.equal(x.counts().creates, 0); assert.equal(x.counts().executes, 0);
  } finally { await x.cleanup(); }
});

test('definitive pre-invoice rejection is replayable and permits only a new explicit identified preparation', async () => {
  const x = await fixture(); try {
    const h = await x.login(); x.hook(async () => { throw new PreparationRejected('No invoice capability invoked'); });
    const attempt = await (await x.request('/v1/reverse/preparations', h, { amountSats: 50000 })).json();
    assert.equal((await x.wait(attempt.id, h)).status, 'REJECTED');
    assert.equal((await (await x.request('/v1/reverse/preparations', h, { amountSats: 50000 })).json()).status, 'REJECTED');
    assert.equal(x.counts().creates, 1); x.hook(async () => {});
    const next = await x.request('/v1/reverse/preparations', h, { amountSats: 50000 }, 'explicit-new-after-rejection'); assert.equal(next.status, 202);
    const ready = await x.wait((await next.json()).id, h); assert.equal(ready.status, 'READY'); assert.equal(x.counts().creates, 2); assert.equal(x.counts().executes, 0);
  } finally { await x.cleanup(); }
});

test('self-service startup is explicit regtest-only and cannot be activated by simulation, mainnet, guest or incomplete flags', () => {
  assert.equal(ownedStartupArguments([], 'regtest'), undefined);
  const args = ['--owned-regtest', '--policy-path', process.platform === 'win32' ? 'C:/private/policy.json' : '/private/policy.json', '--policy-sha256', 'ab'.repeat(32)];
  assert.ok(ownedStartupArguments(args, 'regtest')); assert.throws(() => ownedStartupArguments(args, 'simulation'));
  assert.throws(() => ownedStartupArguments(args.slice(0, 3), 'regtest')); assert.throws(() => ownedStartupArguments([...args, '--guest'], 'regtest'));
});

test('operator profile check has no default, payment command, dynamic loader or incomplete credential fallback', async () => {
  for (const args of [[], ['--execute'], ['--check-owned-runtime'], ['--check-owned-runtime', '--policy-path', 'relative', '--policy-sha256', 'ab'.repeat(32)]])
    await assert.rejects(checkOwnedRuntime(args));
});
