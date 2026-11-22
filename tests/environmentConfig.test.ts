import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createApi } from '../src/api/server.js';
import { CapabilitiesResponse } from '../src/api/schemas.js';
import { config } from '../src/config.js';
import { setup } from './helpers.js';

const base = {
  APP_MODE: 'regtest', DEPLOYMENT_ID: 'lab-a',
  BITCOIN_RPC_URL: 'http://127.0.0.1:18443', BITCOIN_COOKIE_PATH: '/var/lib/bitcoin/regtest/.cookie',
  BITCOIN_WALLET: 'lab-wallet', LND_REST_URL: 'https://127.0.0.1:8080',
  LND_TLS_CERT_PATH: '/var/lib/lnd/tls.cert', LND_MACAROON_PATH: '/var/lib/lnd/readonly.macaroon',
  ALICE_LND_REST_URL: 'https://127.0.0.1:8081', ALICE_LND_TLS_CERT_PATH: '/var/lib/alice/tls.cert',
  ALICE_LND_MACAROON_PATH: '/var/lib/alice/readonly.macaroon',
};
const env = (values: Record<string, string>): NodeJS.ProcessEnv => values as NodeJS.ProcessEnv;

test('environment config is explicit, strict, legacy-compatible and has no lab defaults', () => {
  const simulation = config({});
  assert.equal(simulation.environment, 'simulation'); assert.equal(simulation.mode, 'simulation');
  assert.equal(simulation.deploymentId, null); assert.equal(simulation.spendPolicy, 'disabled');
  assert.deepEqual(simulation.rails.onchain, { enabled: false });
  assert.equal(simulation.capabilities().rails.onchain.configured, false);
  assert.throws(() => config(env({ APP_MODE: 'regtest' })), /DEPLOYMENT_ID_REQUIRED/);
  const configured = config(env(base));
  assert.equal(configured.environment, 'regtest'); assert.equal(configured.mode, 'regtest');
  assert.equal(configured.rails.onchain.enabled, true); assert.equal(configured.rails.lightning.enabled, true);
  assert.equal(configured.rails.lightning.alice?.url, 'https://127.0.0.1:8081');
  const capabilities = configured.capabilities();
  assert.equal(capabilities.rails.onchain.configured, true);
  assert.equal(capabilities.rails.onchain.verified, false);
  assert.equal(capabilities.rails.onchain.available, false);
  assert.equal(capabilities.rails.onchain.reason, 'NOT_VERIFIED');
  assert.equal(capabilities.execution.enabled, false);
  const verified = configured.capabilities({ onchain: true, lightning: true });
  assert.equal(verified.rails.onchain.configured, true); assert.equal(verified.rails.onchain.verified, true);
  assert.equal(verified.rails.onchain.available, true); assert.equal(verified.rails.onchain.reason, null);
  assert.equal(verified.execution.enabled, false);
  assert.equal(configured.capabilities({ onchain: true }).rails.lightning.available, false);
  CapabilitiesResponse.parse(capabilities);
  assert.throws(() => config(env({ ...base, BITCOIN_COOKIE_PATH: 'relative.cookie' })), /BITCOIN_RAIL_CONFIGURATION_INVALID/);
  assert.throws(() => config(env({ ...base, LND_TLS_CERT_PATH: 'relative.cert' })), /LND_PROVIDER_CONFIGURATION_INVALID/);
  assert.throws(() => config(env({ ...base, DEPLOYMENT_ID: 'bad/deployment' })), /DEPLOYMENT_ID_INVALID/);
});

test('mainnet and signet remain read-only with zero execution and explicit spend policy', () => {
  const mainnet = config(env({ APP_ENV: 'mainnet', DEPLOYMENT_ID: 'mainnet-readonly' }));
  assert.equal(mainnet.environment, 'mainnet'); assert.equal(mainnet.mode, 'simulation');
  assert.equal(mainnet.chain.kind, 'bitcoin'); assert.equal(mainnet.chain.name, 'mainnet');
  assert.equal(mainnet.chain.genesisHash, '000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f');
  assert.equal(mainnet.capabilities().execution.enabled, false);
  assert.throws(() => config(env({ APP_ENV: 'mainnet', DEPLOYMENT_ID: 'x', SPEND_POLICY: 'regtest-only' })), /SPEND_POLICY_REGTEST_ONLY/);
  for (const flag of ['ENABLE_MAINNET_EXECUTION', 'ALLOW_MAINNET_EXECUTION', 'ALLOW_MAINNET_SIGNING', 'ALLOW_MAINNET_MINING'])
    assert.throws(() => config(env({ APP_ENV: 'mainnet', DEPLOYMENT_ID: 'x', [flag]: 'true' })), /MAINNET_EXECUTION_FORBIDDEN/);
  assert.throws(() => config(env({ APP_ENV: 'signet', DEPLOYMENT_ID: 'signet-readonly' })), /SIGNET_CHALLENGE_REQUIRED/);
  const signet = config(env({ APP_ENV: 'signet', DEPLOYMENT_ID: 'signet-readonly',
    SIGNET_CHALLENGE: '512103'.padEnd(160, '0') }));
  assert.equal(signet.environment, 'signet'); assert.equal(signet.mode, 'simulation'); assert.equal(signet.spendPolicy, 'disabled');
  const regtestSpend = config(env({ ...base, SPEND_POLICY: 'regtest-only' }));
  assert.equal(regtestSpend.spendPolicy, 'regtest-only');
  assert.equal(regtestSpend.capabilities().execution.enabled, false);
  assert.throws(() => config(env({ ...base, SPEND_POLICY: 'mainnet' })), /SPEND_POLICY_INVALID/);
});

