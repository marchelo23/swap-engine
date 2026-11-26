import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lstat, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { networks, payments } from 'bitcoinjs-lib';
import { config } from '../src/config.js';
import { createArkRegtestCliPort } from '../src/ark/ArkAdapter.js';
import { readAccounts } from '../src/auth/store.js';
import { verifyPassword } from '../src/auth/credentials.js';
import { createRegtestBalanceExtension } from '../scripts/unified-regtest-balances.js';

type ArkLabCliModule = {
  computeWalletBalance: (
    rawBalance: unknown,
    vtxoRows: unknown[],
    nowSec?: number,
  ) => {
    confirmed_sats: number;
    pre_confirmed_sats: number;
    recoverable_sats: number;
    pending_recovery_sats: number;
    total_sats: number;
  };
  normalizeVtxoRow: (
    raw: unknown,
    nowSec?: number,
  ) => {
    outpoint: string;
    amount_sats: number;
    origin: 'ark_transfer' | 'batch_leaf';
    commitment_txids: string[];
    is_spent: boolean;
    is_unrolled: boolean;
    is_swept: boolean;
    is_expired: boolean;
    created_at: number;
    expires_at: number;
    spent_by: string | null;
    ark_txid: string | null;
    settled_by: string | null;
  };
  runArkLabCli: (rawArgs: string[], options?: Record<string, unknown>) => Promise<Record<string, any>>;
};

type BootstrapModule = {
  BITCOIN_REGTEST_GENESIS: string;
  buildLocalEnvProfiles: (options: {
    runtimeDir: string;
    expectedSignerPubkey: string;
    liquidPolicyAsset?: string;
    liquidGenesisHash?: string;
  }) => Record<'regtest.env' | 'ark-regtest.env' | 'liquid-regtest.env' | 'unified.env', string>;
  buildRpcAuthEntry: (user: string, password: string, saltHex?: string) => string;
  deriveSignerPubkey: (signerKeyHex: string) => Promise<string>;
  prepareIsolatedRuntimeFiles: (runtimeDir?: string) => Promise<{
    runtimeDir: string;
    composeEnvPath: string;
    arkLabBin: string;
    authStorePath: string;
    expectedSignerPubkey: string;
  }>;
};

// @ts-expect-error Plain ESM .mjs script without .d.ts
import * as arkLabCliRaw from '../deploy/isolated-regtest/ark-lab-cli.mjs';
// @ts-expect-error Plain ESM .mjs script without .d.ts
import * as bootstrapRaw from '../deploy/isolated-regtest/bootstrap.mjs';

const { computeWalletBalance, normalizeVtxoRow, runArkLabCli } = arkLabCliRaw as unknown as ArkLabCliModule;
const {
  BITCOIN_REGTEST_GENESIS,
  buildLocalEnvProfiles,
  buildRpcAuthEntry,
  deriveSignerPubkey,
  prepareIsolatedRuntimeFiles,
} = bootstrapRaw as unknown as BootstrapModule;

const FORBIDDEN_HOST_PORTS = new Set([
  53, 2310, 4101, 4178, 5432, 6768, 8080, 32838, 33000, 35937, 36079, 37070, 37071, 38443, 40739, 49374,
]);

const EXPECTED_CONTAINERS = [
  'iso_rt_bitcoin',
  'iso_rt_lnd_provider',
  'iso_rt_lnd_alice',
  'iso_rt_postgres',
  'iso_rt_redis',
  'iso_rt_nbxplorer',
  'iso_rt_fulcrum',
  'iso_rt_mempool_api',
  'iso_rt_arkd_wallet',
  'iso_rt_arkd_signer',
  'iso_rt_arkd',
  'iso_rt_elements',
];

function parseDotenv(content: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    assert.ok(eq > 0, `Malformed env line: ${line}`);
    out[line.slice(0, eq)] = line.slice(eq + 1);
  }
  return out;
}

