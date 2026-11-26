#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { createECDH, createHmac, randomBytes, randomUUID, scrypt } from 'node:crypto';
import { constants, existsSync, readFileSync } from 'node:fs';
import { chmod, copyFile, lstat, mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { request as httpsRequest } from 'node:https';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { runArkLabCli } from './ark-lab-cli.mjs';

const runExecFile = promisify(execFile);

export const BITCOIN_REGTEST_GENESIS = '0f9188f13cb7b2c71f2a335e3a4fc328bf5beb436012afca590b1a11466e2206';
export const DEFAULT_RUNTIME_DIR = join(homedir(), '.local/share/swap-engine-iso-regtest');
const ARK_LAB_VTXO_TREE_EXPIRY = '480';
export const DEFAULT_POLICY_ASSET_PLACEHOLDER = 'b2e15d0d7a0c94e4e2ce0fe6e8691b9e451377f6e46e8045a86f7c4b5d4f0f23';
export const DEFAULT_ELEMENTS_GENESIS_PLACEHOLDER = '209577bda6bf4b5804bd46f8621580dd6d4e8bfa2d190e1c50e932492baca07d';

const THIS_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(THIS_DIR, '../..');
const COMPOSE_FILE = join(THIS_DIR, 'docker-compose.yml');
const ARK_CLI_SOURCE = join(THIS_DIR, 'ark-lab-cli.mjs');
const SIGNER_PUBKEY_SCRIPT = join(REPO_ROOT, 'deploy/ark/lqwd-vm/signer-pubkey.mjs');

export function buildRpcAuthEntry(user, password, saltHex = randomBytes(16).toString('hex')) {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(user)) throw new Error('Invalid RPC username');
  if (!/^[0-9a-f]{32}$/.test(saltHex)) throw new Error('Invalid RPC salt');
  const digest = createHmac('sha256', saltHex).update(password, 'utf8').digest('hex');
  return `${user}:${saltHex}$${digest}`;
}

export async function deriveSignerPubkey(signerKeyHex) {
  if (!/^[0-9a-f]{64}$/.test(signerKeyHex)) {
    throw new Error('Signer key must be 64 lowercase hex characters');
  }
  if (existsSync(SIGNER_PUBKEY_SCRIPT)) {
    const { stdout } = await runExecFile(process.execPath, [SIGNER_PUBKEY_SCRIPT, signerKeyHex], {
      timeout: 5_000,
    });
    const pubkey = String(stdout).trim();
    if (/^(02|03)[0-9a-f]{64}$/.test(pubkey)) return pubkey;
  }
  const ecdh = createECDH('secp256k1');
  ecdh.setPrivateKey(Buffer.from(signerKeyHex, 'hex'));
  return ecdh.getPublicKey('hex', 'compressed');
}

async function ensureSecureDir(dirPath) {
  await mkdir(dirPath, { recursive: true, mode: 0o700 });
  const stat = await lstat(dirPath);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`Unsafe directory path: ${dirPath}`);
  }
  await chmod(dirPath, 0o700);
}

