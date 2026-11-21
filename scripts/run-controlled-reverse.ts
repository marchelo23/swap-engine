import { readFileSync } from 'node:fs';
import { join, isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { Store } from '../src/persistence/Store.js';
import { SecretVault } from '../src/persistence/SecretVault.js';
import { RefundKeyVault } from '../src/bitcoin/RefundKeyVault.js';
import { persistedReadinessCustody } from '../src/core/ControlledReadiness.js';
import { preparationSpecSchema, type PreparationSpec } from '../src/core/ReversePreparation.js';
import { createLndJitReaders } from '../src/core/LndReversePreparation.js';
import { createJustInTimeReverse, jitAuthorizationSchema, type JitExecutor } from '../src/core/JustInTimeReverse.js';
import { createJitRuntimeExecutor } from '../src/core/ControlledReverseRuntime.js';
import { ReadOnlyBitcoinClient, ReadOnlyLndClient } from '../src/diagnostics/ReadOnlyClients.js';
import { LndRecoveryClient, LndPayerRecovery, assertRecoveryNode } from '../src/lightning/LndPayerRecovery.js';
import { HttpsLndInvoiceTransport } from '../src/lightning/LndInvoiceTransport.js';
import { createReverseRecovery } from '../src/api/reverseRecovery.js';
import { executeControlledApi } from '../src/api/controlledExecution.js';
import { createOwnedReverseApi, sessionOwnerAuthenticator, type OwnerSessions } from '../src/api/ownedReverse.js';
import { serveOwnedReverse } from '../src/api/serveOwnedReverse.js';
import { controlledRunDigest } from '../src/core/ControlledReverseBackend.js';
import { verifyReverseTestPlan } from '../src/core/ReverseTestPlan.js';
import { operatorDirectory, protectedBytes, checkedJSON, operatorArtifact, sha256, operatorStopped } from '../src/operator/OperatorFiles.js';
import { backupSchema, verifyCustodyBackup } from '../src/operator/CustodyBackup.js';
import { actionPathsSchema, inspectNativeActions, probeCoreAction, nativeActionDependencies } from '../src/operator/NativeActionCredentials.js';
import { withMiningLock } from '../src/mining/MiningLock.js';

const hash = z.string().regex(/^[a-f0-9]{64}$/); const absolute = z.string().refine(isAbsolute);
const readPathsSchema = z.object({ bitcoinCookiePath: absolute, providerCertPath: absolute, providerReadMacaroonPath: absolute,
  payerCertPath: absolute, payerReadMacaroonPath: absolute, providerInvoiceMacaroonPath: absolute.optional() }).strict();
export const operatorAuthorizationSchema = z.object({ specSha256: hash, actionConfigSha256: hash, backupConfigSha256: hash,
  authorization: jitAuthorizationSchema }).strict();
export const uiAccessSchema = z.object({ ownerId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/),
  origin: z.string(), port: z.number().int().min(1).max(65535) }).strict();
type Base = { directory: string; checksum: string };
export type OperatorCommand = { mode: 'help' } | Base & ({ mode: 'review' } | { mode: 'check'; actionHash: string; backupHash: string }
  | { mode: 'execute'; actionHash: string; backupHash: string; approvalHash: string } | { mode: 'reconcile'; jitId: string; revision: number });
