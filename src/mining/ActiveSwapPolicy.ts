import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { minerLockFile } from './MiningLock.js';

export type ActiveSwap = { id: string; state: string; timeoutHeight: number; updatedAt: number };
export type ActiveSwapPause = { pausedAt: string; reason: string;
  activeSwapPolicy?: { version: 1; swaps: Record<string, ActiveSwap> } };

/** DS-02 reads the same MINER_PAUSE_FILE; default is the miner data directory. */
export const minerPauseFile = (value?: string) =>
  value ?? process.env.MINER_PAUSE_FILE ?? join(dirname(minerLockFile()), 'pause.json');

/** Durable timer pause covering accepted/funded/recovering swaps. An operator
 * pause (a pause.json without activeSwapPolicy) is never overwritten or removed.
 * The file is atomically replaced with mode 0600 and contains no secrets. */
export async function updateActiveSwapPause(file: string, swaps: ActiveSwap[]): Promise<void> {
  const unique = Object.fromEntries(swaps.map(swap => [swap.id, swap]));
  const count = Object.keys(unique).length;
  let current: ActiveSwapPause | undefined;
  try {
    const text = await readFile(file, 'utf8');
    try { current = JSON.parse(text) as ActiveSwapPause; } catch { return; } // malformed: preserve for manual review
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  if (count === 0) {
    if (!current?.activeSwapPolicy) return;
    await unlink(file).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; });
    return;
  }
  if (current && !current.activeSwapPolicy) return; // explicit operator pause wins
  const earliest = swaps.reduce((min, swap) => Math.min(min, swap.timeoutHeight), Number.MAX_SAFE_INTEGER);
  const value: ActiveSwapPause = { pausedAt: new Date().toISOString(),
    reason: `active-swap_${count}_earliest_${earliest}`,
    activeSwapPolicy: { version: 1, swaps: unique } };
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.tmp`;
  const handle = await open(temp, 'w', 0o600);
  try { await handle.writeFile(JSON.stringify(value) + '\n'); await handle.sync(); } finally { await handle.close(); }
  await rename(temp, file);
}
