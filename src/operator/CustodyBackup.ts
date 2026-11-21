import { isAbsolute, relative, join, resolve } from 'node:path';
import { z } from 'zod';
import { SecretVault } from '../persistence/SecretVault.js';
import { RefundKeyVault } from '../bitcoin/RefundKeyVault.js';
import { persistedReadinessCustody } from '../core/ControlledReadiness.js';
import type { PreparationSpec } from '../core/ReversePreparation.js';
import { operatorDirectory, protectedBytes, sha256, operatorStopped } from './OperatorFiles.js';

export const backupSchema = z.object({ directory: z.string().refine(isAbsolute), specSha256: z.string().regex(/^[a-f0-9]{64}$/),
  failureDomain: z.enum(['operator-reviewed-independent', 'isolated-regtest-local-restorable']) }).strict();
export type BackupSpec = z.infer<typeof backupSchema>;
/** Verifies an existing encrypted copy and restores identities there. No copy, create,
 * signing, secret output or assertion that a directory proves physical independence.
 */
export async function verifyCustodyBackup(run: string, spec: PreparationSpec, backup: BackupSpec, password: Buffer) {
  const root = resolve(backup.directory); const inside = (a: string, b: string) => { const rel = relative(a, b); return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel)); };
  if (inside(resolve(run), root) || inside(root, resolve(run))) throw operatorStopped();
  await operatorDirectory(root);
  const hashes: Record<string, string> = {};
  for (const [directory, role] of [['client-secrets', 'client'], ['provider-refund-keys', 'refund']] as const) {
    await operatorDirectory(join(root, directory));
    const name = `${role}-${spec.client.paymentHash}.vault`;
    const original = await protectedBytes(join(run, directory, name)); const copy = await protectedBytes(join(root, directory, name));
    if (!original.equals(copy)) throw operatorStopped(); hashes[role] = sha256(copy);
  }
  let client: SecretVault | undefined; let refund: SecretVault | undefined;
  try {
    client = await SecretVault.open(join(root, 'client-secrets'), password); refund = await SecretVault.open(join(root, 'provider-refund-keys'), password);
    const keys = await persistedReadinessCustody(client, new RefundKeyVault(refund))(spec.client.paymentHash);
    if (keys.paymentHash !== spec.client.paymentHash || keys.claimPublicKey !== spec.client.claimPublicKey || keys.refundPublicKey !== spec.refundPublicKey) throw operatorStopped();
    return { restored: true as const, ciphertextHashes: hashes, physicalIndependence: backup.failureDomain === 'isolated-regtest-local-restorable'
      ? 'LOCAL_REGTEST_COPY_SAME_FAILURE_DOMAIN' as const : 'OPERATOR_ASSERTION_NOT_AUTOMATICALLY_PROVEN' as const };
  } finally { client?.close(); refund?.close(); }
}
