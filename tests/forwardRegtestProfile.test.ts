import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { address, networks, payments } from 'bitcoinjs-lib';
import { provisionAccount } from '../scripts/provision-auth.js';
import { readAccounts } from '../src/auth/store.js';
import {
  assertPersistentStorage,
  FORWARD_DEPLOYMENT_ID,
  FORWARD_ORIGIN,
  FORWARD_PORT,
  FORWARD_REGTEST_GENESIS,
  type ForwardClients,
  type ForwardRegtestOverrides,
  type ForwardRegtestPolicy,
} from '../src/forward/ForwardRegtestProfile.js';
import type { PaymentStreamTransport } from '../src/lightning/LndPaymentTransport.js';
import { recoveryPaymentsPath } from '../src/lightning/LndPayerRecovery.js';
import { sha256 } from '../src/operator/OperatorFiles.js';
import { createTestForwardLeaseToken } from '../src/persistence/ForwardPayerRegistry.js';
import { Store } from '../src/persistence/Store.js';
import { forwardStartupArguments, startApplication } from '../src/main.js';
import { api } from '../src/web/api.js';
import { buildLndMacaroon, privateTestDirectory } from './helpers.js';

const payerPubkey = '02' + '11'.repeat(32);
const payeePubkey = '03' + '22'.repeat(32);
const channelId = '1099511627776';
const channelPoint = 'aa'.repeat(32) + ':0';
const tipHash = 'bb'.repeat(32);
const lndCommitHash = '33f90e82464daf9e6d2f2a02e754955ba42e2951';

function makeInvoice(seed: string, sats = 5000) {
  const preimage = seed.repeat(32);
  const paymentHash = createHash('sha256').update(Buffer.from(preimage, 'hex')).digest('hex');
  const char = seed[0] === '9' ? 'a' : seed[0] === '8' ? 'b' : 'c';
  const invoice = 'lnbcrt' + char.repeat(40);
  return { preimage, paymentHash, invoice, sats };
}

