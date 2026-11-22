import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { provisionAccount } from '../scripts/provision-auth.js';
import { setup } from './helpers.js';
import { createApi } from '../src/api/server.js';
import { OperationsBalancesResponse } from '../src/api/schemas.js';
import { ReadOnlyBitcoinClient, ReadOnlyLndClient } from '../src/diagnostics/ReadOnlyClients.js';
import { collectOperationsBalances } from '../src/operations/Balances.js';

type Response = unknown | Error | (() => unknown);

function bitcoinClient(responses: Record<string, Response>) {
  responses = { getblockchaininfo: { chain: 'regtest' }, ...responses };
  return {
    async call<T>(method: string, _params: unknown[] = [], _wallet = false): Promise<T> {
      const response = responses[method];
      if (response === undefined && !(method in responses)) throw new Error(`Unexpected Bitcoin RPC method: ${method}`);
      if (response instanceof Error) throw response;
      if (typeof response === 'function') return await (response as () => T | Promise<T>)() as T;
      return response as T;
    },
  };
}

function lndClient(responses: Record<string, Response>) {
  responses = { '/v1/getinfo': { chains: [{ chain: 'bitcoin', network: 'regtest' }] }, ...responses };
  return {
    async call<T>(path: string, _body?: unknown): Promise<T> {
      const response = responses[path];
      if (response === undefined && !(path in responses)) throw new Error(`Unexpected LND path: ${path}`);
      if (response instanceof Error) throw response;
      if (typeof response === 'function') return await (response as () => T | Promise<T>)() as T;
      return response as T;
    },
  };
}

function providerFixture(): Record<string, Response> {
  return {
    '/v1/balance/blockchain': { confirmed_balance: '100000', unconfirmed_balance: '5000' },
    '/v1/channels': {
      channels: [
        { active: true, local_balance: '300000', remote_balance: '200000', capacity: '500000' },
        { active: false, local_balance: '100000', remote_balance: '50000', capacity: '150000' },
      ],
    },
  };
}

function aliceFixture(): Record<string, Response> {
  return {
    '/v1/balance/blockchain': { confirmed_balance: '50000', unconfirmed_balance: '0' },
    '/v1/channels': { channels: [{ active: true, local_balance: '200000', remote_balance: '300000', capacity: '500000' }] },
  };
}

function bitcoinFixture(): Record<string, Response> {
  return {
    getbalances: { mine: { trusted: 1.23456789, untrusted_pending: 0.00000001, immature: 50 } },
  };
}

test('operations balances match the Frontend envelope and keep sources separate', async () => {
  const report = await collectOperationsBalances({
    bitcoin: bitcoinClient(bitcoinFixture()),
    provider: lndClient(providerFixture()),
    alice: lndClient(aliceFixture()),
  }, new Date('2026-11-18T12:00:00.000Z'));

  const { rails, ...legacy } = report;
  assert.deepEqual(legacy, {
    network: 'regtest',
    capturedAt: '2026-11-18T12:00:00.000Z',
    core: { confirmedSats: 123_456_789, unconfirmedSats: 1 },
    provider: { confirmedSats: 100_000, unconfirmedSats: 5_000, localSats: 400_000, remoteSats: 250_000 },
    alice: { confirmedSats: 50_000, unconfirmedSats: 0, localSats: 200_000, remoteSats: 300_000 },
  });
  assert.deepEqual(rails.map(entry => `${entry.rail}:${entry.account}:${entry.status}`), [
    'onchain:core:available', 'onchain:provider:available', 'onchain:alice:available',
    'lightning:provider:available', 'lightning:alice:available',
    'ark:operator:unavailable', 'liquid:operator:unavailable',
  ]);
  assert.deepEqual(rails.filter(entry => entry.rail === 'lightning').map(entry => entry.balances), [
    { localSats: 400_000, remoteSats: 250_000, capacitySats: 650_000 },
    { localSats: 200_000, remoteSats: 300_000, capacitySats: 500_000 },
  ]);
  assert.equal('totalSats' in report, false);
  assert.equal(JSON.stringify(report).includes('immature'), false);
  OperationsBalancesResponse.parse(report);
});

test('unavailable sources return null values or a null node, never fabricated zeroes', async () => {
  const missing = new Error('do not print /secret/path');
  (missing as NodeJS.ErrnoException).code = 'ENOENT';
  const refused = new Error('do not print connection details');
  (refused as NodeJS.ErrnoException).code = 'ECONNREFUSED';

  const report = await collectOperationsBalances({
    bitcoin: bitcoinClient({ getbalances: missing }),
    provider: null,
    alice: lndClient({
      '/v1/balance/blockchain': { confirmed_balance: '50000', unconfirmed_balance: '0' },
      '/v1/channels': refused,
    }),
  }, new Date('2026-11-18T12:00:00.000Z'));

  assert.deepEqual(report.core, { confirmedSats: null, unconfirmedSats: null });
  assert.equal(report.provider, null);
  assert.deepEqual(report.alice, {
    confirmedSats: 50_000, unconfirmedSats: 0, localSats: null, remoteSats: null,
  });
  assert.equal(JSON.stringify(report).includes('/secret/path'), false);
  assert.equal(JSON.stringify(report).includes('connection details'), false);
});

