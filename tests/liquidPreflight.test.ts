import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:http';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { config } from '../src/config.js';
import { liquidPreflight } from '../src/liquid/preflight.js';
import { ElementsReadOnlyClient } from '../src/environment/ElementsReadOnlyClient.js';

const genesis = 'ab'.repeat(32); const policy = 'cd'.repeat(32);
const parent = '0f9188f13cb7b2c71f2a335e3a4fc328bf5beb436012afca590b1a11466e2206';
const env = (): NodeJS.ProcessEnv => ({ APP_ENV: 'liquid-regtest', DEPLOYMENT_ID: 'liquid-test',
  SPEND_POLICY: 'disabled', LIQUID_NETWORK: 'elementsregtest', ELEMENTS_RPC_URL: 'http://127.0.0.1:7042',
  ELEMENTS_COOKIE_PATH: resolve('unused.cookie'), ELEMENTS_WALLET: 'liquid-test',
  LIQUID_POLICY_ASSET: policy, LIQUID_PARENT_GENESIS_HASH: parent, LIQUID_GENESIS_HASH: genesis,
  REVERSE_SWAP_ENABLED: 'false', BITCOIN_RPC_URL: 'http://127.0.0.1:18443',
  BITCOIN_COOKIE_PATH: resolve('unused-core.cookie'), BITCOIN_WALLET: 'core-test' });

// Fixtures only; these responses are NOT evidence of a deployed Elements/Boltz lab.
function readers(overrides: Record<string, unknown> = {}) {
  const calls: string[] = [];
  const data: Record<string, unknown> = { getnetworkinfo: { version: 230304 },
    getblockchaininfo: { chain: 'elementsregtest', blocks: 20, bestblockhash: genesis, initialblockdownload: false },
    getblockhash: genesis, getsidechaininfo: { fee_asset: policy, pegged_asset: policy, parent_blockhash: parent },
    getwalletinfo: { walletname: 'liquid-test' }, ...overrides };
  const elements = { origin: 'http://127.0.0.1:7042', async call<T>(method: string): Promise<T> {
    calls.push(method); return data[method] as T;
  } };
  const bitcoin = { origin: 'http://127.0.0.1:18443', async call<T>(method: string): Promise<T> {
    calls.push(`btc:${method}`);
    return ({ getblockchaininfo: { chain: 'regtest', blocks: 20, bestblockhash: genesis, initialblockdownload: false },
      getblockhash: parent, getwalletinfo: { walletname: 'core-test' } } as Record<string, unknown>)[method] as T;
  } };
  return { elements, bitcoin, calls };
}

test('OFFLINE: verified chain fixtures never attest a provider or enable any execution', async () => {
  const c = config(env()); const ports = readers();
  const report = await liquidPreflight(c, ports);
  assert.equal(report.elements.verified, true); assert.equal(report.bitcoin.verified, true);
  assert.equal(report.route.available, false); assert.equal(report.route.provider.attested, false);
  assert.equal(report.route.lightningFallback, 'disabled'); assert.equal(report.execution.enabled, false);
  assert.deepEqual(ports.calls, ['getnetworkinfo', 'getblockchaininfo', 'getblockhash', 'getsidechaininfo',
    'getwalletinfo', 'btc:getblockchaininfo', 'btc:getblockhash', 'btc:getwalletinfo']);
  assert.equal(c.capabilities().execution.enabled, false);
});

test('OFFLINE: stock Elements shape without fee_asset is explicitly unsupported', async () => {
  const report = await liquidPreflight(config(env()), readers({
    getsidechaininfo: { pegged_asset: policy, parent_blockhash: parent } }));
  assert.equal(report.elements.version, 230304);
  assert.equal(report.elements.feeAssetReported, false);
  assert.equal(report.elements.reason, 'LIQUID_FEE_ASSET_UNAVAILABLE');
  assert.equal(report.elements.verified, false); assert.equal(report.route.available, false);
});