async function createProfileFixture(t: TestContext) {
  const root = await privateTestDirectory('fwd-profile');
  t.after(() => rm(root, { recursive: true, force: true }));
  const registryDir = join(root, 'registry');
  const dataDir = join(root, 'fwd-state');
  const credsDir = join(root, 'creds');
  await mkdir(credsDir, { mode: 0o700 });
  const authStorePath = join(root, 'auth-3201.json');
  const password = randomBytes(24).toString('base64url');
  await provisionAccount(authStorePath, 'admin3201', 'ADMIN', password);
  await provisionAccount(authStorePath, 'other-admin', 'ADMIN', password);
  await provisionAccount(authStorePath, 'regular-user', 'USER', password);
  const accounts = await readAccounts(authStorePath);
  const owner = accounts.find(a => a.username === 'admin3201')!;
  const otherAdmin = accounts.find(a => a.username === 'other-admin')!;
  const regularUser = accounts.find(a => a.username === 'regular-user')!;

  const credPaths = {
    bitcoinCookiePath: join(credsDir, 'core.cookie'),
    payerCertPath: join(credsDir, 'payer-tls.cert'),
    payerReadMacaroonPath: join(credsDir, 'payer-readonly.macaroon'),
    payerRouterMacaroonPath: join(credsDir, 'payer-router.macaroon'),
    payeeCertPath: join(credsDir, 'payee-tls.cert'),
    payeeReadMacaroonPath: join(credsDir, 'payee-readonly.macaroon'),
  };
  const readonlyOps = [
    { entity: 'info', actions: ['read'] },
    { entity: 'offchain', actions: ['read'] },
    { entity: 'onchain', actions: ['read'] },
  ];
  await writeFile(credPaths.bitcoinCookiePath, '__cookie__:synthetic\n', { mode: 0o600 });
  await writeFile(credPaths.payerCertPath, randomBytes(32), { mode: 0o600 });
  await writeFile(credPaths.payeeCertPath, randomBytes(32), { mode: 0o600 });
  await writeFile(credPaths.payerReadMacaroonPath, buildLndMacaroon(readonlyOps), { mode: 0o600 });
  await writeFile(credPaths.payeeReadMacaroonPath, buildLndMacaroon(readonlyOps), { mode: 0o600 });
  await writeFile(credPaths.payerRouterMacaroonPath, buildLndMacaroon([{
    entity: 'uri',
    actions: ['/routerrpc.Router/SendPaymentV2', '/routerrpc.Router/TrackPaymentV2'],
  }]), { mode: 0o600 });

  const depositAddress = payments.p2wpkh({ hash: Buffer.alloc(20, 0x42), network: networks.regtest }).address!;
  const depositScript = Buffer.from(address.toOutputScript(depositAddress, networks.regtest)).toString('hex');

  const policy: ForwardRegtestPolicy = {
    mode: 'regtest',
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
    channelId,
    channelPoint,
    dataDir,
    routing: {
      bitcoinOrigin: 'http://127.0.0.1:49443',
      payerOrigin: 'https://127.0.0.1:49081',
      payeeOrigin: 'https://127.0.0.1:49082',
    },
    credentialPaths: credPaths,
    limits: { invoiceSats: 5000, feeLimitSats: 100, depositSats: 5100, maxRuns: 1 },
  };

  const writePolicy = async (next: unknown = policy, name = 'profile.json') => {
    const path = join(root, name);
    const bytes = Buffer.from(JSON.stringify(next, null, 2) + '\n');
    await writeFile(path, bytes, { mode: 0o600 });
    return { path, hash: sha256(bytes) };
  };
  const written = await writePolicy();

  const env: Record<string, string> = {
    APP_ENV: 'regtest',
    APP_MODE: 'regtest',
    SPEND_POLICY: 'regtest-only',
    FORWARD_SWAP_ENABLED: 'true',
    REVERSE_SWAP_ENABLED: 'false',
    GUEST_SWAP_ENABLED: 'false',
    REGTEST_AUTO_MINING: 'false',
    MINING_POLICY: 'disabled',
    ENABLE_LIVE_SWAPS: 'false',
    ENABLE_READ_ONLY_RECOVERY: 'false',
    ARK_ENABLED: 'false',
    ARK_EXECUTION_ENABLED: 'false',
    LIQUID_ENABLED: 'false',
    LIQUID_EXECUTION_ENABLED: 'false',
    DEPLOYMENT_ID: FORWARD_DEPLOYMENT_ID,
    PORT: String(FORWARD_PORT),
    DATA_DIR: dataDir,
    AUTH_STORE_PATH: authStorePath,
    AUTH_ORIGIN: FORWARD_ORIGIN,
    BITCOIN_RPC_URL: policy.routing.bitcoinOrigin,
    BITCOIN_COOKIE_PATH: credPaths.bitcoinCookiePath,
    BITCOIN_WALLET: policy.wallet,
    LND_REST_URL: policy.routing.payerOrigin,
    LND_TLS_CERT_PATH: credPaths.payerCertPath,
    LND_MACAROON_PATH: credPaths.payerReadMacaroonPath,
    ALICE_LND_REST_URL: policy.routing.payeeOrigin,
    ALICE_LND_TLS_CERT_PATH: credPaths.payeeCertPath,
    ALICE_LND_MACAROON_PATH: credPaths.payeeReadMacaroonPath,
  };

  const inv1 = makeInvoice('99', 5000);
  const inv2 = makeInvoice('88', 5000);
  const depositTxid = 'cc'.repeat(32);
  const depositVout = 0;

  const state = {
    genesisHash: FORWARD_REGTEST_GENESIS,
    blocks: 250,
    headers: 250,
    initialBlockDownload: false,
    fundingConfs: 6,
    fundingCoinbase: false,
    payerLocalBalance: '290000',
    payerReserve: '3000',
    payerCommitFee: '1500',
    payerPendingHtlcs: [] as unknown[],
    payerZeroConf: false,
    payerSynced: true,
    payerWalletSynced: true as boolean | undefined,
    payerVersion: '0.20.8-beta commit=v0.20.8-beta',
    payerState: 'SERVER_ACTIVE',
    payeeSynced: true,
    payeeHasChannel: true,
    payerHasPriorPayments: false,
    depositValueSats: 5100,
    depositConfs: 2,
    depositCoinbase: false,
    disconnectOnSend: false,
    sendFeeMsat: 100,
    trackOutcome: 'SUCCEEDED' as 'SUCCEEDED' | 'INSUFFICIENT_BALANCE' | 'HIGH_FEE',
    beforeSendHook: undefined as (() => Promise<void>) | undefined,
    counts: { allocations: 0, sends: 0, tracks: 0 },
  };

  const clients: ForwardClients = {
    core: {
      async call<T>(method: string, params: unknown[] = []): Promise<T> {
        if (method === 'getblockchaininfo') {
          return {
            chain: 'regtest',
            initialblockdownload: state.initialBlockDownload,
            blocks: state.blocks,
            headers: state.headers,
            bestblockhash: tipHash,
          } as T;
        }
        if (method === 'getblockhash') return state.genesisHash as T;
        if (method === 'listwallets') return [policy.wallet] as T;
        if (method === 'getwalletinfo') return { walletname: policy.wallet, private_keys_enabled: true } as T;
        if (method === 'getbalances') return { mine: { trusted: 0, untrusted_pending: 0, immature: 0 } } as T;
        if (method === 'getzmqnotifications') {
          return [{ type: 'pubrawblock', address: 'tcp://127.0.0.1:28332' }, { type: 'pubrawtx', address: 'tcp://127.0.0.1:28333' }] as T;
        }
        if (method === 'getnewaddress') {
          state.counts.allocations++;
          return depositAddress as T;
        }
        if (method === 'getaddressinfo') {
          return { scriptPubKey: depositScript, ismine: true, iswatchonly: false } as T;
        }
        if (method === 'gettxout') {
          const [txid] = params as [string, number, boolean];
          if (txid === 'aa'.repeat(32)) {
            return {
              confirmations: state.fundingConfs,
              bestblock: tipHash,
              coinbase: state.fundingCoinbase,
              scriptPubKey: { hex: '0020' + 'dd'.repeat(32) },
            } as T;
          }
          if (txid === depositTxid) {
            return {
              bestblock: tipHash,
              coinbase: state.depositCoinbase,
              confirmations: state.depositConfs,
              value: state.depositValueSats / 1e8,
              scriptPubKey: { hex: depositScript },
            } as T;
          }
          return null as T;
        }
        throw new Error(`Unexpected Core call: ${method}`);
      },
    },
    payer: {
      origin: policy.routing.payerOrigin,
      async call<T>(path: string): Promise<T> {
        if (path === '/v1/state') return { state: state.payerState } as T;
        if (path === '/v1/getinfo') {
          return {
            identity_pubkey: payerPubkey,
            synced_to_chain: state.payerSynced,
            ...(state.payerWalletSynced === undefined ? {} : { wallet_synced: state.payerWalletSynced }),
            version: state.payerVersion,
            commit_hash: lndCommitHash,
            block_hash: tipHash,
            block_height: state.blocks,
            chains: [{ chain: 'bitcoin', network: 'regtest' }],
          } as T;
        }
        if (path === '/v1/channels') {
          return {
            channels: [{
              chan_id: channelId,
              channel_point: channelPoint,
              remote_pubkey: payeePubkey,
              active: true,
              zero_conf: state.payerZeroConf,
              local_balance: state.payerLocalBalance,
              remote_balance: '0',
              commit_fee: state.payerCommitFee,
              unsettled_balance: '0',
              pending_htlcs: state.payerPendingHtlcs,
              local_constraints: { chan_reserve_sat: state.payerReserve },
            }],
          } as T;
        }
        if (path === recoveryPaymentsPath) {
          return (state.payerHasPriorPayments
            ? { first_index_offset: '1', last_index_offset: '1', payments: [{ payment_hash: 'ff'.repeat(32), payment_index: '1' }] }
            : { first_index_offset: '0', last_index_offset: '0', payments: [] }) as T;
        }
        if (path.startsWith('/v1/payreq/')) {
          const rawInv = path.slice('/v1/payreq/'.length);
          const match = [inv1, inv2].find(i => i.invoice === rawInv);
          if (!match) throw new Error('Unknown invoice');
          return {
            destination: payeePubkey,
            payment_hash: match.paymentHash,
            num_satoshis: String(match.sats),
            num_msat: String(match.sats * 1000),
            timestamp: String(Math.floor(Date.now() / 1000)),
            expiry: '600',
            cltv_expiry: '40',
          } as T;
        }
        throw new Error(`Unexpected payer LND call: ${path}`);
      },
    },
    payee: {
      origin: policy.routing.payeeOrigin,
      async call<T>(path: string): Promise<T> {
        if (path === '/v1/state') return { state: 'SERVER_ACTIVE' } as T;
        if (path === '/v1/getinfo') {
          return {
            identity_pubkey: payeePubkey,
            synced_to_chain: state.payeeSynced,
            wallet_synced: true,
            version: '0.20.8-beta commit=v0.20.8-beta',
            block_hash: tipHash,
            block_height: state.blocks,
            chains: [{ chain: 'bitcoin', network: 'regtest' }],
          } as T;
        }
        if (path === '/v1/channels') {
          return {
            channels: state.payeeHasChannel ? [{
              chan_id: channelId,
              channel_point: channelPoint,
              remote_pubkey: payerPubkey,
              active: true,
              zero_conf: false,
              local_balance: '0',
              remote_balance: state.payerLocalBalance,
              commit_fee: state.payerCommitFee,
              unsettled_balance: '0',
              pending_htlcs: [],
              local_constraints: { chan_reserve_sat: '3000' },
            }] : [],
          } as T;
        }
        throw new Error(`Unexpected payee LND call: ${path}`);
      },
    },
    transport: {
      origin: policy.routing.payerOrigin,
      async stream(path, body, onPayment, _signal, beforeRequest) {
        if (path === '/v2/router/send') {
          if (state.beforeSendHook) await state.beforeSendHook();
          await beforeRequest?.();
          state.counts.sends++;
          if (state.disconnectOnSend) throw new Error('Simulated lost terminal response');
          const inv = [inv1, inv2].find(i => i.invoice === (body as { payment_request?: string } | undefined)?.payment_request) ?? inv1;
          onPayment({
            status: 'SUCCEEDED',
            failure_reason: 'FAILURE_REASON_NONE',
            payment_hash: inv.paymentHash,
            payment_preimage: inv.preimage,
            value_msat: '5000000',
            fee_msat: String(state.sendFeeMsat),
          });
          return;
        }
        state.counts.tracks++;
        const encoded = path.slice('/v2/router/track/'.length).split('?')[0]!;
        const trackedHash = Buffer.from(decodeURIComponent(encoded), 'base64').toString('hex');
        const inv = [inv1, inv2].find(i => i.paymentHash === trackedHash) ?? inv1;
        if (state.trackOutcome === 'INSUFFICIENT_BALANCE') {
          onPayment({
            status: 'FAILED',
            failure_reason: 'FAILURE_REASON_INSUFFICIENT_BALANCE',
            payment_hash: inv.paymentHash,
            htlcs: [],
            fee_msat: '0',
            fee_sat: '0',
            fee: '0',
          });
          return;
        }
        onPayment({
          status: 'SUCCEEDED',
          failure_reason: 'FAILURE_REASON_NONE',
          payment_hash: inv.paymentHash,
          payment_preimage: inv.preimage,
          value_msat: '5000000',
          fee_msat: state.trackOutcome === 'HIGH_FEE' ? '100001' : String(state.sendFeeMsat),
        });
      },
    } satisfies PaymentStreamTransport,
  };

  const identity = {
    environment: 'regtest' as const,
    deploymentId: FORWARD_DEPLOYMENT_ID,
    genesisHash: FORWARD_REGTEST_GENESIS,
    wallet: policy.wallet,
    bitcoinOrigin: policy.routing.bitcoinOrigin,
    providerOrigin: policy.routing.payerOrigin,
    payerOrigin: policy.routing.payeeOrigin,
    providerNode: payerPubkey,
    payerNode: payeePubkey,
    verified: { onchain: true, lightning: true },
  };

  const testToken = createTestForwardLeaseToken();
  const provisionFresh = (dir = dataDir, node = payerPubkey) =>
    Store.provisionFreshForwardWithTestToken(testToken, dir, node, registryDir, true, {
      environment: 'regtest',
      deploymentId: FORWARD_DEPLOYMENT_ID,
      genesisHash: FORWARD_REGTEST_GENESIS,
      wallet: policy.wallet,
      bitcoinOrigin: policy.routing.bitcoinOrigin,
      providerOrigin: policy.routing.payerOrigin,
      payerOrigin: policy.routing.payeeOrigin,
      providerNode: node,
      payerNode: payeePubkey,
      liquidOrigin: null,
      liquidWallet: null,
      liquidGenesisHash: null,
      liquidChainName: null,
      liquidPolicyAsset: null,
      liquidParentGenesisHash: null,
    });

  const forwardOverrides: ForwardRegtestOverrides = {
    openStore: (dir, node) => Store.openForForwardWithTestToken(testToken, dir, node, registryDir),
    assertPersistentStorage: async () => {},
    clients: () => clients,
    testToken,
  };

  const boot = (
    overrideEnv: Record<string, string> = {},
    args: string[] = ['--forward-regtest', '--policy-path', written.path, '--policy-sha256', written.hash],
    overrideForward: Partial<ForwardRegtestOverrides> = {},
    overrideIdentity: typeof identity = identity,
  ) => startApplication({ ...env, ...overrideEnv }, args, {
    port: 0,
    reads: { liquidity: async () => ({ onchainSats: 0, incomingSats: 0 }) },
    identity: overrideIdentity,
    forward: { ...forwardOverrides, ...overrideForward },
  });

  return {
    root, registryDir, dataDir, authStorePath, password, owner, otherAdmin, regularUser, testToken, provisionFresh,
    policy, writePolicy, written, env, inv1, inv2, depositTxid, depositVout, state, clients, identity, boot,
  };
}

