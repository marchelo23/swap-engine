import { randomUUID } from 'node:crypto';
import { appendFile, chmod, mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { z } from 'zod';
import { acquireMiningLock, MiningLockedError, withMiningLock } from './MiningLock.js';

const Hash = z.string().regex(/^[0-9a-f]{64}$/);
const ChainInfo = z.object({
  chain: z.string().min(1),
  blocks: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  headers: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  bestblockhash: Hash,
  initialblockdownload: z.boolean(),
});
const WalletInfo = z.object({ walletname: z.string().min(1) });
const AddressInfo = z.object({
  address: z.string().min(1),
  ismine: z.boolean(),
  iswatchonly: z.boolean().optional(),
  solvable: z.boolean().optional(),
});
const PauseInfo = z.object({
  pausedAt: z.string().datetime(),
  reason: z.string().regex(/^[A-Za-z0-9 _.-]{1,120}$/),
});

export type MinerRpc = {
  call<T>(method: string, params?: unknown[], wallet?: boolean): Promise<T>;
};

export type MinerConfig = {
  bitcoinUrl: string;
  cookie: string;
  wallet: string;
  dataDir: string;
  addressFile: string;
  stateFile: string;
  logFile: string;
  lockFile: string;
  pauseFile: string;
  addressLabel: string;
  lockTtlMs: number;
  now?: () => number;
};

export type MinerStatus = {
  chain: 'regtest' | null;
  wallet: string;
  address: string | null;
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  lastHeight: number | null;
  lastBlockHash: string | null;
  blocksMined: number;
  coinbaseMaturityHeight: number | null;
  failures: number;
  lastFailureAt: string | null;
  lastFailureReason: string | null;
  paused: boolean;
  pausedAt: string | null;
  pausedReason: string | null;
};

export type MinerRunResult =
  | { status: 'mined'; at: string; height: number; blockHash: string; address: string; blocksMined: number }
  | { status: 'paused'; at: string; reason: string }
  | { status: 'locked'; at: string; lockOwner: string | null }
  | { status: 'failed'; at: string; failure: string };

export class MinerError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

function iso(now: number): string {
  return new Date(now).toISOString();
}

function emptyStatus(wallet: string): MinerStatus {
  return {
    chain: null,
    wallet,
    address: null,
    lastAttemptAt: null,
    lastSuccessAt: null,
    lastHeight: null,
    lastBlockHash: null,
    blocksMined: 0,
    coinbaseMaturityHeight: null,
    failures: 0,
    lastFailureAt: null,
    lastFailureReason: null,
    paused: false,
    pausedAt: null,
    pausedReason: null,
  };
}

async function ensureDataDir(config: MinerConfig): Promise<void> {
  await mkdir(config.dataDir, { recursive: true, mode: 0o700 });
  await chmod(config.dataDir, 0o700);
}

async function writePrivateFile(path: string, content: string): Promise<void> {
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const file = await open(temp, 'wx', 0o600);
  try {
    await file.writeFile(content);
    await file.sync();
  } finally {
    await file.close();
  }
  try {
    await rename(temp, path);
  } finally {
    await unlink(temp).catch(error => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    });
  }
}

async function readJson(path: string): Promise<unknown | undefined> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as unknown;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

async function loadStatus(config: MinerConfig): Promise<MinerStatus> {
  const value = await readJson(config.stateFile);
  if (value === undefined) return emptyStatus(config.wallet);
  return z.object({
    chain: z.literal('regtest').nullable(),
    wallet: z.string(),
    address: z.string().nullable(),
    lastAttemptAt: z.string().nullable(),
    lastSuccessAt: z.string().nullable(),
    lastHeight: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable(),
    lastBlockHash: Hash.nullable(),
    blocksMined: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    coinbaseMaturityHeight: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable(),
    failures: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    lastFailureAt: z.string().nullable(),
    lastFailureReason: z.string().nullable(),
    paused: z.boolean(),
    pausedAt: z.string().nullable(),
    pausedReason: z.string().nullable(),
  }).parse(value);
}

async function saveStatus(config: MinerConfig, status: MinerStatus): Promise<void> {
  await writePrivateFile(config.stateFile, `${JSON.stringify(status, null, 2)}\n`);
}

async function appendLog(config: MinerConfig, event: Record<string, unknown>): Promise<void> {
  await appendFile(config.logFile, `${JSON.stringify({ at: new Date((config.now ?? Date.now)()).toISOString(), ...event })}\n`, { mode: 0o600 });
  await chmod(config.logFile, 0o600).catch(() => undefined);
}

async function loadPause(config: MinerConfig): Promise<z.infer<typeof PauseInfo> | null> {
  const value = await readJson(config.pauseFile);
  if (value === undefined) return null;
  try {
    return PauseInfo.parse(value);
  } catch {
    throw new MinerError('PAUSE_STATE_INVALID');
  }
}

