import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { preflight } from '../src/diagnostics/preflight.js';
import { ReadOnlyBitcoinClient, ReadOnlyLndClient } from '../src/diagnostics/ReadOnlyClients.js';
import { setup, testAccount } from './helpers.js';
import { createApi } from '../src/api/server.js';

function fixtures() {
  const replies: Record<string, unknown> = {
    getblockchaininfo: { chain: 'regtest', blocks: 0, headers: 0, initialblockdownload: true, bestblockhash: 'ab'.repeat(32) },
    listwallets: [], listwalletdir: { wallets: [{ name: 'lqwd-lab' }] },
    '/v1/getinfo': { chains: [{ chain: 'bitcoin', network: 'regtest' }], block_height: 0,
      block_hash: 'ab'.repeat(32), synced_to_chain: false, wallet_synced: false, num_peers: 0 },
    '/v1/channels': { channels: [{ active: false }] },
    '/v1/state': { state: 'SERVER_ACTIVE' },
    getzmqnotifications: [{ type: 'pubrawblock', address: 'tcp://127.0.0.1:28332' }, { type: 'pubrawtx', address: 'tcp://127.0.0.1:28333' }],
  };
  const calls: string[] = [];
  const transport = { async call<T>(method: string): Promise<T> {
    calls.push(method);
    assert.ok(Object.hasOwn(replies, method), `unexpected call ${method}`);
    return structuredClone(replies[method]) as T;
  } };
  return { replies, calls, transport, run: () => preflight(transport, transport, 'lqwd-lab') };
}

test('preflight distinguishes reachable but unsynced nodes and an unloaded existing wallet', async () => {
  const f = fixtures(); const report = await f.run();
  assert.equal(report.diagnosticsOk, true);
  assert.equal(report.prerequisitesSatisfied, false);
  assert.deepEqual(report.wallet, { loadingRpc: 'ok', loadingReason: null, directoryRpc: 'ok', directoryReason: null, loaded: false, foundOnDisk: true });
  assert.equal(report.bitcoin.height, 0);
  assert.equal(report.lnd.activeChannels, 0); assert.equal(report.lnd.inactiveChannels, 1);
  assert.equal(report.tipsMatch, true);
  for (const blocker of ['CORE_GENESIS_ONLY', 'CORE_SYNC_UNRESOLVED', 'WALLET_NOT_LOADED', 'LND_CHAIN_SYNC_UNRESOLVED', 'LND_WALLET_SYNC_UNRESOLVED', 'NO_ACTIVE_CHANNELS', 'NO_LND_PEERS']) {
    assert.ok(report.blockers.includes(blocker));
  }
  assert.equal(f.calls.length, 7);
});

test('preflight labels the explicit application mode while preserving read-only flags', async () => {
  for (const [mode, label] of [['simulation', 'simulation-read-only'], ['regtest', 'regtest-read-only']] as const) {
    const f = fixtures();
    const report = await preflight(f.transport, f.transport, 'lqwd-lab', mode);
    assert.equal(report.mode, label);
    assert.equal(report.network, 'regtest');
    for (const flag of [report.liveSwapsEnabled, report.signingEnabled, report.broadcastingEnabled, report.miningEnabled, report.paymentsEnabled]) assert.equal(flag, false);
  }
});

test('satisfied diagnostics never enable payments or live swaps', async () => {
  const f = fixtures();
  Object.assign(f.replies.getblockchaininfo as object, { blocks: 100, headers: 100, initialblockdownload: false });
  f.replies.listwallets = ['lqwd-lab'];
  Object.assign(f.replies['/v1/getinfo'] as object, { block_height: 100, synced_to_chain: true, wallet_synced: true, num_peers: 1 });
  f.replies['/v1/channels'] = { channels: [{ active: true }] };
  const report = await f.run();
  assert.equal(report.prerequisitesSatisfied, true);
  for (const flag of [report.liveSwapsEnabled, report.signingEnabled, report.broadcastingEnabled, report.miningEnabled, report.paymentsEnabled]) assert.equal(flag, false);
});