test('forwardStartupArguments is strictly regtest opt-in and default preview keeps forward closed', async t => {
  const f = await createProfileFixture(t);
  assert.equal(forwardStartupArguments([], 'regtest'), undefined);
  assert.deepEqual(
    forwardStartupArguments(['--forward-regtest', '--policy-path', f.written.path, '--policy-sha256', f.written.hash], 'regtest'),
    { path: f.written.path, hash: f.written.hash },
  );
  assert.throws(() => forwardStartupArguments(['--forward-regtest', '--policy-path', f.written.path, '--policy-sha256', f.written.hash], 'simulation'), /FORWARD_STARTUP_REJECTED/);
  assert.throws(() => forwardStartupArguments(['--forward-regtest', '--policy-path', 'relative.json', '--policy-sha256', f.written.hash], 'regtest'), /FORWARD_STARTUP_REJECTED/);
  assert.throws(() => forwardStartupArguments(['--forward-regtest', '--policy-path', f.written.path, '--policy-sha256', 'bad'], 'regtest'), /FORWARD_STARTUP_REJECTED/);
  assert.throws(() => forwardStartupArguments(['--forward-regtest', '--policy-path', f.written.path, '--policy-sha256', f.written.hash, '--extra'], 'regtest'), /FORWARD_STARTUP_REJECTED/);

  // Even when FORWARD_SWAP_ENABLED=true and SPEND_POLICY=regtest-only are set in env, default preview (args=[]) keeps forward disabled.
  const preview = await f.boot({}, []);
  try {
    const base = `http://127.0.0.1:${(preview.server.address() as AddressInfo).port}`;
    const login = await fetch(`${base}/v1/auth/login`, {
      method: 'POST',
      headers: { origin: FORWARD_ORIGIN, 'content-type': 'application/json' },
      body: JSON.stringify({ username: f.owner.username, password: f.password }),
    });
    const cookie = login.headers.get('set-cookie')!.split(';')[0]!;
    const csrf = (await login.json()).csrfToken as string;
    assert.deepEqual(await (await fetch(`${base}/v1/forward/availability`, { headers: { cookie } })).json(), { executionAvailable: false });
    const unavailable = await fetch(`${base}/v1/forward`, {
      method: 'POST',
      headers: { origin: FORWARD_ORIGIN, cookie, 'x-csrf-token': csrf, 'content-type': 'application/json', 'idempotency-key': 'preview-no-spend-1' },
      body: JSON.stringify({ invoice: f.inv1.invoice, invoiceSats: 5000 }),
    });
    assert.equal(unavailable.status, 503);
    assert.equal(f.state.counts.allocations, 0);
    assert.equal(f.state.counts.sends, 0);
  } finally {
    await preview.close();
  }
});

