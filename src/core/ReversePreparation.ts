import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Store } from '../persistence/Store.js';
import type { Quote, Swap } from './SwapTypes.js';
import type { LndClient, Invoice } from '../lightning/LndClient.js';
import type { BitcoinRpcClient } from '../bitcoin/BitcoinRpcClient.js';
import type { ControlledRunReadiness } from './ControlledReverseBackend.js';
import type { ReadinessCustody } from './ControlledReadiness.js';
import { controlledRunDigest } from './ControlledReverseBackend.js';
import { createReverseTestPlan, reverseRoutingSchema, verifyReverseTestPlan } from './ReverseTestPlan.js';
import { MAX_OWNED_DEBIT_SATS, OWNED_ECONOMICS } from './Economics.js';
import { SwapManager, invoiceBudget } from './SwapManager.js';
import { invoiceOnlyPorts } from './InvoiceOnlyPorts.js';
import { transition, updateSwapRevision } from './SwapStateMachine.js';
import { verifyDecodedHoldInvoice } from '../lightning/InvoiceVerification.js';

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const pubkey = z.string().regex(/^(02|03)[a-f0-9]{64}$/);
export const preparationSpecSchema = z.object({ id: z.uuid(), isolationId: z.uuid(), tipHeight: z.number().int().positive().max(499999969),
  wallet: z.string().regex(/^[A-Za-z0-9._-]{1,120}$/),
  providerNode: pubkey, payerNode: pubkey, routing: reverseRoutingSchema,
  client: z.object({ paymentHash: hash, claimPublicKey: pubkey }).strict(), refundPublicKey: pubkey,
  sourceAmountSats: z.number().int().min(11000).max(MAX_OWNED_DEBIT_SATS).optional(),
  claimDestination: z.string(), refundDestination: z.string(),
  input: z.object({ txid: hash, vout: z.number().int().nonnegative().max(0xffffffff),
    valueSats: z.number().int().min(61000).max(Number.MAX_SAFE_INTEGER) }).strict(),
}).strict();
export type PreparationSpec = z.infer<typeof preparationSpecSchema>;
export const preparationApprovalSchema = z.object({ id: z.uuid(), specDigest: hash, scope: z.literal('isolated-regtest-invoice-only'),
  expiresAt: z.number().int().positive().max(Number.MAX_SAFE_INTEGER) }).strict();
export type PreparationApproval = z.infer<typeof preparationApprovalSchema>;
type InvoiceRequest = Readonly<{ hash: string; sats: number; expirySeconds: number; cltvDelta: number }>;
export type PreparationAdapters = {
  bitcoin: Pick<BitcoinRpcClient, 'origin' | 'call' | 'confirmed'>;
  provider: Pick<LndClient, 'origin' | 'assertRegtest' | 'call' | 'lookup'>;
  payer: Pick<LndClient, 'origin' | 'assertRegtest' | 'call'>;
  custody: ReadinessCustody;
  /** Definitive read-only hash lookup; transport/authentication failures must yield UNKNOWN or throw. */
  invoiceStatus(paymentHash: string): Promise<'ABSENT' | 'PRESENT' | 'UNKNOWN'>;
  /** Trusted operator adapter must derive this using createControlledReadiness for this store/swap.
   * No HTTP caller may supply evidence or install adapters.
   */
  inspect(swapId: string, plan: ReturnType<typeof verifyReverseTestPlan>, spec: PreparationSpec): Promise<ControlledRunReadiness>;
  /** Must await beforeRequest exactly once after credentials load and immediately before POST.
   * No retry/fallback is permitted. Existing LndClient.addHoldInvoice lacks this wire hook.
   */
  createInvoice(request: InvoiceRequest, beforeRequest: () => Promise<void>): Promise<{ payment_request: string }>;
  now?: () => number;
};
const stopped = () => new Error('Reverse preparation unavailable or uncertain; inspect existing evidence without retry');
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const legacyBudget = { amountSats: 50000, serviceFeeSats: 750, invoiceSats: 50750, fundingReserveSats: 1000, claimFeeSats: 500 };

export function preparationDigest(value: PreparationSpec) {
  return createHash('sha256').update(JSON.stringify(preparationSpecSchema.parse(value))).digest('hex');
}

/** Local invoice-only preparation. Existing fresh, durable custody is required; this harness
 * never generates/replaces keys, grants execution authority, or installs node transports.
 */