test('deploy/isolated-regtest compose and Dockerfile.elements isolate names, ports, and bind 127.0.0.1 only', async () => {
  const deployDir = resolve('deploy/isolated-regtest');
  const [dockerfile, composeEnvExample, composeYml] = await Promise.all([
    readFile(join(deployDir, 'Dockerfile.elements'), 'utf8'),
    readFile(join(deployDir, 'compose.env.example'), 'utf8'),
    readFile(join(deployDir, 'docker-compose.yml'), 'utf8'),
  ]);

  assert.match(dockerfile, /^FROM (?:docker\.io\/library\/)?debian:bookworm-slim$/m);
  assert.match(dockerfile, /elements-23\.3\.4-x86_64-linux-gnu\.tar\.gz/);
  assert.match(dockerfile, /ca-certificates/);
  assert.match(dockerfile, /curl/);
  assert.match(dockerfile, /tar/);
  assert.match(dockerfile, /\/usr\/local\/bin\/elementsd/);
  assert.match(dockerfile, /\/usr\/local\/bin\/elements-cli/);

  assert.equal(composeYml.includes('ark_lab_'), false);
  assert.equal(composeYml.includes('swap_engine_ark_'), false);
  assert.equal(composeEnvExample.includes('ark_lab_'), false);
  assert.equal(composeEnvExample.includes('swap_engine_ark_'), false);

  for (const container of EXPECTED_CONTAINERS) {
    assert.match(composeYml, new RegExp(`container_name:\\s*${container}\\b`));
  }
  assert.match(composeYml, /name:\s*iso_rt_net\b/);
  assert.match(composeYml, /name:\s*iso_rt_host_net\b/);

  // Every published port mapping must bind explicitly to 127.0.0.1 and avoid forbidden ports
  const portMappings = [...composeYml.matchAll(/-\s*"([^"]+:\d+)"/g)].map(m => m[1]!);
  assert.ok(portMappings.length >= 12);
  for (const mapping of portMappings) {
    assert.ok(mapping.startsWith('127.0.0.1:'), `Port mapping must bind 127.0.0.1: ${mapping}`);
    const defaultPortMatch = /:-(\d+)\}:\d+$/.exec(mapping) ?? /^127\.0\.0\.1:(\d+):\d+$/.exec(mapping);
    assert.ok(defaultPortMatch, `Could not extract host port from ${mapping}`);
    const hostPort = Number(defaultPortMatch[1]);
    assert.equal(FORBIDDEN_HOST_PORTS.has(hostPort), false, `Forbidden host port ${hostPort} in ${mapping}`);
  }

  const exampleEnv = parseDotenv(composeEnvExample);
  for (const [key, value] of Object.entries(exampleEnv)) {
    if (key.endsWith('_PORT')) {
      const port = Number(value);
      assert.equal(FORBIDDEN_HOST_PORTS.has(port), false, `Forbidden port ${port} in ${key}`);
    }
    assert.equal(/^[0-9a-f]{64}$/.test(value), false, `Hardcoded 64-hex secret in ${key}`);
  }
});

