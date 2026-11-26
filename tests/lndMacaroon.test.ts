import assert from 'node:assert/strict';
import { createHmac, randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { readFile, rm, writeFile, mkdir, chmod } from 'node:fs/promises';
import type { ClientRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { test } from 'node:test';
import { config } from '../src/config.js';
import { CoreLndForwardPorts } from '../src/core/CoreLndForwardPorts.js';
import { parseLndMacaroon, verifyLndMacaroonRole, type LndMacaroonRole } from '../src/lightning/LndMacaroon.js';
import { HttpsLndPaymentTransport } from '../src/lightning/LndPaymentTransport.js';
import { startApplication } from '../src/main.js';
import { FORWARD_DEPLOYMENT_ID, FORWARD_ORIGIN, FORWARD_PORT, FORWARD_REGTEST_GENESIS } from '../src/forward/ForwardRegtestProfile.js';
import { provisionAccount } from '../scripts/provision-auth.js';
import { runProvisionForwardCLI } from '../scripts/provision-forward-regtest.js';
import { readAccounts } from '../src/auth/store.js';
import { sha256 } from '../src/operator/OperatorFiles.js';
import { createTestForwardLeaseToken, assertPersistentStorage } from '../src/persistence/ForwardPayerRegistry.js';
import { Store } from '../src/persistence/Store.js';
import { buildLndMacaroon, privateTestDirectory } from './helpers.js';
import { execFileSync } from 'node:child_process';

type VectorFile = {
  origin: string;
  syntheticFixtureRootKeyBase64: string;
  storageIdBase64: string;
  location: string;
  vectors: Record<string, {
    base64: string;
    expectedRolesAccepted: LndMacaroonRole[];
    expectedRolesRejected: LndMacaroonRole[];
  }>;
};

function verifyLibmacaroonV2Signature(bytes: Buffer, rootKey: Buffer): boolean {
  // Parse packets to extract identifier, caveats, and signature, then verify chained HMAC-SHA256.
  const readVarint = (pos: number): { v: number; next: number } => {
    let v = 0; let shift = 0; let p = pos;
    while (p < bytes.length) {
      const b = bytes[p++]!;
      v += (b & 0x7f) * (2 ** shift);
      if ((b & 0x80) === 0) return { v, next: p };
      shift += 7;
    }
    throw new Error('EOF');
  };
  let pos = 1;
  let id: Buffer | undefined;
  for (;;) {
    const t = bytes[pos++]!;
    if (t === 0) break;
    const { v: len, next } = readVarint(pos);
    const data = bytes.subarray(next, next + len);
    pos = next + len;
    if (t === 2) id = data;
  }
  const caveats: Buffer[] = [];
  for (;;) {
    const t0 = bytes[pos++]!;
    if (t0 === 0) break;
    let t = t0;
    for (;;) {
      const { v: len, next } = readVarint(pos);
      const data = bytes.subarray(next, next + len);
      pos = next + len;
      if (t === 2) caveats.push(data);
      const tn = bytes[pos++]!;
      if (tn === 0) break;
      t = tn;
    }
  }
  const sigType = bytes[pos++]!;
  const { v: sigLen, next: sigStart } = readVarint(pos);
  assert.equal(sigType, 6);
  assert.equal(sigLen, 32);
  const sig = bytes.subarray(sigStart, sigStart + 32);

  const derived = createHmac('sha256', Buffer.from('macaroons-key-generator', 'utf8')).update(rootKey).digest();
  let expected = createHmac('sha256', derived).update(id!).digest();
  for (const cav of caveats) {
    expected = createHmac('sha256', expected).update(cav).digest();
  }
  return sig.equals(expected);
}

test('M1: official macaroon-bakery.v2 reference vectors verify HMAC signatures and strict role policies', async () => {
  const raw = await readFile(new URL('./fixtures/lnd-macaroon-vectors.json', import.meta.url), 'utf8');
  const fixture = JSON.parse(raw) as VectorFile;
  const rootKey = Buffer.from(fixture.syntheticFixtureRootKeyBase64, 'base64');

  for (const [name, entry] of Object.entries(fixture.vectors)) {
    const bytes = Buffer.from(entry.base64, 'base64');
    assert.equal(verifyLibmacaroonV2Signature(bytes, rootKey), true, `${name} HMAC signature valid`);
    const parsed = parseLndMacaroon(bytes);
    assert.equal(parsed.location, fixture.location, `${name} location`);

    for (const role of entry.expectedRolesAccepted) {
      verifyLndMacaroonRole(bytes, role);
    }
    for (const role of entry.expectedRolesRejected) {
      assert.throws(() => verifyLndMacaroonRole(bytes, role), /FORWARD_MACAROON_ROLE_REJECTED/, `${name} must reject ${role}`);
    }
  }
});

test('M1: rejects generic offchain:write, extra URIs, readonly outside allowlist, fake uri: entity, and malformed protobuf/packets', () => {
  // Reject generic offchain:write for router & readonly
  for (const role of ['router', 'readonly', 'payer-readonly', 'payee-readonly'] as const) {
    assert.throws(() => verifyLndMacaroonRole(buildLndMacaroon([{ entity: 'offchain', actions: ['read', 'write'] }]), role), /FORWARD_MACAROON_ROLE_REJECTED/);
    assert.throws(() => verifyLndMacaroonRole(buildLndMacaroon([{ entity: 'offchain', actions: ['write'] }]), role), /FORWARD_MACAROON_ROLE_REJECTED/);
  }

  // Reject old text-format uri:/... entity (fake encoding)
  assert.throws(() => verifyLndMacaroonRole(Buffer.concat([
    Buffer.from([0x02, 0x01, 0x03, ...Buffer.from('lnd'), 0x02, 0x45, 0x03]),
    Buffer.from([0x0a, 0x10, ...Buffer.alloc(16, 1), 0x1a, 0x2f, 0x0a, 0x2d, ...Buffer.from('uri:/routerrpc.Router/SendPaymentV2')]),
    Buffer.from([0x00, 0x00, 0x06, 0x20, ...Buffer.alloc(32, 2)]),
  ]), 'router'), /FORWARD_MACAROON_INVALID|FORWARD_MACAROON_ROLE_REJECTED/);

  // Router URI must be exact SendPaymentV2 + TrackPaymentV2 (no extra URI, no mixed entity)
  assert.throws(() => verifyLndMacaroonRole(buildLndMacaroon([{
    entity: 'uri',
    actions: ['/routerrpc.Router/SendPaymentV2', '/routerrpc.Router/TrackPaymentV2', '/routerrpc.Router/SendToRouteV2'],
  }]), 'router'), /FORWARD_MACAROON_ROLE_REJECTED/);
  assert.throws(() => verifyLndMacaroonRole(buildLndMacaroon([
    { entity: 'uri', actions: ['/routerrpc.Router/SendPaymentV2', '/routerrpc.Router/TrackPaymentV2'] },
    { entity: 'info', actions: ['read'] },
  ]), 'router'), /FORWARD_MACAROON_ROLE_REJECTED/);

  // Readonly rejects extra entities outside {info, offchain, onchain}, missing onchain:read, and extra read URIs
  for (const extraEntity of ['invoices', 'macaroon', 'signer', 'address', 'message', 'peers', 'wallet', 'custom']) {
    assert.throws(() => verifyLndMacaroonRole(buildLndMacaroon([
      { entity: 'info', actions: ['read'] },
      { entity: 'offchain', actions: ['read'] },
      { entity: 'onchain', actions: ['read'] },
      { entity: extraEntity, actions: ['read'] },
    ]), 'readonly'), /FORWARD_MACAROON_ROLE_REJECTED/);
  }
  assert.throws(() => verifyLndMacaroonRole(buildLndMacaroon([
    { entity: 'info', actions: ['read'] },
    { entity: 'offchain', actions: ['read'] },
  ]), 'readonly'), /FORWARD_MACAROON_ROLE_REJECTED/);

  // Optional /lnrpc.State/GetState allowed in read URI macaroons, but any unlisted URI rejected
  verifyLndMacaroonRole(buildLndMacaroon([{
    entity: 'uri',
    actions: [
      '/lnrpc.Lightning/GetInfo',
      '/lnrpc.Lightning/ListChannels',
      '/lnrpc.Lightning/WalletBalance',
      '/lnrpc.Lightning/ListPayments',
      '/lnrpc.Lightning/DecodePayReq',
      '/lnrpc.State/GetState',
    ],
  }]), 'payer-readonly');
  verifyLndMacaroonRole(buildLndMacaroon([{
    entity: 'uri',
    actions: [
      '/lnrpc.Lightning/GetInfo',
      '/lnrpc.Lightning/ListChannels',
      '/lnrpc.Lightning/WalletBalance',
      '/lnrpc.State/GetState',
    ],
  }]), 'payee-readonly');
  assert.throws(() => verifyLndMacaroonRole(buildLndMacaroon([{
    entity: 'uri',
    actions: [
      '/lnrpc.Lightning/GetInfo',
      '/lnrpc.Lightning/ListChannels',
      '/lnrpc.Lightning/WalletBalance',
      '/lnrpc.Lightning/LookupInvoice',
    ],
  }]), 'payee-readonly'), /FORWARD_MACAROON_ROLE_REJECTED/);

  // Parser rejects duplicate header packets, duplicate protobuf fields, duplicate actions, unknown fields
  const validRouter = buildLndMacaroon([{
    entity: 'uri',
    actions: ['/routerrpc.Router/SendPaymentV2', '/routerrpc.Router/TrackPaymentV2'],
  }]);
  assert.throws(() => parseLndMacaroon(Buffer.concat([validRouter, Buffer.from([0x00])])), /FORWARD_MACAROON_INVALID/);

  // Duplicate action inside same Op
  assert.throws(() => parseLndMacaroon(buildLndMacaroon([{
    entity: 'uri',
    actions: ['/routerrpc.Router/SendPaymentV2', '/routerrpc.Router/SendPaymentV2'],
  }])), /FORWARD_MACAROON_INVALID/);

  // Duplicate op entity with same action across Ops
  assert.throws(() => verifyLndMacaroonRole(buildLndMacaroon([
    { entity: 'uri', actions: ['/routerrpc.Router/SendPaymentV2'] },
    { entity: 'uri', actions: ['/routerrpc.Router/SendPaymentV2', '/routerrpc.Router/TrackPaymentV2'] },
  ]), 'router'), /FORWARD_MACAROON_ROLE_REJECTED/);

  // Unknown protobuf field inside MacaroonId (field 4)
  const badId = Buffer.from([
    0x03,
    0x0a, 0x08, 1, 2, 3, 4, 5, 6, 7, 8,
    0x22, 0x02, 0xaa, 0xbb,
    0x1a, 0x0c, 0x0a, 0x04, ...Buffer.from('info'), 0x12, 0x04, ...Buffer.from('read'),
  ]);
  const badMac = Buffer.concat([
    Buffer.from([0x02, 0x02, badId.length]), badId,
    Buffer.from([0x00, 0x00, 0x06, 0x20, ...Buffer.alloc(32, 0x33)]),
  ]);
  assert.throws(() => parseLndMacaroon(badMac), /FORWARD_MACAROON_INVALID/);
});

test('M2: exclusive :3201 forward profile blocks alien mutations (HTTP anonymous/auth, before/after state.json bytes) and requires explicit off flags while preserving non-forward profiles', async t => {
  const root = await privateTestDirectory('fwd-m2-http');
  t.after(() => rm(root, { recursive: true, force: true }));
  const registryDir = join(root, 'registry');
  const dataDir = join(root, 'fwd-state');
  const credsDir = join(root, 'creds');
  await mkdir(credsDir, { mode: 0o700 });
  await mkdir(dataDir, { mode: 0o700 });

  const authStorePath = join(root, 'auth-3201.json');
  const password = randomBytes(24).toString('base64url');
  await provisionAccount(authStorePath, 'admin3201', 'ADMIN', password);
  await provisionAccount(authStorePath, 'user3201', 'USER', password);
  const accounts = await readAccounts(authStorePath);
  const owner = accounts.find(a => a.username === 'admin3201')!;

  const payerKeyPath = join(credsDir, 'payer.key');
  const payerCertPath = join(credsDir, 'payer.cert');
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', payerKeyPath, '-out', payerCertPath, '-days', '2',
    '-subj', '/CN=payer', '-addext', 'subjectAltName=IP:127.0.0.1,DNS:localhost',
  ], { stdio: 'ignore' });
  await chmod(payerCertPath, 0o600);

  const payeeCertPath = join(credsDir, 'payee.cert');
  await writeFile(payeeCertPath, await readFile(payerCertPath), { mode: 0o600 });
  const bitcoinCookiePath = join(credsDir, 'core.cookie');
  await writeFile(bitcoinCookiePath, '__cookie__:synthetic\n', { mode: 0o600 });
  const payerReadMacPath = join(credsDir, 'payer-ro.mac');
  const payeeReadMacPath = join(credsDir, 'payee-ro.mac');
  const payerRouterMacPath = join(credsDir, 'payer-router.mac');
  await writeFile(payerReadMacPath, buildLndMacaroon([{
    entity: 'uri',
    actions: ['/lnrpc.Lightning/GetInfo', '/lnrpc.Lightning/ListChannels', '/lnrpc.Lightning/WalletBalance', '/lnrpc.Lightning/ListPayments', '/lnrpc.Lightning/DecodePayReq'],
  }]), { mode: 0o600 });
  await writeFile(payeeReadMacPath, buildLndMacaroon([{
    entity: 'uri',
    actions: ['/lnrpc.Lightning/GetInfo', '/lnrpc.Lightning/ListChannels', '/lnrpc.Lightning/WalletBalance'],
  }]), { mode: 0o600 });
  await writeFile(payerRouterMacPath, buildLndMacaroon([{
    entity: 'uri',
    actions: ['/routerrpc.Router/SendPaymentV2', '/routerrpc.Router/TrackPaymentV2'],
  }]), { mode: 0o600 });

  const payerPubkey = '02' + '11'.repeat(32);
  const payeePubkey = '03' + '22'.repeat(32);
  const policy = {
    mode: 'regtest' as const,
    deploymentId: FORWARD_DEPLOYMENT_ID,
    origin: FORWARD_ORIGIN,
    port: FORWARD_PORT,
    authStorePath,
    ownerId: owner.id,
    ownerUsername: owner.username,
    genesisHash: FORWARD_REGTEST_GENESIS,
    wallet: 'iso_rt_core_fwd',
    payerNode: payerPubkey,
    payeeNode: payeePubkey,
    channelId: '1099511627776',
    channelPoint: 'aa'.repeat(32) + ':0',
    dataDir,
    routing: { bitcoinOrigin: 'http://127.0.0.1:49443', payerOrigin: 'https://127.0.0.1:49081', payeeOrigin: 'https://127.0.0.1:49082' },
    credentialPaths: {
      bitcoinCookiePath,
      payerCertPath,
      payerReadMacaroonPath: payerReadMacPath,
      payerRouterMacaroonPath: payerRouterMacPath,
      payeeCertPath,
      payeeReadMacaroonPath: payeeReadMacPath,
    },
    limits: { invoiceSats: 5000 as const, feeLimitSats: 100 as const, depositSats: 5100 as const, maxRuns: 1 as const },
  };
  const policyPath = join(root, 'policy.json');
  const policyBytes = Buffer.from(JSON.stringify(policy, null, 2) + '\n');
  await writeFile(policyPath, policyBytes, { mode: 0o600 });
  const policyHash = sha256(policyBytes);

  const testToken = createTestForwardLeaseToken();
  assert.equal(await runProvisionForwardCLI(['--policy-path', policyPath, '--policy-sha256', policyHash], {
    provisionFresh: (d, n, s) => Store.provisionFreshForwardWithTestToken(testToken, d, n, registryDir, true, s),
    log: () => {}, error: () => {},
  }), 0);

  const baseEnv: Record<string, string> = {
    APP_ENV: 'regtest', APP_MODE: 'regtest', SPEND_POLICY: 'regtest-only',
    FORWARD_SWAP_ENABLED: 'true', REVERSE_SWAP_ENABLED: 'false', GUEST_SWAP_ENABLED: 'false',
    REGTEST_AUTO_MINING: 'false', MINING_POLICY: 'disabled', ENABLE_LIVE_SWAPS: 'false',
    ENABLE_READ_ONLY_RECOVERY: 'false', ARK_ENABLED: 'false', ARK_EXECUTION_ENABLED: 'false',
    LIQUID_ENABLED: 'false', LIQUID_EXECUTION_ENABLED: 'false',
    DEPLOYMENT_ID: FORWARD_DEPLOYMENT_ID, PORT: String(FORWARD_PORT),
    DATA_DIR: dataDir, AUTH_STORE_PATH: authStorePath, AUTH_ORIGIN: FORWARD_ORIGIN,
    BITCOIN_RPC_URL: policy.routing.bitcoinOrigin, BITCOIN_COOKIE_PATH: bitcoinCookiePath, BITCOIN_WALLET: policy.wallet,
    LND_REST_URL: policy.routing.payerOrigin, LND_TLS_CERT_PATH: payerCertPath, LND_MACAROON_PATH: payerReadMacPath,
    ALICE_LND_REST_URL: policy.routing.payeeOrigin, ALICE_LND_TLS_CERT_PATH: payeeCertPath, ALICE_LND_MACAROON_PATH: payeeReadMacPath,
  };
  const args = ['--forward-regtest', '--policy-path', policyPath, '--policy-sha256', policyHash];
  const tipHash = 'bb'.repeat(32);
  const clients = {
    core: {
      async call<T>(method: string): Promise<T> {
        if (method === 'getblockchaininfo') return { chain: 'regtest', initialblockdownload: false, blocks: 250, headers: 250, bestblockhash: tipHash } as T;
        if (method === 'getblockhash') return FORWARD_REGTEST_GENESIS as T;
        if (method === 'listwallets') return [policy.wallet] as T;
        if (method === 'getwalletinfo') return { walletname: policy.wallet, private_keys_enabled: true } as T;
        if (method === 'getbalances') return { mine: { trusted: 0, untrusted_pending: 0, immature: 0 } } as T;
        if (method === 'getzmqnotifications') return [{ type: 'pubrawblock', address: 'tcp://127.0.0.1:28332' }, { type: 'pubrawtx', address: 'tcp://127.0.0.1:28333' }] as T;
        if (method === 'gettxout') return { confirmations: 6, bestblock: tipHash, coinbase: false, scriptPubKey: { hex: '0020' + 'dd'.repeat(32) } } as T;
        throw new Error(`unexpected ${method}`);
      },
    },
    payer: {
      origin: policy.routing.payerOrigin,
      async call<T>(path: string): Promise<T> {
        if (path === '/v1/state') return { state: 'SERVER_ACTIVE' } as T;
        if (path === '/v1/getinfo') return { identity_pubkey: payerPubkey, synced_to_chain: true, wallet_synced: true, version: '0.20.8-beta commit=v0.20.8-beta', commit_hash: '33f90e82464daf9e6d2f2a02e754955ba42e2951', block_hash: tipHash, block_height: 250, chains: [{ chain: 'bitcoin', network: 'regtest' }] } as T;
        if (path === '/v1/channels') return { channels: [{ chan_id: policy.channelId, channel_point: policy.channelPoint, remote_pubkey: payeePubkey, active: true, zero_conf: false, local_balance: '290000', remote_balance: '0', commit_fee: '1500', unsettled_balance: '0', pending_htlcs: [], local_constraints: { chan_reserve_sat: '3000' } }] } as T;
        if (path.startsWith('/v1/payments')) return { first_index_offset: '0', last_index_offset: '0', payments: [] } as T;
        throw new Error(`unexpected ${path}`);
      },
    },
    payee: {
      origin: policy.routing.payeeOrigin,
      async call<T>(path: string): Promise<T> {
        if (path === '/v1/state') return { state: 'SERVER_ACTIVE' } as T;
        if (path === '/v1/getinfo') return { identity_pubkey: payeePubkey, synced_to_chain: true, wallet_synced: true, version: '0.20.8-beta commit=v0.20.8-beta', block_hash: tipHash, block_height: 250, chains: [{ chain: 'bitcoin', network: 'regtest' }] } as T;
        if (path === '/v1/channels') return { channels: [{ chan_id: policy.channelId, channel_point: policy.channelPoint, remote_pubkey: payerPubkey, active: true, zero_conf: false, local_balance: '0', remote_balance: '290000', commit_fee: '1500', unsettled_balance: '0', pending_htlcs: [], local_constraints: { chan_reserve_sat: '3000' } }] } as T;
        throw new Error(`unexpected ${path}`);
      },
    },
    transport: { origin: policy.routing.payerOrigin, async stream() {}, async probeRouterAuth() {} },
  };
  const identity = {
    environment: 'regtest' as const, deploymentId: FORWARD_DEPLOYMENT_ID, genesisHash: FORWARD_REGTEST_GENESIS,
    wallet: policy.wallet, bitcoinOrigin: policy.routing.bitcoinOrigin, providerOrigin: policy.routing.payerOrigin,
    payerOrigin: policy.routing.payeeOrigin, providerNode: payerPubkey, payerNode: payeePubkey,
    verified: { onchain: true, lightning: true },
  };
  const bootWith = (env: Record<string, string>) => startApplication(env, args, {
    port: 0,
    reads: { liquidity: async () => ({ onchainSats: 0, incomingSats: 0 }) },
    identity,
    forward: {
      openStore: (d, n) => Store.openForForwardWithTestToken(testToken, d, n, registryDir),
      assertPersistentStorage: async () => {},
      clients: () => clients,
      testToken,
    },
  });

  // Omitting any explicit off flag rejects startup
  for (const omitFlag of [
    'REVERSE_SWAP_ENABLED', 'GUEST_SWAP_ENABLED', 'REGTEST_AUTO_MINING',
    'MINING_POLICY', 'ENABLE_LIVE_SWAPS', 'ENABLE_READ_ONLY_RECOVERY',
    'ARK_ENABLED', 'ARK_EXECUTION_ENABLED', 'LIQUID_ENABLED', 'LIQUID_EXECUTION_ENABLED',
  ]) {
    const mutated = { ...baseEnv };
    delete mutated[omitFlag];
    await assert.rejects(bootWith(mutated), /FORWARD_EXECUTION_DISABLED/, `Omitting ${omitFlag} must fail`);
  }
  await assert.rejects(bootWith({ ...baseEnv, REVERSE_SWAP_ENABLED: 'true' }), /FORWARD_EXECUTION_DISABLED/);

  // Normal profile (without --forward-regtest) still defaults reverse=true cleanly
  assert.equal(config({ APP_ENV: 'regtest', DEPLOYMENT_ID: 'preview' }).features.reverse, true);

  // Boot exclusive forward server and compare state.json bytes before & after anonymous + authenticated alien mutations
  const app = await bootWith(baseEnv);
  try {
    const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
    const stateBefore = await readFile(join(dataDir, 'state.json'));

    // Anonymous POSTs to alien mutation routes
    assert.equal((await fetch(`${base}/v1/quotes`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ amountSats: 50_000 }),
    })).status, 503);
    assert.equal((await fetch(`${base}/v1/ark/quotes`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ route: 'onchain-to-ark', amountSats: 50_000 }),
    })).status, 503);
    assert.equal((await fetch(`${base}/v1/guest/quotes`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    })).status, 503);
    assert.equal((await fetch(`${base}/v1/swaps/reverse`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    })).status, 401);
    assert.equal((await fetch(`${base}/v1/ark/swaps`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    })).status, 401);
    assert.equal((await fetch(`${base}/v1/liquid/lightning/quotes`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    })).status, 401);

    // Authenticated ADMIN POSTs to alien mutation routes
    const loginRes = await fetch(`${base}/v1/auth/login`, {
      method: 'POST', headers: { origin: FORWARD_ORIGIN, 'content-type': 'application/json' },
      body: JSON.stringify({ username: owner.username, password }),
    });
    assert.equal(loginRes.status, 200);
    const cookie = loginRes.headers.get('set-cookie')!.split(';')[0]!;
    const csrf = (await loginRes.json()).csrfToken as string;
    const authHeaders = { origin: FORWARD_ORIGIN, cookie, 'x-csrf-token': csrf, 'content-type': 'application/json' };

    for (const [path, payload] of [
      ['/v1/quotes', { amountSats: 50_000 }],
      ['/v1/ark/quotes', { route: 'onchain-to-ark', amountSats: 50_000 }],
      ['/v1/guest/quotes', {}],
      ['/v1/liquid/lightning/quotes', {}],
      ['/v1/liquid/lightning/swaps', {}],
      ['/v1/ark/swaps', {}],
      ['/v1/swaps/reverse', {}],
    ] as const) {
      const res = await fetch(`${base}${path}`, {
        method: 'POST', headers: authHeaders, body: JSON.stringify(payload),
      });
      assert.equal(res.status, 503, `Authenticated ${path} must return 503 in exclusive forward profile`);
    }

    // Verify forward availability still works (200) and state.json is byte-for-byte identical
    const avail = await fetch(`${base}/v1/forward/availability`, { headers: { cookie } });
    assert.equal(avail.status, 200);
    assert.deepEqual(await avail.json(), { executionAvailable: true });
    const stateAfter = await readFile(join(dataDir, 'state.json'));
    assert.equal(Buffer.compare(stateBefore, stateAfter), 0, 'state.json bytes must be untouched');
    assert.equal(sha256(stateBefore), sha256(stateAfter));
  } finally {
    await app.close();
  }

  // Verify normal non-forward profile (args=[]) keeps POST /v1/quotes operational (201)
  const previewDir = join(root, 'preview-state');
  await mkdir(previewDir, { mode: 0o700 });
  const preview = await startApplication({
    APP_ENV: 'regtest', APP_MODE: 'regtest', DEPLOYMENT_ID: 'preview-normal',
    DATA_DIR: previewDir, PORT: String(FORWARD_PORT),
  }, [], { port: 0, reads: { liquidity: async () => ({ onchainSats: 0, incomingSats: 0 }) } });
  try {
    const pBase = `http://127.0.0.1:${(preview.server.address() as AddressInfo).port}`;
    const qRes = await fetch(`${pBase}/v1/quotes`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ amountSats: 50_000 }),
    });
    assert.equal(qRes.status, 201);
  } finally {
    await preview.close();
  }
});