test('startup rejects tampered SHA, volatile tmpfs storage, bad permissions, wrong owner role, and role swaps', async t => {
  const f = await createProfileFixture(t);

  // Real assertPersistentStorage rejects /tmp (tmpfs)
  await assert.rejects(assertPersistentStorage('/tmp/non-durable-forward'), /FORWARD_VOLATILE_STORAGE_FORBIDDEN/);
  await assert.rejects(f.boot({}, undefined, { assertPersistentStorage }), /FORWARD_VOLATILE_STORAGE_FORBIDDEN/);

  // Bad SHA-256
  await assert.rejects(f.boot({}, ['--forward-regtest', '--policy-path', f.written.path, '--policy-sha256', '00'.repeat(32)]), /OPERATOR_STOPPED/);

  // Wrong deployment / origin / spendPolicy / forward flag / auto-mining
  await assert.rejects(f.boot({ DEPLOYMENT_ID: 'other-deployment' }), /FORWARD_CONFIG_REJECTED/);
  await assert.rejects(f.boot({ AUTH_ORIGIN: 'http://127.0.0.1:3200' }), /FORWARD_CONFIG_REJECTED/);
  await assert.rejects(f.boot({ PORT: '3200' }), /FORWARD_CONFIG_REJECTED/);
  await assert.rejects(f.boot({ SPEND_POLICY: 'disabled' }), /FORWARD_EXECUTION_DISABLED/);
  await assert.rejects(f.boot({ FORWARD_SWAP_ENABLED: 'false' }), /FORWARD_EXECUTION_DISABLED/);
  await assert.rejects(f.boot({ REGTEST_AUTO_MINING: 'true' }), /FORWARD_EXECUTION_DISABLED/);

  // Owner missing or USER role instead of ADMIN
  const userPolicy = await f.writePolicy({ ...f.policy, ownerId: f.regularUser.id, ownerUsername: f.regularUser.username }, 'user-owner.json');
  await assert.rejects(f.boot({}, ['--forward-regtest', '--policy-path', userPolicy.path, '--policy-sha256', userPolicy.hash]), /FORWARD_OWNER_UNAUTHORIZED/);
  const ghostPolicy = await f.writePolicy({ ...f.policy, ownerId: randomUUID() }, 'ghost-owner.json');
  await assert.rejects(f.boot({}, ['--forward-regtest', '--policy-path', ghostPolicy.path, '--policy-sha256', ghostPolicy.hash]), /FORWARD_OWNER_UNAUTHORIZED/);

  // Forbidden old lab wallet or swapped payer/payee roles
  const labWalletPolicy = await f.writePolicy({ ...f.policy, wallet: 'iso-core-lab' }, 'lab-wallet.json');
  await assert.rejects(f.boot({ BITCOIN_WALLET: 'iso-core-lab' }, ['--forward-regtest', '--policy-path', labWalletPolicy.path, '--policy-sha256', labWalletPolicy.hash], {}, { ...f.identity, wallet: 'iso-core-lab' }));
  await assert.rejects(f.boot({}, undefined, {}, { ...f.identity, providerNode: payeePubkey, payerNode: payerPubkey }), /FORWARD_IDENTITY_MISMATCH/);

  // Reused router/readonly macaroon
  const sharedCredPolicy = await f.writePolicy({
    ...f.policy,
    credentialPaths: { ...f.policy.credentialPaths, payerRouterMacaroonPath: f.policy.credentialPaths.payerReadMacaroonPath },
  }, 'shared-mac.json');
  await assert.rejects(f.boot({}, ['--forward-regtest', '--policy-path', sharedCredPolicy.path, '--policy-sha256', sharedCredPolicy.hash]));

  // Permissive credential file (0644) or symlinked DATA_DIR
  await chmod(f.policy.credentialPaths.payerRouterMacaroonPath, 0o644);
  await assert.rejects(f.boot(), /OPERATOR_STOPPED/);
  await chmod(f.policy.credentialPaths.payerRouterMacaroonPath, 0o600);

  const symlinkData = join(f.root, 'sym-state');
  await mkdir(join(f.root, 'real-state'), { mode: 0o700 });
  await symlink(join(f.root, 'real-state'), symlinkData);
  const symPolicy = await f.writePolicy({ ...f.policy, dataDir: symlinkData }, 'sym-policy.json');
  await assert.rejects(f.boot({ DATA_DIR: symlinkData }, ['--forward-regtest', '--policy-path', symPolicy.path, '--policy-sha256', symPolicy.hash]), /ALIASED/);
});