test('Ark and Liquid expose canonical config and read-only identity contracts without execution', () => {
  const arkEnv = { APP_ENV: 'ark-regtest', DEPLOYMENT_ID: 'ark-lab', ARK_NETWORK: 'regtest',
    ARK_EXECUTION_ENABLED: 'false', ARK_OPERATOR_URL: 'http://127.0.0.1:37070/v1/info',
    ARK_EXPECTED_SIGNER_PUBKEY: '02' + '11'.repeat(32), ARK_LAB_ROOT: '/var/lib/ark',
    ARK_CLI_PATH: '/var/lib/ark/ark-lab', ARK_STORE_PATH: '/var/lib/ark/store.json', ARK_CONFIRMATION_POLICY: 'read-only' };
  const ark = config(env(arkEnv));
  assert.equal(ark.chain.kind, 'ark'); assert.equal(ark.rails.ark.enabled, true);
  assert.equal(ark.capabilities().rails.ark.configured, true);
  assert.equal(ark.capabilities().rails.ark.available, false);
  assert.throws(() => config(env({ ...base, ARK_ENABLED: 'true' })), /ARK_NETWORK_REQUIRED/);
  assert.throws(() => config(env({ ...arkEnv, ARK_EXECUTION_ENABLED: 'true' })), /ARK_EXECUTION_FORBIDDEN/);
  assert.throws(() => config(env({ ...base, ARK_ENABLED: 'yes' })), /ARK_ENABLED_INVALID/);
  assert.throws(() => config(env({ ...arkEnv, ARK_OPERATOR_INFO_URL: 'http://127.0.0.1:9/v1/info' })), /ARK_OPERATOR_URL_CONFLICT/);

  const policyAsset = 'ab'.repeat(32); const parent = 'cd'.repeat(32);
  const liquidEnv = { APP_ENV: 'liquid-regtest', DEPLOYMENT_ID: 'liquid-lab', LIQUID_NETWORK: 'elementsregtest',
    ELEMENTS_RPC_URL: 'http://127.0.0.1:7042', ELEMENTS_COOKIE_PATH: '/var/lib/liquid/.cookie',
    ELEMENTS_WALLET: 'liquid-wallet', LIQUID_POLICY_ASSET: policyAsset,
    LIQUID_PARENT_GENESIS_HASH: parent, LIQUID_CONFIRMATION_POLICY: 'read-only' };
  const liquid = config(env(liquidEnv));
  assert.equal(liquid.chain.kind, 'liquid'); assert.equal(liquid.rails.liquid.enabled, true);
  assert.equal(liquid.rails.liquid.enabled && liquid.rails.liquid.policyAsset, policyAsset);
  assert.equal(liquid.capabilities().rails.liquid.available, false);
  assert.throws(() => config(env({ ...liquidEnv, LIQUID_NETWORK: 'liquidv1' })), /LIQUID_CONFIGURATION_INVALID/);
  assert.throws(() => config(env({ ...liquidEnv, LIQUID_RPC_URL: 'http://127.0.0.1:9999' })), /ELEMENTS_RPC_URL_CONFLICT/);
  assert.throws(() => config(env({ ...liquidEnv, APP_MODE: 'regtest' })), /APP_ENVIRONMENT_CONFLICT/);
});

test('all shipped profiles load as real multiline env files', async () => {
  const parse = (text: string): Record<string, string> => Object.fromEntries(text.split(/\r?\n/).map(line => line.trim())
    .filter(line => line && !line.startsWith('#')).map(line => { const at = line.indexOf('='); return [line.slice(0, at), line.slice(at + 1)]; }));
  const signer = '02' + '11'.repeat(32); const policy = 'ab'.repeat(32); const parent = 'cd'.repeat(32);
  const cases: Array<[string, string, Record<string, string>]> = [
    ['.env.regtest.example', 'regtest', {}],
    ['.env.signet.example', 'signet', { SIGNET_CHALLENGE: '51' + '00'.repeat(30) }],
    ['.env.mainnet.example', 'mainnet', {}],
    ['.env.ark.regtest.example', 'ark-regtest', { ARK_EXPECTED_SIGNER_PUBKEY: signer }],
    ['.env.liquid.regtest.example', 'liquid-regtest', { LIQUID_POLICY_ASSET: policy, LIQUID_PARENT_GENESIS_HASH: parent }],
  ];
  for (const [file, expected, overrides] of cases) {
    const text = await readFile(file, 'utf8');
    assert.equal(text.includes('\\n'), false, file);
    const values: Record<string, string> = { ...parse(text), DEPLOYMENT_ID: `test-${expected}`, ...overrides };
    assert.equal(values.APP_ENV, expected, file);
    assert.equal(config(values).environment, expected, file);
  }
});

test('public capabilities endpoint is read-only and never infers availability from flags alone', async () => {
  const f = await setup();
  try {
    const c = config(env(base));
    const server = createApi(f.manager, async () => ({ onchainSats: 1, incomingSats: 1 }), undefined, 'regtest',
      { capabilities: () => c.capabilities() });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    try {
      const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const response = await fetch(`${baseUrl}/v1/capabilities`);
      assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
      const body = CapabilitiesResponse.parse(await response.json());
      assert.equal(body.readOnly, true); assert.equal(body.execution.enabled, false);
      assert.equal(body.rails.onchain.available, false);
      assert.equal((await fetch(`${baseUrl}/v1/capabilities?x=1`)).status, 404);
    } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
  } finally { await f.cleanup(); }
});
