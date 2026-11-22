import { constants, readFileSync } from 'node:fs';
import { lstat, realpath, open, mkdir } from 'node:fs/promises';
import { isAbsolute, resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { Store } from '../src/persistence/Store.js';
import { SecretVault } from '../src/persistence/SecretVault.js';
import { RefundKeyVault } from '../src/bitcoin/RefundKeyVault.js';
import { ReadOnlyBitcoinClient, ReadOnlyLndClient } from '../src/diagnostics/ReadOnlyClients.js';
import { HttpsLndInvoiceTransport } from '../src/lightning/LndInvoiceTransport.js';
import { createLndReversePreparation } from '../src/core/LndReversePreparation.js';
import { persistedReadinessCustody } from '../src/core/ControlledReadiness.js';
import { preparationSpecSchema, preparationApprovalSchema, preparationDigest, type createReversePreparation } from '../src/core/ReversePreparation.js';

type Harness = ReturnType<typeof createReversePreparation>;
export type PreparationCommand = { mode: 'help' } | { mode: 'prepare'; directory: string; checksum: string }
  | { mode: 'recover'; directory: string; checksum: string; expectedRevision: number };
const denied = () => new Error('PREPARATION_STOPPED: preserve intents and use lookup-only recovery');
const usage = 'Invoice only; no execution. Use --prepare-invoice-only --run-dir <private-existing-dir> --spec-sha256 <sha256>, or --recover-invoice-only with the same options and --expected-revision <n>. Existing custody required; passphrase via stdin.';

export function parsePreparationCommand(args: string[]): PreparationCommand {
  if (args.length === 1 && args[0] === '--help') return { mode: 'help' };
  const prepare = args[0] === '--prepare-invoice-only'; const recover = args[0] === '--recover-invoice-only';
  if ((!prepare && !recover) || args.length !== (prepare ? 5 : 7) || args[1] !== '--run-dir' || !args[2] || !isAbsolute(args[2]) ||
    args[3] !== '--spec-sha256' || !/^[a-f0-9]{64}$/.test(args[4] ?? '')) throw denied();
  if (prepare) return { mode: 'prepare', directory: args[2], checksum: args[4]! };
  if (args[5] !== '--expected-revision' || !/^(0|[1-9][0-9]*)$/.test(args[6] ?? '') || !Number.isSafeInteger(Number(args[6]))) throw denied();
  return { mode: 'recover', directory: args[2], checksum: args[4]!, expectedRevision: Number(args[6]) };
}

/** Pure dispatch, independently testable without files, credentials, sockets or process startup. */
export function dispatchPreparation(command: Exclude<PreparationCommand, { mode: 'help' }>, harness: Pick<Harness, 'recover'> & Partial<Pick<Harness, 'prepare'>>) {
  if (command.mode === 'recover') return harness.recover(command.expectedRevision);
  if (command.mode !== 'prepare' || !harness.prepare) throw denied(); return harness.prepare();
}

async function privateDirectory(path: string) {
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid!() || stat.mode & 0o077 || await realpath(path) !== resolve(path)) throw denied();
}
async function privateFile(path: string): Promise<Buffer> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.uid !== process.getuid!() || stat.mode & 0o077 || stat.nlink !== 1 || stat.size > 65536) throw denied();
    return await file.readFile();
  } finally { await file.close(); }
}
async function publicArtifact(directory: string, result: unknown) {
  const bytes = Buffer.from(JSON.stringify(result, null, 2) + '\n'); const path = join(directory, 'prepared-public.json');
  let file;
  try { file = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); }
  catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST' || !(await privateFile(path)).equals(bytes)) throw denied(); return;
  }
  try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
  const dir = await open(directory, 'r'); try { await dir.sync(); } finally { await dir.close(); }
}

const credentialPaths = z.object({ bitcoinCookiePath: z.string(), providerCertPath: z.string(), providerReadMacaroonPath: z.string(),
  providerInvoiceMacaroonPath: z.string().optional(), payerCertPath: z.string(), payerReadMacaroonPath: z.string() }).strict()
  .refine(value => Object.values(value).every(path => path !== undefined && isAbsolute(path)));