export function createReversePreparation(store: Store, supplied: PreparationSpec, adapters: PreparationAdapters,
  suppliedApproval?: PreparationApproval) {
  const spec = preparationSpecSchema.parse(structuredClone(supplied)); const digest = preparationDigest(spec);
  const budget = spec.sourceAmountSats === undefined ? legacyBudget : invoiceBudget(spec.sourceAmountSats, OWNED_ECONOMICS.invoice);
  const approval = suppliedApproval ? preparationApprovalSchema.parse(structuredClone(suppliedApproval)) : undefined;
  const now = adapters.now ?? Date.now;
  const planFor = (quote: Quote) => createReverseTestPlan(quote, spec.tipHeight, spec.client, spec.refundPublicKey,
    { claim: spec.claimDestination, refund: spec.refundDestination }, { provider: spec.providerNode, payer: spec.payerNode }, spec.routing, spec.wallet);
  // Validate contract keys, destinations and routing before any adapter or store mutation.
  planFor({ id: spec.id, ...budget, expiresAt: now() + 120000 });
  const boundPlan = (value: unknown) => {
    const plan = verifyReverseTestPlan(value); const expected = planFor(plan.quote); expected.createdAt = plan.createdAt;
    if (Object.entries(budget).some(([key, amount]) => plan.quote[key as keyof typeof budget] !== amount)) throw stopped();
    if (!same(plan, expected)) throw stopped(); return plan;
  };
  const endpoints = () => {
    if (adapters.bitcoin.origin !== spec.routing.bitcoinOrigin || adapters.provider.origin !== spec.routing.providerOrigin ||
      adapters.payer.origin !== spec.routing.payerOrigin) throw stopped();
  };
  endpoints();
  const authorize = () => {
    endpoints();
    if (!approval || approval.id !== spec.id || approval.specDigest !== digest || approval.expiresAt <= now()) throw stopped();
  };
  const entry = () => {
    const current = store.read().reversePreparations?.[spec.id];
    if (!current || current.specDigest !== digest) throw stopped();
    if (current.plan) boundPlan(current.plan); return current;
  };
  const owned = (attemptId: string, status: 'INTENT' | 'RECONCILING') => {
    const current = entry();
    if (current.attemptId !== attemptId || current.status !== status) throw stopped(); return current;
  };
  const exactSwap = (plan: ReturnType<typeof verifyReverseTestPlan>, swapId: string) => {
    const db = store.read(); const swap = db.swaps[swapId];
    if (!swap || !same(swap.quote, plan.quote) || !same(db.quotes[plan.quote.id], plan.quote) || !same(swap.contract, plan.contract) ||
      swap.clientPayment || swap.lockup || swap.fundingIntent || swap.clientClaimIntent || swap.miningIntents?.length ||
      Object.values(db.controlledExecutions ?? {}).length || Object.values(db.swaps).some(s => s.id !== swapId)) throw stopped();
    return swap;
  };
  const nodesAndCustody = async () => {
    endpoints();
    const core = z.object({ chain: z.literal('regtest'), blocks: z.number().int(), initialblockdownload: z.literal(false) })
      .parse(await adapters.bitcoin.call('getblockchaininfo'));
    const info = z.object({ identity_pubkey: pubkey, wallet_synced: z.literal(true), synced_to_chain: z.literal(true),
      chains: z.array(z.object({ chain: z.literal('bitcoin'), network: z.literal('regtest') })).length(1) });
    const p = info.parse(await adapters.provider.call('/v1/getinfo')); const a = info.parse(await adapters.payer.call('/v1/getinfo'));
    if (core.blocks < spec.tipHeight || core.blocks > spec.tipHeight + 10 || p.identity_pubkey !== spec.providerNode || a.identity_pubkey !== spec.payerNode) throw stopped();
    const sats = z.string().regex(/^(0|[1-9][0-9]{0,15})$/).refine(v => BigInt(v) <= BigInt(Number.MAX_SAFE_INTEGER));
    const channel = z.object({ channels: z.array(z.object({ chan_id: z.string(), channel_point: z.string(), remote_pubkey: pubkey,
      active: z.literal(true), zero_conf: z.literal(false), local_balance: sats, remote_balance: sats, commit_fee: sats,
      unsettled_balance: z.literal('0'), pending_htlcs: z.array(z.unknown()).length(0),
      local_constraints: z.object({ chan_reserve_sat: sats }), remote_constraints: z.object({ chan_reserve_sat: sats }) })).length(1) });
    let incoming = BigInt(Number.MAX_SAFE_INTEGER);
    for (const [client, peer] of [[adapters.provider, spec.payerNode], [adapters.payer, spec.providerNode]] as const) {
      const c = channel.parse(await client.call('/v1/channels')).channels[0]!;
      if (c.chan_id !== spec.routing.channelId || c.channel_point !== spec.routing.channelPoint || c.remote_pubkey !== peer) throw stopped();
      const available = client === adapters.payer
        ? BigInt(c.local_balance) - BigInt(c.local_constraints.chan_reserve_sat) - BigInt(c.commit_fee)
        : BigInt(c.remote_balance) - BigInt(c.remote_constraints.chan_reserve_sat) - BigInt(c.commit_fee);
      if (available < BigInt(budget.invoiceSats + 100)) throw stopped(); if (available < incoming) incoming = available;
    }
    const keys = await adapters.custody(spec.client.paymentHash);
    if (keys.paymentHash !== spec.client.paymentHash || keys.claimPublicKey !== spec.client.claimPublicKey || keys.refundPublicKey !== spec.refundPublicKey) throw stopped();
    endpoints(); return { incomingSats: Number(incoming) };
  };
  const unusedHash = async () => {
    if (await adapters.invoiceStatus(spec.client.paymentHash) !== 'ABSENT') throw stopped();
  };
  const verifyInvoice = async (plan: ReturnType<typeof verifyReverseTestPlan>, invoice: Invoice) => {
    if (!/^lnbcrt[0-9a-z]{20,4096}$/.test(invoice.payment_request) || invoice.state !== 'OPEN' ||
      invoice.r_hash !== Buffer.from(spec.client.paymentHash, 'hex').toString('base64') || invoice.value !== String(budget.invoiceSats) || invoice.amt_paid_sat !== '0' ||
      invoice.htlcs?.some(h => h.state === 'ACCEPTED' || h.state === 'SETTLED')) throw stopped();
    verifyDecodedHoldInvoice(invoice.payment_request, await adapters.payer.call(`/v1/payreq/${invoice.payment_request}`), {
      paymentHash: spec.client.paymentHash, payeePublicKey: spec.providerNode, invoiceSats: plan.quote.invoiceSats, minFinalCltv: plan.invoiceCltvDelta }, now());
  };
  const verifyReadiness = async (swap: Swap, plan: ReturnType<typeof verifyReverseTestPlan>) => {
    const observed = await adapters.inspect(swap.id, structuredClone(plan), structuredClone(spec));
    if (observed.network !== 'regtest' || observed.isolationId !== spec.isolationId || observed.providerNode !== spec.providerNode ||
      observed.payerNode !== spec.payerNode || observed.paymentHash !== spec.client.paymentHash || observed.claimPublicKey !== spec.client.claimPublicKey ||
      observed.refundPublicKey !== spec.refundPublicKey || !Number.isSafeInteger(observed.tipHeight) || observed.tipHeight < spec.tipHeight ||
      observed.tipHeight > spec.tipHeight + 10 || observed.funding.confirmed !== true || observed.funding.safe !== true || observed.funding.spendable !== true ||
      observed.funding.txid !== spec.input.txid || observed.funding.vout !== spec.input.vout || observed.funding.valueSats !== spec.input.valueSats) throw stopped();
    if (!swap.invoice) throw stopped();
    verifyDecodedHoldInvoice(swap.invoice, observed.decodedInvoice, { paymentHash: spec.client.paymentHash,
      payeePublicKey: spec.providerNode, invoiceSats: budget.invoiceSats, minFinalCltv: 80 }, now());
  };
  const finish = async (attemptId: string, status: 'INTENT' | 'RECONCILING', expectedPlan: ReturnType<typeof verifyReverseTestPlan>) => {
    const current = owned(attemptId, status); const plan = boundPlan(current.plan);
    if (!same(plan, expectedPlan)) throw stopped();
    if (!current.swapId || !current.invoiceAttempt?.wireAuthorized || plan.quote.expiresAt <= now()) throw stopped();
    const swap = exactSwap(plan, current.swapId); const snapshot = structuredClone(swap);
    if (swap.state !== 'INVOICE_CREATED' || swap.pendingAction || !swap.invoice) throw stopped();
    await nodesAndCustody(); const invoice = await adapters.provider.lookup(spec.client.paymentHash);
    await verifyInvoice(plan, invoice); if (invoice.payment_request !== swap.invoice) throw stopped();
    await verifyReadiness(swap, plan);
    await nodesAndCustody();
    const after = await adapters.provider.lookup(spec.client.paymentHash); await verifyInvoice(plan, after);
    if (!same(invoice, after) || after.payment_request !== swap.invoice || plan.quote.expiresAt <= now()) throw stopped();
    await store.transaction(db => {
      owned(attemptId, status);
      if (!same(exactSwap(plan, swap.id), snapshot) || plan.quote.expiresAt <= now()) throw stopped();
      const record = db.reversePreparations![spec.id]!;
      record.executionRequest = { id: randomUUID(), swapId: swap.id, expectedRevision: swap.revision, isolationId: spec.isolationId,
        scope: 'isolated-regtest-reverse', maxBlocks: 2, expiresAt: Math.min(plan.quote.expiresAt, now() + 90000),
        planDigest: controlledRunDigest(plan, spec.input, swap.id, spec.isolationId) };
      record.status = 'READY';
    });
    return prepared();
  };
  const prepared = () => {
    endpoints(); const current = entry(); const plan = boundPlan(current.plan); const request = current.executionRequest;
    if (current.status !== 'READY' || !request || request.expiresAt <= now() || plan.quote.expiresAt <= now() || !current.swapId) throw stopped();
    const swap = exactSwap(plan, current.swapId);
    if (swap.state !== 'INVOICE_CREATED' || !swap.invoice || swap.pendingAction || swap.revision !== request.expectedRevision ||
      request.planDigest !== controlledRunDigest(plan, spec.input, swap.id, spec.isolationId)) throw stopped();
    return structuredClone({ status: 'PREPARED_UNPAID_NOT_AUTHORIZED' as const, plan,
      input: { txid: spec.input.txid, vout: spec.input.vout }, scope: { ...spec.routing, isolationId: spec.isolationId }, request });
  };
  const freshPrepared = async () => {
    const before = prepared(); const record = entry();
    await nodesAndCustody(); const invoice = await adapters.provider.lookup(spec.client.paymentHash);
    await verifyInvoice(before.plan, invoice);
    const swap = exactSwap(before.plan, before.request.swapId);
    if (invoice.payment_request !== swap.invoice) throw stopped();
    await verifyReadiness(swap, before.plan);
    await nodesAndCustody(); const after = await adapters.provider.lookup(spec.client.paymentHash);
    await verifyInvoice(before.plan, after); if (!same(invoice, after)) throw stopped();
    if (!same(entry(), record) || !same(prepared(), before)) throw stopped();
    return before;
  };
  const abandon = (attemptId: string) => store.transaction(db => {
    const current = db.reversePreparations?.[spec.id];
    if (current?.attemptId === attemptId && ['INTENT', 'RECONCILING'].includes(current.status)) current.status = 'UNKNOWN';
  });
  return {
    async prepare() {
      authorize();
      if (store.read().reversePreparations?.[spec.id]?.status === 'READY') return freshPrepared();
      const attemptId = randomUUID();
      await store.transaction(db => {
        authorize();
        if (Object.keys(db.reversePreparations ?? {}).length || Object.keys(db.swaps).length || Object.keys(db.quotes).length ||
          Object.keys(db.controlledExecutions ?? {}).length) throw stopped();
        (db.reversePreparations ??= {})[spec.id] = { specDigest: digest, attemptId, status: 'INTENT' };
      });
      try {
        const liquidity = await nodesAndCustody(); await unusedHash(); authorize(); owned(attemptId, 'INTENT');
        const manager = new SwapManager(store, OWNED_ECONOMICS); const quote = spec.sourceAmountSats === undefined ? await manager.quote(50000, now()) : await manager.quoteInvoice(spec.sourceAmountSats, now());
        const plan = planFor(quote);
        await store.transaction(db => { authorize(); owned(attemptId, 'INTENT'); db.reversePreparations![spec.id]!.plan = plan; });
        // One quote object, including ID and expiry, is used in the plan and persisted swap.
        const swap = await manager.create(quote.id, `prepare-${spec.id}`, plan.contract, spec.tipHeight,
          { onchainSats: spec.input.valueSats, incomingSats: liquidity.incomingSats }, now());
        await store.transaction(db => { owned(attemptId, 'INTENT'); db.reversePreparations![spec.id]!.swapId = swap.id; });
        const provider = {
          get origin() { return adapters.provider.origin; },
          assertRegtest: () => adapters.provider.assertRegtest(), call: adapters.provider.call.bind(adapters.provider), lookup: adapters.provider.lookup.bind(adapters.provider),
          async addHoldInvoice(paymentHash: string, sats: number, expirySeconds: number, cltvDelta: number) {
            authorize(); await nodesAndCustody();
            await store.transaction(db => {
              authorize(); const record = owned(attemptId, 'INTENT'); const s = exactSwap(plan, swap.id);
              if (!same(record.plan, plan)) throw stopped();
              if (s.state !== 'QUOTED' || s.pendingAction !== 'CREATE_INVOICE' || s.invoice || plan.quote.expiresAt <= now()) throw stopped();
              const draft = db.reversePreparations![spec.id]!;
              if (draft.invoiceAttempt || paymentHash !== spec.client.paymentHash || sats !== budget.invoiceSats || expirySeconds !== 3600 || cltvDelta !== 80) throw stopped();
              draft.invoiceAttempt = { attemptId: randomUUID(), revision: s.revision, wireAuthorized: false };
            });
            const response = await adapters.createInvoice(Object.freeze({ hash: paymentHash, sats, expirySeconds, cltvDelta }), async () => {
              await nodesAndCustody(); await unusedHash();
              await store.transaction(db => {
                authorize(); const record = owned(attemptId, 'INTENT'); const s = exactSwap(plan, swap.id);
                if (!same(record.plan, plan) || !record.invoiceAttempt || record.invoiceAttempt.wireAuthorized || s.revision !== record.invoiceAttempt.revision ||
                  s.state !== 'QUOTED' || s.pendingAction !== 'CREATE_INVOICE' || s.invoice || plan.quote.expiresAt <= now()) throw stopped();
                db.reversePreparations![spec.id]!.invoiceAttempt!.wireAuthorized = true;
              });
              authorize(); owned(attemptId, 'INTENT');
              if (plan.quote.expiresAt <= now() || exactSwap(plan, swap.id).revision !== entry().invoiceAttempt?.revision) throw stopped();
            });
            authorize(); if (!owned(attemptId, 'INTENT').invoiceAttempt?.wireAuthorized) throw stopped();
            return response;
          },
        };
        const ports = invoiceOnlyPorts(adapters.bitcoin, provider, adapters.payer, plan);
        const intent = await updateSwapRevision(store, swap.id, swap.revision, s => {
          authorize(); owned(attemptId, 'INTENT');
          if (!same(s, swap) || !same(exactSwap(plan, swap.id), swap)) throw stopped();
          s.pendingAction = 'CREATE_INVOICE';
        });
        await ports.assertRegtest();
        const invoice = await ports.createInvoice(intent);
        await updateSwapRevision(store, swap.id, intent.revision, s => {
          authorize(); owned(attemptId, 'INTENT');
          if (!same(s, intent) || !same(exactSwap(plan, swap.id), intent) || plan.quote.expiresAt <= now()) throw stopped();
          s.invoice = invoice; delete s.pendingAction; transition(s, 'INVOICE_CREATED');
        });
        return await finish(attemptId, 'INTENT', plan);
      } catch { await abandon(attemptId); throw stopped(); }
    },
    /** Read-only node reconciliation; fences an interrupted owner and never calls createInvoice. */
    async recover(expectedRevision: number) {
      endpoints(); const initial = entry();
      if (!initial.swapId || !initial.plan || !initial.invoiceAttempt || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0) throw stopped();
      if (initial.status === 'READY') {
        const result = await freshPrepared();
        if (result.request.expectedRevision !== expectedRevision) throw stopped(); return result;
      }
      const plan = boundPlan(initial.plan); const attemptId = randomUUID();
      await store.transaction(db => {
        if (!same(entry(), initial) || exactSwap(plan, initial.swapId!).revision !== expectedRevision) throw stopped();
        const record = db.reversePreparations![spec.id]!; record.attemptId = attemptId; record.status = 'RECONCILING';
      });
      try {
        owned(attemptId, 'RECONCILING'); await nodesAndCustody();
        const invoice = await adapters.provider.lookup(spec.client.paymentHash); await verifyInvoice(plan, invoice);
        const swap = exactSwap(plan, initial.swapId);
        if (!initial.invoiceAttempt.wireAuthorized || plan.quote.expiresAt <= now() || swap.revision !== expectedRevision) throw stopped();
        if (swap.state === 'QUOTED' && swap.pendingAction === 'CREATE_INVOICE' && !swap.invoice) {
          await updateSwapRevision(store, swap.id, swap.revision, s => {
            owned(attemptId, 'RECONCILING');
            if (!same(s, swap) || !same(exactSwap(plan, swap.id), swap)) throw stopped();
            s.invoice = invoice.payment_request; delete s.pendingAction; transition(s, 'INVOICE_CREATED');
          });
        } else if (swap.state !== 'INVOICE_CREATED' || swap.pendingAction || swap.invoice !== invoice.payment_request) throw stopped();
        return await finish(attemptId, 'RECONCILING', plan);
      } catch { await abandon(attemptId); throw stopped(); }
    },
  };
}