test('missing wallet sync, foreign networks, malformed replies and tip disagreement block readiness', async () => {
  for (const mutate of [
    (f: ReturnType<typeof fixtures>) => { delete (f.replies['/v1/getinfo'] as any).wallet_synced; },
    (f: ReturnType<typeof fixtures>) => { (f.replies.getblockchaininfo as any).chain = 'main'; },
    (f: ReturnType<typeof fixtures>) => { (f.replies['/v1/getinfo'] as any).chains = [{ chain: 'bitcoin', network: 'mainnet' }]; },
    (f: ReturnType<typeof fixtures>) => { (f.replies['/v1/getinfo'] as any).block_hash = 'cd'.repeat(32); },
    (f: ReturnType<typeof fixtures>) => { (f.replies.getblockchaininfo as any).blocks = -1; },
    (f: ReturnType<typeof fixtures>) => { f.replies['/v1/channels'] = {}; },
  ]) {
    const f = fixtures(); mutate(f);
    const report = await f.run();
    assert.equal(report.prerequisitesSatisfied, false);
    assert.equal(report.liveSwapsEnabled, false);
  }
});

test('wallet state endpoint distinguishes a locked LND wallet from an unavailable node', async () => {
  const f = fixtures();
  f.replies['/v1/state'] = { state: 'LOCKED' };
  f.replies['/v1/getinfo'] = {};
  const report = await f.run();
  assert.equal(report.lnd.walletStateRpc, 'ok');
  assert.equal(report.lnd.walletState, 'LOCKED');
  assert.ok(report.blockers.includes('LND_WALLET_LOCKED'));
  assert.equal(report.prerequisitesSatisfied, false);
});

test('Core RPC connectivity alone does not imply required LND ZMQ publishers are configured', async () => {
  const f = fixtures(); f.replies.getzmqnotifications = [];
  const report = await f.run();
  assert.equal(report.bitcoin.rpc, 'ok');
  assert.equal(report.bitcoin.rawBlockNotifications, false);
  assert.equal(report.bitcoin.rawTransactionNotifications, false);
  assert.ok(report.blockers.includes('CORE_RAW_BLOCK_NOTIFICATIONS_UNAVAILABLE'));
  assert.equal(report.prerequisitesSatisfied, false);
});

test('diagnostics suppress remote error messages and handle unavailable services', async () => {
  const failed = { async call<T>(): Promise<T> { throw new Error('credential-secret and sensitive remote response'); } };
  const report = await preflight(failed, failed, 'lqwd-lab');
  assert.equal(report.diagnosticsOk, false);
  assert.equal(report.bitcoin.rpc, 'unavailable');
  assert.equal(report.lnd.rest, 'unavailable');
  assert.equal(report.wallet.loaded, null);
  assert.doesNotMatch(JSON.stringify(report), /credential-secret|sensitive remote/);
});

test('preflight reports safe credential, connectivity and authentication failure reasons', async () => {
  for (const [error, reason] of [
    [Object.assign(new Error('do not print path'), { code: 'ENOENT' }), 'credential_file_missing'],
    [Object.assign(new Error('do not print path'), { code: 'EACCES' }), 'credential_file_unreadable'],
    [new Error('fetch failed', { cause: { code: 'ECONNREFUSED' } }), 'connection_refused'],
    [Object.assign(new Error('do not print cert'), { code: 'ERR_TLS_CERT_ALTNAME_INVALID' }), 'tls_verification_failed'],
    [new Error('LND HTTP 403'), 'authentication_or_permission_rejected'],
  ] as const) {
    const failed = { async call<T>(): Promise<T> { throw error; } };
    const report = await preflight(failed, failed, 'lqwd-lab');
    assert.equal(report.bitcoin.rpcReason, reason);
    assert.equal(report.lnd.restReason, reason);
    assert.doesNotMatch(JSON.stringify(report), /do not print/);
  }
});

