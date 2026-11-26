import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { chmod, mkdir, readFile, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { address, networks, payments } from 'bitcoinjs-lib';
import { provisionAccount } from '../scripts/provision-auth.js';
import { runProvisionForwardCLI } from '../scripts/provision-forward-regtest.js';
import { readAccounts } from '../src/auth/store.js';
import {
  FORWARD_DEPLOYMENT_ID,
  FORWARD_ORIGIN,
  FORWARD_PORT,
  FORWARD_REGTEST_GENESIS,
  forwardStateScope,
  prepareForwardRegtestProfile,
  type ForwardRegtestPolicy,
} from '../src/forward/ForwardRegtestProfile.js';
import { verifyLndMacaroonRole } from '../src/lightning/LndMacaroon.js';
import { recoveryPaymentsPath } from '../src/lightning/LndPayerRecovery.js';
import { startApplication } from '../src/main.js';
import { sha256 } from '../src/operator/OperatorFiles.js';
import { createTestForwardLeaseToken } from '../src/persistence/ForwardPayerRegistry.js';
import { prepareForwardConsolidationWithTestRegistry } from '../src/persistence/PrepareForwardConsolidation.js';
import { Store } from '../src/persistence/Store.js';
import { buildLndMacaroon, privateTestDirectory } from './helpers.js';

const payerPubkey = '02' + '11'.repeat(32);
const payeePubkey = '03' + '22'.repeat(32);
const channelId = '1099511627776';
const channelPoint = 'aa'.repeat(32) + ':0';
const tipHash = 'bb'.repeat(32);
const lndVersion = '0.20.8-beta commit=v0.20.8-beta';
const lndCommit = '33f90e82464daf9e6d2f2a02e754955ba42e2951';

function generateLoopbackCert(dir: string, prefix: string) {
  const keyPath = join(dir, `${prefix}.key`);
  const certPath = join(dir, `${prefix}.cert`);
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', keyPath, '-out', certPath, '-days', '2',
    '-subj', `/CN=${prefix}`,
    '-addext', 'subjectAltName=IP:127.0.0.1,DNS:localhost',
  ], { stdio: 'ignore' });
  return { keyPath, certPath };
}

