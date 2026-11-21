import { isAbsolute, join } from 'node:path';
import type { MinerConfig } from './RegtestMiner.js';

export function minerConfigFromEnv(env: NodeJS.ProcessEnv = process.env): MinerConfig {
  const dataDir = env.MINER_DATA_DIR ?? '/home/truja/.local/share/lqwd-regtest-miner';
  if (!isAbsolute(dataDir)) throw new Error('MINER_DATA_DIR must be absolute');
  const lockTtlMs = Number(env.MINER_LOCK_TTL_MS ?? 60_000);
  if (!Number.isSafeInteger(lockTtlMs) || lockTtlMs < 1_000 || lockTtlMs > 3_600_000) {
    throw new Error('MINER_LOCK_TTL_MS must be an integer from 1000 to 3600000');
  }
  return {
    bitcoinUrl: env.BITCOIN_RPC_URL ?? 'http://127.0.0.1:18443',
    cookie: env.BITCOIN_COOKIE_PATH ?? '/home/truja/.bitcoin/regtest/.cookie',
    wallet: env.BITCOIN_WALLET ?? 'lqwd-lab',
    dataDir,
    addressFile: env.MINER_ADDRESS_FILE ?? join(dataDir, 'mining-address'),
    stateFile: env.MINER_STATE_FILE ?? join(dataDir, 'status.json'),
    logFile: env.MINER_LOG_FILE ?? join(dataDir, 'miner.log'),
    lockFile: env.MINER_LOCK_FILE ?? join(dataDir, 'miner.lock'),
    pauseFile: env.MINER_PAUSE_FILE ?? join(dataDir, 'pause.json'),
    addressLabel: env.MINER_ADDRESS_LABEL ?? 'lqwd-regtest-miner',
    lockTtlMs,
  };
}