async function writeSecureFile(filePath, content, mode = 0o600) {
  await ensureSecureDir(dirname(filePath));
  try {
    const existing = await lstat(filePath);
    if (existing.isSymbolicLink() || !existing.isFile()) {
      throw new Error(`Refusing to overwrite non-regular file: ${filePath}`);
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  const tempPath = `${filePath}.${randomUUID()}.tmp`;
  const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | (constants.O_NOFOLLOW ?? 0);
  const handle = await open(tempPath, flags, mode);
  try {
    await handle.writeFile(content, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  await chmod(tempPath, mode);
  await rename(tempPath, filePath);
}

async function readOrCreateSecret(filePath, generator = () => randomBytes(32).toString('hex')) {
  try {
    const stat = await lstat(filePath);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new Error(`Unsafe secret file: ${filePath}`);
    }
    const value = (await readFile(filePath, 'utf8')).trim();
    if (value.length >= 16) {
      await chmod(filePath, 0o600);
      return value;
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  const generated = generator();
  await writeSecureFile(filePath, `${generated}\n`, 0o600);
  return generated;
}

function hashScryptPassword(password) {
  const salt = randomBytes(16);
  const options = { N: 32_768, r: 8, p: 3, maxmem: 48 * 1024 * 1024 };
  return new Promise((resolvePromise, rejectPromise) => {
    scrypt(password, salt, 32, options, (err, key) => {
      if (err) rejectPromise(err);
      else resolvePromise(`scrypt-v1$${salt.toString('hex')}$${key.toString('hex')}`);
    });
  });
}

export async function provisionLocalAccount(storePath, username, role, password) {
  try {
    const mod = await import('../../scripts/provision-auth.ts');
    if (typeof mod.provisionAccount === 'function') {
      await mod.provisionAccount(storePath, username, role, password).catch(err => {
        if (!/already exists/i.test(String(err?.message ?? err))) throw err;
      });
      return;
    }
  } catch {
    // Fallback when running under plain Node without tsx loader
  }
  await ensureSecureDir(dirname(storePath));
  let users = [];
  if (existsSync(storePath)) {
    const stat = await lstat(storePath);
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('Invalid auth store file');
    const parsed = JSON.parse(await readFile(storePath, 'utf8'));
    users = Array.isArray(parsed?.users) ? parsed.users : [];
  }
  if (users.some(u => String(u.username).toLowerCase() === username.toLowerCase())) {
    return;
  }
  const passwordHash = await hashScryptPassword(password);
  users.push({
    id: randomUUID(),
    username,
    role,
    passwordHash,
  });
  await writeSecureFile(storePath, `${JSON.stringify({ version: 1, users }, null, 2)}\n`, 0o600);
}

export function buildLocalEnvProfiles(options) {
  const runtimeDir = resolve(options.runtimeDir ?? DEFAULT_RUNTIME_DIR);
  const signerPubkey = options.expectedSignerPubkey;
  const liquidPolicyAsset = (options.liquidPolicyAsset ?? DEFAULT_POLICY_ASSET_PLACEHOLDER).toLowerCase();
  const liquidGenesisHash = (options.liquidGenesisHash ?? DEFAULT_ELEMENTS_GENESIS_PLACEHOLDER).toLowerCase();
  const bitcoinGenesis = BITCOIN_REGTEST_GENESIS;

  const authStorePath = join(runtimeDir, 'auth/users.json');
  const bitcoinCookiePath = join(runtimeDir, 'bitcoin/regtest/.cookie');
  const elementsCookiePath = join(runtimeDir, 'elements/elementsregtest/.cookie');
  const providerCertPath = join(runtimeDir, 'lnd-provider/tls.cert');
  const providerMacaroonPath = join(runtimeDir, 'lnd-provider/data/chain/bitcoin/regtest/readonly.macaroon');
  const aliceCertPath = join(runtimeDir, 'lnd-alice/tls.cert');
  const aliceMacaroonPath = join(runtimeDir, 'lnd-alice/data/chain/bitcoin/regtest/readonly.macaroon');
  const arkLabRoot = join(runtimeDir, 'ark');
  const arkCliPath = join(runtimeDir, 'ark/ark-lab');
  const arkStorePath = join(runtimeDir, 'ark/ark-swaps.json');

  const regtestEnv = [
    'APP_ENV=regtest',
    'DEPLOYMENT_ID=iso-regtest-lab',
    'PORT=43000',
    `DATA_DIR=${join(runtimeDir, 'state/regtest')}`,
    'SPEND_POLICY=disabled',
    'ENABLE_LIVE_SWAPS=false',
    `AUTH_STORE_PATH=${authStorePath}`,
    'AUTH_ORIGIN=http://127.0.0.1:43000',
    'BITCOIN_RPC_URL=http://127.0.0.1:48443',
    `BITCOIN_COOKIE_PATH=${bitcoinCookiePath}`,
    'BITCOIN_WALLET=iso-core-lab',
    'LND_REST_URL=https://127.0.0.1:48080',
    `LND_TLS_CERT_PATH=${providerCertPath}`,
    `LND_MACAROON_PATH=${providerMacaroonPath}`,
    'ALICE_LND_REST_URL=https://127.0.0.1:48081',
    `ALICE_LND_TLS_CERT_PATH=${aliceCertPath}`,
    `ALICE_LND_MACAROON_PATH=${aliceMacaroonPath}`,
  ].join('\n') + '\n';

  const arkRegtestEnv = [
    'APP_ENV=ark-regtest',
    'DEPLOYMENT_ID=iso-ark-regtest-lab',
    'PORT=43300',
    `DATA_DIR=${join(runtimeDir, 'state/ark-regtest')}`,
    'SPEND_POLICY=disabled',
    'ENABLE_LIVE_SWAPS=false',
    `AUTH_STORE_PATH=${authStorePath}`,
    'AUTH_ORIGIN=http://127.0.0.1:43300',
    'ARK_ENABLED=true',
    'ARK_NETWORK=regtest',
    'ARK_OPERATOR_URL=http://127.0.0.1:47070/v1/info',
    `ARK_EXPECTED_SIGNER_PUBKEY=${signerPubkey}`,
    'ARK_CONFIRMATION_POLICY=read-only',
    'ARK_EXECUTION_ENABLED=true',
    'ARK_EXECUTION_OWNER=iso-user',
    `ARK_LAB_ROOT=${arkLabRoot}`,
    `ARK_CLI_PATH=${arkCliPath}`,
    `ARK_STORE_PATH=${arkStorePath}`,
    'BITCOIN_RPC_URL=http://127.0.0.1:48443',
    `BITCOIN_COOKIE_PATH=${bitcoinCookiePath}`,
    'BITCOIN_WALLET=iso-core-lab',
  ].join('\n') + '\n';

  const liquidRegtestEnv = [
    'APP_ENV=liquid-regtest',
    'DEPLOYMENT_ID=iso-liquid-regtest-lab',
    'PORT=43400',
    `DATA_DIR=${join(runtimeDir, 'state/liquid-regtest')}`,
    'SPEND_POLICY=disabled',
    'ENABLE_LIVE_SWAPS=false',
    'REVERSE_SWAP_ENABLED=false',
    'GUEST_SWAP_ENABLED=false',
    'FORWARD_SWAP_ENABLED=false',
    'REGTEST_AUTO_MINING=false',
    `AUTH_STORE_PATH=${authStorePath}`,
    'AUTH_ORIGIN=http://127.0.0.1:43400',
    'LIQUID_NETWORK=elementsregtest',
    'LIQUID_EXECUTION_ENABLED=false',
    'ELEMENTS_RPC_URL=http://127.0.0.1:47052',
    `ELEMENTS_COOKIE_PATH=${elementsCookiePath}`,
    'ELEMENTS_WALLET=iso-liquid-provider',
    `LIQUID_POLICY_ASSET=${liquidPolicyAsset}`,
    `LIQUID_GENESIS_HASH=${liquidGenesisHash}`,
    `LIQUID_PARENT_GENESIS_HASH=${bitcoinGenesis}`,
    'LIQUID_CONFIRMATION_POLICY=read-only',
    'BITCOIN_RPC_URL=http://127.0.0.1:48443',
    `BITCOIN_COOKIE_PATH=${bitcoinCookiePath}`,
    'BITCOIN_WALLET=iso-core-lab',
  ].join('\n') + '\n';

  const unifiedEnv = [
    'APP_ENV=regtest',
    'DEPLOYMENT_ID=iso-unified-regtest-lab',
    'PORT=43000',
    `DATA_DIR=${join(runtimeDir, 'state/regtest')}`,
    'SPEND_POLICY=disabled',
    'ENABLE_LIVE_SWAPS=false',
    `AUTH_STORE_PATH=${authStorePath}`,
    'AUTH_ORIGIN=http://127.0.0.1:43002',
    'UNIFIED_BROWSER_ORIGIN=http://127.0.0.1:43002',
    'UNIFIED_ADMIN_ORIGIN=http://127.0.0.1:43000',
    'UNIFIED_GUEST_ORIGIN=http://127.0.0.1:43001',
    'UNIFIED_LIQUID_ALICE_WALLET=iso-liquid-user',
    'UNIFIED_LIQUID_PROVIDER_WALLET=iso-liquid-provider',
    'UNIFIED_ARK_ALICE_WALLET=alice',
    'UNIFIED_ARK_PROVIDER_WALLET=bob',
    'BITCOIN_RPC_URL=http://127.0.0.1:48443',
    `BITCOIN_COOKIE_PATH=${bitcoinCookiePath}`,
    'BITCOIN_WALLET=iso-core-lab',
    'LND_REST_URL=https://127.0.0.1:48080',
    `LND_TLS_CERT_PATH=${providerCertPath}`,
    `LND_MACAROON_PATH=${providerMacaroonPath}`,
    'ALICE_LND_REST_URL=https://127.0.0.1:48081',
    `ALICE_LND_TLS_CERT_PATH=${aliceCertPath}`,
    `ALICE_LND_MACAROON_PATH=${aliceMacaroonPath}`,
    'ARK_ENABLED=true',
    'ARK_NETWORK=regtest',
    'ARK_OPERATOR_URL=http://127.0.0.1:47070/v1/info',
    `ARK_EXPECTED_SIGNER_PUBKEY=${signerPubkey}`,
    'ARK_CONFIRMATION_POLICY=read-only',
    'ARK_EXECUTION_ENABLED=true',
    'ARK_EXECUTION_OWNER=iso-user',
    `ARK_LAB_ROOT=${arkLabRoot}`,
    `ARK_CLI_PATH=${arkCliPath}`,
    `ARK_STORE_PATH=${arkStorePath}`,
    'LIQUID_NETWORK=elementsregtest',
    'LIQUID_EXECUTION_ENABLED=false',
    'ELEMENTS_RPC_URL=http://127.0.0.1:47052',
    `ELEMENTS_COOKIE_PATH=${elementsCookiePath}`,
    'ELEMENTS_WALLET=iso-liquid-provider',
    `LIQUID_POLICY_ASSET=${liquidPolicyAsset}`,
    `LIQUID_GENESIS_HASH=${liquidGenesisHash}`,
    `LIQUID_PARENT_GENESIS_HASH=${bitcoinGenesis}`,
    'LIQUID_CONFIRMATION_POLICY=read-only',
  ].join('\n') + '\n';

  return {
    'regtest.env': regtestEnv,
    'ark-regtest.env': arkRegtestEnv,
    'liquid-regtest.env': liquidRegtestEnv,
    'unified.env': unifiedEnv,
  };
}

export async function prepareIsolatedRuntimeFiles(runtimeDir = DEFAULT_RUNTIME_DIR) {
  const root = resolve(runtimeDir);
  const subdirs = [
    root,
    join(root, 'bitcoin'),
    join(root, 'lnd-provider'),
    join(root, 'lnd-alice'),
    join(root, 'elements'),
    join(root, 'ark'),
    join(root, 'ark/wallets'),
    join(root, 'ark/wallets/alice'),
    join(root, 'ark/wallets/bob'),
    join(root, 'auth'),
    join(root, 'secrets'),
    join(root, 'env'),
    join(root, 'state'),
    join(root, 'state/regtest'),
    join(root, 'state/ark-regtest'),
    join(root, 'state/liquid-regtest'),
  ];
  for (const dir of subdirs) {
    await ensureSecureDir(dir);
  }

  const rpcPassword = await readOrCreateSecret(join(root, 'secrets/bitcoin-rpc-pass'));
  const rpcSalt = await readOrCreateSecret(join(root, 'secrets/bitcoin-rpc-salt'), () => randomBytes(16).toString('hex'));
  const arkWalletPass = await readOrCreateSecret(join(root, 'secrets/ark-cli-password'));
  const arkSignerKey = await readOrCreateSecret(join(root, 'secrets/ark-signer-key'));
  const adminPassword = await readOrCreateSecret(join(root, 'secrets/iso-admin-password'), () => `iso-admin-${randomBytes(16).toString('hex')}`);
  const userPassword = await readOrCreateSecret(join(root, 'secrets/iso-user-password'), () => `iso-user-${randomBytes(16).toString('hex')}`);
  await readOrCreateSecret(join(root, 'secrets/lnd-provider-password'));
  await readOrCreateSecret(join(root, 'secrets/lnd-alice-password'));

  const rpcAuth = buildRpcAuthEntry('iso-rt-rpc', rpcPassword, rpcSalt);
  const expectedSignerPubkey = await deriveSignerPubkey(arkSignerKey);

  const composeEnvPath = join(root, 'compose.env');
  const composeEnvContent = [
    'ISO_RT_PROJECT_NAME=swap-engine-iso-regtest',
    `ISO_RT_RUNTIME_DIR=${root}`,
    'ISO_RT_HOST_BIND=127.0.0.1',
    'ISO_RT_BITCOIN_RPC_USER=iso-rt-rpc',
    `ISO_RT_BITCOIN_RPC_PASS=${rpcPassword}`,
    `ISO_RT_BITCOIN_RPCAUTH=${rpcAuth}`,
    `ISO_RT_ARKD_WALLET_PASS=${arkWalletPass}`,
    `ISO_RT_ARKD_SIGNER_KEY=${arkSignerKey}`,
    'ISO_RT_BITCOIN_RPC_PORT=48443',
    'ISO_RT_BITCOIN_P2P_PORT=48444',
    'ISO_RT_BITCOIN_ZMQ_BLOCK_PORT=48332',
    'ISO_RT_BITCOIN_ZMQ_TX_PORT=48333',
    'ISO_RT_LND_PROVIDER_REST_PORT=48080',
    'ISO_RT_LND_PROVIDER_GRPC_PORT=40009',
    'ISO_RT_LND_PROVIDER_P2P_PORT=49735',
    'ISO_RT_LND_ALICE_REST_PORT=48081',
    'ISO_RT_LND_ALICE_GRPC_PORT=40010',
    'ISO_RT_LND_ALICE_P2P_PORT=49736',
    'ISO_RT_NBXPLORER_PORT=42938',
    'ISO_RT_MEMPOOL_PORT=43100',
    'ISO_RT_ARKD_PORT=47070',
    'ISO_RT_ARKD_ADMIN_PORT=47071',
    'ISO_RT_ELEMENTS_RPC_PORT=47052',
  ].join('\n') + '\n';
  await writeSecureFile(composeEnvPath, composeEnvContent, 0o600);

  // Install ark-lab as a regular executable file (never a symlink)
  const arkLabBin = join(root, 'ark/ark-lab');
  try {
    const st = await lstat(arkLabBin);
    if (st.isSymbolicLink()) await unlink(arkLabBin);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  // Always overwrite so the installed wrapper matches the repository source.
  await copyFile(ARK_CLI_SOURCE, arkLabBin);
  await chmod(arkLabBin, 0o700);
  const installedStat = await lstat(arkLabBin);
  if (!installedStat.isFile() || installedStat.isSymbolicLink()) {
    throw new Error('ark-lab must be a regular executable file');
  }

  // Provision iso-admin and iso-user in auth/users.json
  const authStorePath = join(root, 'auth/users.json');
  await provisionLocalAccount(authStorePath, 'iso-admin', 'ADMIN', adminPassword);
  await provisionLocalAccount(authStorePath, 'iso-user', 'USER', userPassword);

  const profiles = buildLocalEnvProfiles({
    runtimeDir: root,
    expectedSignerPubkey,
  });
  for (const [filename, content] of Object.entries(profiles)) {
    await writeSecureFile(join(root, 'env', filename), content, 0o600);
  }

  return {
    runtimeDir: root,
    composeEnvPath,
    arkLabBin,
    authStorePath,
    expectedSignerPubkey,
  };
}

async function waitFor(description, fn, { attempts = 90, delayMs = 2_000 } = {}) {
  let lastError;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      await new Promise(r => setTimeout(r, delayMs));
    }
  }
  throw new Error(`Timed out waiting for ${description}: ${lastError?.message ?? lastError}`);
}

async function jsonRpcCall(url, cookiePath, method, params = [], wallet) {
  const cookie = (await readFile(cookiePath, 'utf8')).trim();
  const endpoint = wallet ? `${url.replace(/\/$/, '')}/wallet/${encodeURIComponent(wallet)}` : url;
  const response = await fetch(endpoint, {
    method: 'POST',
    signal: AbortSignal.timeout(45_000),
    headers: {
      authorization: `Basic ${Buffer.from(cookie).toString('base64')}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ jsonrpc: '1.0', id: 'iso-bootstrap', method, params }),
  });
  const body = await response.json();
  if (body?.error) {
    const err = new Error(`RPC ${method} error ${body.error.code}: ${body.error.message}`);
    err.code = body.error.code;
    throw err;
  }
  if (!response.ok) throw new Error(`RPC ${method} HTTP ${response.status}`);
  return body.result;
}

function lndRestRequest({ url, certPath, macaroonPath, method = 'GET', path, body }) {
  const ca = readFileSync(certPath);
  const headers = { accept: 'application/json' };
  if (macaroonPath && existsSync(macaroonPath)) {
    headers['Grpc-Metadata-macaroon'] = readFileSync(macaroonPath).toString('hex');
  }
  const payload = body !== undefined ? Buffer.from(JSON.stringify(body), 'utf8') : undefined;
  if (payload) {
    headers['content-type'] = 'application/json';
    headers['content-length'] = String(payload.length);
  }
  const parsed = new URL(path, url);
  return new Promise((resolvePromise, rejectPromise) => {
    const req = httpsRequest(
      parsed,
      { method, ca, headers, timeout: 15_000 },
      res => {
        const chunks = [];
        res.on('data', chunk => chunks.push(chunk));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          const status = res.statusCode ?? 500;
          let json = null;
          try {
            json = text ? JSON.parse(text) : {};
          } catch {
            json = { raw: text };
          }
          if (status < 200 || status >= 300) {
            rejectPromise(new Error(`LND ${method} ${path} HTTP ${status}: ${text}`));
            return;
          }
          resolvePromise(json);
        });
      },
    );
    req.on('error', rejectPromise);
    req.on('timeout', () => req.destroy(new Error(`LND ${method} ${path} timeout`)));
    if (payload) req.write(payload);
    req.end();
  });
}

async function initOrUnlockLndNode({ name, url, dir, secretsDir }) {
  const certPath = join(dir, 'tls.cert');
  const adminMacaroonPath = join(dir, 'data/chain/bitcoin/regtest/admin.macaroon');
  const readonlyMacaroonPath = join(dir, 'data/chain/bitcoin/regtest/readonly.macaroon');
  const passwordPath = join(secretsDir, `lnd-${name}-password`);
  const seedPath = join(secretsDir, `lnd-${name}-seed.json`);
  const password = (await readFile(passwordPath, 'utf8')).trim();

  await waitFor(`LND ${name} TLS cert and /v1/state`, async () => {
    if (!existsSync(certPath)) throw new Error('tls.cert not ready');
    return lndRestRequest({ url, certPath, path: '/v1/state' });
  });

  const stateRes = await lndRestRequest({ url, certPath, path: '/v1/state' });
  if (stateRes.state === 'NON_EXISTING') {
    const seedRes = await lndRestRequest({ url, certPath, path: '/v1/genseed' });
    const mnemonic = seedRes.cipher_seed_mnemonic;
    if (!Array.isArray(mnemonic) || mnemonic.length === 0) {
      throw new Error(`Failed to generate LND seed for ${name}`);
    }
    await writeSecureFile(seedPath, `${JSON.stringify({ cipher_seed_mnemonic: mnemonic }, null, 2)}\n`, 0o600);
    await lndRestRequest({
      url,
      certPath,
      method: 'POST',
      path: '/v1/initwallet',
      body: {
        wallet_password: Buffer.from(password, 'utf8').toString('base64'),
        cipher_seed_mnemonic: mnemonic,
      },
    });
  } else if (stateRes.state === 'LOCKED') {
    await lndRestRequest({
      url,
      certPath,
      method: 'POST',
      path: '/v1/unlockwallet',
      body: {
        wallet_password: Buffer.from(password, 'utf8').toString('base64'),
      },
    });
  }

  await waitFor(`LND ${name} SERVER_ACTIVE and macaroons`, async () => {
    const current = await lndRestRequest({ url, certPath, path: '/v1/state' });
    if (current.state !== 'SERVER_ACTIVE' && current.state !== 'RPC_ACTIVE') {
      throw new Error(`state is ${current.state}`);
    }
    if (!existsSync(adminMacaroonPath) || !existsSync(readonlyMacaroonPath)) {
      throw new Error('macaroons not created yet');
    }
    await chmod(adminMacaroonPath, 0o600).catch(() => {});
    await chmod(readonlyMacaroonPath, 0o600).catch(() => {});
    const info = await lndRestRequest({
      url,
      certPath,
      macaroonPath: adminMacaroonPath,
      path: '/v1/getinfo',
    });
    if (!info.synced_to_chain) throw new Error('not synced_to_chain yet');
    return info;
  });

  return {
    certPath,
    adminMacaroonPath,
    readonlyMacaroonPath,
    call: (path, method = 'GET', body) =>
      lndRestRequest({ url, certPath, macaroonPath: adminMacaroonPath, method, path, body }),
  };
}

export async function runBootstrap(options = {}) {
  const runtimeDir = resolve(options.runtimeDir ?? process.env.ISO_RT_RUNTIME_DIR ?? DEFAULT_RUNTIME_DIR);
  const prepared = await prepareIsolatedRuntimeFiles(runtimeDir);
  if (options.prepareOnly) {
    return { status: 'prepared', ...prepared };
  }

  const envWithLocalBin = {
    ...process.env,
    PATH: `${process.env.PATH || '/usr/bin:/bin'}:/usr/local/bin:${join(homedir(), '.local/bin')}`,
  };

  // Start isolated compose stack without touching existing ark_lab_* containers
  await runExecFile(
    'podman-compose',
    [
      '--in-pod',
      'false',
      '-p',
      'swap-engine-iso-regtest',
      '--env-file',
      prepared.composeEnvPath,
      '-f',
      COMPOSE_FILE,
      'up',
      '-d',
      '--no-recreate',
    ],
    { env: envWithLocalBin, timeout: 300_000 },
  );

  // 1. Bitcoin Core
  const bitcoinUrl = 'http://127.0.0.1:48443';
  const bitcoinCookie = join(runtimeDir, 'bitcoin/regtest/.cookie');
  const bitcoinWallet = 'iso-core-lab';
  const btc = (method, params = [], wallet = false) =>
    jsonRpcCall(bitcoinUrl, bitcoinCookie, method, params, wallet ? bitcoinWallet : undefined);

  await waitFor('iso_rt_bitcoin RPC and cookie', async () => {
    if (!existsSync(bitcoinCookie)) throw new Error('cookie not created yet');
    await chmod(bitcoinCookie, 0o600).catch(() => {});
    const info = await btc('getblockchaininfo');
    if (info.chain !== 'regtest') throw new Error(`unexpected chain ${info.chain}`);
    const genesis = await btc('getblockhash', [0]);
    if (genesis !== BITCOIN_REGTEST_GENESIS) throw new Error('unexpected genesis');
    return info;
  });

  const loadedWallets = await btc('listwallets');
  if (!loadedWallets.includes(bitcoinWallet)) {
    const dirWallets = await btc('listwalletdir');
    const existsOnDisk = Array.isArray(dirWallets?.wallets) &&
      dirWallets.wallets.some(w => w.name === bitcoinWallet);
    if (existsOnDisk) {
      await btc('loadwallet', [bitcoinWallet, true]);
    } else {
      await btc('createwallet', [bitcoinWallet, false, false, '', false, true, true]);
    }
  }

  const mineBitcoinBlocks = async count => {
    const minerAddr = await btc('getnewaddress', ['iso-miner', 'bech32'], true);
    await btc('generatetoaddress', [count, minerAddr], true);
  };

  const currentHeight = await btc('getblockcount');
  if (currentHeight < 105) {
    await mineBitcoinBlocks(105 - currentHeight);
  }

  // 2. LND Provider & Alice
  const secretsDir = join(runtimeDir, 'secrets');
  const providerLnd = await initOrUnlockLndNode({
    name: 'provider',
    url: 'https://127.0.0.1:48080',
    dir: join(runtimeDir, 'lnd-provider'),
    secretsDir,
  });
  const aliceLnd = await initOrUnlockLndNode({
    name: 'alice',
    url: 'https://127.0.0.1:48081',
    dir: join(runtimeDir, 'lnd-alice'),
    secretsDir,
  });

  for (const [label, node] of [['provider', providerLnd], ['alice', aliceLnd]]) {
    const bal = await node.call('/v1/balance/blockchain');
    const confirmed = Number(bal?.confirmed_balance ?? 0);
    if (confirmed < 100_000_000) {
      const addrRes = await node.call('/v1/newaddress?type=WITNESS_PUBKEY_HASH');
      if (!addrRes?.address?.startsWith('bcrt1')) {
        throw new Error(`Invalid newaddress for LND ${label}`);
      }
      await btc('sendtoaddress', [addrRes.address, 2], true);
    }
  }
  await mineBitcoinBlocks(6);

  const [providerInfo, aliceInfo] = await Promise.all([
    waitFor('LND provider synced', async () => {
      const info = await providerLnd.call('/v1/getinfo');
      if (!info.synced_to_chain) throw new Error('provider not synced');
      return info;
    }),
    waitFor('LND alice synced', async () => {
      const info = await aliceLnd.call('/v1/getinfo');
      if (!info.synced_to_chain) throw new Error('alice not synced');
      return info;
    }),
  ]);

  await waitFor('alice connected to provider peer', async () => {
    const alicePeers = await aliceLnd.call('/v1/peers');
    const connected = Array.isArray(alicePeers?.peers) &&
      alicePeers.peers.some(p => p.pub_key === providerInfo.identity_pubkey);
    if (connected) return alicePeers;
    await aliceLnd.call('/v1/peers', 'POST', {
      addr: { pubkey: providerInfo.identity_pubkey, host: 'iso_rt_lnd_provider:9735' },
      perm: true,
    }).catch(() => {});
    throw new Error('peer not connected yet');
  }, { attempts: 30, delayMs: 2_000 });

  const existingChannels = await aliceLnd.call('/v1/channels');
  const pendingChannels = await aliceLnd.call('/v1/channels/pending');
  const hasChannel =
    (Array.isArray(existingChannels?.channels) &&
      existingChannels.channels.some(c => c.remote_pubkey === providerInfo.identity_pubkey)) ||
    (Array.isArray(pendingChannels?.pending_open_channels) &&
      pendingChannels.pending_open_channels.some(c =>
        c.channel?.remote_node_pub === providerInfo.identity_pubkey));

  if (!hasChannel) {
    await aliceLnd.call('/v1/channels', 'POST', {
      node_pubkey_string: providerInfo.identity_pubkey,
      local_funding_amount: '2000000',
      push_sat: '1000000',
      private: false,
    });
    await mineBitcoinBlocks(6);
  }

  await waitFor('active LND channel between alice and provider', async () => {
    const ch = await aliceLnd.call('/v1/channels');
    const active = Array.isArray(ch?.channels) &&
      ch.channels.some(c => c.remote_pubkey === providerInfo.identity_pubkey && c.active);
    if (!active) {
      await mineBitcoinBlocks(1);
      throw new Error('channel not active yet');
    }
    return ch;
  });

  // 3. Ark indexers, operator wallet, and alice/bob CLI wallets
  const waitIndexers = () =>
    waitFor('NBXplorer and Mempool Esplora sync', async () => {
      const height = await btc('getblockcount');
      const tip = await btc('getbestblockhash');
      const [eHeight, eTip, nbxStatus] = await Promise.all([
        fetch('http://127.0.0.1:43100/api/blocks/tip/height').then(r => r.text()),
        fetch('http://127.0.0.1:43100/api/blocks/tip/hash').then(r => r.text()),
        fetch('http://127.0.0.1:42938/v1/cryptos/BTC/status').then(r => r.json()),
      ]);
      if (Number(eHeight.trim()) !== height || eTip.trim() !== tip) {
        throw new Error(`Esplora at ${eHeight.trim()} vs Core ${height}`);
      }
      if (!nbxStatus?.isFullySynched || nbxStatus?.syncHeight !== height) {
        throw new Error('NBXplorer not synced yet');
      }
      return { height, tip };
    });

  await waitIndexers();

  const arkAdminBase = 'http://127.0.0.1:47071/v1/admin';
  const arkStatus = await waitFor('arkd admin wallet status', async () => {
    const res = await fetch(`${arkAdminBase}/wallet/status`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  });

  const arkWalletPass = (await readFile(join(runtimeDir, 'secrets/ark-cli-password'), 'utf8')).trim();
  if (!arkStatus.initialized) {
    const seedRes = await (await fetch(`${arkAdminBase}/wallet/seed`)).json();
    await fetch(`${arkAdminBase}/wallet/create`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ seed: seedRes.seed, password: arkWalletPass }),
    });
  }
  const afterCreateStatus = await (await fetch(`${arkAdminBase}/wallet/status`)).json();
  if (!afterCreateStatus.unlocked) {
    await fetch(`${arkAdminBase}/wallet/unlock`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: arkWalletPass }),
    }).catch(() => {});
  }

  await waitFor('arkd operator ready and wallet unlocked/synced', async () => {
    const st = await (await fetch(`${arkAdminBase}/wallet/status`)).json();
    if (!st.initialized || !st.unlocked || !st.synced) throw new Error('arkd wallet not synced');
    const info = await (await fetch('http://127.0.0.1:47070/v1/info')).json();
    if (info.network !== 'regtest' || info.signerPubkey !== prepared.expectedSignerPubkey) {
      throw new Error('arkd info mismatch');
    }
    return info;
  });

  // arkd only uses ARKD_VTXO_TREE_EXPIRY to seed a new settings database.
  const readArkTreeExpiry = async () => {
    const res = await fetch(`${arkAdminBase}/settings`, { signal: AbortSignal.timeout(5_000) });
    if (!res.ok) throw new Error(`Ark settings lookup failed: HTTP ${res.status}`);
    return String((await res.json()).settings?.vtxoTreeExpiry);
  };
  if (await readArkTreeExpiry() !== ARK_LAB_VTXO_TREE_EXPIRY) {
    const res = await fetch(`${arkAdminBase}/settings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ settings: { vtxoTreeExpiry: ARK_LAB_VTXO_TREE_EXPIRY } }),
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) throw new Error(`Ark settings update failed: HTTP ${res.status}`);
    if (await readArkTreeExpiry() !== ARK_LAB_VTXO_TREE_EXPIRY) {
      throw new Error('Ark tree expiry update was not applied');
    }
  }

  const arkBalanceRes = await (await fetch(`${arkAdminBase}/wallet/balance`)).json();
  const arkTotalBtc =
    Number(arkBalanceRes?.mainAccount?.available ?? 0) +
    Number(arkBalanceRes?.mainAccount?.locked ?? 0);
  if (arkTotalBtc < 5) {
    const addrRes = await (await fetch(`${arkAdminBase}/wallet/address`)).json();
    if (!addrRes?.address?.startsWith('bcrt1')) throw new Error('Invalid arkd operator address');
    for (let i = 0; i < 5; i++) {
      await btc('sendtoaddress', [addrRes.address, 1], true);
    }
    await mineBitcoinBlocks(2);
    await waitIndexers();
    await waitFor('arkd operator funded balance', async () => {
      const b = await (await fetch(`${arkAdminBase}/wallet/balance`)).json();
      const total = Number(b?.mainAccount?.available ?? 0) + Number(b?.mainAccount?.locked ?? 0);
      if (total < 5) throw new Error(`operator balance ${total} < 5`);
      return total;
    });
  }

  await fetch(`${arkAdminBase}/intentFees`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      fees: {
        offchainInputFee: '0.0',
        onchainInputFee: '0.0',
        offchainOutputFee: '0.0',
        onchainOutputFee: '0.0',
      },
    }),
  }).catch(() => {});

  const arkWalletsInit = await runArkLabCli(['init-wallets'], {
    runtimeDir,
    password: arkWalletPass,
  });
  const bobVtxos = async () => (await runArkLabCli(['list-vtxos', 'bob'], {
    runtimeDir,
    password: arkWalletPass,
  })).wallets.bob;
  const eligibleBatchLeaves = rows => rows.filter(row =>
    row.origin === 'batch_leaf' && row.amount_sats > 0 &&
    !row.is_spent && !row.is_swept && !row.is_unrolled && !row.is_expired &&
    row.expires_at > 0 && row.commitment_txids.length > 0);

  // A recoverable balance is not a spendable, settled VTXO.
  if (eligibleBatchLeaves(await bobVtxos()).length === 0) {
    const bobBoardingAddr = arkWalletsInit.wallets.bob.boarding[0];
    const txid = await btc('sendtoaddress', [bobBoardingAddr, 0.002], true);
    await mineBitcoinBlocks(1);
    await waitIndexers();
    const rawTx = await btc('getrawtransaction', [txid, 1]);
    const voutObj = rawTx.vout.find(o => o?.scriptPubKey?.address === bobBoardingAddr);
    const outpoint = `${txid}:${voutObj?.n ?? 0}`;
    const boarded = await runArkLabCli(['board', 'bob', outpoint], {
      runtimeDir,
      password: arkWalletPass,
    });
    if (boarded?.wallets?.bob?.commitment_txid) {
      await mineBitcoinBlocks(1);
      await waitIndexers();
    }
  }
  await waitFor('confirmed spendable Ark fixture', async () => {
    for (const row of eligibleBatchLeaves(await bobVtxos())) {
      const commitments = await Promise.all(row.commitment_txids.map(txid =>
        btc('getrawtransaction', [txid, true]).catch(() => null)));
      if (commitments.every(tx => tx?.confirmations > 0)) return;
    }
    throw new Error('no eligible Bob batch leaf with confirmed commitments');
  }, { attempts: 10, delayMs: 2_000 });

  // 4. Elements Core (iso_rt_elements)
  const elementsUrl = 'http://127.0.0.1:47052';
  const elementsCookie = join(runtimeDir, 'elements/elementsregtest/.cookie');
  const el = (method, params = [], wallet) =>
    jsonRpcCall(elementsUrl, elementsCookie, method, params, wallet);

  await waitFor('iso_rt_elements RPC and cookie', async () => {
    if (!existsSync(elementsCookie)) throw new Error('elements cookie not ready');
    await chmod(elementsCookie, 0o600).catch(() => {});
    const info = await el('getblockchaininfo');
    if (info.chain !== 'elementsregtest') throw new Error(`unexpected chain ${info.chain}`);
    return info;
  });

  const walletsRoot = join(runtimeDir, 'elements/elementsregtest/wallets');
  const ensureLegacyWallet = async wName => {
    let loaded = await el('listwallets');
    if (!loaded.includes(wName)) {
      const dir = await el('listwalletdir');
      const onDisk = Array.isArray(dir?.wallets) && dir.wallets.some(w => w.name === wName);
      if (onDisk) await el('loadwallet', [wName, true]);
      else {
        await el('createwallet', [wName, false, false, '', false, false, true]);
        return;
      }
    }
    const info = await el('getwalletinfo', [], wName);
    if (info?.descriptors === true) {
      const utxos = await el('listunspent', [0], wName);
      if (Array.isArray(utxos) && utxos.length > 0) return;
      // Empty descriptor wallet cannot claim anyone-can-spend genesis coins: replace it.
      await el('unloadwallet', [wName]);
      await rename(join(walletsRoot, wName), join(walletsRoot, `${wName}.descriptor-${Date.now()}`));
      await el('createwallet', [wName, false, false, '', false, false, true]);
    }
  };
  for (const wName of ['iso-liquid-provider', 'iso-liquid-user']) {
    await ensureLegacyWallet(wName);
  }

  await el('rescanblockchain', [0], 'iso-liquid-provider');
  const liquidGenesisHash = (await el('getblockhash', [0])).toLowerCase();
  const sidechainInfo = await el('getsidechaininfo');
  let policyAsset = (sidechainInfo?.pegged_asset ?? DEFAULT_POLICY_ASSET_PLACEHOLDER).toLowerCase();

  const providerUtxos = await el('listunspent', [0], 'iso-liquid-provider');
  if (Array.isArray(providerUtxos) && providerUtxos[0]?.asset) {
    policyAsset = String(providerUtxos[0].asset).toLowerCase();
  }

  const userUtxos = await el('listunspent', [1, 9_999_999, [], false, { asset: policyAsset }], 'iso-liquid-user');
  if (!Array.isArray(userUtxos) || userUtxos.length === 0 || providerUtxos.length <= 1) {
    const userAddr = await el('getnewaddress', ['iso-liquid-user-init'], 'iso-liquid-user');
    const providerAddr = await el('getnewaddress', ['iso-liquid-provider-init'], 'iso-liquid-provider');
    await el('sendtoaddress', [userAddr, 10], 'iso-liquid-provider');
    await el('sendtoaddress', [providerAddr, 10], 'iso-liquid-provider');
    const minerAddr = await el('getnewaddress', ['iso-liquid-miner'], 'iso-liquid-provider');
    await el('generatetoaddress', [1, minerAddr], 'iso-liquid-provider');
  }

  // The tip coinbase must carry a positive fee output in policyAsset for confirmedAssetEvidence.
  const tipHasPolicyCoinbase = async () => {
    const tip = await el('getblock', [await el('getbestblockhash'), 2]);
    const cb = tip?.tx?.[0];
    return Array.isArray(cb?.vout) &&
      cb.vout.some(o => o?.asset === policyAsset && typeof o?.value === 'number' && o.value > 0);
  };
  if (!(await tipHasPolicyCoinbase())) {
    const providerAddr = await el('getnewaddress', ['iso-liquid-fee-tip'], 'iso-liquid-provider');
    await el('sendtoaddress', [providerAddr, 0.0001], 'iso-liquid-provider');
    const minerAddr = await el('getnewaddress', ['iso-liquid-miner'], 'iso-liquid-provider');
    await el('generatetoaddress', [1, minerAddr], 'iso-liquid-provider');
  }

  // Update env profiles with attested live Elements genesisHash and policyAsset
  const updatedProfiles = buildLocalEnvProfiles({
    runtimeDir,
    expectedSignerPubkey: prepared.expectedSignerPubkey,
    liquidPolicyAsset: policyAsset,
    liquidGenesisHash,
  });
  for (const [filename, content] of Object.entries(updatedProfiles)) {
    await writeSecureFile(join(runtimeDir, 'env', filename), content, 0o600);
  }

  return {
    status: 'bootstrapped',
    runtimeDir,
    expectedSignerPubkey: prepared.expectedSignerPubkey,
    liquidGenesisHash,
    liquidPolicyAsset: policyAsset,
    providerPubkey: providerInfo.identity_pubkey,
    alicePubkey: aliceInfo.identity_pubkey,
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const prepareOnly = process.argv.includes('--prepare-only');
  runBootstrap({ prepareOnly })
    .then(summary => {
      process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    })
    .catch(error => {
      process.stderr.write(`ISO_REGTEST_BOOTSTRAP_FAILED: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exit(1);
    });
}