test('startup and pre-spend enforce genesis, node sync, direct confirmed channel, liquidity, and empty payer history', async t => {
  const f = await createProfileFixture(t);
  await f.provisionFresh();

  // Wrong genesis
  f.state.genesisHash = 'ff'.repeat(32);
  await assert.rejects(f.boot(), /FORWARD_GENESIS_MISMATCH/);
  f.state.genesisHash = FORWARD_REGTEST_GENESIS;

  // Payer LND not synced / unknown version without wallet_synced
  f.state.payerSynced = false;
  await assert.rejects(f.boot());
  f.state.payerSynced = true;
  f.state.payerWalletSynced = undefined;
  f.state.payerVersion = '0.20.99-custom';
  await assert.rejects(f.boot(), /FORWARD_LND_WALLET_NOT_SYNCED/);
  f.state.payerVersion = '0.20.8-beta commit=v0.20.8-beta';

  // Channel funding < 6 confirmations, coinbase, zero_conf, or missing on payee
  f.state.fundingConfs = 5;
  await assert.rejects(f.boot());
  f.state.fundingConfs = 6;
  f.state.fundingCoinbase = true;
  await assert.rejects(f.boot());
  f.state.fundingCoinbase = false;
  f.state.payerZeroConf = true;
  await assert.rejects(f.boot(), /FORWARD_CHANNEL_BINDING_INVALID/);
  f.state.payerZeroConf = false;
  f.state.payeeHasChannel = false;
  await assert.rejects(f.boot(), /FORWARD_CHANNEL_NOT_FOUND/);
  f.state.payeeHasChannel = true;

  // Insufficient spendable channel liquidity (290000 - 3000 - 282000 = 5000 < 5100)
  f.state.payerCommitFee = '282000';
  await assert.rejects(f.boot(), /FORWARD_CHANNEL_LIQUIDITY_INSUFFICIENT/);
  f.state.payerCommitFee = '1500';

  // Prior LND payment on unused fresh store
  f.state.payerHasPriorPayments = true;
  await assert.rejects(f.boot());
  f.state.payerHasPriorPayments = false;

  // Unprovisioned directory fails closed with FORWARD_CUSTODY_BINDING_REQUIRED
  const unprovDir = join(f.root, 'unprovisioned-dir');
  const unprovReg = join(f.root, 'unprovisioned-reg');
  await mkdir(unprovDir, { mode: 0o700 });
  const unprovPolicy = await f.writePolicy({ ...f.policy, dataDir: unprovDir }, 'unprov.json');
  await assert.rejects(
    f.boot({ DATA_DIR: unprovDir }, ['--forward-regtest', '--policy-path', unprovPolicy.path, '--policy-sha256', unprovPolicy.hash], {
      openStore: (dir, node) => Store.openForForwardWithTestToken(f.testToken, dir, node, unprovReg),
    }),
    /FORWARD_CUSTODY_BINDING_REQUIRED/,
  );
});