async function createRealTransportFixture(t: TestContext) {
  const root = await privateTestDirectory('fwd-real-transport');
  t.after(() => rm(root, { recursive: true, force: true }));
  const registryDir = join(root, 'registry');
  const dataDir = join(root, 'fwd-state');
  const credsDir = join(root, 'creds');
  await mkdir(credsDir, { mode: 0o700 });
  await mkdir(dataDir, { mode: 0o700 });

  const authStorePath = join(root, 'auth-3201.json');
  const password = randomBytes(24).toString('base64url');
  await provisionAccount(authStorePath, 'admin3201', 'ADMIN', password);
  await provisionAccount(authStorePath, 'outsider', 'USER', password);
  const accounts = await readAccounts(authStorePath);
  const owner = accounts.find(a => a.username === 'admin3201')!;

  const payerTls = generateLoopbackCert(credsDir, 'payer-tls');
  const payeeTls = generateLoopbackCert(credsDir, 'payee-tls');
  const [payerKey, payerCert, payeeKey, payeeCert] = await Promise.all([
    readFile(payerTls.keyPath),
    readFile(payerTls.certPath),
    readFile(payeeTls.keyPath),
    readFile(payeeTls.certPath),
  ]);
  await chmod(payerTls.certPath, 0o600);
  await chmod(payeeTls.certPath, 0o600);

  const cookieSecret = '__cookie__:' + randomBytes(24).toString('hex');
  const bitcoinCookiePath = join(credsDir, 'core.cookie');
  await writeFile(bitcoinCookiePath, cookieSecret + '\n', { mode: 0o600 });

  const payerReadMac = buildLndMacaroon([{
    entity: 'uri',
    actions: [
      '/lnrpc.Lightning/DecodePayReq',
      '/lnrpc.Lightning/GetInfo',
      '/lnrpc.Lightning/ListChannels',
      '/lnrpc.Lightning/ListPayments',
      '/lnrpc.Lightning/WalletBalance',
    ],
  }]);
  const payeeReadMac = buildLndMacaroon([{
    entity: 'uri',
    actions: [
      '/lnrpc.Lightning/GetInfo',
      '/lnrpc.Lightning/ListChannels',
      '/lnrpc.Lightning/WalletBalance',
    ],
  }]);
  const payerRouterMac = buildLndMacaroon([{
    entity: 'uri',
    actions: [
      '/routerrpc.Router/SendPaymentV2',
      '/routerrpc.Router/TrackPaymentV2',
    ],
  }]);
  const adminMac = buildLndMacaroon([
    { entity: 'info', actions: ['read', 'write'] },
    { entity: 'offchain', actions: ['read', 'write'] },
    { entity: 'onchain', actions: ['read', 'write'] },
    { entity: 'macaroon', actions: ['generate', 'read', 'write'] },
    { entity: 'wallet', actions: ['read', 'write'] },
  ]);

  const credPaths = {
    bitcoinCookiePath,
    payerCertPath: payerTls.certPath,
    payerReadMacaroonPath: join(credsDir, 'payer-readonly.macaroon'),
    payerRouterMacaroonPath: join(credsDir, 'payer-router.macaroon'),
    payeeCertPath: payeeTls.certPath,
    payeeReadMacaroonPath: join(credsDir, 'payee-readonly.macaroon'),
  };
  await writeFile(credPaths.payerReadMacaroonPath, payerReadMac, { mode: 0o600 });
  await writeFile(credPaths.payerRouterMacaroonPath, payerRouterMac, { mode: 0o600 });
  await writeFile(credPaths.payeeReadMacaroonPath, payeeReadMac, { mode: 0o600 });

  const adminMacPath = join(credsDir, 'admin.macaroon');
  await writeFile(adminMacPath, adminMac, { mode: 0o600 });

  const depositAddress = payments.p2wpkh({ hash: Buffer.alloc(20, 0x55), network: networks.regtest }).address!;
  const depositScript = Buffer.from(address.toOutputScript(depositAddress, networks.regtest)).toString('hex');
  const depositTxid = 'cc'.repeat(32);
  const preimage = '77'.repeat(32);
  const paymentHash = createHash('sha256').update(Buffer.from(preimage, 'hex')).digest('hex');
  const invoice = 'lnbcrt' + 'd'.repeat(40);

  const state = {
    coreCalls: [] as string[],
    payerCalls: [] as string[],
    payeeCalls: [] as string[],
    routerRequests: [] as Array<{ path: string; body?: unknown }>,
    walletBalanceTrusted: 0,
    zmqAddresses: ['tcp://127.0.0.1:28332', 'tcp://127.0.0.1:28333'],
    payerCommitHash: lndCommit,
    payerWalletSynced: undefined as boolean | undefined,
    payerLocalBalance: '290000',
    payeePendingHtlcs: [] as unknown[],
    payeeUnsettledBalance: '0',
    rejectRouterAuth: false,
    disconnectOnSend: false,
    trackOutcome: 'SUCCEEDED' as 'SUCCEEDED' | 'INSUFFICIENT_BALANCE',
    beforeRouteSend: undefined as (() => Promise<void>) | undefined,
  };

  const expectedBasic = `Basic ${Buffer.from(cookieSecret).toString('base64')}`;
  const coreServer = http.createServer(async (req, res) => {
    if (req.headers.authorization !== expectedBasic) {
      res.writeHead(401).end('unauthorized');
      return;
    }
    let raw = '';
    for await (const chunk of req) raw += chunk.toString();
    const rpc = JSON.parse(raw) as { id: string; method: string; params?: unknown[] };
    state.coreCalls.push(rpc.method);
    let result: unknown = null;
    if (rpc.method === 'getblockchaininfo') {
      result = { chain: 'regtest', initialblockdownload: false, blocks: 250, headers: 250, bestblockhash: tipHash };
    } else if (rpc.method === 'getblockhash') {
      result = FORWARD_REGTEST_GENESIS;
    } else if (rpc.method === 'listwallets') {
      result = ['iso_rt_core_fwd'];
    } else if (rpc.method === 'listwalletdir') {
      result = { wallets: [{ name: 'iso_rt_core_fwd' }] };
    } else if (rpc.method === 'getwalletinfo') {
      result = { walletname: 'iso_rt_core_fwd', private_keys_enabled: true };
    } else if (rpc.method === 'getbalances') {
      result = { mine: { trusted: state.walletBalanceTrusted, untrusted_pending: 0, immature: 0 } };
    } else if (rpc.method === 'getzmqnotifications') {
      result = [
        { type: 'pubrawblock', address: state.zmqAddresses[0] },
        { type: 'pubrawtx', address: state.zmqAddresses[1] },
      ];
    } else if (rpc.method === 'getnewaddress') {
      result = depositAddress;
    } else if (rpc.method === 'getaddressinfo') {
      result = { scriptPubKey: depositScript, ismine: true, iswatchonly: false };
    } else if (rpc.method === 'gettxout') {
      const [txid] = rpc.params as [string];
      if (txid === 'aa'.repeat(32)) {
        result = { confirmations: 6, bestblock: tipHash, coinbase: false, scriptPubKey: { hex: '0020' + 'dd'.repeat(32) } };
      } else if (txid === depositTxid) {
        result = { bestblock: tipHash, coinbase: false, confirmations: 2, value: 5100 / 1e8, scriptPubKey: { hex: depositScript } };
      }
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ result, error: null, id: rpc.id }));
  });

  const payerReadHex = payerReadMac.toString('hex');
  const payerRouterHex = payerRouterMac.toString('hex');
  const payeeReadHex = payeeReadMac.toString('hex');

  const payerServer = https.createServer({ key: payerKey, cert: payerCert }, async (req, res) => {
    const mac = req.headers['grpc-metadata-macaroon'];
    const url = req.url ?? '/';
    const isRouter = url.startsWith('/v2/router/');
    if (isRouter) {
      if (mac !== payerRouterHex || state.rejectRouterAuth) {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ code: 16, message: 'permission denied' }));
        return;
      }
    } else if (mac !== payerReadHex && mac !== payerRouterHex) {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ code: 16, message: 'permission denied' }));
      return;
    }

    state.payerCalls.push(url);
    if (url === '/v1/state') {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ state: 'SERVER_ACTIVE' }));
      return;
    }
    if (url === '/v1/getinfo') {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
        identity_pubkey: payerPubkey,
        synced_to_chain: true,
        ...(state.payerWalletSynced === undefined ? {} : { wallet_synced: state.payerWalletSynced }),
        version: lndVersion,
        commit_hash: state.payerCommitHash,
        block_hash: tipHash,
        block_height: 250,
        num_peers: 1,
        chains: [{ chain: 'bitcoin', network: 'regtest' }],
      }));
      return;
    }
    if (url === '/v1/channels') {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
        channels: [{
          chan_id: channelId,
          channel_point: channelPoint,
          remote_pubkey: payeePubkey,
          active: true,
          zero_conf: false,
          local_balance: state.payerLocalBalance,
          remote_balance: '0',
          commit_fee: '1500',
          unsettled_balance: '0',
          pending_htlcs: [],
          local_constraints: { chan_reserve_sat: '3000' },
        }],
      }));
      return;
    }
    if (url === '/v1/balance/blockchain') {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
        confirmed_balance: '350000',
        unconfirmed_balance: '0',
      }));
      return;
    }
    if (url === recoveryPaymentsPath) {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
        first_index_offset: '0',
        last_index_offset: '0',
        payments: [],
      }));
      return;
    }
    if (url === `/v1/payreq/${invoice}`) {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
        destination: payeePubkey,
        payment_hash: paymentHash,
        num_satoshis: '5000',
        num_msat: '5000000',
        timestamp: String(Math.floor(Date.now() / 1000)),
        expiry: '600',
        cltv_expiry: '40',
      }));
      return;
    }
    if (url.startsWith('/v2/router/track/')) {
      const encoded = url.slice('/v2/router/track/'.length).split('?')[0]!;
      const trackedHex = Buffer.from(decodeURIComponent(encoded), 'base64').toString('hex');
      state.routerRequests.push({ path: url });
      if (trackedHex === '00'.repeat(32)) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { code: 5, message: "payment isn't found" } }) + '\n');
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      const payload = state.trackOutcome === 'INSUFFICIENT_BALANCE'
        ? {
          status: 'FAILED',
          failure_reason: 'FAILURE_REASON_INSUFFICIENT_BALANCE',
          payment_hash: paymentHash,
          htlcs: [],
          fee_msat: '0',
          fee_sat: '0',
          fee: '0',
        }
        : {
          status: 'SUCCEEDED',
          failure_reason: 'FAILURE_REASON_NONE',
          payment_hash: paymentHash,
          payment_preimage: preimage,
          value_msat: '5000000',
          fee_msat: '50',
        };
      res.end(JSON.stringify({ result: payload }) + '\n');
      return;
    }
    if (url === '/v2/router/send') {
      let bodyText = '';
      for await (const chunk of req) bodyText += chunk.toString();
      state.routerRequests.push({ path: url, body: JSON.parse(bodyText) });
      if (state.beforeRouteSend) await state.beforeRouteSend();
      if (state.disconnectOnSend) {
        res.destroy();
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        result: {
          status: 'SUCCEEDED',
          failure_reason: 'FAILURE_REASON_NONE',
          payment_hash: paymentHash,
          payment_preimage: preimage,
          value_msat: '5000000',
          fee_msat: '50',
        },
      }) + '\n');
      return;
    }
    res.writeHead(404).end();
  });

  const payeeServer = https.createServer({ key: payeeKey, cert: payeeCert }, (req, res) => {
    if (req.headers['grpc-metadata-macaroon'] !== payeeReadHex) {
      res.writeHead(401).end();
      return;
    }
    const url = req.url ?? '/';
    state.payeeCalls.push(url);
    if (url === '/v1/state') {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ state: 'SERVER_ACTIVE' }));
      return;
    }
    if (url === '/v1/getinfo') {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
        identity_pubkey: payeePubkey,
        synced_to_chain: true,
        wallet_synced: true,
        version: lndVersion,
        commit_hash: lndCommit,
        block_hash: tipHash,
        block_height: 250,
        num_peers: 1,
        chains: [{ chain: 'bitcoin', network: 'regtest' }],
      }));
      return;
    }
    if (url === '/v1/channels') {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
        channels: [{
          chan_id: channelId,
          channel_point: channelPoint,
          remote_pubkey: payerPubkey,
          active: true,
          zero_conf: false,
          local_balance: '0',
          remote_balance: state.payerLocalBalance,
          commit_fee: '1500',
          unsettled_balance: state.payeeUnsettledBalance,
          pending_htlcs: state.payeePendingHtlcs,
          local_constraints: { chan_reserve_sat: '3000' },
        }],
      }));
      return;
    }
    if (url === '/v1/balance/blockchain') {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
        confirmed_balance: '0',
        unconfirmed_balance: '0',
      }));
      return;
    }
    res.writeHead(404).end();
  });

  coreServer.listen(0, '127.0.0.1');
  payerServer.listen(0, '127.0.0.1');
  payeeServer.listen(0, '127.0.0.1');
  await Promise.all([once(coreServer, 'listening'), once(payerServer, 'listening'), once(payeeServer, 'listening')]);
  t.after(() => {
    coreServer.close();
    payerServer.close();
    payeeServer.close();
  });

  const bitcoinOrigin = `http://127.0.0.1:${(coreServer.address() as AddressInfo).port}`;
  const payerOrigin = `https://127.0.0.1:${(payerServer.address() as AddressInfo).port}`;
  const payeeOrigin = `https://127.0.0.1:${(payeeServer.address() as AddressInfo).port}`;

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
    routing: { bitcoinOrigin, payerOrigin, payeeOrigin },
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
    BITCOIN_RPC_URL: bitcoinOrigin,
    BITCOIN_COOKIE_PATH: credPaths.bitcoinCookiePath,
    BITCOIN_WALLET: policy.wallet,
    LND_REST_URL: payerOrigin,
    LND_TLS_CERT_PATH: credPaths.payerCertPath,
    LND_MACAROON_PATH: credPaths.payerReadMacaroonPath,
    ALICE_LND_REST_URL: payeeOrigin,
    ALICE_LND_TLS_CERT_PATH: credPaths.payeeCertPath,
    ALICE_LND_MACAROON_PATH: credPaths.payeeReadMacaroonPath,
  };

  const testToken = createTestForwardLeaseToken();
  const provisionWithCli = async (extraArgs: string[] = []) => {
    const logs: string[] = [];
    const errors: string[] = [];
    const code = await runProvisionForwardCLI(
      extraArgs.length ? extraArgs : ['--policy-path', written.path, '--policy-sha256', written.hash],
      {
        provisionFresh: (dir, node, scope) => Store.provisionFreshForwardWithTestToken(testToken, dir, node, registryDir, true, scope),
        provisionConsolidated: (dir, node, bundle, sha, scope) =>
          Store.provisionConsolidatedForwardWithTestToken(testToken, dir, node, bundle, sha, registryDir, true, scope),
        log: line => logs.push(line),
        error: line => errors.push(line),
      },
    );
    return { code, logs, errors };
  };

  const bootReal = (
    overrideEnv: Record<string, string> = {},
    args: string[] = ['--forward-regtest', '--policy-path', written.path, '--policy-sha256', written.hash],
    portOverride: number | undefined = 0,
    includeToken = true,
  ) => startApplication({ ...env, ...overrideEnv }, args, {
    ...(portOverride === undefined ? {} : { port: portOverride }),
    forward: {
      openStore: (dir, node) => Store.openForForwardWithTestToken(testToken, dir, node, registryDir),
      assertPersistentStorage: async () => {},
      ...(includeToken ? { testToken } : {}),
    },
  });

  return {
    root, registryDir, dataDir, authStorePath, password, owner, credPaths, adminMacPath,
    payerRouterMac, policy, writePolicy, written, env, state, invoice, preimage, paymentHash,
    depositTxid, testToken, provisionWithCli, bootReal,
  };
}

