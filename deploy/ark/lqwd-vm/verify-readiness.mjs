#!/usr/bin/env node

function flag(name, fallback) {
  const index = process.argv.indexOf(name);
  if (index === -1) return fallback;
  const value = process.argv[index + 1];
  if (value === undefined || value.startsWith('--')) throw new Error(`${name} requires a value`);
  return value;
}

function loopback(value, label) {
  const url = new URL(value);
  if (url.protocol !== 'http:') throw new Error(`${label} must use http`);
  if (url.hostname !== '127.0.0.1') throw new Error(`${label} must be 127.0.0.1`);
  if (url.pathname !== '/' || url.search || url.hash || url.username || url.password) {
    throw new Error(`${label} must be an origin only`);
  }
  return url.origin;
}

async function getJson(url) {
  const response = await fetch(url, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(5000),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${url} returned ${response.status}: ${text.slice(0, 200)}`);
  return JSON.parse(text);
}

async function getText(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
  const text = (await response.text()).trim();
  if (!response.ok) throw new Error(`${url} returned ${response.status}: ${text.slice(0, 200)}`);
  return text;
}

const expectedHeight = Number(flag('--expected-height', process.env.ARK_EXPECTED_HEIGHT));
const expectedHash = flag('--expected-hash', process.env.ARK_EXPECTED_HASH);
const expectedSigner = flag('--expected-signer', process.env.ARK_EXPECTED_SIGNER);
const expectedDust = flag('--expected-dust', process.env.ARK_EXPECTED_DUST);
const forfeitPrefix = flag('--forfeit-prefix', process.env.ARK_FORFEIT_PREFIX ?? 'bcrt1');

if (!Number.isInteger(expectedHeight) || expectedHeight < 0) throw new Error('expected height is required');
if (!/^[0-9a-f]{64}$/.test(expectedHash ?? '')) throw new Error('expected hash must be 64 lowercase hex characters');
if (!/^0[23][0-9a-f]{64}$/.test(expectedSigner ?? '')) throw new Error('expected signer must be a compressed pubkey');

const arkBase = loopback(flag('--ark', process.env.ARK_URL ?? 'http://127.0.0.1:37170'), 'ark');
const mempoolBase = loopback(flag('--mempool', process.env.ARK_MEMPOOL_URL ?? 'http://127.0.0.1:33100'), 'mempool');
const nbxBase = loopback(flag('--nbx', process.env.ARK_NBX_URL ?? 'http://127.0.0.1:32938'), 'nbxplorer');

const [info, mempoolHeightText, mempoolHash, nbx] = await Promise.all([
  getJson(`${arkBase}/v1/info`),
  getText(`${mempoolBase}/api/blocks/tip/height`),
  getText(`${mempoolBase}/api/blocks/tip/hash`),
  getJson(`${nbxBase}/v1/cryptos/BTC/status`),
]);

const observed = {
  ark: {
    network: info.network,
    signerPubkey: info.signerPubkey,
    forfeitAddress: info.forfeitAddress,
    dust: info.dust,
  },
  mempool: { height: Number(mempoolHeightText), hash: mempoolHash },
  nbxplorer: {
    networkType: nbx.networkType,
    isFullySynched: nbx.isFullySynched,
    syncHeight: nbx.syncHeight,
    chainHeight: nbx.chainHeight,
  },
};

const failures = [];
if (info.network !== 'regtest') failures.push('ARK_NETWORK_MISMATCH');
if (info.signerPubkey !== expectedSigner) failures.push('ARK_SIGNER_MISMATCH');
if (!String(info.forfeitAddress ?? '').startsWith(forfeitPrefix)) failures.push('ARK_FORFEIT_ADDRESS_MISMATCH');
if (expectedDust !== undefined) {
  if (String(info.dust) !== String(expectedDust)) failures.push('ARK_DUST_MISMATCH');
} else if (!/^\d+$/.test(String(info.dust ?? ''))) {
  failures.push('ARK_DUST_UNKNOWN');
}
if (observed.mempool.height !== expectedHeight) failures.push('ESPLORA_HEIGHT_MISMATCH');
if (observed.mempool.hash !== expectedHash) failures.push('ESPLORA_HASH_MISMATCH');
if (nbx.isFullySynched !== true) failures.push('NBX_NOT_FULLY_SYNCHED');
if (nbx.syncHeight !== expectedHeight) failures.push('NBX_SYNC_HEIGHT_MISMATCH');
if (nbx.chainHeight !== expectedHeight) failures.push('NBX_CHAIN_HEIGHT_MISMATCH');
if (nbx.networkType !== 'Regtest') failures.push('NBX_NETWORK_MISMATCH');

const report = {
  status: failures.length === 0 ? 'passed' : 'failed',
  expected: {
    height: expectedHeight,
    hash: expectedHash,
    signerPubkey: expectedSigner,
    forfeitPrefix,
    dust: expectedDust ?? 'any-integer',
  },
  observed,
  failures,
};

console.log(JSON.stringify(report, null, 2));
if (failures.length > 0) process.exitCode = 1;
