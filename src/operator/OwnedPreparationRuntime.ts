import { randomUUID } from 'node:crypto';
import { mkdir, lstat } from 'node:fs/promises';
import { join, isAbsolute, relative } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';
import { Store } from '../persistence/Store.js';
import { SecretVault } from '../persistence/SecretVault.js';
import { RefundKeyVault } from '../bitcoin/RefundKeyVault.js';
import { ownedRunPolicyBase, ownedRunPolicySchema, prepareOwnedRunCustody } from './OwnedRunCustody.js';
import { actionPathsSchema, inspectNativeActions, probeCoreAction, nativeActionDependencies } from './NativeActionCredentials.js';
import { protectedBytes, checkedJSON, operatorDirectory, operatorArtifact, operatorStopped, sha256 } from './OperatorFiles.js';
import { verifyCustodyBackup, backupSchema } from './CustodyBackup.js';
import { archivedPreparationSpecSchema, verifyArchivedChain } from './ArchiveEvidence.js';
import { ReadOnlyBitcoinClient, ReadOnlyLndClient } from '../diagnostics/ReadOnlyClients.js';
import { HttpsLndInvoiceTransport } from '../lightning/LndInvoiceTransport.js';
import { LndRecoveryClient, LndPayerRecovery, recoveryPaymentsPath, assertRecoveryNode } from '../lightning/LndPayerRecovery.js';
import { createLndReversePreparation, createLndJitReaders } from '../core/LndReversePreparation.js';
import { preparationSpecSchema, preparationDigest } from '../core/ReversePreparation.js';
import { createJustInTimeReverse, type JitExecutor } from '../core/JustInTimeReverse.js';
import { createJitRuntimeExecutor } from '../core/ControlledReverseRuntime.js';
import { persistedReadinessCustody } from '../core/ControlledReadiness.js';
import { createReverseRecovery } from '../api/reverseRecovery.js';
import { createOwnedReverseApi, sessionOwnerAuthenticator, type OwnerSessions } from '../api/ownedReverse.js';
import { PreparationRejected, type PreparationFactory, type PreparationEntry, type PreparedRuntime } from '../api/ownedPreparation.js';
import { withMiningLock } from '../mining/MiningLock.js';
import { CONTROLLED_FUNDING_CHANGE_BUFFER_SATS, LEGACY_ECONOMICS, MAX_OWNED_DEBIT_SATS, OWNED_ECONOMICS } from '../core/Economics.js';
import { invoiceBudget } from '../core/SwapManager.js';

const absolute = z.string().refine(isAbsolute);
const historyInteger = z.string().regex(/^(0|[1-9][0-9]{0,19})$/).refine(v => BigInt(v) <= 0xffffffffffffffffn);
const payerHistorySchema = z.object({ first_index_offset: historyInteger, last_index_offset: historyInteger,
  payments: z.array(z.object({ payment_hash: z.string().regex(/^[a-f0-9]{64}$/), payment_index: historyInteger })).max(100) });