test('real-transport integration via startApplication (no reads/identity mocks) exercises preflight, balances, Router TLS, and single run', async t => {
  const f = await createRealTransportFixture(t);
  const prov = await f.provisionWithCli();
  assert.equal(prov.code, 0, prov.errors.join('\n'));

  // Verify complete 15-field StateScope written by provision CLI
  const scope = JSON.parse(await readFile(join(f.dataDir, '.environment.json'), 'utf8'));
  assert.deepEqual(scope, { version: 2, ...forwardStateScope(f.policy) });

  const app = await f.bootReal();
  t.after(() => app.close().catch(() => {}));
  const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;

  // B1: /v1/preflight probes payer (LND_*) via real HTTP/HTTPS, passes commit_hash + ZMQ
  const preflightRes = await fetch(`${base}/v1/preflight`);
  assert.equal(preflightRes.status, 200);
  const preflightBody = await preflightRes.json();
  assert.equal(preflightBody.prerequisitesSatisfied, true);
  assert.equal(preflightBody.lnd.walletSyncSource, 'lnd-v0.20.8-beta-chain-sync');
  assert.ok(f.state.payerCalls.includes('/v1/getinfo'));

  // B3: startup probed Router auth in read-only mode
  assert.ok(f.state.routerRequests.some(r => r.path.startsWith('/v2/router/track/')));

  const loginRes = await fetch(`${base}/v1/auth/login`, {
    method: 'POST',
    headers: { origin: FORWARD_ORIGIN, 'content-type': 'application/json' },
    body: JSON.stringify({ username: f.owner.username, password: f.password }),
  });
  assert.equal(loginRes.status, 200);
  const cookie = loginRes.headers.get('set-cookie')!.split(';')[0]!;
  const csrf = (await loginRes.json()).csrfToken as string;

  // B1: /v1/operations/balances reports provider = payer (290k local) and alice = payee (290k remote)
  const balRes = await fetch(`${base}/v1/operations/balances`, { headers: { cookie } });
  assert.equal(balRes.status, 200);
  const bal = await balRes.json();
  assert.equal(bal.provider.localSats, 290_000);
  assert.equal(bal.provider.remoteSats, 0);
  assert.equal(bal.alice.localSats, 0);
  assert.equal(bal.alice.remoteSats, 290_000);

  // Full forward flow over real HTTP + HTTPS TLS + real HttpsLndPaymentTransport (lost response -> UNKNOWN -> real TLS recover -> SUCCEEDED)
  const admitRes = await fetch(`${base}/v1/forward`, {
    method: 'POST',
    headers: { origin: FORWARD_ORIGIN, cookie, 'x-csrf-token': csrf, 'content-type': 'application/json', 'idempotency-key': 'real-transport-1' },
    body: JSON.stringify({ invoice: f.invoice, invoiceSats: 5000 }),
  });
  assert.equal(admitRes.status, 201);
  const admitted = await admitRes.json();
  assert.equal(admitted.depositSats, 5100);

  f.state.disconnectOnSend = true;
  const execRes = await fetch(`${base}/v1/forward/${admitted.id}/execute`, {
    method: 'POST',
    headers: { origin: FORWARD_ORIGIN, cookie, 'x-csrf-token': csrf, 'content-type': 'application/json' },
    body: JSON.stringify({ txid: f.depositTxid, vout: 0 }),
  });
  assert.equal(execRes.status, 200);
  assert.equal((await execRes.json()).state, 'UNKNOWN');

  const recoverRes = await fetch(`${base}/v1/forward/${admitted.id}/recover`, {
    method: 'POST',
    headers: { origin: FORWARD_ORIGIN, cookie, 'x-csrf-token': csrf, 'content-type': 'application/json' },
    body: JSON.stringify({}),
  });
  assert.equal(recoverRes.status, 200);
  const recText = await recoverRes.text();
  assert.equal(JSON.parse(recText).state, 'SUCCEEDED');
  assert.equal(recText.includes(f.preimage), false);

  const sends = f.state.routerRequests.filter(r => r.path === '/v2/router/send');
  assert.equal(sends.length, 1);
  assert.deepEqual(sends[0]!.body, {
    payment_request: f.invoice,
    timeout_seconds: 60,
    fee_limit_sat: '100',
    max_parts: 16,
    outgoing_chan_ids: [channelId],
    no_inflight_updates: false,
    allow_self_payment: false,
    amp: false,
    cancelable: false,
  });

  // Idempotent replay of execute after SUCCEEDED never resends
  const replayExec = await fetch(`${base}/v1/forward/${admitted.id}/execute`, {
    method: 'POST',
    headers: { origin: FORWARD_ORIGIN, cookie, 'x-csrf-token': csrf, 'content-type': 'application/json' },
    body: JSON.stringify({ txid: f.depositTxid, vout: 0 }),
  });
  assert.equal(replayExec.status, 200);
  assert.equal((await replayExec.json()).state, 'SUCCEEDED');
  assert.equal(f.state.routerRequests.filter(r => r.path === '/v2/router/send').length, 1);

  // Also verify grouped/split real LND URI-scoped router macaroon accepted & generic/fake/caveat rejected
  verifyLndMacaroonRole(buildLndMacaroon([{
    entity: 'uri',
    actions: ['/routerrpc.Router/SendPaymentV2', '/routerrpc.Router/TrackPaymentV2'],
  }]), 'router');
  verifyLndMacaroonRole(buildLndMacaroon([
    { entity: 'uri', actions: ['/routerrpc.Router/SendPaymentV2'] },
    { entity: 'uri', actions: ['/routerrpc.Router/TrackPaymentV2'] },
  ]), 'router');
  assert.throws(() => verifyLndMacaroonRole(buildLndMacaroon([
    { entity: 'uri', actions: ['/routerrpc.Router/SendPaymentV2'] },
  ]), 'router'), /FORWARD_MACAROON_ROLE_REJECTED/);
  assert.throws(() => verifyLndMacaroonRole(buildLndMacaroon([
    { entity: 'offchain', actions: ['read', 'write'] },
  ]), 'router'), /FORWARD_MACAROON_ROLE_REJECTED/);
  assert.throws(() => verifyLndMacaroonRole(buildLndMacaroon([{
    entity: 'uri',
    actions: ['/routerrpc.Router/SendPaymentV2', '/routerrpc.Router/TrackPaymentV2'],
  }], ['time-before 2099-01-01']), 'router'), /FORWARD_MACAROON_ROLE_REJECTED/);
});