/** Trusted module-level test seam; the executable entry point always uses native IO.
 * No command flag or environment variable can install an alternate assembly.
 */
export type PreparationCLIIO = { readPassword(): Buffer; assemble: typeof createLndReversePreparation };
export async function runPreparationCLI(args: string[], io: PreparationCLIIO = {
  readPassword: () => readFileSync(0), assemble: createLndReversePreparation,
}): Promise<void> {
  const command = parsePreparationCommand(args);
  if (command.mode === 'help') { process.stdout.write(usage + '\n'); return; }
  if (process.platform === 'win32' || !process.getuid) throw denied();
  const directory = resolve(command.directory); await privateDirectory(directory);
  const specBytes = await privateFile(join(directory, 'spec.json'));
  if (createHash('sha256').update(specBytes).digest('hex') !== command.checksum) throw denied();
  const spec = preparationSpecSchema.parse(JSON.parse(specBytes.toString('utf8')));
  const approval = command.mode === 'prepare' ? preparationApprovalSchema.parse(JSON.parse((await privateFile(join(directory, 'preparation-approval.json'))).toString('utf8'))) : undefined;
  if (approval && (approval.id !== spec.id || approval.specDigest !== preparationDigest(spec) || approval.expiresAt <= Date.now())) throw denied();
  const paths = credentialPaths.parse(JSON.parse((await privateFile(join(directory, 'credential-paths.json'))).toString('utf8')));
  if (command.mode === 'prepare' && !paths.providerInvoiceMacaroonPath) throw denied();
  await privateDirectory(join(directory, 'client-secrets')); await privateDirectory(join(directory, 'provider-refund-keys'));
  const password = io.readPassword(); let length = password.length;
  while (length && [10, 13].includes(password[length - 1]!)) length--;
  let store: Store | undefined; let clientVault: SecretVault | undefined; let providerVault: SecretVault | undefined;
  try {
    if (length < 8 || length > 4096) throw denied();
    const storePath = join(directory, 'store');
    if (command.mode === 'prepare') { try { await mkdir(storePath, { mode: 0o700 }); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; } }
    await privateDirectory(storePath); store = await Store.open(storePath);
    clientVault = await SecretVault.open(join(directory, 'client-secrets'), password.subarray(0, length));
    providerVault = await SecretVault.open(join(directory, 'provider-refund-keys'), password.subarray(0, length)); password.fill(0);
    const bitcoin = new ReadOnlyBitcoinClient(spec.routing.bitcoinOrigin, paths.bitcoinCookiePath, spec.wallet);
    const provider = new ReadOnlyLndClient(spec.routing.providerOrigin, paths.providerCertPath, paths.providerReadMacaroonPath);
    const payer = new ReadOnlyLndClient(spec.routing.payerOrigin, paths.payerCertPath, paths.payerReadMacaroonPath);
    const invoices = new HttpsLndInvoiceTransport(provider.origin, paths.providerCertPath, paths.providerReadMacaroonPath,
      command.mode === 'prepare' ? paths.providerInvoiceMacaroonPath : undefined);
    const harness = io.assemble(store, spec, { bitcoin, provider, payer, invoices,
      custody: persistedReadinessCustody(clientVault, new RefundKeyVault(providerVault)) }, approval, command.mode);
    const result = await dispatchPreparation(command, harness);
    await publicArtifact(directory, result);
    process.stdout.write(JSON.stringify({ status: result.status, swapId: result.request.swapId,
      revision: result.request.expectedRevision, publicArtifact: join(directory, 'prepared-public.json') }) + '\n');
  } finally { password.fill(0); clientVault?.close(); providerVault?.close(); await store?.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  void runPreparationCLI(process.argv.slice(2)).catch(() => { process.stderr.write('PREPARATION_STOPPED: preserve intents; no automatic retry\n'); process.exitCode = 1; });
}