test('ark-lab-cli normalizes VTXOs, balances, addresses, boarding, and cooperative offboarding for ArkAdapter', async () => {
  const txid1 = '11'.repeat(32);
  const txid2 = '22'.repeat(32);
  const commit1 = '33'.repeat(32);
  const commit2 = '44'.repeat(32);
  const forfeitAddr = payments.p2wpkh({ hash: Buffer.alloc(20, 0x33), network: networks.regtest }).address!;
  const boardingAddr = payments.p2wpkh({ hash: Buffer.alloc(20, 0x44), network: networks.regtest }).address!;
  const destAddr = payments.p2wpkh({ hash: Buffer.alloc(20, 0x55), network: networks.regtest }).address!;
  const offchainAddr = 'tark1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq';

  const row = normalizeVtxoRow({
    outpoint: { txid: txid1, vout: 0 },
    amount: 75_000,
    is_preconfirmed: false,
    commitment_txids: [commit1],
    spent: false,
    unrolled: false,
    swept: false,
    created_at: '2026-11-25T10:00:00Z',
    expires_at: '2026-12-25T10:00:00Z',
    spent_by: '',
    ark_txid: null,
    settled_by: commit1,
  }, 1_700_000_000);
  assert.equal(row.outpoint, `${txid1}:0`);
  assert.equal(row.amount_sats, 75_000);
  assert.equal(row.origin, 'batch_leaf');
  assert.deepEqual(row.commitment_txids, [commit1]);
  assert.equal(row.is_expired, false);
  assert.equal(row.settled_by, commit1);
  assert.equal(row.spent_by, null);

  const balance = computeWalletBalance({ offchain_balance: { total: 75_000 } }, [row], 1_700_000_000);
  assert.deepEqual(balance, {
    confirmed_sats: 75_000,
    pre_confirmed_sats: 0,
    recoverable_sats: 0,
    pending_recovery_sats: 0,
    total_sats: 75_000,
  });

  const mockExecFn = async (_cmd: string, args: string[]) => {
    const datadirIdx = args.indexOf('--datadir');
    const wallet = args[datadirIdx + 1]?.split('/').pop();
    const subcmd = args[datadirIdx + 2];
    if (subcmd === 'receive') {
      return {
        stdout: JSON.stringify({
          boarding_address: boardingAddr,
          offchain_address: offchainAddr,
          onchain_address: boardingAddr,
        }),
        stderr: '',
      };
    }
    if (subcmd === 'balance') {
      return {
        stdout: JSON.stringify({
          onchain_balance: { spendable_amount: 0 },
          offchain_balance: { total: wallet === 'bob' ? 75_000 : 125_000 },
        }),
        stderr: '',
      };
    }
    if (subcmd === 'vtxos') {
      if (args.includes('--spent')) return { stdout: '[]', stderr: '' };
      return {
        stdout: JSON.stringify([
          {
            txid: wallet === 'bob' ? txid2 : txid1,
            vout: 0,
            amount: wallet === 'bob' ? 75_000 : 125_000,
            commitment_txids: [commit1],
            created_at: 1_700_000_000,
            expires_at: 1_999_999_999,
            is_preconfirmed: false,
            is_spent: false,
            is_swept: false,
            is_unrolled: false,
            settled_by: commit1,
          },
        ]),
        stderr: '',
      };
    }
    if (subcmd === 'settle') {
      return { stdout: JSON.stringify({ txid: commit1 }), stderr: '' };
    }
    if (subcmd === 'redeem') {
      return { stdout: JSON.stringify({ txid: commit2 }), stderr: '' };
    }
    throw new Error(`Unexpected subcmd ${subcmd}`);
  };

  const mockOperatorInfo = async () => ({
    network: 'regtest',
    version: 'v0.9.25',
    signerPubkey: '02' + '11'.repeat(32),
    forfeitAddress: forfeitAddr,
    dust: 330,
  });

  const cliOptions = {
    password: 'aa'.repeat(32),
    queryOperatorInfo: mockOperatorInfo,
    execFn: mockExecFn,
  };

  const addrEnvelope = await runArkLabCli(['addresses', 'alice'], cliOptions);
  assert.equal(addrEnvelope.wallets.alice.offchain_address, offchainAddr);
  assert.equal(addrEnvelope.wallets.alice.boarding_address, boardingAddr);

  const port = createArkRegtestCliPort({
    operatorInfoUrl: 'http://127.0.0.1:47070/v1/info',
    expectedSignerPubkey: '02' + '11'.repeat(32),
    fetchImpl: (async () => new Response(JSON.stringify(await mockOperatorInfo()), { status: 200 })) as typeof fetch,
    cli: args => runArkLabCli(args, cliOptions),
  });

  const telemetry = await port.telemetry();
  assert.equal(telemetry.operatorStatus, 'ok');
  assert.equal(telemetry.wallets?.alice?.confirmedSats, 125_000);
  assert.equal(telemetry.wallets?.bob?.confirmedSats, 75_000);

  const aliceVtxos = await port.vtxos('alice');
  assert.equal(aliceVtxos.length, 1);
  assert.equal(aliceVtxos[0]?.outpoint, `${txid1}:0`);

  const boarded = await port.board({ wallet: 'alice', fundingOutpoint: `${txid1}:1`, amountSats: 50_000 });
  assert.equal(boarded.commitmentTxid, commit1);

  const offboarded = await port.offboardCooperative({
    vtxoOutpoint: `${txid2}:0`,
    destinationAddress: destAddr,
    amountSats: 30_000,
  });
  assert.equal(offboarded.commitmentTxid, commit2);
});

