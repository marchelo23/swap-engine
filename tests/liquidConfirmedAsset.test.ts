import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { createServer } from 'node:http';
import { config } from '../src/config.js';
import { ElementsReadOnlyClient } from '../src/environment/ElementsReadOnlyClient.js';
import { attestStartup } from '../src/environment/StartupAttestation.js';
import { confirmedAssetEvidence } from '../src/liquid/ConfirmedAssetEvidence.js';
import { liquidPreflight } from '../src/liquid/preflight.js';
import { startApplication } from '../src/main.js';

// Public identity values reported in DeepSeek's installed-lab document.
// Transactions, amounts and RPC server below are synthetic offline fixtures.
const genesis = 'cd179c84c35f51825f20a3b91a18d45f0c53b5ceb744a5b6ef8f0babe809396f';
const tip = 'd6901f95dc66ce0d5b738b9eb0c34ba6e12dee2e99f20e845fbbd92c051a2800';
const asset = 'b2e15d0d7a0c94e4e2ce0fe6e8691b9e451377f6e46e8045a86f7c4b5d4f0f23';
const parent = '0f9188f13cb7b2c71f2a335e3a4fc328bf5beb436012afca590b1a11466e2206';
const other = 'fe'.repeat(32);
const env = () => ({ APP_ENV: 'liquid-regtest', DEPLOYMENT_ID: 'liquid-evidence-test',
  SPEND_POLICY: 'disabled', REVERSE_SWAP_ENABLED: 'false', LIQUID_CONFIRMATION_POLICY: 'read-only',
  LIQUID_NETWORK: 'elementsregtest', ELEMENTS_RPC_URL: 'http://127.0.0.1:7042',
  ELEMENTS_COOKIE_PATH: resolve('unused.cookie'), ELEMENTS_WALLET: 'lqwd-liquid',
  LIQUID_POLICY_ASSET: asset, LIQUID_PARENT_GENESIS_HASH: parent, LIQUID_GENESIS_HASH: genesis });
function fixtures() {
  const observed = { blockchain: { chain: 'elementsregtest', blocks: 101, bestblockhash: tip, initialblockdownload: false },
    sidechain: { parent_blockhash: parent, pegged_asset: other }, genesis, wallet: { walletname: 'lqwd-liquid' } };
  const data = { block: { hash: tip, height: 101, confirmations: 1, tx: [{ txid: 'ab'.repeat(32),
    vin: [{ coinbase: '0165' }], vout: [{ n: 0, asset, value: 0, scriptPubKey: { hex: '6a' } }] }] },
    coins: [{ txid: 'cd'.repeat(32), vout: 0, asset, amount: 1.25, scriptPubKey: '51',
      confirmations: 101, spendable: true, safe: true }] };
  const calls: { method: string; params: unknown[]; wallet: boolean }[] = [];
  const reader = { origin: 'http://127.0.0.1:7042', async call<T>(method: string, params: unknown[] = [], wallet = false): Promise<T> {
    calls.push({ method, params, wallet });
    const values: Record<string, unknown> = { getblockchaininfo: observed.blockchain,
      getsidechaininfo: observed.sidechain, getwalletinfo: observed.wallet,
      getnetworkinfo: { version: 230304 }, getblock: data.block, listunspent: data.coins,
      getblockhash: params[0] === 0 ? observed.genesis : tip };
    if (!(method in values)) throw new Error('Unexpected RPC');
    return values[method] as T;
  } };
  return { observed, data, calls, reader };
}

test('OFFLINE: confirmed wallet/coinbase asset equality never claims current fee policy', async () => {
  const f = fixtures();
  const evidence = await confirmedAssetEvidence(config(env()), f.reader, f.observed);
  assert.equal(evidence.identityVerified, true); assert.equal(evidence.walletAssetVerified, true);
  assert.equal(evidence.asset, asset); assert.equal(evidence.feePolicyVerified, false);
  assert.equal(evidence.blockHeight, 101); assert.equal(evidence.confirmations, 1);
  assert.equal(evidence.limitation, 'CURRENT_FEE_POLICY_UNPROVEN');
  assert.deepEqual(f.calls.map(x => x.method), ['getblockhash', 'getblock', 'listunspent', 'getblockchaininfo', 'getblockhash']);
  assert.deepEqual(f.calls[1]!.params, [tip, 2]);
  assert.deepEqual(f.calls[2], { method: 'listunspent', params: [1, 9_999_999, [], false, { asset }], wallet: true });
  assert.ok(!JSON.stringify(evidence).includes(f.data.coins[0]!.txid));
});

test('OFFLINE: wrong identity/scope fails before evidence RPC', async () => {
  for (const mutate of [
    (f: ReturnType<typeof fixtures>) => { f.observed.genesis = other; },
    (f: ReturnType<typeof fixtures>) => { f.observed.wallet.walletname = 'wrong'; },
    (f: ReturnType<typeof fixtures>) => { f.observed.blockchain.chain = 'liquidv1'; },
    (f: ReturnType<typeof fixtures>) => { f.observed.blockchain.initialblockdownload = true; },
    (f: ReturnType<typeof fixtures>) => { f.observed.sidechain.parent_blockhash = other; },
    (f: ReturnType<typeof fixtures>) => { f.reader.origin = 'http://127.0.0.1:17042'; },
  ]) {
    const f = fixtures(); mutate(f);
    await assert.rejects(confirmedAssetEvidence(config(env()), f.reader, f.observed)); assert.equal(f.calls.length, 0);
  }
  for (const overrides of [{ APP_ENV: 'regtest', SPEND_POLICY: 'regtest-only' }, { APP_ENV: 'mainnet' },
    { LIQUID_CONFIRMATION_POLICY: 'disabled' }, { LIQUID_GENESIS_HASH: '' }]) {
    const f = fixtures();
    await assert.rejects(confirmedAssetEvidence(config({ ...env(), ...overrides }), f.reader, f.observed), /SCOPE_INVALID/);
    assert.equal(f.calls.length, 0);
  }
});