test('OFFLINE: chain, genesis, wallet, policy, pegged asset and parent mismatches fail closed', async () => {
  for (const overrides of [
    { getblockhash: 'ef'.repeat(32) }, { getwalletinfo: { walletname: 'other' } },
    { getsidechaininfo: { fee_asset: 'ef'.repeat(32), pegged_asset: policy, parent_blockhash: parent } },
    { getsidechaininfo: { fee_asset: policy, pegged_asset: 'ef'.repeat(32), parent_blockhash: parent } },
    { getsidechaininfo: { fee_asset: policy, pegged_asset: policy, parent_blockhash: 'ef'.repeat(32) } },
    { getblockchaininfo: { chain: 'liquidv1', blocks: 20, bestblockhash: genesis, initialblockdownload: false } },
    { getblockchaininfo: { chain: 'elementsregtest', blocks: 20, bestblockhash: genesis, initialblockdownload: true } },
  ]) {
    const report = await liquidPreflight(config(env()), readers(overrides));
    assert.equal(report.elements.verified, false); assert.equal(report.route.available, false);
  }
});

test('OFFLINE: missing genesis pin and reader-origin mismatch are rejected before Elements I/O', async () => {
  const noPin = env(); delete noPin.LIQUID_GENESIS_HASH;
  const ports = readers();
  assert.equal((await liquidPreflight(config(noPin), ports)).elements.reason, 'LIQUID_GENESIS_PIN_REQUIRED');
  assert.ok(ports.calls.every(call => call.startsWith('btc:')));
  const mismatch = readers(); mismatch.elements.origin = 'http://127.0.0.1:17042';
  assert.equal((await liquidPreflight(config(env()), mismatch)).elements.reason, 'ELEMENTS_READER_MISMATCH');
});

test('OFFLINE: diagnostic rejects other environments before I/O and never discloses RPC errors', async () => {
  const ports = readers();
  await assert.rejects(liquidPreflight(config({ APP_ENV: 'simulation' }), ports), /READ_ONLY_PROFILE_REQUIRED/);
  assert.deepEqual(ports.calls, []);
  ports.elements.call = async () => { throw new Error('credential-and-private-path'); };
  const report = await liquidPreflight(config(env()), ports);
  assert.equal(report.elements.reason, 'ELEMENTS_PROBE_FAILED');
  assert.ok(!JSON.stringify(report).includes('credential-and-private-path'));
});

test('OFFLINE: CLI loads a real env file and exits unavailable without node configuration', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'liquid-profile-'));
  try {
    const profile = join(directory, '.env');
    await writeFile(profile, 'APP_ENV=liquid-regtest\nDEPLOYMENT_ID=profile-test\nSPEND_POLICY=disabled\nREVERSE_SWAP_ENABLED=false\n');
    const result = spawnSync(process.execPath, [`--env-file=${profile}`, '--import', 'tsx', 'scripts/liquid-preflight.ts'], {
      cwd: fileURLToPath(new URL('../', import.meta.url)), encoding: 'utf8', timeout: 15_000,
      env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot },
    });
    assert.equal(result.error, undefined); assert.equal(result.status, 2, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.deploymentId, 'profile-test'); assert.equal(report.elements.reason, 'NOT_CONFIGURED');
    assert.equal(report.bitcoin.reason, 'NOT_CONFIGURED'); assert.equal(report.route.available, false);
    assert.equal(report.execution.enabled, false);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('OFFLINE: Elements transport allows version read, blocks mutations and refuses redirects', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'elements-reader-')); const requests: string[] = [];
  let redirect = false;
  const server = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    const request = JSON.parse(body); requests.push(request.method);
    if (redirect) { res.writeHead(302, { location: 'http://127.0.0.1:1/' }); res.end(); return; }
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ result: { version: 230304 }, error: null }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const cookie = join(directory, '.cookie'); await writeFile(cookie, 'fixture:only');
    const address = server.address(); assert.ok(address && typeof address !== 'string');
    const reader = new ElementsReadOnlyClient(`http://127.0.0.1:${address.port}`, cookie, 'fixture');
    assert.deepEqual(await reader.call('getnetworkinfo'), { version: 230304 });
    for (const method of ['sendtoaddress', 'sendrawtransaction', 'getnewaddress', 'generatetoaddress', 'createwallet', 'signrawtransactionwithwallet'])
      await assert.rejects(reader.call(method), /READ_ONLY_MODE/);
    assert.deepEqual(requests, ['getnetworkinfo']);
    redirect = true; await assert.rejects(reader.call('getnetworkinfo'));
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); await rm(directory, { recursive: true, force: true }); }
});
