import { link, mkdir, open, readFile, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

export type StateScope = { environment: string; deploymentId: string; genesisHash: string | null; wallet: string;
  bitcoinOrigin?: string | null; providerOrigin?: string | null; payerOrigin?: string | null;
  providerNode?: string | null; payerNode?: string | null; liquidOrigin?: string | null; liquidWallet?: string | null };
export type StateScopeOptions = { allowLegacyOfflineMigration?: boolean };

const markerName = '.environment.json';
const scopeVersion = 2;

function sameScope(value: unknown, expected: StateScope): boolean {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return record.version === scopeVersion && record.environment === expected.environment &&
    record.deploymentId === expected.deploymentId && record.genesisHash === expected.genesisHash &&
    record.wallet === expected.wallet && record.bitcoinOrigin === expected.bitcoinOrigin &&
    record.providerOrigin === expected.providerOrigin && record.payerOrigin === expected.payerOrigin &&
    record.providerNode === expected.providerNode && record.payerNode === expected.payerNode &&
    record.liquidOrigin === expected.liquidOrigin && record.liquidWallet === expected.liquidWallet;
}

/** Binds an existing journal/lock directory to one explicit deployment and
 * verified chain/wallet identity. A missing marker over an existing journal is
 * refused unless the operator explicitly requests the offline regtest migration. */
export async function assertStateScope(directory: string, expected: StateScope, options: StateScopeOptions = {}) {
  if (!expected.deploymentId || !/^[A-Za-z0-9._-]{1,64}$/.test(expected.deploymentId))
    throw new Error('STATE_SCOPE_INVALID');
  if (options.allowLegacyOfflineMigration && expected.environment !== 'regtest')
    throw new Error('STATE_SCOPE_MIGRATION_REGTEST_ONLY');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const marker = join(directory, markerName);
  let text: string | undefined;
  try { text = await readFile(marker, 'utf8'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('STATE_SCOPE_UNAVAILABLE');
  }
  if (text !== undefined) {
    let value: unknown;
    try { value = JSON.parse(text); } catch { throw new Error('STATE_SCOPE_MALFORMED'); }
    if (!sameScope(value, expected)) throw new Error('STATE_SCOPE_MISMATCH');
    return;
  }
  let legacy = false;
  try { await readFile(join(directory, 'state.json'), 'utf8'); legacy = true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('STATE_SCOPE_UNAVAILABLE'); }
  if (legacy && !options.allowLegacyOfflineMigration) throw new Error('STATE_SCOPE_MIGRATION_REQUIRED');
  const temp = `${marker}.${randomUUID()}.tmp`;
  const contents = JSON.stringify({ version: scopeVersion, ...expected }) + '\n';
  const handle = await open(temp, 'wx', 0o600);
  try { await handle.writeFile(contents); await handle.sync(); } finally { await handle.close(); }
  try {
    // Hard-link creation is atomic and never replaces an existing marker.
    await link(temp, marker);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    let winner: unknown;
    try { winner = JSON.parse(await readFile(marker, 'utf8')); } catch { throw new Error('STATE_SCOPE_MALFORMED'); }
    if (!sameScope(winner, expected)) throw new Error('STATE_SCOPE_MISMATCH');
  } finally { await unlink(temp).catch(() => {}); }
  if (process.platform !== 'win32') {
    const dir = await open(directory, 'r');
    try { await dir.sync(); } finally { await dir.close(); }
  }
}