test('m1-m3: CoreLndForwardPorts checks commit_hash, assertPersistentStorage guards /tmp, and transport zeroes macaroon on abort/error', async () => {
  // m1: inspectPayer rejects missing or wrong commit_hash when wallet_synced is undefined
  const payer = '02' + '11'.repeat(32);
  const payee = '03' + '22'.repeat(32);
  const tip = 'bb'.repeat(32);
  const core = { call: async <T>() => ({ chain: 'regtest', bestblockhash: tip, blocks: 100 }) as T };
  const badCommitPorts = new CoreLndForwardPorts(core, {
    origin: 'https://127.0.0.1:48080',
    call: async <T>() => ({
      identity_pubkey: payer, synced_to_chain: true, version: '0.20.8-beta commit=v0.20.8-beta',
      commit_hash: 'deadbeef', block_hash: tip, block_height: 100, chains: [{ chain: 'bitcoin', network: 'regtest' }],
    }) as T,
  }, { origin: 'https://127.0.0.1:48080', stream: async () => {} }, payer, payee, '123');
  await assert.rejects(badCommitPorts.inspectPayer(), /not synced/);

  // m2: assertPersistentStorage rejects /tmp and /dev/shm paths
  await assert.rejects(assertPersistentStorage('/tmp/test-registry'), /FORWARD_VOLATILE_STORAGE_FORBIDDEN/);
  await assert.rejects(assertPersistentStorage('/dev/shm/test-registry'), /FORWARD_VOLATILE_STORAGE_FORBIDDEN/);

  // m3: HttpsLndPaymentTransport zeroes macaroon on beforeRequest throw and on abort (before/after beforeRequest)
  const body = {
    payment_request: 'lnbcrt' + 'a'.repeat(30), timeout_seconds: 60, fee_limit_sat: '100', max_parts: 16,
    outgoing_chan_ids: ['12345'], no_inflight_updates: false, allow_self_payment: false, amp: false, cancelable: false,
  };
  const macBuf1 = Buffer.from('secret-macaroon-bytes-0001', 'utf8');
  const transport1 = new HttpsLndPaymentTransport('https://127.0.0.1:8081', 'unused', 'unused', {
    credentials: async () => ({ ca: Buffer.from('ca'), macaroon: macBuf1 }),
    request: () => new EventEmitter() as ClientRequest,
  });
  await assert.rejects(transport1.stream('/v2/router/send', body, () => false, new AbortController().signal, async () => {
    throw new Error('guard rejected');
  }));
  assert.equal(macBuf1.every(b => b === 0), true, 'macaroon buffer must be zeroed when beforeRequest throws');

  const macBuf2 = Buffer.from('secret-macaroon-bytes-0002', 'utf8');
  const ac2 = new AbortController();
  const transport2 = new HttpsLndPaymentTransport('https://127.0.0.1:8081', 'unused', 'unused', {
    credentials: async () => { ac2.abort(); return { ca: Buffer.from('ca'), macaroon: macBuf2 }; },
    request: () => new EventEmitter() as ClientRequest,
  });
  await assert.rejects(transport2.stream('/v2/router/send', body, () => false, ac2.signal));
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(macBuf2.every(b => b === 0), true, 'macaroon buffer must be zeroed on abort before beforeRequest');

  const macBuf3 = Buffer.from('secret-macaroon-bytes-0003', 'utf8');
  const ac3 = new AbortController();
  const transport3 = new HttpsLndPaymentTransport('https://127.0.0.1:8081', 'unused', 'unused', {
    credentials: async () => ({ ca: Buffer.from('ca'), macaroon: macBuf3 }),
    request: () => new EventEmitter() as ClientRequest,
  });
  await assert.rejects(transport3.stream('/v2/router/send', body, () => false, ac3.signal, async () => {
    ac3.abort();
  }));
  assert.equal(macBuf3.every(b => b === 0), true, 'macaroon buffer must be zeroed on abort during beforeRequest');
});