async function readAddress(config: MinerConfig): Promise<string | null> {
  try {
    const address = (await readFile(config.addressFile, 'utf8')).trim();
    if (!address) throw new MinerError('ADDRESS_FILE_EMPTY');
    return address;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

async function assertAddressOwned(rpc: MinerRpc, address: string): Promise<void> {
  if (!/^bcrt1[0-9a-z]{20,}$/.test(address)) throw new MinerError('ADDRESS_NOT_REGTEST');
  const info = AddressInfo.parse(await rpc.call('getaddressinfo', [address], true));
  if (!info.ismine || info.iswatchonly === true) throw new MinerError('ADDRESS_NOT_OWNED');
}

export async function ensureMinerAddress(rpc: MinerRpc, config: MinerConfig): Promise<string> {
  const existing = await readAddress(config);
  if (existing !== null) {
    await assertAddressOwned(rpc, existing);
    return existing;
  }
  const created = z.string().min(1).parse(await rpc.call('getnewaddress', [config.addressLabel, 'bech32'], true));
  await assertAddressOwned(rpc, created);
  await writePrivateFile(config.addressFile, `${created}\n`);
  return created;
}

async function assertReady(rpc: MinerRpc, config: MinerConfig): Promise<z.infer<typeof ChainInfo>> {
  const chain = ChainInfo.parse(await rpc.call('getblockchaininfo'));
  if (chain.chain !== 'regtest') throw new MinerError('CORE_WRONG_CHAIN');
  if (chain.initialblockdownload !== false || chain.headers < chain.blocks) throw new MinerError('CORE_NOT_READY');
  const wallets = z.array(z.string()).parse(await rpc.call('listwallets'));
  if (!wallets.includes(config.wallet)) throw new MinerError('WALLET_NOT_LOADED');
  const wallet = WalletInfo.parse(await rpc.call('getwalletinfo', [], true));
  if (wallet.walletname !== config.wallet) throw new MinerError('WALLET_MISMATCH');
  return chain;
}

function failureReason(error: unknown): string {
  if (error instanceof MinerError) return error.code;
  return 'CORE_OR_CONFIGURATION_ERROR';
}

/** Timer path: respects pause and returns locked without mining when another writer owns the lock. */
export async function runMinerOnce(
  rpc: MinerRpc,
  config: MinerConfig,
  options: { ignorePause?: boolean; owner?: string } = {},
): Promise<MinerRunResult> {
  await ensureDataDir(config);
  const now = config.now ?? Date.now;
  let release: (() => Promise<void>) | undefined;
  try {
    release = await acquireMiningLock(config.lockFile, {
      owner: options.owner ?? 'timer',
      ttlMs: config.lockTtlMs,
      now,
    });
  } catch (error) {
    if (error instanceof MiningLockedError) {
      await appendLog(config, { event: 'locked', owner: options.owner ?? 'timer', lockOwner: error.info?.owner ?? null });
      return { status: 'locked', at: iso(now()), lockOwner: error.info?.owner ?? null };
    }
    throw error;
  }

  try {
    const status = await loadStatus(config);
    status.lastAttemptAt = iso(now());
    try {
      const pause = await loadPause(config);
      if (pause && !options.ignorePause) {
        status.paused = true;
        status.pausedAt = pause.pausedAt;
        status.pausedReason = pause.reason;
        await saveStatus(config, status);
        await appendLog(config, { event: 'paused', reason: pause.reason });
        return { status: 'paused', at: iso(now()), reason: pause.reason };
      }

      status.paused = false;
      status.pausedAt = null;
      status.pausedReason = null;
      const before = await assertReady(rpc, config);
      const address = await ensureMinerAddress(rpc, config);
      const raw = await rpc.call('generatetoaddress', [1, address], true);
      const hashes = z.array(Hash).length(1).parse(raw);
      const after = ChainInfo.parse(await rpc.call('getblockchaininfo'));
      const blockHash = hashes[0]!;
      if (after.blocks !== before.blocks + 1 || after.bestblockhash !== blockHash) throw new MinerError('AMBIGUOUS_MINE');

      status.chain = 'regtest';
      status.wallet = config.wallet;
      status.address = address;
      status.lastSuccessAt = iso(now());
      status.lastHeight = after.blocks;
      status.lastBlockHash = blockHash;
      status.blocksMined += 1;
      status.coinbaseMaturityHeight = after.blocks + 100;
      await saveStatus(config, status);
      await appendLog(config, { event: 'mined', height: after.blocks, blockHash, address, blocksMined: status.blocksMined });
      return { status: 'mined', at: iso(now()), height: after.blocks, blockHash, address, blocksMined: status.blocksMined };
    } catch (error) {
      const reason = failureReason(error);
      status.failures += 1;
      status.lastFailureAt = iso(now());
      status.lastFailureReason = reason;
      await saveStatus(config, status);
      await appendLog(config, { event: 'failed', reason, failures: status.failures });
      return { status: 'failed', at: iso(now()), failure: reason };
    }
  } finally {
    await release();
  }
}

export async function getMinerStatus(config: MinerConfig): Promise<MinerStatus> {
  const status = await loadStatus(config);
  const pause = await loadPause(config);
  return {
    ...status,
    paused: pause !== null,
    pausedAt: pause?.pausedAt ?? null,
    pausedReason: pause?.reason ?? null,
  };
}

const allowedReason = /^[A-Za-z0-9 _.-]{1,120}$/;

export async function pauseMiner(config: MinerConfig, reason: string): Promise<{ paused: true; reason: string }> {
  if (!allowedReason.test(reason)) throw new MinerError('PAUSE_REASON_INVALID');
  await ensureDataDir(config);
  return withMiningLock(config.lockFile, { owner: 'pause', ttlMs: 10_000, now: config.now }, async () => {
    await writePrivateFile(config.pauseFile, `${JSON.stringify({ pausedAt: iso((config.now ?? Date.now)()), reason }, null, 2)}\n`);
    await appendLog(config, { event: 'pause', reason });
    return { paused: true as const, reason };
  });
}

export async function resumeMiner(config: MinerConfig): Promise<{ paused: false }> {
  await ensureDataDir(config);
  return withMiningLock(config.lockFile, { owner: 'resume', ttlMs: 10_000, now: config.now }, async () => {
    await unlink(config.pauseFile).catch(error => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    });
    await appendLog(config, { event: 'resume' });
    return { paused: false as const };
  });
}
