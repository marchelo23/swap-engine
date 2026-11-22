import { createServer } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { once } from 'node:events';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AddressInfo } from 'node:net';
import { ReadOnlyBitcoinClient } from '../src/diagnostics/ReadOnlyClients.js';
import { ElementsReadOnlyClient } from '../src/environment/ElementsReadOnlyClient.js';
import { attestStartup } from '../src/environment/StartupAttestation.js';
import { config } from '../src/config.js';
import { startApplication } from '../src/main.js';

const genesis = '0f9188f13cb7b2c71f2a335e3a4fc328bf5beb436012afca590b1a11466e2206';

async function coreMock(options: { genesis?: string; wallet?: string; chainName?: string; challenge?: string } = {}) {
  const server = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk.toString();
    const request = JSON.parse(body) as { id: string; method: string; params?: unknown[] };
    const result = request.method === 'getblockchaininfo'
      ? { chain: options.chainName ?? 'regtest', blocks: 10, bestblockhash: 'ab'.repeat(32), initialblockdownload: false }
      : request.method === 'getblockhash' ? (options.genesis ?? genesis)
      : request.method === 'listwallets' ? ['test-wallet']
      : request.method === 'getwalletinfo' ? { walletname: options.wallet ?? 'test-wallet' }
      : request.method === 'getmininginfo' ? { signet_challenge: options.challenge ?? '' }
      : null;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ result, error: null, id: request.id }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  return { server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

async function cookie(directory: string) {
  const path = join(directory, 'cookie'); await writeFile(path, 'user:password'); return path;
}
function environment(url: string, cookiePath: string, directory: string) {
  return { APP_MODE: 'regtest', DEPLOYMENT_ID: 'attestation-test', DATA_DIR: directory,
    BITCOIN_RPC_URL: url, BITCOIN_COOKIE_PATH: cookiePath, BITCOIN_WALLET: 'test-wallet' };
}

test('startup attestation verifies chain/genesis/wallet before any journal is opened', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'swap-attestation-')); const core = await coreMock();
  try {
    const cookiePath = await cookie(directory); const c = config(environment(core.url, cookiePath, directory));
    const bitcoin = new ReadOnlyBitcoinClient(core.url, cookiePath, 'test-wallet');
    const identity = await attestStartup(c, { bitcoin });
    assert.equal(identity.genesisHash, genesis); assert.equal(identity.wallet, 'test-wallet'); assert.equal(identity.verified.onchain, true);

    core.server.close(); await once(core.server, 'close');
    const wrongGenesis = await coreMock({ genesis: 'cd'.repeat(32) });
    try {
      const wrong = config(environment(wrongGenesis.url, cookiePath, directory));
      await assert.rejects(attestStartup(wrong, { bitcoin: new ReadOnlyBitcoinClient(wrongGenesis.url, cookiePath, 'test-wallet') }),
        /GENESIS_MISMATCH/);
    } finally { wrongGenesis.server.close(); }
    const wrongWallet = await coreMock({ wallet: 'other-wallet' });
    try {
      const wrong = config(environment(wrongWallet.url, cookiePath, directory));
      await assert.rejects(attestStartup(wrong, { bitcoin: new ReadOnlyBitcoinClient(wrongWallet.url, cookiePath, 'test-wallet') }),
        /WALLET_IDENTITY_MISMATCH/);
    } finally { wrongWallet.server.close(); }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('attests configured mainnet and signet profiles read-only, including the signet challenge', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'swap-attestation-net-'));
  const mainnetGenesis = '000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f';
  const signetGenesis = '00000008819873e925422c1ff0f99f7cc9bbb232af63a077a480a3633bee1ef6';
  const main = await coreMock({ chainName: 'main', genesis: mainnetGenesis });
  const signet = await coreMock({ chainName: 'signet', genesis: signetGenesis, challenge: '51' });
  try {
    const cookiePath = await cookie(directory);
    const mainConfig = config({ ...environment(main.url, cookiePath, directory), APP_ENV: 'mainnet', APP_MODE: undefined,
      DEPLOYMENT_ID: 'mainnet-attestation', SIGNET_CHALLENGE: undefined });
    const mainIdentity = await attestStartup(mainConfig, { bitcoin: new ReadOnlyBitcoinClient(main.url, cookiePath, 'test-wallet') });
    assert.equal(mainIdentity.verified.onchain, true); assert.equal(mainIdentity.genesisHash, mainnetGenesis);
    assert.equal(mainConfig.capabilities(mainIdentity.verified).execution.enabled, false);
    const signetConfig = config({ ...environment(signet.url, cookiePath, directory), APP_ENV: 'signet', APP_MODE: undefined,
      DEPLOYMENT_ID: 'signet-attestation', SIGNET_CHALLENGE: '51' });
    const signetIdentity = await attestStartup(signetConfig, { bitcoin: new ReadOnlyBitcoinClient(signet.url, cookiePath, 'test-wallet') });
    assert.equal(signetIdentity.verified.onchain, true); assert.equal(signetIdentity.genesisHash, signetGenesis);
  } finally { main.server.close(); signet.server.close(); await rm(directory, { recursive: true, force: true }); }
});

