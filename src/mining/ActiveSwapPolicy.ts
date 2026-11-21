import { mkdir, open, readdir, readFile, rename, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Store } from '../persistence/Store.js';
import type { Database, Swap } from '../core/SwapTypes.js';
import { minerLockFile } from './MiningLock.js';

export type ActiveSwap = { id: string; state: string; timeoutHeight: number; updatedAt: number };
export type ActiveSwapPause = { pausedAt: string; reason: string;
  activeSwapPolicy?: { version: 1; swaps: Record<string, ActiveSwap> } };
export type ActiveSwapScanner = () => Promise<ActiveSwap[]>;
export type OnDemandAuthorization = { issuedAt: number; expiresAt: number; maxHeight: number; reason: string };

/** DS-02 reads the same MINER_PAUSE_FILE; default is the miner data directory. */
export const minerPauseFile = (value?: string) =>
  value ?? process.env.MINER_PAUSE_FILE ?? join(dirname(minerLockFile()), 'pause.json');
export const minerOnDemandAuthFile = (value?: string) =>
  value ?? process.env.MINER_ON_DEMAND_AUTH_FILE ?? join(dirname(minerPauseFile()), 'on-demand-auth.json');

const terminalStates = new Set(['COMPLETED', 'REFUNDED', 'EXPIRED', 'FAILED']);
const riskyStates = new Set(['INVOICE_ACCEPTED', 'LOCKUP_BROADCAST', 'LOCKUP_CONFIRMED', 'CLAIM_DETECTED',
  'LIGHTNING_SETTLED', 'MANUAL_REVIEW', 'REFUND_PENDING']);