test('B1 negative tests: role inversion, unpinned commit_hash, and wrong ZMQ port are rejected', async t => {
  const f = await createRealTransportFixture(t);
  await f.provisionWithCli();

  // Swapped LND_* and ALICE_LND_* rejected by real attestStartup + prepareForwardRegtestProfile
  await assert.rejects(
    f.bootReal({
      LND_REST_URL: f.policy.routing.payeeOrigin,
      LND_TLS_CERT_PATH: f.credPaths.payeeCertPath,
      LND_MACAROON_PATH: f.credPaths.payeeReadMacaroonPath,
      ALICE_LND_REST_URL: f.policy.routing.payerOrigin,
      ALICE_LND_TLS_CERT_PATH: f.credPaths.payerCertPath,
      ALICE_LND_MACAROON_PATH: f.credPaths.payerReadMacaroonPath,
    }),
    /FORWARD_IDENTITY_MISMATCH/,
  );

  // Wrong commit_hash when wallet_synced is undefined rejected
  f.state.payerCommitHash = 'deadbeef';
  await assert.rejects(f.bootReal(), /FORWARD_LND_WALLET_NOT_SYNCED/);
  f.state.payerCommitHash = lndCommit;

  // Wrong ZMQ ports rejected
  f.state.zmqAddresses = ['tcp://127.0.0.1:28334', 'tcp://127.0.0.1:28335'];
  await assert.rejects(f.bootReal(), /FORWARD_ZMQ_NOTIFICATIONS_MISSING/);
});