function verifyAbsentHistory(value: unknown, hash: string) {
  const page = payerHistorySchema.parse(value);
  if (page.payments.length === 100 || page.payments.some(p => p.payment_hash === hash)) throw operatorStopped();
  if (!page.payments.length) {
    if (page.first_index_offset !== '0' || page.last_index_offset !== '0') throw operatorStopped();
  } else if (page.first_index_offset !== page.payments[0]!.payment_index || page.last_index_offset !== page.payments.at(-1)!.payment_index ||
    page.payments.some((p, i) => BigInt(p.payment_index) < 1n || (i > 0 && BigInt(p.payment_index) <= BigInt(page.payments[i - 1]!.payment_index)))) throw operatorStopped();
}
export const ownedRuntimePolicySchema = ownedRunPolicyBase.omit({ backupDirectory: true, tipHeight: true, input: true }).extend({
  mode: z.literal('regtest'), runsDirectory: absolute, backupsDirectory: absolute, passwordPath: absolute,
  actions: actionPathsSchema, amountSats: z.literal(50000), invoiceSats: z.literal(50750),
  fundingFeeLimitSats: z.literal(1000), routingFeeLimitSats: z.literal(100), claimFeeSats: z.literal(500),
  maxBlocks: z.literal(2), maxInputSats: z.number().int().min(61000).max(Number.MAX_SAFE_INTEGER),
  maxSourceAmountSats: z.number().int().min(LEGACY_ECONOMICS.invoice.minSats).max(MAX_OWNED_DEBIT_SATS).optional(),
  archives: z.array(z.object({ directory: absolute, specSha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict()).max(20).default([]),
}).strict().refine(p => p.actions.providerSettleMacaroonPath === p.credentialPaths.providerInvoiceMacaroonPath &&
  new URL(p.origin).port === String(p.port), 'Invoice creation must use the same inspected invoices-only credential')
  .refine(p => p.maxInputSats >= minimumFundingInput(p.maxSourceAmountSats), 'Funding input cap cannot cover the approved debit');
export type OwnedRuntimePolicy = z.infer<typeof ownedRuntimePolicySchema>;
function minimumFundingInput(sourceAmountSats?: number) {
  if (sourceAmountSats === undefined) return 61_000;
  const budget = invoiceBudget(sourceAmountSats, OWNED_ECONOMICS.invoice);
  return Math.max(61_000, budget.amountSats + budget.fundingReserveSats + CONTROLLED_FUNDING_CHANGE_BUFFER_SATS);
}
const clockSynchronized = async () => {
  const { stdout } = await promisify(execFile)('/usr/bin/timedatectl', ['show', '-p', 'NTPSynchronized', '--value'], { timeout: 5000, maxBuffer: 1024 });
  if (stdout.trim() !== 'yes') throw operatorStopped();
};
const nativeClients = (p: OwnedRuntimePolicy) => ({
  bitcoin: new ReadOnlyBitcoinClient(p.routing.bitcoinOrigin, p.credentialPaths.bitcoinCookiePath, p.wallet),
  provider: new ReadOnlyLndClient(p.routing.providerOrigin, p.credentialPaths.providerCertPath, p.credentialPaths.providerReadMacaroonPath),
  payer: new ReadOnlyLndClient(p.routing.payerOrigin, p.credentialPaths.payerCertPath, p.credentialPaths.payerReadMacaroonPath),
  invoices: new HttpsLndInvoiceTransport(p.routing.providerOrigin, p.credentialPaths.providerCertPath,
    p.credentialPaths.providerReadMacaroonPath, p.credentialPaths.providerInvoiceMacaroonPath),
  recoveryPayer: new LndRecoveryClient(p.routing.payerOrigin, p.credentialPaths.payerCertPath, p.credentialPaths.payerReadMacaroonPath),
});
export type OwnedNativeIO = { clock: typeof clockSynchronized; clients: typeof nativeClients;
  inspect: typeof inspectNativeActions; probe: typeof probeCoreAction; actions: typeof nativeActionDependencies; executor: typeof createJitRuntimeExecutor };
const nativeIO: OwnedNativeIO = { clock: clockSynchronized, clients: nativeClients, inspect: inspectNativeActions,
  probe: probeCoreAction, actions: nativeActionDependencies, executor: createJitRuntimeExecutor };

/** Repeated runs under one explicitly reviewed server policy. Test seams are module-only:
 * configuration/HTTP cannot load code, secrets or alternative clients. No action on construction. */
export async function createOwnedRuntimeFactory<S extends { account: { id: string; role: string } }>(
  value: unknown, sessions: OwnerSessions<S>, overrides: Partial<OwnedNativeIO> = {},
): Promise<PreparationFactory> {
  if (process.platform !== 'linux') throw operatorStopped();
  const policy = ownedRuntimePolicySchema.parse(value); const io = { ...nativeIO, ...overrides };
  await operatorDirectory(policy.runsDirectory); await operatorDirectory(policy.backupsDirectory);
  const contains = (a: string, b: string) => { const r = relative(a, b); return !r || (!r.startsWith('..') && !isAbsolute(r)); };
  if (contains(policy.runsDirectory, policy.backupsDirectory) || contains(policy.backupsDirectory, policy.runsDirectory) ||
    contains(policy.runsDirectory, policy.passwordPath) || contains(policy.backupsDirectory, policy.passwordPath)) throw operatorStopped();
  const password = await protectedBytes(policy.passwordPath);
  if (password.length < 8 || password.length > 4096 || [10, 13].includes(password.at(-1)!)) { password.fill(0); throw operatorStopped(); }
  const clients = io.clients(policy); let closed = false; const opened = new Set<PreparedRuntime>();
  const checkOwnerAndNodes = async (sourceAmountSats?: number) => {
    if (closed) throw operatorStopped(); await io.clock();
    const chain = z.object({ chain: z.literal('regtest'), initialblockdownload: z.literal(false), blocks: z.number().int().positive(), bestblockhash: z.string() })
      .parse(await clients.bitcoin.call('getblockchaininfo'));
    for (const [node, identity, peer, payerSide] of [[clients.provider, policy.providerNode, policy.payerNode, false], [clients.payer, policy.payerNode, policy.providerNode, true]] as const) {
      await assertRecoveryNode(node, identity);
      const info = z.object({ block_height: z.number().int(), block_hash: z.string(), num_peers: z.number().int().positive() }).parse(await node.call('/v1/getinfo'));
      if (info.block_height !== chain.blocks || info.block_hash !== chain.bestblockhash) throw operatorStopped();
      const response = z.object({ channels: z.array(z.object({ chan_id: z.string(), channel_point: z.string(), remote_pubkey: z.string(), active: z.boolean(),
        pending_htlcs: z.array(z.unknown()), unsettled_balance: z.string(), local_balance: z.string(), remote_balance: z.string(), commit_fee: z.string(),
        local_constraints: z.object({ chan_reserve_sat: z.string() }), remote_constraints: z.object({ chan_reserve_sat: z.string() }) })) }).parse(await node.call('/v1/channels'));
      const active = response.channels.filter(c => c.active); const c = active[0];
      if (active.length !== 1 || !c || c.chan_id !== policy.routing.channelId || c.channel_point !== policy.routing.channelPoint || c.remote_pubkey !== peer ||
        c.pending_htlcs.length || c.unsettled_balance !== '0' ||
        BigInt(payerSide ? c.local_balance : c.remote_balance) - BigInt(payerSide ? c.local_constraints.chan_reserve_sat : c.remote_constraints.chan_reserve_sat) - BigInt(c.commit_fee) < BigInt(sourceAmountSats ?? 50_850)) throw operatorStopped();
    }
    // Fixed default external-address inventory is read-only; never derives a new address.
    const addresses = z.object({ account_with_addresses: z.array(z.object({ addresses: z.array(z.object({ address: z.string(), is_internal: z.boolean() })) })) })
      .parse(await clients.payer.call('/v2/wallet/addresses?account_name=default'));
    if (addresses.account_with_addresses.flatMap(a => a.addresses).filter(a => a.address === policy.claimDestination && !a.is_internal).length !== 1) throw operatorStopped();
    return chain;
  };
  const assemble = async (id: string, entry: PreparationEntry, fresh: boolean, marker?: { invoiceMayHaveBeenAttempted: boolean }): Promise<PreparedRuntime | undefined> => {
    if (closed || !/^[a-f0-9]{64}$/.test(id) || !z.uuid().safeParse(entry.attemptId).success || entry.ownerId !== policy.ownerId) throw operatorStopped();
    const sourceAmount = entry.sourceAmountSats;
    if (sourceAmount !== undefined && (!Number.isSafeInteger(sourceAmount) || sourceAmount < LEGACY_ECONOMICS.invoice.minSats ||
      sourceAmount > (policy.maxSourceAmountSats ?? policy.amountSats))) throw operatorStopped();
    const directory = join(policy.runsDirectory, entry.attemptId); const backupDirectory = join(policy.backupsDirectory, entry.attemptId);
    if (fresh) {
      try { await lstat(directory); if (marker) marker.invoiceMayHaveBeenAttempted = true; throw operatorStopped(); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { if (marker) marker.invoiceMayHaveBeenAttempted = true; throw error; } }
      const chain = await checkOwnerAndNodes(sourceAmount);
      const minimumInputSats = minimumFundingInput(sourceAmount);
      const coins = z.array(z.object({ txid: z.string().regex(/^[a-f0-9]{64}$/), vout: z.number().int().nonnegative(), amount: z.number(),
        confirmations: z.number().int(), scriptPubKey: z.string(), safe: z.boolean(), spendable: z.boolean(), solvable: z.boolean() })).max(1000)
        .parse(await clients.bitcoin.call('listunspent', [1, 9999999, [], false, { maximumCount: 1000 }], true));
      if (coins.length === 1000 || new Set(coins.map(c => `${c.txid}:${c.vout}`)).size !== coins.length) throw operatorStopped();
      const locks = z.array(z.object({ txid: z.string(), vout: z.number() })).parse(await clients.bitcoin.call('listlockunspent', [], true));
      const candidates = coins.filter(c => c.safe && c.spendable && c.solvable && c.confirmations > 0 && /^0014[a-f0-9]{40}$/.test(c.scriptPubKey) &&
        Number.isSafeInteger(Math.round(c.amount * 1e8)) && Math.round(c.amount * 1e8) / 1e8 === c.amount && Math.round(c.amount * 1e8) >= minimumInputSats &&
        Math.round(c.amount * 1e8) <= policy.maxInputSats && !locks.some(l => l.txid === c.txid && l.vout === c.vout))
        .sort((a, b) => a.amount - b.amount || a.txid.localeCompare(b.txid) || a.vout - b.vout).slice(0, 20);
      let input: { txid: string; vout: number; valueSats: number } | undefined;
      for (const candidate of candidates) {
        const coin = z.object({ coinbase: z.boolean(), value: z.number(), confirmations: z.number().int().positive() }).nullable()
          .parse(await clients.bitcoin.call('gettxout', [candidate.txid, candidate.vout, true]));
        if (coin && !coin.coinbase && coin.value === candidate.amount) { input = { txid: candidate.txid, vout: candidate.vout, valueSats: Math.round(coin.value * 1e8) }; break; }
      }
      if (!input) throw operatorStopped();
      await mkdir(directory, { mode: 0o700 }); await mkdir(backupDirectory, { mode: 0o700 });
      const custodyPolicy = ownedRunPolicySchema.parse({ ...Object.fromEntries(Object.entries(policy).filter(([key]) =>
        ['ownerUsername','ownerId','authStorePath','wallet','origin','port','providerNode','payerNode','routing','claimDestination','refundDestination','credentialPaths'].includes(key))),
        tipHeight: chain.blocks, input, backupDirectory, ...(entry.sourceAmountSats === undefined ? {} : { sourceAmountSats: entry.sourceAmountSats }) });
      await operatorArtifact(directory, 'admission.json', { id, entry, policyDigest: sha256(Buffer.from(JSON.stringify(policy))) });
      await operatorArtifact(directory, 'owner-policy.json', custodyPolicy);
      await prepareOwnedRunCustody(directory, custodyPolicy, password);
    }
    await operatorDirectory(directory);
    const admission = JSON.parse((await protectedBytes(join(directory, 'admission.json'))).toString());
    if (admission.id !== id || admission.entry.attemptId !== entry.attemptId || admission.entry.ownerId !== entry.ownerId ||
      admission.policyDigest !== sha256(Buffer.from(JSON.stringify(policy)))) throw operatorStopped();
    const ready = z.object({ artifacts: z.record(z.string(), z.string()) }).parse(JSON.parse((await protectedBytes(join(directory, 'custody-ready.json'))).toString()));
    const spec = preparationSpecSchema.parse(await checkedJSON(join(directory, 'spec.json'), ready.artifacts['spec.json']!));
    if (spec.wallet !== policy.wallet || spec.sourceAmountSats !== entry.sourceAmountSats) throw operatorStopped();
    const backup = backupSchema.parse(await checkedJSON(join(directory, 'custody-backup.json'), ready.artifacts['custody-backup.json']!));
    let store: Store | undefined; let client: SecretVault | undefined; let refund: SecretVault | undefined;
    let concrete: JitExecutor | undefined; let underlying: Promise<unknown> | undefined; let stopped = false;
    try {
      store = await Store.open(join(directory, 'store')); const current = store;
      const recoveryPayer = new LndPayerRecovery(clients.recoveryPayer, spec.payerNode, h => {
        if (h !== spec.client.paymentHash) throw operatorStopped(); return { routing: spec.routing, providerNode: spec.providerNode };
      });
      const recovery = createReverseRecovery(current, {
        assertRegtest: async () => { await clients.bitcoin.assertRegtest(); await assertRecoveryNode(clients.provider, spec.providerNode); await assertRecoveryNode(clients.recoveryPayer, spec.payerNode); },
        invoice: h => clients.provider.lookup(h), confirmed: h => clients.bitcoin.confirmed(h),
        tip: async () => z.object({ blocks: z.number().int() }).parse(await clients.bitcoin.call('getblockchaininfo')).blocks,
      }, recoveryPayer);
      const api = createOwnedReverseApi(current, sessionOwnerAuthenticator(sessions), { origin: policy.origin, recovery });
      if (fresh) {
        client = await SecretVault.open(join(directory, 'client-secrets'), password); refund = await SecretVault.open(join(directory, 'provider-refund-keys'), password);
        await verifyCustodyBackup(directory, spec, backup, password);
        const inspected = await io.inspect(policy.actions, policy.credentialPaths); await io.probe(spec, policy.actions, inspected, clients.bitcoin);
        const custody = persistedReadinessCustody(client, new RefundKeyVault(refund));
        const harness = createLndReversePreparation(current, spec, { ...clients, custody }, { id: spec.id, specDigest: preparationDigest(spec),
          scope: 'isolated-regtest-invoice-only', expiresAt: Date.now() + 180000 }, 'prepare');
        if (!('prepare' in harness)) throw operatorStopped();
        if (marker) marker.invoiceMayHaveBeenAttempted = true;
        const result = await harness.prepare();
        await operatorArtifact(directory, 'prepared-public.json', result);
      } else {
        const prep = current.read().reversePreparations?.[spec.id];
        if (!prep?.swapId) throw operatorStopped();
        if (prep.status !== 'READY') {
          client = await SecretVault.open(join(directory, 'client-secrets'), password); refund = await SecretVault.open(join(directory, 'provider-refund-keys'), password);
          await createLndReversePreparation(current, spec, { ...clients, custody: persistedReadinessCustody(client, new RefundKeyVault(refund)) }, undefined, 'recover')
            .recover(current.read().swaps[prep.swapId]!.revision);
        }
      }
      const swapId = current.read().reversePreparations![spec.id]!.swapId!;
      await api.bind(policy.ownerId, swapId, spec.claimDestination);
      const stop = () => { stopped = true; concrete?.stopClient(); };
      let approvedUntil = 0;
      const authorize = async (reviewId: string) => {
        if (stopped) throw operatorStopped();
        if (approvedUntil > Date.now()) return; // Same valid approval, never extend it by replay.
        await checkOwnerAndNodes(spec.sourceAmountSats);
        await assertRecoveryNode(clients.recoveryPayer, spec.payerNode);
        const before = current.read(); const swap = before.swaps[swapId]!;
        if (Object.keys(before.jitExecutions ?? {}).length || Object.keys(before.controlledExecutions ?? {}).length ||
          Object.values(before.ownedReverse?.requests ?? {}).some(r => r.kind === 'EXECUTE')) throw operatorStopped();
        // Prove complete payer history has no matching payment before granting a new unused envelope.
        verifyAbsentHistory(await clients.recoveryPayer.call(recoveryPaymentsPath), spec.client.paymentHash);
        client ??= await SecretVault.open(join(directory, 'client-secrets'), password); refund ??= await SecretVault.open(join(directory, 'provider-refund-keys'), password);
        await verifyCustodyBackup(directory, spec, backup, password);
        const readers = createLndJitReaders(current, spec, { ...clients, custody: persistedReadinessCustody(client, new RefundKeyVault(refund)) });
        const checked = await createJustInTimeReverse(current, spec, readers).review();
        const inspected = await io.inspect(policy.actions, policy.credentialPaths); await io.probe(spec, policy.actions, inspected, clients.bitcoin);
        const issuedAt = Date.now(); const authority = { id: randomUUID(), termsDigest: checked.termsDigest,
          scope: 'isolated-regtest-one-requote-and-execute' as const, issuedAt,
          startBefore: Math.min(issuedAt + 600000, checked.invoiceExpiresAt - 150000), maxBlocks: 2 as const,
          quoteLifetimeMs: 120000 as const, executionWindowMs: 90000 as const };
        if (authority.startBefore <= issuedAt || JSON.stringify(current.read().swaps[swapId]) !== JSON.stringify(swap)) throw operatorStopped();
        await operatorArtifact(directory, `review-${reviewId}.json`, { authority, specSha256: ready.artifacts['spec.json'] });
        const executor: JitExecutor = { execute(context) {
          const guard = () => { if (stopped || context.signal.aborted) throw operatorStopped(); context.guard(); };
          concrete = io.executor(current, { ...io.actions(spec, policy.actions, policy.credentialPaths, inspected, clients, guard),
            clientVault: client!, refundKeys: new RefundKeyVault(refund!) });
          underlying = concrete.execute(context); return underlying as ReturnType<JitExecutor['execute']>;
        }, stopClient: stop };
        api.replaceExpiredApproval({ ownerId: policy.ownerId, swapId, expectedRevision: checked.revision, termsDigest: checked.termsDigest,
          expiresAt: authority.startBefore,
          execute: () => withMiningLock(() => createJustInTimeReverse(current, spec, readers, authority, executor).run()) });
        approvedUntil = authority.startBefore;
      };
      let shutdown: Promise<void> | undefined;
      const runtime: PreparedRuntime = { swapId, api, authorize,
        async terminal() {
          const db = current.read(); const swap = db.swaps[swapId]!;
          if (swap.state === 'COMPLETED') {
            if (swap.clientPayment?.status !== 'SUCCEEDED' || !swap.lockup || !swap.claimTxid ||
              !Object.values(db.ownedReverse?.requests ?? {}).some(r => r.swapId === swapId && r.kind === 'EXECUTE' && r.status === 'SUCCEEDED') ||
              !Object.values(db.controlledExecutions ?? {}).some(r => r.swapId === swapId && r.status === 'COMPLETED')) return;
            client?.close(); refund?.close(); client = refund = undefined; return 'COMPLETED';
          }
          if (swap.clientPayment || swap.pendingAction || swap.fundingIntent || swap.lockup || swap.clientClaimIntent ||
            Object.keys(db.jitExecutions ?? {}).length || Object.values(db.ownedReverse?.requests ?? {}).some(r => r.kind === 'EXECUTE')) return;
          await clients.bitcoin.assertRegtest(); await assertRecoveryNode(clients.provider, spec.providerNode);
          await assertRecoveryNode(clients.recoveryPayer, spec.payerNode);
          const invoice = await clients.provider.lookup(spec.client.paymentHash);
          if (invoice.state !== 'CANCELED' || invoice.amt_paid_sat !== '0' || invoice.htlcs?.length) return;
          verifyAbsentHistory(await clients.recoveryPayer.call(recoveryPaymentsPath), spec.client.paymentHash);
          api.revokeUnusedApproval(swapId); approvedUntil = 0; return 'EXPIRED';
        },
        close() { return shutdown ??= (async () => { stop(); await api.drain(); await underlying?.catch(() => {}); client?.close(); refund?.close(); await current.close(); opened.delete(runtime); })(); },
      };
      if (fresh) await authorize(entry.attemptId);
      opened.add(runtime);
      return runtime;
    } catch (error) {
      concrete?.stopClient(); await underlying?.catch(() => {}); client?.close(); refund?.close(); await store?.close(); throw error;
    }
  };
  return { prepare: async (id, entry) => {
      const marker = { invoiceMayHaveBeenAttempted: false };
      try { return (await assemble(id, entry, true, marker))!; }
      catch (error) { if (!marker.invoiceMayHaveBeenAttempted) throw new PreparationRejected('Regtest prerequisites rejected before invoice preparation'); throw error; }
    }, restore: (id, entry) => assemble(id, entry, false),
    async preflight() {
      const chain = await checkOwnerAndNodes(policy.maxSourceAmountSats);
      const inspected = await io.inspect(policy.actions, policy.credentialPaths);
      // Public placeholders for the wallet-scope probe only; no contract, key generation,
      // invoice, input reservation or execution capability is created by this check.
      const spec = preparationSpecSchema.parse({ id: randomUUID(), isolationId: randomUUID(), tipHeight: chain.blocks, wallet: policy.wallet,
        providerNode: policy.providerNode, payerNode: policy.payerNode, routing: policy.routing,
        client: { paymentHash: '00'.repeat(32), claimPublicKey: policy.payerNode }, refundPublicKey: policy.providerNode,
        claimDestination: policy.claimDestination, refundDestination: policy.refundDestination,
        input: { txid: '00'.repeat(32), vout: 0, valueSats: 61000 } });
      const coreScope = await io.probe(spec, policy.actions, inspected, clients.bitcoin);
      const archives = [];
      for (const archive of policy.archives) {
        const archivedSpec = archivedPreparationSpecSchema.parse(await checkedJSON(join(archive.directory, 'spec.json'), archive.specSha256));
        const db = JSON.parse((await protectedBytes(join(archive.directory, 'store/state.json'))).toString());
        archives.push(await verifyArchivedChain(db, archivedSpec, policy.ownerId, policy.claimDestination, clients.bitcoin));
      }
      return { status: 'REGTEST_PROFILE_CHECKED_NO_INVOICE_OR_PAYMENT', height: chain.blocks, network: 'regtest',
        providerNode: policy.providerNode, payerNode: policy.payerNode, channelId: policy.routing.channelId, claimDestination: policy.claimDestination,
        coreScope, archives, permissions: { provider: inspected.settle.permissions, payer: inspected.pay.permissions } };
    },
    async history() {
      const result: PreparedRuntime[] = [];
      for (const archive of policy.archives) {
        await operatorDirectory(archive.directory);
        const spec = archivedPreparationSpecSchema.parse(await checkedJSON(join(archive.directory, 'spec.json'), archive.specSha256));
        if (spec.providerNode !== policy.providerNode || spec.payerNode !== policy.payerNode || spec.claimDestination !== policy.claimDestination ||
          spec.refundDestination !== policy.refundDestination || JSON.stringify(spec.routing) !== JSON.stringify(policy.routing)) throw operatorStopped();
        const store = await Store.open(join(archive.directory, 'store')); let shutdown: Promise<void> | undefined;
        try {
          const db = store.read(); const swaps = Object.values(db.swaps); const swap = swaps[0];
          if (swaps.length !== 1 || !swap || swap.state !== 'COMPLETED' || swap.clientPayment?.status !== 'SUCCEEDED' || !swap.lockup || !swap.claimTxid ||
            db.ownedReverse?.owners[swap.id]?.ownerId !== policy.ownerId || swap.contract.paymentHash !== spec.client.paymentHash) throw operatorStopped();
          await verifyArchivedChain(db, spec, policy.ownerId, policy.claimDestination, clients.bitcoin);
          const api = createOwnedReverseApi(store, sessionOwnerAuthenticator(sessions), { origin: policy.origin });
          if (api.list(policy.ownerId).length !== 1) throw operatorStopped();
          const runtime: PreparedRuntime = { swapId: swap.id, api, authorize: async () => { throw operatorStopped(); }, terminal: async () => 'COMPLETED',
            close() { return shutdown ??= (async () => { await api.drain(); await store.close(); opened.delete(runtime); })(); } };
          opened.add(runtime); result.push(runtime);
        } catch (error) { await store.close(); throw error; }
      }
      return result;
    },
    async close() { closed = true; try { await Promise.all([...opened].map(r => r.close())); } finally { password.fill(0); } } };
}
