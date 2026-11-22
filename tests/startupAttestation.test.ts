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
import { attestStartup } from '../src/environment/StartupAttestation.js';
import { config } from '../src/config.js';
import { startApplication } from '../src/main.js';

const genesis = '0f9188f13cb7b2c71f2a335e3a4fc328bf5beb436012afca590b1a11466e2206';

async function coreMock(options: { genesis?: string; wallet?: string } = {}) {
  const server = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk.toString();
    const request = JSON.parse(body) as { id: string; method: string; params?: unknown[] };
    const result = request.method === 'getblockchaininfo'
      ? { chain: 'regtest', blocks: 10, bestblockhash: 'ab'.repeat(32), initialblockdownload: false }
      : request.method === 'getblockhash' ? (options.genesis ?? genesis)
      : request.method === 'listwallets' ? ['test-wallet']
      : request.method === 'getwalletinfo' ? { walletname: options.wallet ?? 'test-wallet' }
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
