import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { open, mkdir, copyFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { address, networks } from 'bitcoinjs-lib';
import { z } from 'zod';
import { readAccounts } from '../auth/store.js';
import { ClaimWallet } from '../client/ClaimWallet.js';
import { RefundKeyVault } from '../bitcoin/RefundKeyVault.js';
import { SecretVault } from '../persistence/SecretVault.js';
import { preparationSpecSchema } from '../core/ReversePreparation.js';
import { reverseRoutingSchema } from '../core/ReverseTestPlan.js';
import { operatorDirectory, protectedBytes, sha256, operatorStopped } from './OperatorFiles.js';
import { verifyCustodyBackup } from './CustodyBackup.js';

const absolute = z.string().refine(isAbsolute); const pubkey = z.string().regex(/^(02|03)[a-f0-9]{64}$/);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const ownedRunPolicySchema = z.object({ ownerUsername: z.literal('truja503'), ownerId: z.uuid(), authStorePath: absolute,
  origin: z.literal('http://127.0.0.1:3101'), port: z.literal(3101), backupDirectory: absolute,
  sourceAmountSats: z.number().int().min(11000).max(50000).optional(),
  tipHeight: z.number().int().positive().max(499999969), providerNode: pubkey, payerNode: pubkey,
  routing: reverseRoutingSchema, claimDestination: z.string(), refundDestination: z.string(),
  input: z.object({ txid: hash, vout: z.number().int().nonnegative().max(0xffffffff), valueSats: z.number().int().min(61000).max(Number.MAX_SAFE_INTEGER) }).strict(),
  credentialPaths: z.object({ bitcoinCookiePath: absolute, providerCertPath: absolute, providerReadMacaroonPath: absolute,
    payerCertPath: absolute, payerReadMacaroonPath: absolute, providerInvoiceMacaroonPath: absolute }).strict(),
}).strict();

async function immutable(directory: string, name: string, bytes: Buffer) {
  const file = await open(join(directory, name), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
  const parent = await open(directory, 'r'); try { await parent.sync(); } finally { await parent.close(); }
}
const json = (value: unknown) => Buffer.from(JSON.stringify(value, null, 2) + '\n');

/** Local client/operator setup only: no node transports, invoice, execution approval or signing.
 * The trusted operator must independently inspect the policy's current node/input/address evidence.
 * Immutable intent/ready files make a partial attempt fail closed instead of replacing custody. */
export async function prepareOwnedRunCustody(directory: string, unverified: unknown, password: Buffer) {
  directory = resolve(directory); await operatorDirectory(directory);
  const policy = ownedRunPolicySchema.parse(unverified);
  const account = (await readAccounts(policy.authStorePath)).find(a => a.id === policy.ownerId && a.username === policy.ownerUsername);
  if (!account || !['USER', 'ADMIN'].includes(account.role) || policy.providerNode === policy.payerNode ||
    policy.routing.providerOrigin === policy.routing.payerOrigin || password.length < 8 || password.length > 4096) throw operatorStopped();
  for (const destination of [policy.claimDestination, policy.refundDestination]) {
    if (!destination.startsWith('bcrt1')) throw operatorStopped(); address.toOutputScript(destination, networks.regtest);
  }
  const backupDirectory = resolve(policy.backupDirectory);
  const contains = (a: string, b: string) => { const p = relative(a, b); return !p || (!p.startsWith('..') && !isAbsolute(p)); };
  if (contains(directory, backupDirectory) || contains(backupDirectory, directory)) throw operatorStopped();
  await operatorDirectory(backupDirectory);
  const policyDigest = sha256(json(policy)); const intentPath = join(directory, 'custody-intent.json');
  const readyPath = join(directory, 'custody-ready.json');
  let initial = false;
  try { await immutable(directory, 'custody-intent.json', json({ policyDigest })); initial = true; }
  catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; }
  const intent = z.object({ policyDigest: hash }).strict().parse(JSON.parse((await protectedBytes(intentPath)).toString('utf8')));
  if (intent.policyDigest !== policyDigest) throw operatorStopped();
  if (!initial) {
    const ready = z.object({ policyDigest: hash, artifacts: z.record(z.string(), hash) }).strict().parse(JSON.parse((await protectedBytes(readyPath)).toString('utf8')));
    if (ready.policyDigest !== policyDigest || JSON.stringify(Object.keys(ready.artifacts).sort()) !== JSON.stringify(['credential-paths.json','custody-backup.json','spec.json','ui-access.json'])) throw operatorStopped();
    for (const [name, digest] of Object.entries(ready.artifacts)) if (sha256(await protectedBytes(join(directory, name))) !== digest) throw operatorStopped();
    const spec = preparationSpecSchema.parse(JSON.parse((await protectedBytes(join(directory, 'spec.json'))).toString('utf8')));
    await verifyCustodyBackup(directory, spec, { directory: backupDirectory, specSha256: ready.artifacts['spec.json']!, failureDomain: 'isolated-regtest-local-restorable' }, password);
    return { status: 'CUSTODY_READY' as const, ...ready, paymentHash: spec.client.paymentHash };
  }
  let client: ClaimWallet | undefined; let clientVault: SecretVault | undefined; let refundVault: SecretVault | undefined;
  try {
    clientVault = await SecretVault.open(join(directory, 'client-secrets'), password);
    refundVault = await SecretVault.open(join(directory, 'provider-refund-keys'), password);
    client = ClaimWallet.generate(); await client.backup(clientVault);
    const refund = await new RefundKeyVault(refundVault).create(client.paymentHash);
    const spec = preparationSpecSchema.parse({ id: randomUUID(), isolationId: randomUUID(), tipHeight: policy.tipHeight,
      providerNode: policy.providerNode, payerNode: policy.payerNode, routing: policy.routing, claimDestination: policy.claimDestination,
      refundDestination: policy.refundDestination, input: policy.input, client: client.toJSON(), refundPublicKey: refund.publicKey,
      ...(policy.sourceAmountSats === undefined ? {} : { sourceAmountSats: policy.sourceAmountSats }) });
    for (const [name, role] of [['client-secrets', 'client'], ['provider-refund-keys', 'refund']] as const) {
      await mkdir(join(backupDirectory, name), { mode: 0o700 });
      const copied = join(backupDirectory, name, `${role}-${client.paymentHash}.vault`);
      await copyFile(join(directory, name, `${role}-${client.paymentHash}.vault`), copied, constants.COPYFILE_EXCL);
      const file = await open(copied, 'r'); try { await file.sync(); } finally { await file.close(); }
      const parent = await open(join(backupDirectory, name), 'r'); try { await parent.sync(); } finally { await parent.close(); }
    }
    const backupParent = await open(backupDirectory, 'r'); try { await backupParent.sync(); } finally { await backupParent.close(); }
    const specBytes = json(spec); const artifacts: Record<string, string> = {};
    const values = { 'spec.json': spec, 'credential-paths.json': policy.credentialPaths,
      'custody-backup.json': { directory: backupDirectory, specSha256: sha256(specBytes), failureDomain: 'isolated-regtest-local-restorable' as const },
      'ui-access.json': { ownerId: account.id, origin: policy.origin, port: policy.port } };
    for (const [name, value] of Object.entries(values)) { const bytes = json(value); await immutable(directory, name, bytes); artifacts[name] = sha256(bytes); }
    await verifyCustodyBackup(directory, spec, values['custody-backup.json'], password);
    const ready = { policyDigest, artifacts };
    await immutable(directory, 'custody-ready.json', json(ready));
    return { status: 'CUSTODY_READY' as const, ...ready, paymentHash: client.paymentHash };
  } finally { client?.destroy(); clientVault?.close(); refundVault?.close(); }
}