test('B2 negative & consolidation tests: unprovisioned/legacy Store never auto-adopted; CLI enforces StateScope', async t => {
  const f = await createRealTransportFixture(t);

  // 1. Unprovisioned directory fails BEFORE creating .environment.json
  await assert.rejects(f.bootReal(), /FORWARD_CUSTODY_BINDING_REQUIRED/);
  await assert.rejects(readFile(join(f.dataDir, '.environment.json')), { code: 'ENOENT' });

  // 2. CLI refuses /tmp (tmpfs)
  const tmpPolicy = await f.writePolicy({ ...f.policy, dataDir: '/tmp/fwd-volatile-test' }, 'tmp-policy.json');
  const tmpCode = await runProvisionForwardCLI(['--policy-path', tmpPolicy.path, '--policy-sha256', tmpPolicy.hash], {
    log: () => {},
    error: () => {},
  });
  assert.equal(tmpCode, 1);

  // 3. CLI refuses pre-existing historical state.json without auto-adopting it
  await writeFile(join(f.dataDir, 'state.json'), '{"schema":1,"quotes":{},"swaps":{}}\n', { mode: 0o600 });
  assert.equal((await f.provisionWithCli()).code, 1);
  await unlink(join(f.dataDir, 'state.json'));

  // 4. Legacy bound directory missing .environment.json fails with STATE_SCOPE_MIGRATION_REQUIRED without writing .environment.json
  await Store.provisionFreshForwardWithTestToken(f.testToken, f.dataDir, payerPubkey, f.registryDir, true);
  await assert.rejects(f.bootReal(), /STATE_SCOPE_MIGRATION_REQUIRED/);
  await assert.rejects(readFile(join(f.dataDir, '.environment.json')), { code: 'ENOENT' });

  // 5. Consolidated CLI enforces StateScope & cuts over cleanly when .environment.json matches
  const consRoot = await privateTestDirectory('fwd-cons-cli');
  t.after(() => rm(consRoot, { recursive: true, force: true }));
  const [histA, histB, adminDir, outDir] = ['a', 'b', 'admin', 'out'].map(n => join(consRoot, n)) as [string, string, string, string];
  await Promise.all([histA, histB, adminDir, outDir].map(d => mkdir(d, { mode: 0o700 })));
  const preimage1 = '12'.repeat(32);
  const hash1 = sha256(Buffer.from(preimage1, 'hex'));
  const script1 = '0014' + 'aa'.repeat(20);
  const addr1 = address.fromOutputScript(Buffer.from(script1, 'hex'), networks.regtest);
  const txid1 = '34'.repeat(32);
  const preimage2 = '56'.repeat(32);
  const hash2 = sha256(Buffer.from(preimage2, 'hex'));
  const script2 = '0014' + 'bb'.repeat(20);
  const addr2 = address.fromOutputScript(Buffer.from(script2, 'hex'), networks.regtest);
  const txid2 = '78'.repeat(32);
  const mkEntry = (pHash: string, pre: string, scr: string, adr: string, tx: string, id: string, invChar: string) => {
    const approval = {
      network: 'regtest' as const, payerNode: payerPubkey, payeeNode: payeePubkey, paymentHash: pHash,
      invoice: 'lnbcrt' + invChar.repeat(30), invoiceSats: 5000, feeLimitSats: 100 as const, expiresAt: 1,
      deposit: { txid: tx, vout: 0, scriptPubKey: scr, valueSats: 5100 },
    };
    const { deposit: _omitDeposit, ...admissionTerms } = approval;
    const digest = sha256(Buffer.from(JSON.stringify(approval)));
    return {
      doc: Buffer.from(JSON.stringify({
        schema: 1, quotes: {}, swaps: {},
        forwardPayments: { [pHash]: { payerNode: payerPubkey, outpoint: `${tx}:0`, approvalDigest: digest, status: 'SUCCEEDED' } },
        forwardAdmissions: { [id]: { ...admissionTerms, owner: 'hist', address: adr, scriptPubKey: scr, depositSats: 5100, outpoint: { txid: tx, vout: 0 } } },
      })),
      obs: {
        before: { network: 'regtest', container: 'iso_rt_lnd_provider', containerId: '9'.repeat(64), node: payerPubkey },
        after: { network: 'regtest', container: 'iso_rt_lnd_provider', containerId: '9'.repeat(64), node: payerPubkey },
        approval,
        track: { status: 'SUCCEEDED', hash: pHash, preimage: pre, valueMsat: 5_000_000, feeMsat: 10 },
      },
    };
  };
  const e1 = mkEntry(hash1, preimage1, script1, addr1, txid1, '11111111-1111-4111-8111-111111111111', 'e');
  const e2 = mkEntry(hash2, preimage2, script2, addr2, txid2, '22222222-2222-4222-8222-222222222222', 'f');
  const adminBytes = Buffer.from('{"schema":1,"quotes":{},"swaps":{}}\n');
  await writeFile(join(histA, 'state.json'), e1.doc, { mode: 0o600 });
  await writeFile(join(histB, 'state.json'), e2.doc, { mode: 0o600 });
  await writeFile(join(adminDir, 'state.json'), adminBytes, { mode: 0o600 });
  const evidencePath = join(consRoot, 'evidence.json');
  await writeFile(evidencePath, JSON.stringify({
    target: 'admin-regtest-3201',
    payer: e1.obs.before,
    payeeNode: payeePubkey,
    sources: {
      admin: { sha256: sha256(adminBytes), owner: f.owner.id },
      historicalA: { sha256: sha256(e1.doc), owner: 'hist' },
      historicalB: { sha256: sha256(e2.doc), owner: 'hist' },
    },
    lookups: { [hash1]: e1.obs, [hash2]: e2.obs },
  }), { mode: 0o600 });
  const consReg = join(consRoot, 'registry');
  await prepareForwardConsolidationWithTestRegistry(f.testToken, {
    adminDirectory: adminDir,
    historicalADirectory: histA,
    historicalBDirectory: histB,
    outputDirectory: outDir,
    evidenceFile: evidencePath,
  }, consReg);
  const bundleDir = join(outDir, 'admin-regtest-3201-review');
  const manifestSha = sha256(await readFile(join(bundleDir, 'manifest.json')));
  const consPolicy = await f.writePolicy({ ...f.policy, dataDir: adminDir }, 'cons-policy.json');

  // Legacy adminDir without .environment.json is rejected (no auto-adoption) and binding is NOT created
  const deniedCons = await runProvisionForwardCLI([
    '--consolidated', '--policy-path', consPolicy.path, '--policy-sha256', consPolicy.hash,
    '--bundle-dir', bundleDir, '--manifest-sha256', manifestSha,
  ], {
    provisionConsolidated: (dir, node, bundle, sha, scope) =>
      Store.provisionConsolidatedForwardWithTestToken(f.testToken, dir, node, bundle, sha, consReg, true, scope),
    log: () => {},
    error: () => {},
  });
  assert.equal(deniedCons, 1);
  await assert.rejects(readFile(join(consReg, 'bindings', `${payerPubkey}.json`)), { code: 'ENOENT' });

  // With matching .environment.json present, consolidated CLI cuts over cleanly
  await writeFile(join(adminDir, '.environment.json'), JSON.stringify({ version: 2, ...forwardStateScope(f.policy) }) + '\n', { mode: 0o600 });
  const okCons = await runProvisionForwardCLI([
    '--consolidated', '--policy-path', consPolicy.path, '--policy-sha256', consPolicy.hash,
    '--bundle-dir', bundleDir, '--manifest-sha256', manifestSha,
  ], {
    provisionConsolidated: (dir, node, bundle, sha, scope) =>
      Store.provisionConsolidatedForwardWithTestToken(f.testToken, dir, node, bundle, sha, consReg, true, scope),
    log: () => {},
    error: () => {},
  });
  assert.equal(okCons, 0);
  const cutoverStore = await Store.openForForwardWithTestToken(f.testToken, adminDir, payerPubkey, consReg);
  assert.equal(Object.keys(cutoverStore.read().forwardPayments ?? {}).length, 2);
  await cutoverStore.close();
});