test('a read-only Bitcoin regtest profile can verify a local Elements wallet without enabling execution', async () => {
  const f = fixtures();
  const evidence = await confirmedAssetEvidence(config({ ...env(), APP_ENV: 'regtest' }), f.reader, f.observed);
  assert.equal(evidence.walletAssetVerified, true);
  assert.equal(evidence.feePolicyVerified, false);
});

test('OFFLINE: absent, unsafe or wrong-asset wallet outputs and noncanonical blocks fail closed', async () => {
  const mutations: ((f: ReturnType<typeof fixtures>) => void)[] = [
    f => { f.data.coins = []; }, f => { f.data.coins[0]!.asset = other; },
    f => { f.data.coins[0]!.confirmations = 0; }, f => { f.data.coins[0]!.spendable = false; },
    f => { f.data.coins[0]!.safe = false; }, f => { f.data.coins[0]!.amount = 0; },
    f => { f.data.block.confirmations = -1; }, f => { f.data.block.confirmations = 0; },
    f => { f.data.block.hash = other; }, f => { f.data.block.height = 100; },
    f => { f.data.block.tx[0]!.vin = []; }, f => { f.data.block.tx[0]!.vout[0]!.asset = other; },
    f => { f.data.block.tx = []; },
  ];
  for (const mutate of mutations) {
    const f = fixtures(); mutate(f);
    await assert.rejects(confirmedAssetEvidence(config(env()), f.reader, f.observed));
  }
});

test('OFFLINE: a tip change during collection invalidates the snapshot', async () => {
  const f = fixtures(); const call = f.reader.call.bind(f.reader);
  f.reader.call = async <T>(method: string, params: unknown[] = [], wallet = false): Promise<T> => {
    if (method === 'getblockchaininfo') return { ...f.observed.blockchain, bestblockhash: other } as T;
    return call<T>(method, params, wallet);
  };
  await assert.rejects(confirmedAssetEvidence(config(env()), f.reader, f.observed), /CHAIN_CHANGED/);
});

test('OFFLINE: startup and preflight use real HTTP read-only methods with stock Elements response shapes', async () => {
  const f = fixtures(); const directory = await mkdtemp(join(tmpdir(), 'elements-stock-'));
  const requests: string[] = []; let fee: string | undefined;
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw); requests.push(body.method);
    if (body.method === 'getwalletinfo' || body.method === 'listunspent') assert.equal(req.url, '/wallet/lqwd-liquid');
    const result = body.method === 'getsidechaininfo' ? { ...f.observed.sidechain, fee_asset: fee }
      : await f.reader.call(body.method, body.params);
    res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ result, error: null }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const cookie = join(directory, '.cookie'); await writeFile(cookie, 'fixture:only');
    const address = server.address(); assert.ok(address && typeof address !== 'string');
    const url = `http://127.0.0.1:${address.port}`;
    const c = config({ ...env(), ELEMENTS_RPC_URL: url, ELEMENTS_COOKIE_PATH: cookie });
    const reader = new ElementsReadOnlyClient(url, cookie, 'lqwd-liquid');
    const scope = await attestStartup(c, { liquid: reader });
    assert.equal(scope.liquidGenesisHash, genesis); assert.equal(scope.liquidWallet, 'lqwd-liquid');
    assert.equal(scope.liquidAssetEvidence?.walletAssetVerified, true);
    assert.equal(scope.verified.liquid, false); assert.equal(c.capabilities(scope.verified).execution.enabled, false);
    assert.equal(c.capabilities(scope.verified).rails.liquid.available, false);
    const report = await liquidPreflight(c, { elements: reader });
    assert.equal(report.elements.assetEvidence?.identityVerified, true);
    assert.equal(report.elements.reason, 'LIQUID_FEE_POLICY_UNVERIFIED');
    assert.equal(report.elements.verified, false); assert.equal(report.route.available, false);
    assert.equal(report.execution.enabled, false);
    const app = await startApplication({ ...env(), ELEMENTS_RPC_URL: url, ELEMENTS_COOKIE_PATH: cookie,
      DATA_DIR: join(directory, 'state'), AUTH_STORE_PATH: join(directory, 'auth.json') }, [], { port: 0 });
    try {
      const listening = app.server.address(); assert.ok(listening && typeof listening !== 'string');
      const capabilities = await (await fetch(`http://127.0.0.1:${listening.port}/v1/capabilities`)).json() as any;
      assert.equal(capabilities.readOnly, true); assert.equal(capabilities.execution.enabled, false);
      assert.equal(capabilities.rails.liquid.verified, false); assert.equal(capabilities.rails.liquid.available, false);
    } finally { await app.close(); }
    // A contradictory reported fee asset must never fall through to coinbase evidence.
    fee = other; requests.length = 0;
    await assert.rejects(attestStartup(c, { liquid: reader }), /POLICY_ASSET_MISMATCH/);
    assert.ok(!requests.includes('getblock')); assert.ok(!requests.includes('listunspent'));
    for (const method of ['sendtoaddress', 'sendrawtransaction', 'generatetoaddress', 'createwallet', 'getnewaddress'])
      await assert.rejects(reader.call(method), /READ_ONLY_MODE/);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); await rm(directory, { recursive: true, force: true }); }
});
