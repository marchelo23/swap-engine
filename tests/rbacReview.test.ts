import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { provisionAccount } from '../scripts/provision-auth.js';
import { createApi } from '../src/api/server.js';
import { createOwnedReverseApi, sessionOwnerAuthenticator } from '../src/api/ownedReverse.js';
import { SessionResponse } from '../src/api/schemas.js';
import { readAccounts } from '../src/auth/store.js';
import { SwapManager } from '../src/core/SwapManager.js';
import { testAccount } from './helpers.js';
import { preparationFixture } from './preparationFixture.js';

test('real sessions isolate owned swaps and protect balance collection and mutation admission', async t => {
  const fixture = await preparationFixture();
  t.after(fixture.cleanup);
  const { request } = await fixture.harness().prepare();
  const owner = await testAccount(fixture.directory, 'ADMIN');
  const otherSecret = randomBytes(24).toString('base64url');
  const userSecret = randomBytes(24).toString('base64url');
  await provisionAccount(owner.storePath, 'other-admin', 'ADMIN', otherSecret);
  await provisionAccount(owner.storePath, 'regular-user', 'USER', userSecret);
  const account = (await readAccounts(owner.storePath)).find(user => user.username === owner.username)!;
  let balanceReads = 0;
  const snapshot = {
    network: 'regtest' as const, capturedAt: '2026-01-01T00:00:00.000Z',
    core: { confirmedSats: null, unconfirmedSats: null }, rails: [],
    alice: { confirmedSats: 70_000, unconfirmedSats: 0, localSats: null, remoteSats: null },
    provider: { confirmedSats: 90_000, unconfirmedSats: 0, localSats: null, remoteSats: null },
  };
  const server = createApi(new SwapManager(fixture.store), async () => { throw new Error('No node adapters'); },
    undefined, 'regtest', { auth: { storePath: owner.storePath }, operations: async () => { balanceReads++; return snapshot; } });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = 'http://127.0.0.1:' + (server.address() as AddressInfo).port;
  const owned = createOwnedReverseApi(fixture.store, sessionOwnerAuthenticator(server.controlled.operatorIO.sessions), { origin });
  let mounted: Promise<unknown> | undefined;
  try {
    await owned.bind(account.id, request.swapId, fixture.spec.claimDestination);
    mounted = server.controlled.operatorIO.serve(fixture.store, owned, 3000, () => {});
    async function login(username: string, password: string) {
      const response = await fetch(origin + '/v1/auth/login', {
        method: 'POST', headers: { 'content-type': 'application/json', origin },
        body: JSON.stringify({ username, password }),
      });
      assert.equal(response.status, 200);
      const { csrfToken } = SessionResponse.parse(await response.json());
      return { cookie: response.headers.get('set-cookie')!.split(';')[0]!, 'x-csrf-token': csrfToken, origin };
    }
    const ownerHeaders = await owner.headers(origin);
    const otherHeaders = await login('other-admin', otherSecret);
    const userHeaders = await login('regular-user', userSecret);
    const swap = '/v1/swaps/' + request.swapId;
    const read = (path: string, headers?: Record<string, string>) => fetch(origin + path, { headers });
    assert.equal((await read(swap)).status, 401);
    assert.equal((await read(swap, otherHeaders)).status, 404);
    assert.equal((await read(swap + '/revision', otherHeaders)).status, 404);
    const detail = await read(swap, ownerHeaders);
    assert.equal(detail.status, 200);
    assert.equal((await detail.json()).payment.valueSats, fixture.store.read().swaps[request.swapId]!.quote.invoiceSats);
    assert.deepEqual((await (await read('/v1/swaps', otherHeaders)).json()).swaps, []);

    const balances = '/v1/operations/balances';
    assert.equal((await read(balances)).status, 401);
    assert.equal((await read(balances, userHeaders)).status, 403);
    assert.equal(balanceReads, 0);
    const allowed = await read(balances, ownerHeaders);
    assert.equal(allowed.status, 200);
    assert.equal(allowed.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await allowed.json(), snapshot);
    assert.equal(balanceReads, 1);

    const execute = (headers: Record<string, string>) => fetch(origin + '/v1/swaps/reverse', {
      method: 'POST', headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ preparedSwapId: request.swapId, expectedRevision: request.expectedRevision }),
    });
    const denied = await execute({ cookie: ownerHeaders.cookie, origin });
    assert.equal(denied.status, 403);
    assert.deepEqual(await denied.json(), { error: 'CSRF_REJECTED' });
    assert.equal((await execute({ ...ownerHeaders, origin: 'https://other.invalid' })).status, 403);
    const withoutKey = await execute(ownerHeaders);
    assert.equal(withoutKey.status, 400);
    assert.deepEqual(await withoutKey.json(), { error: 'IDEMPOTENCY_KEY_REQUIRED' });
    assert.deepEqual(fixture.store.read().ownedReverse?.requests, {});
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await server.controlled.close();
    await mounted;
  }
});