type ServeCommand = Base & { mode: 'serve'; actionHash: string; backupHash: string; approvalHash: string; uiHash: string };
type StatusCommand = Base & { mode: 'serve-status'; uiHash: string };
const usage = 'Local Linux regtest only; no default action. --review-jit-only --run-dir ABS --spec-sha256 SHA; --check-runtime-only adds --action-config-sha256 SHA --backup-config-sha256 SHA; --execute-jit adds those plus --authorization-sha256 SHA; --reconcile-only adds --jit-id UUID --expected-revision N. --serve-jit uses execution arguments plus --ui-config-sha256 SHA; --serve-status-only uses review arguments plus --ui-config-sha256 SHA. Serve modes require the existing application Sessions instance injected in-process; no separate login or browser operator token. Execution can pay/sign/broadcast/mine; review/check/reconcile/status cannot. Passphrase via stdin only; reconcile/status need none.';
export function parseOperatorCommand(args: string[]): OperatorCommand | ServeCommand | StatusCommand {
  if (args[0] === '--serve-status-only' && args.length === 7 && args[5] === '--ui-config-sha256' && hash.safeParse(args[6]).success) {
    const review = parseOperatorCommand(['--review-jit-only', ...args.slice(1, 5)]);
    if (review.mode !== 'review') throw operatorStopped(); return { ...review, mode: 'serve-status', uiHash: args[6]! };
  }
  if (args[0] === '--serve-jit' && args.length === 13 && args[11] === '--ui-config-sha256' && hash.safeParse(args[12]).success) {
    const execute = parseOperatorCommand(['--execute-jit', ...args.slice(1, 11)]);
    if (execute.mode !== 'execute') throw operatorStopped(); return { ...execute, mode: 'serve', uiHash: args[12]! };
  }
  if (args.length === 1 && args[0] === '--help') return { mode: 'help' };
  const modes: Record<string, 'review' | 'check' | 'execute' | 'reconcile'> = {
    '--review-jit-only': 'review', '--check-runtime-only': 'check', '--execute-jit': 'execute', '--reconcile-only': 'reconcile' };
  const mode = modes[args[0] ?? ''];
  if (!mode || args[1] !== '--run-dir' || !isAbsolute(args[2] ?? '') || args[3] !== '--spec-sha256' || !hash.safeParse(args[4]).success) throw operatorStopped();
  const base = { directory: args[2]!, checksum: args[4]! };
  if (mode === 'review' && args.length === 5) return { ...base, mode };
  if (mode === 'reconcile' && args.length === 9 && args[5] === '--jit-id' && z.uuid().safeParse(args[6]).success &&
    args[7] === '--expected-revision' && /^(0|[1-9][0-9]*)$/.test(args[8] ?? '') && Number.isSafeInteger(Number(args[8])))
    return { ...base, mode, jitId: args[6]!, revision: Number(args[8]) };
  if ((mode === 'check' || mode === 'execute') && args.length === (mode === 'check' ? 9 : 11) &&
    args[5] === '--action-config-sha256' && hash.safeParse(args[6]).success && args[7] === '--backup-config-sha256' && hash.safeParse(args[8]).success) {
    const checked = { ...base, actionHash: args[6]!, backupHash: args[8]! };
    if (mode === 'check') return { ...checked, mode };
    if (args[9] === '--authorization-sha256' && hash.safeParse(args[10]).success) return { ...checked, mode, approvalHash: args[10]! };
  }
  throw operatorStopped();
}
type OperatorClients = {
  bitcoin: Pick<ReadOnlyBitcoinClient, 'origin' | 'call' | 'confirmed' | 'assertRegtest'>;
  provider: Pick<ReadOnlyLndClient, 'origin' | 'call' | 'lookup' | 'assertRegtest'>;
  payer: Pick<ReadOnlyLndClient, 'origin' | 'call' | 'assertRegtest'>;
  invoices: Pick<HttpsLndInvoiceTransport, 'origin' | 'lookup'>;
  recoveryPayer: Pick<LndRecoveryClient, 'origin' | 'call'>;
};
function readClients(spec: PreparationSpec, paths: z.infer<typeof readPathsSchema>): OperatorClients {
  const bitcoin = new ReadOnlyBitcoinClient(spec.routing.bitcoinOrigin, paths.bitcoinCookiePath, 'lqwd-lab');
  const provider = new ReadOnlyLndClient(spec.routing.providerOrigin, paths.providerCertPath, paths.providerReadMacaroonPath);
  const payer = new ReadOnlyLndClient(spec.routing.payerOrigin, paths.payerCertPath, paths.payerReadMacaroonPath);
  return { bitcoin, provider, payer, invoices: new HttpsLndInvoiceTransport(provider.origin, paths.providerCertPath, paths.providerReadMacaroonPath),
    recoveryPayer: new LndRecoveryClient(payer.origin, paths.payerCertPath, paths.payerReadMacaroonPath) };
}
export type OperatorIO = { password(): Buffer; clients: typeof readClients; inspectActions: typeof inspectNativeActions;
  probeCore: typeof probeCoreAction; backup: typeof verifyCustodyBackup; actions: typeof nativeActionDependencies; executor: typeof createJitRuntimeExecutor;
  serve: typeof serveOwnedReverse; sessions?: OwnerSessions<{ account: { id: string; role: string } }> };
const nativeIO: OperatorIO = { password: () => readFileSync(0), clients: readClients, inspectActions: inspectNativeActions,
  probeCore: probeCoreAction, backup: verifyCustodyBackup, actions: nativeActionDependencies, executor: createJitRuntimeExecutor, serve: serveOwnedReverse };