test('B3 negative tests: admin.macaroon rejected, Router auth probed, TOCTOU digest swap blocked, allowlists enforced', async t => {
  const f = await createRealTransportFixture(t);
  await f.provisionWithCli();

  // 1. admin.macaroon in payerRouterMacaroonPath rejected
  const adminRouterPolicy = await f.writePolicy({
    ...f.policy,
    credentialPaths: { ...f.policy.credentialPaths, payerRouterMacaroonPath: f.adminMacPath },
  }, 'admin-router.json');
  await assert.rejects(
    f.bootReal({}, ['--forward-regtest', '--policy-path', adminRouterPolicy.path, '--policy-sha256', adminRouterPolicy.hash]),
    /FORWARD_MACAROON_ROLE_REJECTED/,
  );

  // 2. router.macaroon in payerReadMacaroonPath rejected
  const writeInReadPath = join(f.root, 'creds', 'bad-read.macaroon');
  await writeFile(writeInReadPath, f.payerRouterMac, { mode: 0o600 });
  const badReadPolicy = await f.writePolicy({
    ...f.policy,
    credentialPaths: { ...f.policy.credentialPaths, payerReadMacaroonPath: writeInReadPath },
  }, 'bad-read.json');
  await assert.rejects(
    f.bootReal({ LND_MACAROON_PATH: writeInReadPath }, ['--forward-regtest', '--policy-path', badReadPolicy.path, '--policy-sha256', badReadPolicy.hash]),
    /FORWARD_MACAROON_ROLE_REJECTED/,
  );

  // 3. Forged/rejected router macaroon caught at startup by Router read-only auth probe
  f.state.rejectRouterAuth = true;
  await assert.rejects(f.bootReal(), /FORWARD_ROUTER_AUTH_FAILED/);
  f.state.rejectRouterAuth = false;

  // 4. Symlinked credential file rejected
  const symRouter = join(f.root, 'creds', 'sym-router.macaroon');
  await symlink(f.credPaths.payerRouterMacaroonPath, symRouter);
  const symCredPolicy = await f.writePolicy({
    ...f.policy,
    credentialPaths: { ...f.policy.credentialPaths, payerRouterMacaroonPath: symRouter },
  }, 'sym-cred.json');
  await assert.rejects(
    f.bootReal({}, ['--forward-regtest', '--policy-path', symCredPolicy.path, '--policy-sha256', symCredPolicy.hash]),
    /OPERATOR_STOPPED/,
  );

  // 5. Allowlists enforce strict Core/Payer/Payee boundaries
  const { config: parseConfig } = await import('../src/config.js');
  const prepared = await prepareForwardRegtestProfile(
    { path: f.written.path, hash: f.written.hash },
    parseConfig(f.env),
    {
      environment: 'regtest',
      deploymentId: FORWARD_DEPLOYMENT_ID,
      genesisHash: FORWARD_REGTEST_GENESIS,
      wallet: f.policy.wallet,
      bitcoinOrigin: f.policy.routing.bitcoinOrigin,
      providerOrigin: f.policy.routing.payerOrigin,
      payerOrigin: f.policy.routing.payeeOrigin,
      providerNode: payerPubkey,
      payerNode: payeePubkey,
      verified: { onchain: true, lightning: true },
    },
    0,
    { testToken: f.testToken, openStore: (d, n) => Store.openForForwardWithTestToken(f.testToken, d, n, f.registryDir), assertPersistentStorage: async () => {} },
  );
  await assert.rejects(prepared.clients.core.call('sendtoaddress', ['bcrt1q...', 1], true), /FORWARD_CORE_OPERATION_DISABLED/);
  await assert.rejects(prepared.clients.core.call('generatetoaddress', [1, 'bcrt1q...'], false), /FORWARD_CORE_OPERATION_DISABLED/);
  await assert.rejects(prepared.clients.payer.call('/v2/invoices/hodl', {}), /FORWARD_PAYER_OPERATION_DISABLED/);
  await assert.rejects(prepared.clients.payee.call(recoveryPaymentsPath), /FORWARD_PAYEE_OPERATION_DISABLED/);

  // 6. TOCTOU credential replacement after startup pinning blocks Router send before wire
  const app = await f.bootReal();
  t.after(() => app.close().catch(() => {}));
  const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  const loginRes = await fetch(`${base}/v1/auth/login`, {
    method: 'POST',
    headers: { origin: FORWARD_ORIGIN, 'content-type': 'application/json' },
    body: JSON.stringify({ username: f.owner.username, password: f.password }),
  });
  const cookie = loginRes.headers.get('set-cookie')!.split(';')[0]!;
  const csrf = (await loginRes.json()).csrfToken as string;
  const admitRes = await fetch(`${base}/v1/forward`, {
    method: 'POST',
    headers: { origin: FORWARD_ORIGIN, cookie, 'x-csrf-token': csrf, 'content-type': 'application/json', 'idempotency-key': 'toctou-1' },
    body: JSON.stringify({ invoice: f.invoice, invoiceSats: 5000 }),
  });
  const admitted = await admitRes.json();

  // Swap router macaroon on disk to a different valid URI router macaroon -> digest mismatch aborts before Router HTTP call!
  await writeFile(f.credPaths.payerRouterMacaroonPath, buildLndMacaroon([{
    entity: 'uri',
    actions: ['/routerrpc.Router/SendPaymentV2', '/routerrpc.Router/TrackPaymentV2'],
  }]), { mode: 0o600 });
  const beforeSends = f.state.routerRequests.filter(r => r.path === '/v2/router/send').length;
  const execRes = await fetch(`${base}/v1/forward/${admitted.id}/execute`, {
    method: 'POST',
    headers: { origin: FORWARD_ORIGIN, cookie, 'x-csrf-token': csrf, 'content-type': 'application/json' },
    body: JSON.stringify({ txid: f.depositTxid, vout: 0 }),
  });
  assert.equal(execRes.status, 200);
  assert.equal((await execRes.json()).state, 'UNKNOWN');
  assert.equal(f.state.routerRequests.filter(r => r.path === '/v2/router/send').length, beforeSends);
});

