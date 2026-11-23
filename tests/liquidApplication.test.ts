import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { provisionAccount } from '../scripts/provision-auth.js';
import { startApplication } from '../src/main.js';

const policy = 'b2e15d0d7a0c94e4e2ce0fe6e8691b9e451377f6e46e8045a86f7c4b5d4f0f23';
const parent = '0f9188f13cb7b2c71f2a335e3a4fc328bf5beb436012afca590b1a11466e2206';
const genesis = '209577bda6bf4b5804bd46f8621580dd6d4e8bfa2d190e1c50e932492baca07d';
const wallet = 'lqwd-liquid-ops';
const blockHash = 'b'.repeat(64);
const txid = 'a'.repeat(64);
const utxo = { txid, vout: 1, asset: policy, amount: 21, confirmations: 1, spendable: true, safe: true,
  scriptPubKey: '51' };
const coinbase = { txid, vin: [{ coinbase: '00' }],
  vout: [{ n: 0, asset: policy, value: 21, scriptPubKey: { hex: '51' } }] };

async function fakeElements() {
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const request = JSON.parse(body) as { id: string; method: string; params?: unknown[] };
    const result = request.method === 'getblockchaininfo'
      ? { chain: 'elementsregtest', blocks: 2, headers: 2, bestblockhash: blockHash,
        initialblockdownload: false }
      : request.method === 'getblockhash'
        ? request.params?.[0] === 0 ? genesis : blockHash
        : request.method === 'getsidechaininfo'
          ? { pegged_asset: policy, parent_blockhash: parent }
          : request.method === 'getwalletinfo'
            ? { walletname: wallet }
            : request.method === 'listunspent'
              ? [utxo]
              : request.method === 'getblock'
                ? { hash: blockHash, height: 2, confirmations: 1, tx: [coinbase] }
                : null;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ id: request.id, result, error: null }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/` };
}

test('real Liquid-only startup serves attested wallet balances and the gated Lightning route', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'liquid-app-'));
  const cookie = join(directory, '.cookie');
  const authStore = join(directory, 'users.json');
  const password = randomBytes(24).toString('base64url');
  const elements = await fakeElements();
  let app: Awaited<ReturnType<typeof startApplication>> | undefined;
  t.after(async () => {
    await app?.close().catch(() => {});
    await new Promise<void>((resolve, reject) => elements.server.close(error => error ? reject(error) : resolve()));
    await rm(directory, { recursive: true, force: true });
  });
  await writeFile(cookie, 'fixture:only');
  await provisionAccount(authStore, 'operator', 'ADMIN', password);
  const started = await startApplication({
    APP_ENV: 'liquid-regtest', DEPLOYMENT_ID: 'liquid-app-test', PORT: '3400',
    DATA_DIR: join(directory, 'state'), AUTH_STORE_PATH: authStore,
    SPEND_POLICY: 'disabled', LIQUID_NETWORK: 'elementsregtest', LIQUID_EXECUTION_ENABLED: 'false',
    ELEMENTS_RPC_URL: elements.url, ELEMENTS_COOKIE_PATH: cookie, ELEMENTS_WALLET: wallet,
    LIQUID_POLICY_ASSET: policy, LIQUID_PARENT_GENESIS_HASH: parent, LIQUID_GENESIS_HASH: genesis,
    LIQUID_CONFIRMATION_POLICY: 'read-only', ENABLE_LIVE_SWAPS: 'false', REVERSE_SWAP_ENABLED: 'false',
    GUEST_SWAP_ENABLED: 'false', FORWARD_SWAP_ENABLED: 'false', REGTEST_AUTO_MINING: 'false',
  }, [], { port: 0 });
  app = started;
  const base = `http://127.0.0.1:${(started.server.address() as AddressInfo).port}`;
  const login = await fetch(`${base}/v1/auth/login`, { method: 'POST',
    headers: { 'content-type': 'application/json', origin: base },
    body: JSON.stringify({ username: 'operator', password }) });
  assert.equal(login.status, 200);
  const cookieHeader = login.headers.get('set-cookie')!.split(';')[0]!;

  const balances = await fetch(`${base}/v1/operations/balances`, { headers: { cookie: cookieHeader } });
  assert.equal(balances.status, 200);
  const report = await balances.json() as { liquid?: Record<string, unknown>; rails: Array<Record<string, unknown>> };
  assert.deepEqual(report.liquid, { wallet, chain: 'elementsregtest', height: 2, genesisHash: genesis,
    assetId: policy, confirmedBaseUnits: 2_100_000_000, unconfirmedBaseUnits: 0,
    spendableBaseUnits: 2_100_000_000, utxoCount: 1,
    assetEvidence: 'confirmed-wallet-and-coinbase', feePolicyVerified: false, readOnly: true });
  assert.deepEqual(report.rails.find(item => item.rail === 'liquid'), {
    rail: 'liquid', account: 'operator', status: 'available', reason: null,
    balances: { assetId: policy, confirmedBaseUnits: 2_100_000_000, unconfirmedBaseUnits: 0,
      spendableBaseUnits: 2_100_000_000, utxoCount: 1 } });

  const route = await fetch(`${base}/v1/liquid/lightning/availability`,
    { headers: { cookie: cookieHeader } });
  assert.equal(route.status, 200);
  assert.deepEqual(await route.json(), { route: 'liquid-to-lightning', available: false,
    executionEnabled: false, reason: 'LIQUID_LIGHTNING_ATOMIC_ADAPTER_UNAVAILABLE',
    atomicAdapterInstalled: false, invoiceValidationAvailable: false, recoveryAvailable: false,
    refundAvailable: false });
});