test('bootstrap prepares 0700/0600 runtime files, auth accounts, and valid regtest/ark/liquid/unified env profiles', async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), 'iso-regtest-test-'));
  try {
    const rpcAuth = buildRpcAuthEntry('iso-rt-rpc', 'secretpass', '00112233445566778899aabbccddeeff');
    assert.equal(
      rpcAuth,
      'iso-rt-rpc:00112233445566778899aabbccddeeff$dff7a71e268d18bfe44c79093d6052aa22b71012ad184aace4f250f659f861ae',
    );

    const signerPubkey = await deriveSignerPubkey('11'.repeat(32));
    assert.match(signerPubkey, /^(02|03)[0-9a-f]{64}$/);

    const prepared = await prepareIsolatedRuntimeFiles(tempRoot);
    const rootStat = await lstat(tempRoot);
    assert.equal(rootStat.mode & 0o777, 0o700);

    const composeEnvStat = await lstat(prepared.composeEnvPath);
    assert.equal(composeEnvStat.mode & 0o777, 0o600);

    const arkLabStat = await lstat(prepared.arkLabBin);
    assert.equal(arkLabStat.isFile(), true);
    assert.equal(arkLabStat.isSymbolicLink(), false);
    assert.equal(arkLabStat.mode & 0o777, 0o700);

    // Verify provisioned accounts in auth/users.json
    const accounts = await readAccounts(prepared.authStorePath);
    assert.equal(accounts.length, 2);
    const adminAcc = accounts.find(a => a.username === 'iso-admin');
    const userAcc = accounts.find(a => a.username === 'iso-user');
    assert.equal(adminAcc?.role, 'ADMIN');
    assert.equal(userAcc?.role, 'USER');
    const adminPass = (await readFile(join(tempRoot, 'secrets/iso-admin-password'), 'utf8')).trim();
    const userPass = (await readFile(join(tempRoot, 'secrets/iso-user-password'), 'utf8')).trim();
    assert.equal(await verifyPassword(adminPass, adminAcc?.passwordHash), true);
    assert.equal(await verifyPassword(userPass, userAcc?.passwordHash), true);

    // Verify all 4 generated env profiles parse cleanly via src/config.ts
    const profiles = buildLocalEnvProfiles({
      runtimeDir: tempRoot,
      expectedSignerPubkey: prepared.expectedSignerPubkey,
      liquidPolicyAsset: 'aa'.repeat(32),
      liquidGenesisHash: 'bb'.repeat(32),
    });

    const regtestCfg = config(parseDotenv(profiles['regtest.env']));
    assert.equal(regtestCfg.environment, 'regtest');
    assert.equal(regtestCfg.port, 43000);
    assert.equal(regtestCfg.rails.onchain.enabled, true);
    assert.equal(regtestCfg.rails.lightning.enabled, true);

    const arkCfg = config(parseDotenv(profiles['ark-regtest.env']));
    assert.equal(arkCfg.environment, 'ark-regtest');
    assert.equal(arkCfg.port, 43300);
    assert.equal(arkCfg.rails.ark.enabled, true);
    if (arkCfg.rails.ark.enabled) {
      assert.equal(arkCfg.rails.ark.executionEnabled, true);
      assert.equal(arkCfg.rails.ark.executionOwner, 'iso-user');
      assert.equal(arkCfg.rails.ark.operatorInfoUrl, 'http://127.0.0.1:47070/v1/info');
    }

    const liquidCfg = config(parseDotenv(profiles['liquid-regtest.env']));
    assert.equal(liquidCfg.environment, 'liquid-regtest');
    assert.equal(liquidCfg.port, 43400);
    assert.equal(liquidCfg.rails.liquid.enabled, true);
    if (liquidCfg.rails.liquid.enabled) {
      assert.equal(liquidCfg.rails.liquid.rpcUrl, 'http://127.0.0.1:47052');
      assert.equal(liquidCfg.rails.liquid.wallet, 'iso-liquid-provider');
      assert.equal(liquidCfg.rails.liquid.parentGenesisHash, BITCOIN_REGTEST_GENESIS);
    }

    const unifiedEnv = parseDotenv(profiles['unified.env']);
    assert.equal(unifiedEnv.UNIFIED_BROWSER_ORIGIN, 'http://127.0.0.1:43002');
    assert.equal(unifiedEnv.UNIFIED_ADMIN_ORIGIN, 'http://127.0.0.1:43000');
    assert.equal(unifiedEnv.UNIFIED_GUEST_ORIGIN, 'http://127.0.0.1:43001');
    assert.equal(unifiedEnv.UNIFIED_LIQUID_ALICE_WALLET, 'iso-liquid-user');
    assert.equal(unifiedEnv.UNIFIED_LIQUID_PROVIDER_WALLET, 'iso-liquid-provider');
    assert.equal(unifiedEnv.UNIFIED_ARK_ALICE_WALLET, 'alice');
    assert.equal(unifiedEnv.UNIFIED_ARK_PROVIDER_WALLET, 'bob');
    const extension = createRegtestBalanceExtension(unifiedEnv);
    assert.equal(typeof extension, 'function');
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('normalizeVtxoRow accepts the PascalCase JSON emitted by arkd v0.9.25 /app/ark vtxos', () => {
  const txid = 'ab'.repeat(32);
  const commit = 'cd'.repeat(32);
  const row = normalizeVtxoRow({
    Txid: txid, VOut: 1, Script: '5120', Amount: 125000,
    CommitmentTxids: [commit],
    ExpiresAt: '2026-11-26T10:00:00Z', CreatedAt: '2026-11-25T10:00:00Z',
    Preconfirmed: false, Swept: false, Unrolled: false, Spent: false,
    SpentBy: '', SettledBy: commit, ArkTxid: '',
  }, 1_700_000_000);
  assert.equal(row.outpoint, `${txid}:1`);
  assert.equal(row.amount_sats, 125000);
  assert.equal(row.origin, 'batch_leaf');
  assert.deepEqual(row.commitment_txids, [commit]);
  assert.equal(row.is_spent, false);
  assert.equal(row.settled_by, commit);
  assert.equal(row.spent_by, null);
  assert.equal(row.ark_txid, null);
  assert.ok(row.expires_at > 0 && row.created_at > 0);
});

test('deploy/isolated-regtest contains no hardcoded user home paths', async () => {
  const dir = resolve('deploy/isolated-regtest');
  for (const name of await readdir(dir)) {
    const content = await readFile(join(dir, name), 'utf8');
    assert.equal(content.includes('/home/chelo'), false, `${name} must not contain /home/chelo`);
  }
});