async function readPause(file: string): Promise<{ current?: ActiveSwapPause; operator: boolean; malformed: boolean }> {
  let text: string;
  try { text = await readFile(file, 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { operator: false, malformed: false }; throw error; }
  try {
    const value = JSON.parse(text) as ActiveSwapPause;
    if (!value || typeof value !== 'object') return { operator: false, malformed: true };
    if (value.activeSwapPolicy) return { current: value, operator: false, malformed: false };
    return { operator: true, malformed: false };
  } catch { return { operator: false, malformed: true }; }
}

async function syncDirectory(file: string) {
  if (process.platform === 'win32') return;
  const directory = await open(dirname(file), 'r');
  try { await directory.sync(); } finally { await directory.close(); }
}

async function writePause(file: string, swaps: Record<string, ActiveSwap>) {
  const count = Object.keys(swaps).length; if (!count) return;
  const earliest = Object.values(swaps).reduce((min, swap) => Math.min(min, swap.timeoutHeight), Number.MAX_SAFE_INTEGER);
  const value: ActiveSwapPause = { pausedAt: new Date().toISOString(),
    reason: `active-swap_${count}_earliest_${earliest}`, activeSwapPolicy: { version: 1, swaps } };
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.tmp`;
  const handle = await open(temp, 'w', 0o600);
  try { await handle.writeFile(JSON.stringify(value) + '\n'); await handle.sync(); } finally { await handle.close(); }
  await rename(temp, file);
  await syncDirectory(file);
}

/** Replaces our marker with the authoritative active set. Operator pauses and
 * malformed state are preserved; removal only removes our marker. */
export async function updateActiveSwapPause(file: string, swaps: ActiveSwap[]) {
  const unique = Object.fromEntries(swaps.map(swap => [swap.id, swap]));
  const state = await readPause(file);
  if (state.operator || state.malformed) return;
  if (!Object.keys(unique).length) {
    if (!state.current) return;
    try { await unlink(file); await syncDirectory(file); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    return;
  }
  await writePause(file, unique);
}

/** Fail-closed pre-invoice/pre-exposure marker; merges with other active swaps. */
export async function markActiveSwap(file: string, swap: ActiveSwap) {
  const state = await readPause(file);
  if (state.operator || state.malformed) return; // already paused for the timer
  await writePause(file, { ...(state.current?.activeSwapPolicy?.swaps ?? {}), [swap.id]: swap });
}

/** Full authoritative reconciliation under the caller's kernel lock. A scanner
 * error becomes a conservative uncertain entry; the marker is never removed on
 * uncertainty. A busy lock throws without touching the marker. */
export class MiningPauseCoordinator {
  constructor(private readonly pauseFile: string, private readonly lock: <T>(work: () => Promise<T>) => Promise<T>,
    private readonly scanners: ActiveSwapScanner[]) {}
  async reconcile(): Promise<void> {
    await this.lock(async () => {
      const active: ActiveSwap[] = []; let uncertain = false;
      for (const scan of this.scanners) {
        try { active.push(...await scan()); } catch { uncertain = true; }
      }
      if (uncertain) active.push({ id: `uncertain-${process.pid}-${Date.now()}`, state: 'UNKNOWN',
        timeoutHeight: 0, updatedAt: Date.now() });
      await updateActiveSwapPause(this.pauseFile, active);
    });
  }
}

export async function guestActiveSwaps(store: Store, scan: (row: NonNullable<Database['guestSwaps']>[string]) => Promise<Swap | undefined>,
  lookup: (hash: string) => Promise<{ status: 'ABSENT' } | { status: 'PRESENT'; invoice: { state: string } }>): Promise<ActiveSwap[]> {
  const active: ActiveSwap[] = [];
  for (const row of Object.values(store.read().guestSwaps ?? {})) {
    if (row.terminal) continue;
    if (row.status === 'PREPARING' || row.status === 'PREPARATION_UNKNOWN') {
      active.push({ id: row.id, state: row.status, timeoutHeight: row.timeoutHeight ?? 0, updatedAt: Date.now() });
      continue;
    }
    const swap = await scan(row); // throws -> coordinator uncertainty
    if (!swap) { active.push({ id: row.id, state: 'UNKNOWN', timeoutHeight: row.timeoutHeight ?? 0, updatedAt: Date.now() }); continue; }
    let invoiceState = 'UNKNOWN';
    try {
      const found = await lookup(swap.contract.paymentHash);
      invoiceState = found.status === 'PRESENT' ? found.invoice.state : 'ABSENT';
    } catch { throw new Error('Guest invoice evidence unavailable'); }
    const risk = !!swap.clientPayment || !!swap.lockup || !!swap.fundingIntent ||
      riskyStates.has(swap.state) || invoiceState === 'ACCEPTED' || invoiceState === 'UNKNOWN';
    if (!terminalStates.has(swap.state) && risk) active.push({ id: swap.id, state: swap.state,
      timeoutHeight: swap.contract.timeoutHeight, updatedAt: Date.now() });
  }
  return active;
}

export async function ownedActiveSwaps(runsDirectory: string, openStore: (directory: string) => Promise<Store>): Promise<ActiveSwap[]> {
  let entries; try { entries = await readdir(runsDirectory, { withFileTypes: true }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  const active: ActiveSwap[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const store = await openStore(join(runsDirectory, entry.name, 'store')); // busy/unreadable -> uncertainty
    try {
      const db = store.read();
      for (const swap of Object.values(db.swaps)) {
        const risk = !!swap.clientPayment || !!swap.lockup || !!swap.fundingIntent || riskyStates.has(swap.state);
        if (!terminalStates.has(swap.state) && risk) active.push({ id: swap.id, state: swap.state,
          timeoutHeight: swap.contract.timeoutHeight, updatedAt: Date.now() });
      }
      for (const [id, run] of Object.entries(db.jitExecutions ?? {})) if (run.status === 'UNKNOWN')
        active.push({ id, state: 'JIT_UNKNOWN', timeoutHeight: 0, updatedAt: Date.now() });
      for (const [id, run] of Object.entries(db.controlledExecutions ?? {})) if (run.status === 'UNKNOWN')
        active.push({ id, state: 'CONTROLLED_UNKNOWN', timeoutHeight: 0, updatedAt: Date.now() });
      for (const [id, preparation] of Object.entries(db.reversePreparations ?? {})) if (['INTENT', 'UNKNOWN'].includes(preparation.status))
        active.push({ id, state: `PREPARATION_${preparation.status}`,
          timeoutHeight: preparation.plan?.contract.timeoutHeight ?? 0, updatedAt: Date.now() });
    } finally { await store.close(); }
  }
  return active;
}

/** DS-02 --on-demand must call this (or an equivalent) before ignoring the
 * automatic active-swap pause. An authorization is explicit, expiring and
 * deadline-aware: it cannot mine into the earliest active swap's safety window. */
export async function validateOnDemandAuthorization(pauseFile: string, authFile: string, now = Date.now()):
  Promise<{ allowed: boolean; reason: string }> {
  let current: ActiveSwapPause | undefined;
  try {
    const text = await readFile(pauseFile, 'utf8');
    try { current = JSON.parse(text) as ActiveSwapPause; } catch { return { allowed: false, reason: 'pause-malformed' }; }
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { allowed: true, reason: 'no-active-swaps' };
    return { allowed: false, reason: 'pause-unavailable' }; }
  const swaps = Object.values(current?.activeSwapPolicy?.swaps ?? {});
  if (!swaps.length) return { allowed: true, reason: 'no-active-swaps' };
  const earliest = swaps.reduce((min, swap) => Math.min(min, swap.timeoutHeight), Number.MAX_SAFE_INTEGER);
  let auth: Partial<OnDemandAuthorization>;
  try { auth = JSON.parse(await readFile(authFile, 'utf8')) as Partial<OnDemandAuthorization>; }
  catch { return { allowed: false, reason: 'authorization-missing' }; }
  if (!Number.isSafeInteger(auth.issuedAt) || !Number.isSafeInteger(auth.expiresAt) ||
    !Number.isSafeInteger(auth.maxHeight) || typeof auth.reason !== 'string' ||
    !/^[A-Za-z0-9 _.-]{1,120}$/.test(auth.reason)) return { allowed: false, reason: 'authorization-invalid' };
  if (auth.issuedAt! > now || auth.expiresAt! <= now) return { allowed: false, reason: 'authorization-expired' };
  if (auth.maxHeight! > earliest - 20) return { allowed: false, reason: 'deadline-window-too-small' };
  return { allowed: true, reason: 'authorized' };
}
