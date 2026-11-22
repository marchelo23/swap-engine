import { spawn } from 'node:child_process';
import { mkdir, open } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';

/** Shared with DS-02 `scripts/regtest-block-miner.sh`; both use MINER_LOCK_FILE. */
export const defaultMinerLockFile = join(homedir(), '.local', 'share', 'lqwd-regtest-miner', 'miner.lock');
export const minerLockFile = (value?: string) => resolve(value ?? process.env.MINER_LOCK_FILE ?? defaultMinerLockFile);

export class MiningLockBusyError extends Error {
  readonly code = 'MINING_LOCK_BUSY';
  constructor() { super('MINING_LOCK_BUSY'); }
}
export class MiningLockUnavailableError extends Error {
  readonly code = 'MINING_LOCK_UNAVAILABLE';
  constructor() { super('MINING_LOCK_UNAVAILABLE'); }
}

type Options = { lockFile?: string; timeoutMs?: number };
let localQueue: Promise<unknown> = Promise.resolve();

/** Process-local fallback only for non-Linux development/test hosts. The deployed
 * runtime is Linux and always uses the kernel flock shared with DS-02. */
function withLocalLock<T>(work: () => Promise<T>): Promise<T> {
  const previous = localQueue;
  let release!: () => void; localQueue = new Promise<void>(resolve => { release = resolve; });
  return previous.catch(() => {}).then(work).finally(release);
}

function acquireHelper(handleFd: number, timeoutMs: number): Promise<void> {
  return new Promise((resolveReady, reject) => {
    const helper = spawn('flock', ['-n', '3'], { stdio: ['ignore', 'ignore', 'ignore', handleFd] });
    let settled = false; let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (error?: Error) => {
      if (settled) return; settled = true; if (timer) clearTimeout(timer);
      if (error) reject(error); else resolveReady();
    };
    timer = setTimeout(() => { helper.kill('SIGKILL'); finish(new MiningLockUnavailableError()); }, timeoutMs);
    helper.once('error', () => finish(new MiningLockUnavailableError()));
    helper.once('exit', (code) => {
      if (code === 0) finish();
      else if (code === 1) finish(new MiningLockBusyError());
      else finish(new MiningLockUnavailableError());
    });
  });
}

/** Holds the same exclusive kernel flock as the DS-02 miner around a critical
 * section. The acquisition helper locks an inherited descriptor and exits; the
 * lock stays attached to this process's still-open descriptor, so helper death
 * after acquisition cannot release it silently. Closing the descriptor in the
 * finally block, process exit or a crash releases the kernel lock. Acquisition
 * is non-blocking; a busy lock throws MINING_LOCK_BUSY. */
export async function withMiningLock<T>(work: () => Promise<T>, options: Options = {}): Promise<T> {
  if (process.platform !== 'linux') return withLocalLock(work);
  const timeoutMs = options.timeoutMs ?? 5000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 30000) throw new MiningLockUnavailableError();
  const file = minerLockFile(options.lockFile);
  try { await mkdir(dirname(file), { recursive: true, mode: 0o700 }); } catch { throw new MiningLockUnavailableError(); }
  let handle;
  try { handle = await open(file, 'a+', 0o600); } catch { throw new MiningLockUnavailableError(); }
  try {
    await acquireHelper(handle.fd, timeoutMs);
    return await work();
  } finally {
    // Closing this process's descriptor is the only release path.
    await handle.close().catch(() => {});
  }
}