/** Trusted test seams only. Native entrypoint never reads assembly code from args/env/config. */
export async function runOperatorCLI(args: string[], overrides: Partial<OperatorIO> = {}): Promise<unknown> {
  const command = parseOperatorCommand(args); if (command.mode === 'help') return { help: usage };
  if (process.platform !== 'linux' || !process.getuid) throw operatorStopped();
  const io = { ...nativeIO, ...overrides };
  if ((command.mode === 'serve' || command.mode === 'serve-status') && !io.sessions) throw operatorStopped();
  const directory = resolve(command.directory); await operatorDirectory(directory);
  const spec = preparationSpecSchema.parse(await checkedJSON(join(directory, 'spec.json'), command.checksum));
  const paths = readPathsSchema.parse(JSON.parse((await protectedBytes(join(directory, 'credential-paths.json'))).toString('utf8')));
  const actions = command.mode === 'check' || command.mode === 'execute' || command.mode === 'serve'
    ? actionPathsSchema.parse(await checkedJSON(join(directory, 'action-credential-paths.json'), command.actionHash)) : undefined;
  const backup = command.mode === 'check' || command.mode === 'execute' || command.mode === 'serve'
    ? backupSchema.parse(await checkedJSON(join(directory, 'custody-backup.json'), command.backupHash)) : undefined;
  if (backup && backup.specSha256 !== command.checksum) throw operatorStopped();
  const authorization = command.mode === 'execute' || command.mode === 'serve' ? operatorAuthorizationSchema.parse(await checkedJSON(join(directory, 'jit-authorization.json'), command.approvalHash)) : undefined;
  const ui = command.mode === 'serve' || command.mode === 'serve-status' ? uiAccessSchema.parse(await checkedJSON(join(directory, 'ui-access.json'), command.uiHash)) : undefined;
  if (authorization && ((command.mode !== 'execute' && command.mode !== 'serve') || authorization.specSha256 !== command.checksum ||
    authorization.actionConfigSha256 !== command.actionHash || authorization.backupConfigSha256 !== command.backupHash ||
    authorization.authorization.issuedAt > Date.now() || authorization.authorization.startBefore <= Date.now())) throw operatorStopped();
  await operatorDirectory(join(directory, 'store')); await protectedBytes(join(directory, 'store/state.json'));
  let store: Store | undefined; let client: SecretVault | undefined; let refund: SecretVault | undefined; let password: Buffer | undefined;
  let executor: JitExecutor | undefined; let underlying: ReturnType<JitExecutor['execute']> | undefined; let interrupted = false;
  const stop = () => { interrupted = true; executor?.stopClient(); };
  try {
    store = await Store.open(join(directory, 'store')); const clients = io.clients(spec, paths);
    const ownerRecovery = () => createReverseRecovery(store!, {
      assertRegtest: async () => { await clients.bitcoin.assertRegtest(); await assertRecoveryNode(clients.provider, spec.providerNode); await assertRecoveryNode(clients.recoveryPayer, spec.payerNode); },
      invoice: hash => clients.provider.lookup(hash), confirmed: id => clients.bitcoin.confirmed(id),
      tip: async () => z.object({ chain: z.literal('regtest'), initialblockdownload: z.literal(false), blocks: z.number().int().nonnegative() }).parse(await clients.bitcoin.call('getblockchaininfo')).blocks,
    }, new LndPayerRecovery(clients.recoveryPayer, spec.payerNode, hash => {
      if (hash !== spec.client.paymentHash) throw operatorStopped(); return { routing: spec.routing, providerNode: spec.providerNode };
    }));
    if (command.mode === 'serve-status') {
      if (!ui) throw operatorStopped();
      const swaps = Object.values(store.read().swaps); const swap = swaps[0];
      if (swaps.length !== 1 || !swap || swap.contract.paymentHash !== spec.client.paymentHash ||
        swap.contract.claimPublicKey !== spec.client.claimPublicKey || swap.contract.refundPublicKey !== spec.refundPublicKey) throw operatorStopped();
      const owned = createOwnedReverseApi(store, sessionOwnerAuthenticator(io.sessions!),
        { origin: ui.origin, recovery: ownerRecovery() });
      await owned.bind(ui.ownerId, swap.id, spec.claimDestination);
      return await io.serve(store, owned, ui.port, stop);
    }
    if (command.mode === 'reconcile') {
      const record = store.read().jitExecutions?.[command.jitId];
      if (!record?.plan || !record.approval || record.authorization.termsDigest !== record.termsDigest) throw operatorStopped();
      const plan = verifyReverseTestPlan(record.plan); const approval = record.approval;
      if (approval.swapId !== record.swapId || approval.isolationId !== spec.isolationId ||
        approval.planDigest !== controlledRunDigest(plan, spec.input, record.swapId, spec.isolationId) ||
        plan.contract.paymentHash !== spec.client.paymentHash || JSON.stringify(plan.routing) !== JSON.stringify(spec.routing)) throw operatorStopped();
      const payer = new LndPayerRecovery(clients.recoveryPayer, spec.payerNode, hash => {
        if (hash !== spec.client.paymentHash) throw operatorStopped(); return { routing: spec.routing, providerNode: spec.providerNode };
      });
      return await createReverseRecovery(store, {
        assertRegtest: async () => { await clients.bitcoin.assertRegtest(); await assertRecoveryNode(clients.provider, spec.providerNode); await assertRecoveryNode(clients.recoveryPayer, spec.payerNode); },
        invoice: hash => clients.provider.lookup(hash), confirmed: id => clients.bitcoin.confirmed(id),
        tip: async () => z.object({ chain: z.literal('regtest'), initialblockdownload: z.literal(false), blocks: z.number().int().nonnegative() }).parse(await clients.bitcoin.call('getblockchaininfo')).blocks,
      }, payer).reconcile(record.swapId, command.revision);
    }
    await operatorDirectory(join(directory, 'client-secrets')); await operatorDirectory(join(directory, 'provider-refund-keys'));
    password = io.password(); let length = password.length; while (length && [10, 13].includes(password[length - 1]!)) length--;
    if (length < 8 || length > 4096) throw operatorStopped();
    client = await SecretVault.open(join(directory, 'client-secrets'), password.subarray(0, length));
    refund = await SecretVault.open(join(directory, 'provider-refund-keys'), password.subarray(0, length));
    const custody = persistedReadinessCustody(client, new RefundKeyVault(refund));
    const readers = createLndJitReaders(store, spec, { ...clients, custody });
    if (command.mode === 'review') {
      password.fill(0); const review = await createJustInTimeReverse(store, spec, readers).review();
      const result = { ...review, plan: store.read().reversePreparations![spec.id]!.plan, input: spec.input };
      await operatorArtifact(directory, `jit-review-${review.termsDigest}.json`, result); return result;
    }
    const restored = await io.backup(directory, spec, backup!, password.subarray(0, length)); password.fill(0);
    const inspected = await io.inspectActions(actions!, paths); const coreScope = await io.probeCore(spec, actions!, inspected, clients.bitcoin);
    const review = await createJustInTimeReverse(store, spec, readers).review();
    if (command.mode === 'check') return { status: 'RUNTIME_CHECKED_NOT_AUTHORIZED', review, restored, coreScope,
      permissions: { provider: inspected.settle.permissions, payer: inspected.pay.permissions } };
    if (!authorization || authorization.authorization.termsDigest !== review.termsDigest) throw operatorStopped();
    let concrete: JitExecutor | undefined;
    const currentStore = store; const currentClient = client; const refundKeys = new RefundKeyVault(refund);
    executor = { async execute(context) {
      const guard = () => { if (interrupted || context.signal.aborted) throw operatorStopped(); context.guard(); };
      guard(); const dependencies = io.actions(spec, actions!, paths, inspected, clients, guard);
      concrete = io.executor(currentStore, { ...dependencies, clientVault: currentClient, refundKeys });
      underlying = concrete.execute(context); return underlying;
    }, stopClient() { interrupted = true; concrete?.stopClient(); } };
    process.on('SIGINT', stop); process.on('SIGTERM', stop);
    if (command.mode === 'serve') {
      if (!ui) throw operatorStopped();
      const owned = createOwnedReverseApi(store, sessionOwnerAuthenticator(io.sessions!),
        { origin: ui.origin, recovery: ownerRecovery() });
      await owned.bind(ui.ownerId, review.swapId, spec.claimDestination);
      owned.approve({ ownerId: ui.ownerId, swapId: review.swapId, expectedRevision: review.revision, termsDigest: review.termsDigest,
        expiresAt: authorization.authorization.startBefore,
        execute: () => withMiningLock(() => createJustInTimeReverse(currentStore, spec, readers, authorization.authorization, executor).run()) });
      return await io.serve(store, owned, ui.port, stop);
    }
    return await executeControlledApi(store, review.swapId, review.revision,
      () => withMiningLock(() => createJustInTimeReverse(currentStore, spec, readers, authorization.authorization, executor).run()));
  } finally {
    try { executor?.stopClient(); } catch { /* Keep the store locked until journaling settles. */ }
    // A timed-out executor can still be journaling its uncertain result. Never release the
    // single-writer lock while it could overwrite a newly opened reconciliation process.
    await underlying?.catch(() => {}); process.off('SIGINT', stop); process.off('SIGTERM', stop);
    password?.fill(0); client?.close(); refund?.close(); await store?.close();
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  void runOperatorCLI(process.argv.slice(2)).then(result => process.stdout.write(JSON.stringify(result) + '\n'))
    .catch(() => { process.stderr.write('OPERATOR_STOPPED: preserve custody and intents; no automatic retry\n'); process.exitCode = 1; });
}