test('runtime read-only clients deny mutations before opening credential files or making requests', async () => {
  const bitcoin = new ReadOnlyBitcoinClient('http://127.0.0.1:18443', 'nonexistent-cookie', 'test-wallet');
  const lnd = new ReadOnlyLndClient('https://127.0.0.1:8080', 'nonexistent-cert', 'nonexistent-macaroon');
  for (const method of ['walletcreatefundedpsbt', 'walletprocesspsbt', 'finalizepsbt', 'signrawtransactionwithwallet',
    'sendrawtransaction', 'generatetoaddress', 'generateblock', 'loadwallet', 'createwallet', 'stop', 'unknown']) {
    await assert.rejects(bitcoin.call(method), /READ_ONLY_MODE/);
  }
  await assert.rejects(bitcoin.broadcast('00'), /READ_ONLY_MODE/);
  for (const path of ['/v1/getinfo', '/v1/channels', '/v2/invoices/hodl', '/v2/invoices/settle', '/v1/channels/transactions', '/v2/router/send']) {
    await assert.rejects(lnd.call(path, {}), /READ_ONLY_MODE/);
  }
  await assert.rejects(lnd.call('/v1/unknown'), /READ_ONLY_MODE/);
});

test('unsynced preflight is 503 while UI, liveness and quotes remain available', async () => {
  const f = await setup(); const probes = fixtures();
  const account = await testAccount(f.directory, 'ADMIN');
  const server = createApi(f.manager, async () => { throw new Error('unavailable'); }, probes.run, 'regtest', { auth: { storePath: account.storePath } });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    assert.equal((await fetch(base)).status, 200);
    assert.equal((await fetch(`${base}/v1/health`)).status, 200);
    const response = await fetch(`${base}/v1/preflight`);
    assert.equal(response.status, 503);
    assert.equal((await response.json()).wallet.loaded, false);
    assert.equal((await fetch(`${base}/v1/quotes`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"amountSats":50000}' })).status, 201);
    const auth = await account.headers(base);
    assert.equal((await fetch(`${base}/v1/liquidity`, { headers: { cookie: auth.cookie } })).status, 503);
    const disabled = await fetch(`${base}/v1/swaps/reverse`, { method: 'POST', headers: { ...auth, 'content-type': 'application/json', 'idempotency-key': 'disabled-test' },
      body: JSON.stringify({ quoteId: f.quote.id, paymentHash: f.contract.paymentHash, claimPublicKey: f.contract.claimPublicKey }) });
    assert.equal(disabled.status, 503);
    assert.match((await disabled.json()).error, /LIVE_SWAPS_DISABLED/);
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await f.cleanup();
  }
});

test('regtest HTTP preflight matches health mode and keeps the reverse gate at 503', async () => {
  const f = await setup(); const probes = fixtures();
  const account = await testAccount(f.directory, 'USER');
  const server = createApi(f.manager, async () => ({ onchainSats: 0, incomingSats: 0 }),
    () => preflight(probes.transport, probes.transport, 'lqwd-lab', 'regtest'), 'regtest', { auth: { storePath: account.storePath } });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const health = await (await fetch(`${base}/v1/health`)).json();
    assert.equal(health.mode, 'regtest');
    const response = await fetch(`${base}/v1/preflight`);
    assert.equal(response.status, 503);
    const report = await response.json();
    assert.equal(report.mode, 'regtest-read-only');
    assert.equal(report.liveSwapsEnabled, false);
    const disabled = await fetch(`${base}/v1/swaps/reverse`, { method: 'POST', headers: { ...await account.headers(base), 'content-type': 'application/json', 'idempotency-key': 'regtest-label-test' },
      body: JSON.stringify({ quoteId: f.quote.id, paymentHash: f.contract.paymentHash, claimPublicKey: f.contract.claimPublicKey }) });
    assert.equal(disabled.status, 503);
    assert.match((await disabled.json()).error, /LIVE_SWAPS_DISABLED/);
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await f.cleanup();
  }
});