test('B4 negative tests: portOverride without testToken, exclusive rails, mandatory schema fields, ADMIN role on route, and listen check', async t => {
  const f = await createRealTransportFixture(t);
  await f.provisionWithCli();

  // 1. portOverride without testToken rejected (without opening port 3201)
  await assert.rejects(f.bootReal({}, undefined, 0, false), /FORWARD_CONFIG_REJECTED/);
  await assert.rejects(f.bootReal({}, undefined, 3999, false), /FORWARD_CONFIG_REJECTED/);
  await assert.rejects(f.bootReal({}, undefined, 3999, true), /FORWARD_CONFIG_REJECTED/);

  // 2. Missing ownerUsername or limits rejected
  const noUserPolicy = await f.writePolicy({ ...f.policy, ownerUsername: undefined }, 'no-user.json');
  await assert.rejects(f.bootReal({}, ['--forward-regtest', '--policy-path', noUserPolicy.path, '--policy-sha256', noUserPolicy.hash]));
  const noLimitsPolicy = await f.writePolicy({ ...f.policy, limits: undefined }, 'no-limits.json');
  await assert.rejects(f.bootReal({}, ['--forward-regtest', '--policy-path', noLimitsPolicy.path, '--policy-sha256', noLimitsPolicy.hash]));

  // 3. Active guest / ark / liquid / recovery rejected
  await assert.rejects(f.bootReal({ GUEST_SWAP_ENABLED: 'true' }), /FORWARD_EXECUTION_DISABLED/);
  await assert.rejects(f.bootReal({
    ARK_ENABLED: 'true',
    ARK_NETWORK: 'regtest',
    ARK_OPERATOR_URL: 'http://127.0.0.1:7070',
    ARK_EXPECTED_SIGNER_PUBKEY: '02' + '99'.repeat(32),
  }), /FORWARD_EXECUTION_DISABLED/);
  await assert.rejects(f.bootReal({
    LIQUID_ENABLED: 'true',
    LIQUID_NETWORK: 'liquidregtest',
    ELEMENTS_RPC_URL: 'http://127.0.0.1:18884',
    ELEMENTS_COOKIE_PATH: f.credPaths.bitcoinCookiePath,
    ELEMENTS_WALLET: 'liq-wallet',
    LIQUID_POLICY_ASSET: 'aa'.repeat(32),
    LIQUID_PARENT_GENESIS_HASH: FORWARD_REGTEST_GENESIS,
  }), /FORWARD_EXECUTION_DISABLED/);
  await assert.rejects(f.bootReal({
    ENABLE_READ_ONLY_RECOVERY: 'true',
    RECOVERY_PAYER_REST_URL: f.policy.routing.payerOrigin,
    RECOVERY_PAYER_TLS_CERT_PATH: f.credPaths.payerCertPath,
    RECOVERY_PAYER_MACAROON_PATH: f.credPaths.payerReadMacaroonPath,
    RECOVERY_PAYER_NODE_PUBKEY: payerPubkey,
    RECOVERY_PROVIDER_NODE_PUBKEY: payeePubkey,
  }), /FORWARD_EXECUTION_DISABLED/);

  // 4. Server address mismatch post-listen fails closed
  const addrMock = t.mock.method(http.Server.prototype, 'address', () => ({ address: '0.0.0.0', family: 'IPv4', port: 9999 }));
  try {
    await assert.rejects(f.bootReal(), /LISTEN_ADDRESS_MISMATCH/);
  } finally {
    addrMock.mock.restore();
  }

  // 5. Downgrading ownerId from ADMIN to USER in authStorePath blocks /v1/forward* even with matching ownerId
  const app = await f.bootReal();
  t.after(() => app.close().catch(() => {}));
  const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  const accounts = await readAccounts(f.authStorePath);
  await writeFile(f.authStorePath, JSON.stringify({
    version: 1,
    users: accounts.map(a => a.id === f.owner.id ? { ...a, role: 'USER' as const } : a),
  }) + '\n', { mode: 0o600 });
  const loginRes = await fetch(`${base}/v1/auth/login`, {
    method: 'POST',
    headers: { origin: FORWARD_ORIGIN, 'content-type': 'application/json' },
    body: JSON.stringify({ username: f.owner.username, password: f.password }),
  });
  assert.equal(loginRes.status, 200);
  const cookie = loginRes.headers.get('set-cookie')!.split(';')[0]!;
  const csrf = (await loginRes.json()).csrfToken as string;
  assert.deepEqual(await (await fetch(`${base}/v1/forward/availability`, { headers: { cookie } })).json(), { executionAvailable: false });
  const denied = await fetch(`${base}/v1/forward`, {
    method: 'POST',
    headers: { origin: FORWARD_ORIGIN, cookie, 'x-csrf-token': csrf, 'content-type': 'application/json', 'idempotency-key': 'downgraded-role-1' },
    body: JSON.stringify({ invoice: f.invoice, invoiceSats: 5000 }),
  });
  assert.equal(denied.status, 403);
});

