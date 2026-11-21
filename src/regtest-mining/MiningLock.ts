import { mkdir, open, readFile, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';

export type MiningLockInfo = {
  pid: number;
  owner: string;
  acquiredAt: number;
  expiresAt: number;
};

export class MiningLockedError extends Error {
  constructor(readonly info: MiningLockInfo | undefined) {
    super('MINING_LOCKED');
  }
}

export type MiningLockOptions = {
  owner?: string;
  ttlMs?: number;
  now?: () => number;
};

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function readLock(path: string): Promise<MiningLockInfo | undefined> {
  try {
    const value = JSON.parse(await readFile(path, 'utf8')) as Partial<MiningLockInfo>;
    if (!Number.isSafeInteger(value.pid) || typeof value.owner !== 'string' ||
      !Number.isSafeInteger(value.acquiredAt) || !Number.isSafeInteger(value.expiresAt)) return undefined;
    return value as MiningLockInfo;
  } catch {
    return undefined;
  }
}

/** Shared advisory lock. The same lock path must wrap swap/recovery block-sensitive work. */
export async function acquireMiningLock(path: string, options: MiningLockOptions = {}): Promise<() => Promise<void>> {
  const now = options.now ?? Date.now;
  const owner = options.owner ?? 'miner';
  const ttlMs = options.ttlMs ?? 60_000;
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 1_000 || ttlMs > 3_600_000) throw new Error('Invalid mining lock TTL');
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });

  for (let attempt = 0; attempt < 2; attempt++) {
    const acquiredAt = now();
    const record: MiningLockInfo = { pid: process.pid, owner, acquiredAt, expiresAt: acquiredAt + ttlMs };
    try {
      const file = await open(path, 'wx', 0o600);
      try {
        await file.writeFile(`${JSON.stringify(record)}\n`);
        await file.sync();
      } finally {
        await file.close();
      }
      let released = false;
      return async () => {
        if (released) return;
        released = true;
        try {
          const current = await readLock(path);
          if (current?.pid === record.pid && current.acquiredAt === record.acquiredAt) await unlink(path);
        } catch {
          // A failed unlock is left for stale-lock recovery on the next tick.
        }
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const existing = await readLock(path);
      if (existing && existing.expiresAt > now() && isAlive(existing.pid)) throw new MiningLockedError(existing);
      try { await unlink(path); } catch { /* Another process may have removed it. */ }
    }
  }
  throw new MiningLockedError(undefined);
}

export async function withMiningLock<T>(path: string, options: MiningLockOptions, work: () => Promise<T>): Promise<T> {
  const release = await acquireMiningLock(path, options);
  try {
    return await work();
  } finally {
    await release();
  }
}
