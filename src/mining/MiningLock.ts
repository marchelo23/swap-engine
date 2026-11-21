import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdir, open } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { once } from 'node:events';

/** Shared with DS-02 `scripts/regtest-block-miner.sh`; both use MINER_LOCK_FILE. */
export const defaultMinerLockFile = '/home/truja/.local/share/lqwd-regtest-miner/miner.lock';
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

async function readLocked(child: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<void> {
  await new Promise<void>((resolveReady, reject) => {
    let text = ''; let settled = false;
    const cleanup = () => {
      clearTimeout(timer);
      child.stdout.off('data', onData); child.off('exit', onExit); child.off('error', onError);
    };
    const finish = (error?: Error) => {
      if (settled) return; settled = true; cleanup();
      if (error) reject(error); else resolveReady();
    };
    const onData = (chunk: Buffer) => {
      text += chunk.toString();
      if (text.includes('\n')) finish();
    };
    const onExit = (code: number | null) => finish(code === 1 ? new MiningLockBusyError() : new MiningLockUnavailableError());
    const onError = () => finish(new MiningLockUnavailableError());
    const timer = setTimeout(() => { child.kill('SIGKILL'); finish(new MiningLockUnavailableError()); }, timeoutMs);
    child.stdout.on('data', onData); child.once('exit', onExit); child.once('error', onError);
  });
}

async function releaseLock(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null) return;
  try {
    child.stdin.end();
    const exited = once(child, 'exit');
    const timer = setTimeout(() => child.kill('SIGKILL'), 2000);
    try { await exited; } finally { clearTimeout(timer); }
  } catch { child.kill('SIGKILL'); }
}

/** Holds the same exclusive kernel flock as the DS-02 miner around a critical
 * section. Acquisition is non-blocking; a busy lock throws MINING_LOCK_BUSY.
 * The lock is released on normal completion, thrown work, process exit or crash
 * because the helper's stdin EOF lets the kernel drop the flock. */
export async function withMiningLock<T>(work: () => Promise<T>, options: Options = {}): Promise<T> {
  if (process.platform !== 'linux') return withLocalLock(work);
  const timeoutMs = options.timeoutMs ?? 2000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 30000) throw new MiningLockUnavailableError();
  const file = minerLockFile(options.lockFile);
  try { await mkdir(dirname(file), { recursive: true, mode: 0o700 }); } catch { throw new MiningLockUnavailableError(); }
  try { const handle = await open(file, 'a', 0o600); await handle.close(); } catch { throw new MiningLockUnavailableError(); }
  let child: ChildProcessWithoutNullStreams;
  try {
    child = spawn('flock', ['-n', file, 'sh', '-c', "printf 'locked\\n'; cat"], { stdio: ['pipe', 'pipe', 'pipe'] });
  } catch { throw new MiningLockUnavailableError(); }
  try {
    await readLocked(child, timeoutMs);
    return await work();
  } finally {
    await releaseLock(child);
  }
}