test('B5 negative tests: non-zero wallet balance, payee pending HTLCs, and liquidity drop before execute preserve idempotency without INTENT', async t => {
  const f = await createRealTransportFixture(t);
  await f.provisionWithCli();

  // 1. Non-zero Core wallet balance when admissionCount === 0 rejected
  f.state.walletBalanceTrusted = 0.0001;
  await assert.rejects(f.bootReal(), /FORWARD_WALLET_NOT_EMPTY/);
  f.state.walletBalanceTrusted = 0;

  // 2. Payee pending HTLCs / unsettled balance rejected before admit/execute
  const app = await f.bootReal();
  t.after(() => app.close().catch(() => {}));
  const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  const loginRes = await fetch(`${base}/v1/auth/login`, {
    method: 'POST',
    headers: { origin: FORWARD_ORIGIN, 'content-type': 'application/json' },
    body: JSON.stringify({ username: f.owner.username, password: f.password }),
  });
  const cookie = loginRes.headers.get('set-cookie')!.split(';')[0]!;
  const csrf = (await loginRes.json()).csrfToken as string;

  f.state.payeePendingHtlcs = [{ incoming: true }];
  const badAdmit = await fetch(`${base}/v1/forward`, {
    method: 'POST',
    headers: { origin: FORWARD_ORIGIN, cookie, 'x-csrf-token': csrf, 'content-type': 'application/json', 'idempotency-key': 'b5-htlc-1' },
    body: JSON.stringify({ invoice: f.invoice, invoiceSats: 5000 }),
  });
  assert.equal(badAdmit.status, 409);
  f.state.payeePendingHtlcs = [];

  // Admit cleanly
  const okAdmit = await fetch(`${base}/v1/forward`, {
    method: 'POST',
    headers: { origin: FORWARD_ORIGIN, cookie, 'x-csrf-token': csrf, 'content-type': 'application/json', 'idempotency-key': 'b5-run-1' },
    body: JSON.stringify({ invoice: f.invoice, invoiceSats: 5000 }),
  });
  assert.equal(okAdmit.status, 201);
  const admitted = await okAdmit.json();

  // 3. Liquidity drop between admit and execute fails BEFORE writing INTENT or calling Router, so recovery of liquidity lets SAME admission succeed
  f.state.payerLocalBalance = '8000'; // 8000 - 3000 - 1500 = 3500 < 5100
  const dropExec = await fetch(`${base}/v1/forward/${admitted.id}/execute`, {
    method: 'POST',
    headers: { origin: FORWARD_ORIGIN, cookie, 'x-csrf-token': csrf, 'content-type': 'application/json' },
    body: JSON.stringify({ txid: f.depositTxid, vout: 0 }),
  });
  assert.equal(dropExec.status, 409);
  assert.equal(f.state.routerRequests.filter(r => r.path === '/v2/router/send').length, 0);

  // Verify status is STILL AWAITING_DEPOSIT (NOT burned into UNKNOWN/INTENT!)
  const statusAfterDrop = await (await fetch(`${base}/v1/forward/${admitted.id}`, { headers: { cookie } })).json();
  assert.equal(statusAfterDrop.state, 'AWAITING_DEPOSIT');
  assert.equal(statusAfterDrop.outpoint, null);

  // Restore liquidity and execute the SAME admission -> SUCCEEDED!
  f.state.payerLocalBalance = '290000';
  const okExec = await fetch(`${base}/v1/forward/${admitted.id}/execute`, {
    method: 'POST',
    headers: { origin: FORWARD_ORIGIN, cookie, 'x-csrf-token': csrf, 'content-type': 'application/json' },
    body: JSON.stringify({ txid: f.depositTxid, vout: 0 }),
  });
  assert.equal(okExec.status, 200);
  assert.equal((await okExec.json()).state, 'SUCCEEDED');
  assert.equal(f.state.routerRequests.filter(r => r.path === '/v2/router/send').length, 1);
});