test('startApplication attests a configured mainnet profile before serving read-only capabilities', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'swap-attestation-mainnet-serve-'));
  const mainnetGenesis = '000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f';
  const core = await coreMock({ chainName: 'main', genesis: mainnetGenesis });
  try {
    const cookiePath = await cookie(directory); const data = join(directory, 'data');
    const app = await startApplication({ APP_ENV: 'mainnet', APP_MODE: undefined, DEPLOYMENT_ID: 'mainnet-serve',
      DATA_DIR: data, AUTH_STORE_PATH: join(directory, 'auth.json'), AUTH_ORIGIN: 'http://127.0.0.1:3000',
      BITCOIN_RPC_URL: core.url, BITCOIN_COOKIE_PATH: cookiePath, BITCOIN_WALLET: 'test-wallet' }, [], { port: 0 });
    try {
      const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
      const response = await fetch(`${base}/v1/capabilities`); assert.equal(response.status, 200);
      const capabilities = await response.json() as any;
      assert.equal(capabilities.environment, 'mainnet');
      assert.equal(capabilities.rails.onchain.configured, true); assert.equal(capabilities.rails.onchain.verified, true);
      assert.equal(capabilities.rails.onchain.available, true); assert.equal(capabilities.execution.enabled, false);
      assert.equal(capabilities.rails.lightning.available, false);
    } finally { await app.close(); }
  } finally { core.server.close(); await rm(directory, { recursive: true, force: true }); }
});

test('Elements read-only identity uses fee_asset/policy asset and wallet without execution', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'swap-elements-attest-'));
  const policy = 'ab'.repeat(32); const parent = 'cd'.repeat(32); const pegged = 'ef'.repeat(32); const nativeGenesis = '12'.repeat(32);
  let fee: string | undefined = policy;
  const server = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk.toString();
    const request = JSON.parse(body) as { id: string; method: string };
    const result = request.method === 'getblockhash' ? nativeGenesis
      : request.method === 'getblockchaininfo' ? { chain: 'elementsregtest' }
      : request.method === 'getsidechaininfo' ? { fee_asset: fee, pegged_asset: pegged, parent_blockhash: parent }
      : request.method === 'getwalletinfo' ? { walletname: 'liquid-wallet' } : null;
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ result, error: null, id: request.id }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  try {
    const cookiePath = await cookie(directory); const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const env = { APP_ENV: 'liquid-regtest', DEPLOYMENT_ID: 'liquid-attest', DATA_DIR: join(directory, 'data'),
      AUTH_STORE_PATH: join(directory, 'auth.json'), AUTH_ORIGIN: 'http://127.0.0.1:3000', LIQUID_ENABLED: 'true',
      LIQUID_NETWORK: 'elementsregtest', ELEMENTS_RPC_URL: url, ELEMENTS_COOKIE_PATH: cookiePath,
      ELEMENTS_WALLET: 'liquid-wallet', LIQUID_POLICY_ASSET: policy, LIQUID_PARENT_GENESIS_HASH: parent,
      LIQUID_CONFIRMATION_POLICY: 'read-only', LIQUID_GENESIS_HASH: nativeGenesis };
    const c = config(env); const identity = await attestStartup(c, { liquid: new ElementsReadOnlyClient(url, cookiePath, 'liquid-wallet') });
    assert.equal(identity.verified.liquid, true); assert.equal(identity.liquidWallet, 'liquid-wallet');
    assert.equal(identity.liquidGenesisHash, nativeGenesis); assert.equal(c.chain.genesisHash, nativeGenesis);
    assert.equal(c.capabilities(identity.verified).execution.enabled, false);
    const app = await startApplication(env, [], { port: 0 });
    try {
      const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
      const caps = await (await fetch(`${base}/v1/capabilities`)).json() as any;
      assert.equal(caps.rails.liquid.configured, true); assert.equal(caps.rails.liquid.verified, true); assert.equal(caps.rails.liquid.available, true);
      assert.equal(caps.execution.enabled, false);
    } finally { await app.close(); }
    fee = undefined;
    await assert.rejects(attestStartup(c, { liquid: new ElementsReadOnlyClient(url, cookiePath, 'liquid-wallet') }), /LIQUID_FEE_ASSET_UNAVAILABLE/);
  } finally { server.close(); await rm(directory, { recursive: true, force: true }); }
});

test('startApplication rejects a wrong Core identity before creating the journal or lock', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'swap-attestation-start-')); const core = await coreMock({ genesis: 'ef'.repeat(32) });
  try {
    const cookiePath = await cookie(directory);
    await assert.rejects(startApplication(environment(core.url, cookiePath, directory)), /GENESIS_MISMATCH/);
    assert.equal(existsSync(join(directory, 'state.json')), false);
    assert.equal(existsSync(join(directory, 'engine.lock')), false);
    assert.equal(existsSync(join(directory, '.environment.json')), false);
  } finally { core.server.close(); await rm(directory, { recursive: true, force: true }); }
});