test('unsafe or malformed amounts become null without failing the whole response', async () => {
  const report = await collectOperationsBalances({
    bitcoin: bitcoinClient({
      getbalances: { mine: { trusted: 1e20, untrusted_pending: 0, immature: 0 } },
    }),
    provider: lndClient({
      '/v1/balance/blockchain': { confirmed_balance: '9007199254740992', unconfirmed_balance: '0' },
      '/v1/channels': {
        channels: [
          { active: true, local_balance: '9007199254740991', remote_balance: '9007199254740991' },
          { active: true, local_balance: '9007199254740991', remote_balance: '9007199254740991' },
        ],
      },
    }),
    alice: lndClient({
      '/v1/balance/blockchain': { confirmed_balance: true, unconfirmed_balance: 0 },
      '/v1/channels': { channels: [] },
    }),
  }, new Date('2026-11-18T12:00:00.000Z'));

  assert.deepEqual(report.core, { confirmedSats: null, unconfirmedSats: 0 });
  assert.deepEqual(report.provider, {
    confirmedSats: null, unconfirmedSats: 0, localSats: null, remoteSats: null,
  });
  assert.deepEqual(report.alice, {
    confirmedSats: null, unconfirmedSats: null, localSats: 0, remoteSats: 0,
  });
  OperationsBalancesResponse.parse(report);
});

test('the collector skips balance calls for sources that do not prove they are Bitcoin regtest', async () => {
  let balanceReads = 0;
  const attemptedBalance = () => { balanceReads++; };
  const report = await collectOperationsBalances({
    bitcoin: bitcoinClient({ getblockchaininfo: { chain: 'main' }, getbalances: attemptedBalance }),
    provider: lndClient({
      '/v1/getinfo': { chains: [{ chain: 'bitcoin', network: 'mainnet' }] },
      '/v1/balance/blockchain': attemptedBalance, '/v1/channels': attemptedBalance,
    }),
    alice: lndClient(aliceFixture()),
  });
  assert.equal(balanceReads, 0);
  assert.deepEqual(report.core, { confirmedSats: null, unconfirmedSats: null });
  assert.equal(report.provider, null);
  assert.equal(report.alice?.confirmedSats, 50_000);
});

test('read-only clients permit the new balance reads without permitting mutations', async () => {
  const bitcoin = new ReadOnlyBitcoinClient('http://127.0.0.1:18443', 'nonexistent-cookie');
  const lnd = new ReadOnlyLndClient('https://127.0.0.1:8080', 'nonexistent-cert', 'nonexistent-macaroon');
  await assert.rejects(bitcoin.call('getbalances', [], true), error => !/READ_ONLY_MODE/.test(String(error)));
  await assert.rejects(lnd.call('/v1/balance/blockchain'), error => !/READ_ONLY_MODE/.test(String(error)));
  await assert.rejects(bitcoin.call('sendrawtransaction', ['00']), /READ_ONLY_MODE/);
  await assert.rejects(lnd.call('/v2/router/send', {}), /READ_ONLY_MODE/);
});

test('GET /v1/operations/balances rejects anonymous and USER callers before invoking the collector', async t => {
  const f = await setup();
  t.after(f.cleanup);
  const directory = await mkdtemp(join(tmpdir(), 'swap-operations-auth-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const storePath = join(directory, 'users.json');
  const userPassword = randomBytes(24).toString('base64url');
  const adminPassword = randomBytes(24).toString('base64url');
  await provisionAccount(storePath, 'member', 'USER', userPassword);
  await provisionAccount(storePath, 'operator', 'ADMIN', adminPassword);
  const report = await collectOperationsBalances({
    bitcoin: bitcoinClient(bitcoinFixture()),
    provider: lndClient(providerFixture()),
    alice: lndClient(aliceFixture()),
  }, new Date('2026-11-18T12:00:00.000Z'));
  let snapshots = 0;
  async function listen(operations?: () => Promise<typeof report>) {
    const server = createApi(f.manager, async () => ({ onchainSats: 0, incomingSats: 0 }), undefined, 'regtest', {
      auth: { storePath }, operations,
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    t.after(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    return {
      balances: (cookie?: string) => fetch(`${origin}/v1/operations/balances`, cookie ? { headers: { cookie } } : undefined),
      login: async (username: string, password: string) => {
        const response = await fetch(`${origin}/v1/auth/login`, {
          method: 'POST', headers: { 'content-type': 'application/json', origin },
          body: JSON.stringify({ username, password }),
        });
        assert.equal(response.status, 200);
        return response.headers.get('set-cookie')!.split(';')[0]!;
      },
    };
  }
  const configured = await listen(async () => {
    snapshots++;
    return report;
  });
  const anonymous = await configured.balances();
  assert.equal(anonymous.status, 401);
  assert.deepEqual(await anonymous.json(), { error: 'AUTH_REQUIRED' });
  const user = await configured.balances(await configured.login('member', userPassword));
  assert.equal(user.status, 403);
  assert.deepEqual(await user.json(), { error: 'FORBIDDEN' });
  assert.equal(snapshots, 0);

  const admin = await configured.balances(await configured.login('operator', adminPassword));
  assert.equal(admin.status, 200);
  assert.equal(admin.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await admin.json(), report);
  assert.equal(snapshots, 1);

  const unconfigured = await listen();
  const unavailable = await unconfigured.balances(await unconfigured.login('operator', adminPassword));
  assert.equal(unavailable.status, 503);
  assert.deepEqual(await unavailable.json(), { error: 'OPERATIONS_BALANCES_NOT_CONFIGURED' });

  const malformed = await listen(async () => ({ ...report, capturedAt: 'November 18, 2026' }));
  const invalid = await malformed.balances(await malformed.login('operator', adminPassword));
  assert.equal(invalid.status, 503);
  assert.deepEqual(await invalid.json(), { error: 'SERVICE_UNAVAILABLE' });
});