test('HTTP opt-in profile binds StateScope, enforces negative auth, single 5000/5100 run, LN fee<=100, and no second hash across restarts', async t => {
  const f = await createProfileFixture(t);
  await f.provisionFresh();
  let app = await f.boot();
  let closed = false;
  t.after(async () => { if (!closed) await app.close().catch(() => {}); });

  // Concurrent Store.openForForward for the same payerNode fails closed while running
  const otherDir = join(f.root, 'other-dir');
  await mkdir(otherDir, { mode: 0o700 });
  await assert.rejects(Store.openForForwardWithTestToken(f.testToken, otherDir, payerPubkey, f.registryDir), /EEXIST/);

  // StateScope records admin-regtest-3201 and exact payer/payee roles (LND_* providerNode = payer, ALICE_* payerNode = payee)
  const scope = JSON.parse(await readFile(join(f.dataDir, '.environment.json'), 'utf8'));
  assert.equal(scope.deploymentId, FORWARD_DEPLOYMENT_ID);
  assert.equal(scope.providerNode, payerPubkey);
  assert.equal(scope.payerNode, payeePubkey);
  assert.equal(scope.wallet, 'iso_rt_core_fwd');

  let base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  const req = (path: string, headers?: Record<string, string>, body?: unknown) => fetch(base + path,
    body === undefined ? { headers } : { method: 'POST', headers: { origin: FORWARD_ORIGIN, 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  const loginAs = async (username: string) => {
    const res = await req('/v1/auth/login', {}, { username, password: f.password });
    assert.equal(res.status, 200);
    return { cookie: res.headers.get('set-cookie')!.split(';')[0]!, 'x-csrf-token': (await res.json()).csrfToken as string };
  };

  // Negative authorizations: unauthenticated, USER, and OTHER ADMIN all denied!
  assert.equal((await req('/v1/forward/availability')).status, 401);
  const userAuth = await loginAs(f.regularUser.username);
  const otherAdminAuth = await loginAs(f.otherAdmin.username);
  const ownerAuth = await loginAs(f.owner.username);

  assert.deepEqual(await (await req('/v1/forward/availability', userAuth)).json(), { executionAvailable: false });
  assert.deepEqual(await (await req('/v1/forward/availability', otherAdminAuth)).json(), { executionAvailable: false });
  assert.deepEqual(await (await req('/v1/forward/availability', ownerAuth)).json(), { executionAvailable: true });
  for (const denied of [userAuth, otherAdminAuth]) {
    assert.equal((await req('/v1/forward', denied)).status, 403);
    assert.equal((await req('/v1/forward', { ...denied, 'idempotency-key': 'unauth-admit-1' }, { invoice: f.inv1.invoice, invoiceSats: 5000 })).status, 403);
  }
  // Missing CSRF / foreign origin rejected
  assert.equal((await req('/v1/forward', { cookie: ownerAuth.cookie, 'idempotency-key': 'no-csrf-1' }, { invoice: f.inv1.invoice, invoiceSats: 5000 })).status, 403);
  assert.equal((await fetch(`${base}/v1/forward`, {
    method: 'POST',
    headers: { origin: 'https://evil.invalid', cookie: ownerAuth.cookie, 'x-csrf-token': ownerAuth['x-csrf-token'], 'content-type': 'application/json', 'idempotency-key': 'bad-origin-1' },
    body: JSON.stringify({ invoice: f.inv1.invoice, invoiceSats: 5000 }),
  })).status, 403);

  // Reject non-5000 amounts
  for (const badAmount of [4999, 5001, 10_000]) {
    const res = await req('/v1/forward', { ...ownerAuth, 'idempotency-key': `bad-amt-${badAmount}` }, { invoice: f.inv1.invoice, invoiceSats: badAmount });
    assert.equal(res.status, 409);
  }
  assert.equal(f.state.counts.allocations, 0);

  // Admit exact 5000 sat invoice -> depositSats: 5100; idempotent replay works, second hash rejected (even concurrently)
  const keyA = { ...ownerAuth, 'idempotency-key': 'run-1-key-a' };
  const keyB = { ...ownerAuth, 'idempotency-key': 'run-1-key-b' };
  const [r1, r2] = await Promise.all([
    req('/v1/forward', keyA, { invoice: f.inv1.invoice, invoiceSats: 5000 }),
    req('/v1/forward', keyB, { invoice: f.inv2.invoice, invoiceSats: 5000 }),
  ]);
  assert.equal([r1.status, r2.status].filter(s => s === 201).length, 1);
  assert.equal([r1.status, r2.status].filter(s => s === 409).length, 1);
  const r1Won = r1.status === 201;
  const admitted = await (r1Won ? r1 : r2).json();
  const winnerHeaders = r1Won ? keyA : keyB;
  const winnerInv = r1Won ? f.inv1 : f.inv2;
  const loserInv = r1Won ? f.inv2 : f.inv1;
  assert.equal(admitted.depositSats, 5100);
  assert.equal(f.state.counts.allocations, 1);

  // Replay with same key returns same id
  const replay = await req('/v1/forward', winnerHeaders, { invoice: winnerInv.invoice, invoiceSats: 5000 });
  assert.equal(replay.status, 201);
  assert.equal((await replay.json()).id, admitted.id);
  // Second hash with new key rejected
  const secondHash = await req('/v1/forward', { ...ownerAuth, 'idempotency-key': 'run-2-bypass' }, { invoice: loserInv.invoice, invoiceSats: 5000 });
  assert.equal(secondHash.status, 409);
  assert.equal(f.state.counts.allocations, 1);

  // Wrong deposit value (!= 5100) rejected without sending
  f.state.depositValueSats = 5099;
  assert.equal((await req(`/v1/forward/${admitted.id}/execute`, ownerAuth, { txid: f.depositTxid, vout: f.depositVout })).status, 409);
  f.state.depositValueSats = 5101;
  assert.equal((await req(`/v1/forward/${admitted.id}/execute`, ownerAuth, { txid: f.depositTxid, vout: f.depositVout })).status, 409);
  f.state.depositValueSats = 5100;
  assert.equal(f.state.counts.sends, 0);

  // Liquidity drop before spend aborts before wire send and marks UNKNOWN (never retries)
  f.state.disconnectOnSend = true;
  const sent = await req(`/v1/forward/${admitted.id}/execute`, ownerAuth, { txid: f.depositTxid, vout: f.depositVout });
  assert.equal(sent.status, 200);
  assert.equal((await sent.json()).state, 'UNKNOWN');
  assert.equal(f.state.counts.sends, 1);

  // Restart on canonical DATA_DIR: second hash still rejected, execute never resends, HIGH fee (>100) never marks SUCCEEDED, then valid SUCCEEDED resolves
  await app.close();
  app = await f.boot();
  base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  const relogin = await loginAs(f.owner.username);

  assert.equal((await req('/v1/forward', { ...relogin, 'idempotency-key': 'post-restart-second-hash' }, { invoice: loserInv.invoice, invoiceSats: 5000 })).status, 409);
  assert.equal((await (await req(`/v1/forward/${admitted.id}/execute`, relogin, { txid: f.depositTxid, vout: f.depositVout })).json()).state, 'UNKNOWN');
  assert.equal(f.state.counts.sends, 1);

  // LN fee > 100 sats rejected by recovery verification
  f.state.trackOutcome = 'HIGH_FEE';
  const highFeeRecover = await req(`/v1/forward/${admitted.id}/recover`, relogin, {});
  assert.equal(highFeeRecover.status, 200);
  assert.equal((await highFeeRecover.json()).state, 'UNKNOWN');

  // Valid recovery settles SUCCEEDED without exposing preimage
  f.state.trackOutcome = 'SUCCEEDED';
  const okRecover = await req(`/v1/forward/${admitted.id}/recover`, relogin, {});
  assert.equal(okRecover.status, 200);
  const bodyText = await okRecover.text();
  assert.equal(JSON.parse(bodyText).state, 'SUCCEEDED');
  assert.equal(bodyText.includes(winnerInv.preimage), false);
  assert.equal(f.state.counts.sends, 1);
  assert.equal(f.state.counts.tracks, 2);

  // Restart again even with 0 channel liquidity -> still boots for terminal inspection and blocks any second run
  await app.close();
  f.state.payerLocalBalance = '0';
  app = await f.boot();
  base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  const afterDone = await loginAs(f.owner.username);
  assert.equal((await (await req(`/v1/forward/${admitted.id}`, afterDone)).json()).state, 'SUCCEEDED');
  assert.equal((await req('/v1/forward', { ...afterDone, 'idempotency-key': 'after-succeeded-second' }, { invoice: loserInv.invoice, invoiceSats: 5000 })).status, 409);
  await app.close();
  closed = true;
});

test('lock loss fails closed before send and on HTTP, and FAILED_INSUFFICIENT_BALANCE is valid in web API client', async t => {
  const f = await createProfileFixture(t);
  await f.provisionFresh();
  const lockPath = join(f.registryDir, 'locks', `${payerPubkey}.lock`);

  // Case 1: Lock loss inside beforeSend prevents wire send and poisons store
  const app1 = await f.boot();
  const base1 = `http://127.0.0.1:${(app1.server.address() as AddressInfo).port}`;
  const login1 = await fetch(`${base1}/v1/auth/login`, {
    method: 'POST', headers: { origin: FORWARD_ORIGIN, 'content-type': 'application/json' },
    body: JSON.stringify({ username: f.owner.username, password: f.password }),
  });
  const cookie1 = login1.headers.get('set-cookie')!.split(';')[0]!;
  const csrf1 = (await login1.json()).csrfToken as string;
  const admit1 = await (await fetch(`${base1}/v1/forward`, {
    method: 'POST',
    headers: { origin: FORWARD_ORIGIN, cookie: cookie1, 'x-csrf-token': csrf1, 'content-type': 'application/json', 'idempotency-key': 'lock-loss-run-1' },
    body: JSON.stringify({ invoice: f.inv1.invoice, invoiceSats: 5000 }),
  })).json();

  f.state.beforeSendHook = async () => {
    await unlink(lockPath);
    await writeFile(lockPath, '{"replacement":true}\n', { mode: 0o600 });
  };
  const execRes = await fetch(`${base1}/v1/forward/${admit1.id}/execute`, {
    method: 'POST',
    headers: { origin: FORWARD_ORIGIN, cookie: cookie1, 'x-csrf-token': csrf1, 'content-type': 'application/json' },
    body: JSON.stringify({ txid: f.depositTxid, vout: f.depositVout }),
  });
  assert.equal(execRes.status, 503);
  assert.equal(f.state.counts.sends, 0);
  assert.equal((await fetch(`${base1}/v1/forward/availability`, { headers: { cookie: cookie1 } })).status, 503);
  await assert.rejects(app1.close(), /lock lost or replaced/);
  // Replacement lock preserved
  assert.equal(await readFile(lockPath, 'utf8'), '{"replacement":true}\n');
  await unlink(lockPath);
  await unlink(join(f.dataDir, 'engine.lock'));

  // Reopen after beforeSend lock loss preserves INTENT and never resends
  f.state.beforeSendHook = undefined;
  const appReopen = await f.boot();
  const baseReopen = `http://127.0.0.1:${(appReopen.server.address() as AddressInfo).port}`;
  const loginReopen = await fetch(`${baseReopen}/v1/auth/login`, {
    method: 'POST', headers: { origin: FORWARD_ORIGIN, 'content-type': 'application/json' },
    body: JSON.stringify({ username: f.owner.username, password: f.password }),
  });
  const cookieReopen = loginReopen.headers.get('set-cookie')!.split(';')[0]!;
  const csrfReopen = (await loginReopen.json()).csrfToken as string;
  const statusAfterLockLoss = await (await fetch(`${baseReopen}/v1/forward/${admit1.id}`, { headers: { cookie: cookieReopen } })).json();
  assert.equal(statusAfterLockLoss.state, 'INTENT');
  assert.equal((await (await fetch(`${baseReopen}/v1/forward/${admit1.id}/execute`, {
    method: 'POST',
    headers: { origin: FORWARD_ORIGIN, cookie: cookieReopen, 'x-csrf-token': csrfReopen, 'content-type': 'application/json' },
    body: JSON.stringify({ txid: f.depositTxid, vout: f.depositVout }),
  })).json()).state, 'INTENT');
  assert.equal(f.state.counts.sends, 0);
  await appReopen.close();

  // Case 2: Fresh fixture -> lost response -> UNKNOWN -> recover -> FAILED_INSUFFICIENT_BALANCE -> web api.forwardStatus parses terminal state
  const f2 = await createProfileFixture(t);
  await f2.provisionFresh();
  const app2 = await f2.boot();
  t.after(() => app2.close().catch(() => {}));
  const base2 = `http://127.0.0.1:${(app2.server.address() as AddressInfo).port}`;
  const login2 = await fetch(`${base2}/v1/auth/login`, {
    method: 'POST', headers: { origin: FORWARD_ORIGIN, 'content-type': 'application/json' },
    body: JSON.stringify({ username: f2.owner.username, password: f2.password }),
  });
  const cookie2 = login2.headers.get('set-cookie')!.split(';')[0]!;
  const csrf2 = (await login2.json()).csrfToken as string;
  const admit2 = await (await fetch(`${base2}/v1/forward`, {
    method: 'POST',
    headers: { origin: FORWARD_ORIGIN, cookie: cookie2, 'x-csrf-token': csrf2, 'content-type': 'application/json', 'idempotency-key': 'insuff-run-1' },
    body: JSON.stringify({ invoice: f2.inv1.invoice, invoiceSats: 5000 }),
  })).json();

  f2.state.disconnectOnSend = true;
  const sent = await fetch(`${base2}/v1/forward/${admit2.id}/execute`, {
    method: 'POST',
    headers: { origin: FORWARD_ORIGIN, cookie: cookie2, 'x-csrf-token': csrf2, 'content-type': 'application/json' },
    body: JSON.stringify({ txid: f2.depositTxid, vout: f2.depositVout }),
  });
  assert.equal(sent.status, 200);
  assert.equal((await sent.json()).state, 'UNKNOWN');

  f2.state.trackOutcome = 'INSUFFICIENT_BALANCE';
  const rec = await fetch(`${base2}/v1/forward/${admit2.id}/recover`, {
    method: 'POST',
    headers: { origin: FORWARD_ORIGIN, cookie: cookie2, 'x-csrf-token': csrf2, 'content-type': 'application/json' },
    body: JSON.stringify({}),
  });
  assert.equal(rec.status, 200);
  const terminalPayload = await rec.json();
  assert.equal(terminalPayload.state, 'FAILED_INSUFFICIENT_BALANCE');

  // Verify src/web/api.ts client parser accepts FAILED_INSUFFICIENT_BALANCE without throwing
  const prevFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify(terminalPayload), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })) as typeof fetch;
  try {
    const parsed = await api.forwardStatus(admit2.id);
    assert.equal(parsed.state, 'FAILED_INSUFFICIENT_BALANCE');
  } finally {
    globalThis.fetch = prevFetch;
  }
});

test('direct synchronous send allows LN fee <= 100 sats and rejects LN fee > 100 sats', async t => {
  const f1 = await createProfileFixture(t);
  await f1.provisionFresh();
  f1.state.sendFeeMsat = 100_000;
  const app1 = await f1.boot();
  t.after(() => app1.close().catch(() => {}));
  const base1 = `http://127.0.0.1:${(app1.server.address() as AddressInfo).port}`;
  const login1 = await fetch(`${base1}/v1/auth/login`, {
    method: 'POST', headers: { origin: FORWARD_ORIGIN, 'content-type': 'application/json' },
    body: JSON.stringify({ username: f1.owner.username, password: f1.password }),
  });
  const cookie1 = login1.headers.get('set-cookie')!.split(';')[0]!;
  const csrf1 = (await login1.json()).csrfToken as string;
  const admitted1 = await (await fetch(`${base1}/v1/forward`, {
    method: 'POST',
    headers: { origin: FORWARD_ORIGIN, cookie: cookie1, 'x-csrf-token': csrf1, 'content-type': 'application/json', 'idempotency-key': 'fee-cap-ok-1' },
    body: JSON.stringify({ invoice: f1.inv1.invoice, invoiceSats: 5000 }),
  })).json();
  const okExec = await fetch(`${base1}/v1/forward/${admitted1.id}/execute`, {
    method: 'POST',
    headers: { origin: FORWARD_ORIGIN, cookie: cookie1, 'x-csrf-token': csrf1, 'content-type': 'application/json' },
    body: JSON.stringify({ txid: f1.depositTxid, vout: f1.depositVout }),
  });
  assert.equal(okExec.status, 200);
  assert.equal((await okExec.json()).state, 'SUCCEEDED');

  const f2 = await createProfileFixture(t);
  await f2.provisionFresh();
  f2.state.sendFeeMsat = 100_001;
  const app2 = await f2.boot();
  t.after(() => app2.close().catch(() => {}));
  const base2 = `http://127.0.0.1:${(app2.server.address() as AddressInfo).port}`;
  const login2 = await fetch(`${base2}/v1/auth/login`, {
    method: 'POST', headers: { origin: FORWARD_ORIGIN, 'content-type': 'application/json' },
    body: JSON.stringify({ username: f2.owner.username, password: f2.password }),
  });
  const cookie2 = login2.headers.get('set-cookie')!.split(';')[0]!;
  const csrf2 = (await login2.json()).csrfToken as string;
  const admitted2 = await (await fetch(`${base2}/v1/forward`, {
    method: 'POST',
    headers: { origin: FORWARD_ORIGIN, cookie: cookie2, 'x-csrf-token': csrf2, 'content-type': 'application/json', 'idempotency-key': 'fee-cap-bad-1' },
    body: JSON.stringify({ invoice: f2.inv1.invoice, invoiceSats: 5000 }),
  })).json();
  const badExec = await fetch(`${base2}/v1/forward/${admitted2.id}/execute`, {
    method: 'POST',
    headers: { origin: FORWARD_ORIGIN, cookie: cookie2, 'x-csrf-token': csrf2, 'content-type': 'application/json' },
    body: JSON.stringify({ txid: f2.depositTxid, vout: f2.depositVout }),
  });
  assert.equal(badExec.status, 200);
  assert.equal((await badExec.json()).state, 'UNKNOWN');
});
