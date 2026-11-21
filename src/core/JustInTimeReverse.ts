import { createHash, randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { z } from 'zod';
import type { Store } from '../persistence/Store.js';
import type { Invoice } from '../lightning/LndClient.js';
import { verifyDecodedHoldInvoice } from '../lightning/InvoiceVerification.js';
import { assertRecoveryNode } from '../lightning/LndPayerRecovery.js';
import { preparationSpecSchema, preparationDigest, type PreparationSpec, type PreparationAdapters } from './ReversePreparation.js';
import { verifyReverseTestPlan, createReverseTestPlan, type ReverseTestPlan } from './ReverseTestPlan.js';
import { controlledRunDigest, type ControlledRunApproval } from './ControlledReverseBackend.js';
import { SwapManager } from './SwapManager.js';
import type { Database } from './SwapTypes.js';

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fail = () => new Error('JIT reverse stopped; retain invoice and reconcile without retry');
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const time = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const jitAuthorizationSchema = z.object({ id: z.uuid(), termsDigest: hash,
  scope: z.literal('isolated-regtest-one-requote-and-execute'), issuedAt: time, startBefore: time,
  maxBlocks: z.literal(2), quoteLifetimeMs: z.literal(120000), executionWindowMs: z.literal(90000),
}).strict().refine(v => v.startBefore > v.issuedAt && v.startBefore - v.issuedAt <= 600000);
export type JitAuthorization = z.infer<typeof jitAuthorizationSchema>;
export type JitExecution = { plan: ReverseTestPlan; input: { txid: string; vout: number };
  scope: PreparationSpec['routing'] & { isolationId: string }; approval: ControlledRunApproval;
  guard(): void; signal: AbortSignal };
export type JitExecutor = { execute(context: JitExecution): Promise<{ id: string; state: string; revision: number }>;
  /** Observation shutdown only. Never cancel a remote payment or retry an action. */
  stopClient(): void };
export type JitReaders = Pick<PreparationAdapters, 'custody' | 'inspect'> & {
  bitcoin: Pick<PreparationAdapters['bitcoin'], 'origin' | 'call'>;
  provider: Pick<PreparationAdapters['provider'], 'origin' | 'call' | 'lookup'>;
  payer: Pick<PreparationAdapters['payer'], 'origin' | 'call'>;
};
type Clock = { now(): number; monotonic(): number };
type JitRecord = NonNullable<Database['jitExecutions']>[string];

/** One reviewed stable-terms envelope, one retained invoice, one explicit new quote and
 * immediate local execution. No invoice-creation capability or background retry exists.
 */
export function createJustInTimeReverse(store: Store, value: PreparationSpec, readers: JitReaders,
  suppliedAuthorization?: JitAuthorization, executor?: JitExecutor, clock: Clock = { now: Date.now, monotonic: () => performance.now() }) {
  const spec = preparationSpecSchema.parse(structuredClone(value));
  const authority = suppliedAuthorization ? jitAuthorizationSchema.parse(structuredClone(suppliedAuthorization)) : undefined;
  const initialDb = store.read(); const prep = initialDb.reversePreparations?.[spec.id];
  if (!prep?.plan || !prep.swapId || prep.status !== 'READY' || !prep.invoiceAttempt?.wireAuthorized || prep.specDigest !== preparationDigest(spec)) throw fail();
  const priorPlan = verifyReverseTestPlan(prep.plan); const initial = initialDb.swaps[prep.swapId];
  if (spec.sourceAmountSats !== undefined && priorPlan.quote.invoiceSats !== spec.sourceAmountSats) throw fail();
  const expected = createReverseTestPlan(priorPlan.quote, spec.tipHeight, spec.client, spec.refundPublicKey,
    { claim: spec.claimDestination, refund: spec.refundDestination }, { provider: spec.providerNode, payer: spec.payerNode }, spec.routing);
  expected.createdAt = priorPlan.createdAt;
  if (!same(priorPlan, expected) || !initial?.invoice || initial.state !== 'INVOICE_CREATED' || initial.pendingAction || initial.clientPayment ||
    initial.fundingIntent || initial.lockup || initial.clientClaimIntent || initial.claimTxid || initial.refundTxid || initial.miningIntents?.length ||
    !same(initial.quote, priorPlan.quote) || !same(initial.contract, priorPlan.contract) || !same(initialDb.quotes[initial.quote.id], initial.quote) ||
    Object.keys(initialDb.swaps).length !== 1 || Object.keys(initialDb.controlledExecutions ?? {}).length) throw fail();
  const termsDigest = digest({ spec, swapId: initial.id, revision: initial.revision, priorPlan,
    invoiceDigest: digest(initial.invoice), maxBlocks: 2, quoteLifetimeMs: 120000, executionWindowMs: 90000 });
  let lastWall = clock.now();
  const wall = () => { const now = clock.now(); if (!Number.isSafeInteger(now) || now < lastWall) throw fail(); lastWall = now; return now; };
  const endpoints = () => {
    if (readers.bitcoin.origin !== spec.routing.bitcoinOrigin || readers.provider.origin !== spec.routing.providerOrigin ||
      readers.payer.origin !== spec.routing.payerOrigin) throw fail();
  };
  endpoints();
  const unused = () => {
    const db = store.read();
    if (!same(db.swaps[initial.id], initial) || !same(db.reversePreparations?.[spec.id], prep) ||
      !same(db.quotes[priorPlan.quote.id], priorPlan.quote) || Object.keys(db.swaps).length !== 1 ||
      Object.keys(db.controlledExecutions ?? {}).length || Object.values(db.jitExecutions ?? {}).some(r => r.swapId === initial.id)) throw fail();
  };
  const verifyInvoice = async (invoice: Invoice, minimumLifeMs: number) => {
    if (invoice.state !== 'OPEN' || invoice.payment_request !== initial.invoice || invoice.r_hash !== Buffer.from(spec.client.paymentHash, 'hex').toString('base64') ||
      invoice.value !== String(priorPlan.quote.invoiceSats) || invoice.amt_paid_sat !== '0' || (invoice.htlcs?.length ?? 0) !== 0) throw fail();
    const raw = await readers.payer.call(`/v1/payreq/${invoice.payment_request}`);
    verifyDecodedHoldInvoice(invoice.payment_request, raw, { paymentHash: spec.client.paymentHash, payeePublicKey: spec.providerNode,
      invoiceSats: priorPlan.quote.invoiceSats, minFinalCltv: 80 }, wall());
    const decoded = z.object({ timestamp: z.string().regex(/^[0-9]+$/), expiry: z.string().regex(/^[0-9]+$/) }).parse(raw);
    const invoiceExpiresAt = (BigInt(decoded.timestamp) + BigInt(decoded.expiry)) * 1000n;
    if (invoiceExpiresAt <= BigInt(wall() + minimumLifeMs)) throw fail();
    return Number(invoiceExpiresAt);
  };
  const proof = async () => {
    endpoints();
    const chain = z.object({ chain: z.literal('regtest'), blocks: z.number().int(), initialblockdownload: z.literal(false) })
      .parse(await readers.bitcoin.call('getblockchaininfo'));
    await assertRecoveryNode(readers.provider, spec.providerNode); await assertRecoveryNode(readers.payer, spec.payerNode);
    if (chain.blocks < spec.tipHeight || chain.blocks > spec.tipHeight + 10) throw fail();
    const keys = await readers.custody(spec.client.paymentHash);
    if (keys.paymentHash !== spec.client.paymentHash || keys.claimPublicKey !== spec.client.claimPublicKey || keys.refundPublicKey !== spec.refundPublicKey) throw fail();
    const invoice = await readers.provider.lookup(spec.client.paymentHash); const invoiceExpiresAt = await verifyInvoice(invoice, 150000);
    endpoints(); return { invoice, invoiceExpiresAt, height: chain.blocks };
  };
  const bounded = async <T>(work: () => Promise<T>, deadline: number, stop?: () => void): Promise<T> => {
    const remaining = deadline - clock.monotonic(); if (remaining <= 0) { stop?.(); throw fail(); }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([work(), new Promise<never>((_, reject) => { timer = setTimeout(() => { stop?.(); reject(fail()); }, remaining); })]);
      if (clock.monotonic() >= deadline) { stop?.(); throw fail(); } return result;
    } finally { if (timer) clearTimeout(timer); }
  };
  return {
    /** Read-only; expired preparation quote is historical evidence, never permission to pay. */
    async review() {
      unused(); const result = await bounded(proof, clock.monotonic() + 30000); unused(); wall();
      return { status: 'RETAINED_UNPAID_REQUIRES_JIT_AUTHORITY' as const, termsDigest, swapId: initial.id, revision: initial.revision,
        priorQuote: structuredClone(priorPlan.quote), invoiceExpiresAt: result.invoiceExpiresAt, height: result.height,
        paymentHash: spec.client.paymentHash, executionApproved: false as const };
    },
    async run() {
      if (!authority || !executor || authority.termsDigest !== termsDigest || authority.issuedAt > wall() || authority.startBefore <= wall()) throw fail();
      unused();
      // Slow/human review happens before this call. Recheck the retained invoice before consuming the envelope.
      const checked = await bounded(proof, clock.monotonic() + Math.min(30000, authority.startBefore - wall()));
      unused(); if (authority.startBefore <= wall()) throw fail();
      const startedAt = wall(); const prepDeadline = clock.monotonic() + 30000;
      const controller = new AbortController(); let stopped = false;
      const stop = () => { if (stopped) return; stopped = true; controller.abort(); try { executor.stopClient(); } catch { /* Preserve uncertainty. */ } };
      let recordSnapshot: JitRecord = await store.transaction(db => {
        unused();
        if (authority.startBefore <= wall() || db.jitExecutions?.[authority.id]) throw fail();
        (db.jitExecutions ??= {})[authority.id] = { termsDigest, swapId: initial.id, priorRevision: initial.revision,
          priorPlan: structuredClone(priorPlan), authorization: structuredClone(authority), startedAt, status: 'INTENT' };
        return db.jitExecutions[authority.id]!;
      });
      const owned = (status: 'INTENT' | 'QUOTED' | 'EXECUTING') => {
        endpoints(); const db = store.read(); const record = db.jitExecutions?.[authority.id]; const current = db.swaps[initial.id];
        if (!record || !same(record, recordSnapshot) || record.status !== status || stopped ||
          !same(db.reversePreparations?.[spec.id], prep) || Object.keys(db.swaps).length !== 1 ||
          (record.plan && (!same(current?.quote, record.plan.quote) || !same(current?.contract, initial.contract) || current?.invoice !== initial.invoice ||
            !same(db.quotes[priorPlan.quote.id], priorPlan.quote) || !same(db.quotes[record.plan.quote.id], record.plan.quote)))) throw fail();
        return record;
      };
      try {
        if (authority.startBefore <= wall() || clock.monotonic() >= prepDeadline) throw fail();
        const quotedAt = wall(); const manager = new SwapManager(store);
        const quote = spec.sourceAmountSats === undefined ? await manager.quote(50000, quotedAt) : await manager.quoteInvoice(spec.sourceAmountSats, quotedAt);
        owned('INTENT');
        if (quote.expiresAt !== quotedAt + 120000) throw fail();
        for (const key of ['amountSats', 'serviceFeeSats', 'invoiceSats', 'fundingReserveSats', 'claimFeeSats'] as const) {
          if (quote[key] !== priorPlan.quote[key]) throw fail();
        }
        const plan = verifyReverseTestPlan({ ...priorPlan, quote });
        recordSnapshot = await store.transaction(db => {
          owned('INTENT');
          if (!same(db.swaps[initial.id], initial) || !same(db.reversePreparations?.[spec.id], prep) ||
            !same(db.quotes[quote.id], quote) || (db.quotes[priorPlan.quote.id] && !same(db.quotes[priorPlan.quote.id], priorPlan.quote)) ||
            Object.keys(db.controlledExecutions ?? {}).length || clock.monotonic() >= prepDeadline) throw fail();
          // Preserve original quote/plan/request unchanged. This is an explicit new quote, not expiry editing.
          db.quotes[priorPlan.quote.id] = structuredClone(priorPlan.quote);
          const swap = db.swaps[initial.id]!; swap.quote = structuredClone(quote); swap.revision++; swap.updatedAt = wall();
          const record = db.jitExecutions![authority.id]!; record.plan = plan; record.revision = swap.revision; record.status = 'QUOTED';
          return record;
        });
        const quotedSwap = store.read().swaps[initial.id]!;
        const readiness = await bounded(() => readers.inspect(initial.id, structuredClone(plan), structuredClone(spec)), prepDeadline, stop);
        owned('QUOTED');
        if (readiness.network !== 'regtest' || readiness.isolationId !== spec.isolationId || readiness.providerNode !== spec.providerNode ||
          readiness.payerNode !== spec.payerNode || readiness.paymentHash !== spec.client.paymentHash || readiness.claimPublicKey !== spec.client.claimPublicKey ||
          readiness.refundPublicKey !== spec.refundPublicKey || !Number.isSafeInteger(readiness.tipHeight) || readiness.tipHeight < spec.tipHeight ||
          readiness.tipHeight > spec.tipHeight + 10 || readiness.funding.txid !== spec.input.txid || readiness.funding.vout !== spec.input.vout ||
          readiness.funding.valueSats !== spec.input.valueSats || readiness.funding.confirmed !== true || readiness.funding.safe !== true || readiness.funding.spendable !== true) throw fail();
        verifyDecodedHoldInvoice(initial.invoice!, readiness.decodedInvoice, { paymentHash: spec.client.paymentHash, payeePublicKey: spec.providerNode,
          invoiceSats: priorPlan.quote.invoiceSats, minFinalCltv: 80 }, wall());
        const fresh = await bounded(proof, prepDeadline, stop);
        if (!same(fresh.invoice, checked.invoice) || !same(store.read().swaps[initial.id], quotedSwap) || quote.expiresAt - wall() < 90000 ||
          clock.monotonic() >= prepDeadline || authority.startBefore <= wall()) throw fail();
        const approval: ControlledRunApproval = { id: randomUUID(), swapId: initial.id, expectedRevision: quotedSwap.revision,
          isolationId: spec.isolationId, scope: 'isolated-regtest-reverse', maxBlocks: 2,
          expiresAt: wall() + 90000, planDigest: controlledRunDigest(plan, spec.input, initial.id, spec.isolationId) };
        const executionDeadline = clock.monotonic() + 90000;
        const guard = () => {
          owned('EXECUTING');
          if (wall() >= approval.expiresAt || clock.monotonic() >= executionDeadline || controller.signal.aborted) throw fail();
        };
        recordSnapshot = await store.transaction(db => {
          owned('QUOTED'); if (!same(db.swaps[initial.id], quotedSwap) || quote.expiresAt - wall() < 90000) throw fail();
          const record = db.jitExecutions![authority.id]!; record.status = 'EXECUTING'; record.approval = approval;
          return record;
        });
        guard();
        const result = await bounded(() => executor.execute({ plan: structuredClone(plan), input: { txid: spec.input.txid, vout: spec.input.vout },
          scope: { ...spec.routing, isolationId: spec.isolationId }, approval, guard, signal: controller.signal }), executionDeadline, stop);
        guard();
        const completed = store.read().swaps[initial.id]; const run = store.read().controlledExecutions?.[approval.id];
        if (result.id !== initial.id || result.state !== 'COMPLETED' || completed?.state !== 'COMPLETED' ||
          completed.revision !== result.revision || !same(completed.quote, quote) || !same(completed.contract, initial.contract) ||
          run?.status !== 'COMPLETED' || run.planDigest !== approval.planDigest) throw fail();
        recordSnapshot = await store.transaction(db => { owned('EXECUTING'); const record = db.jitExecutions![authority.id]!;
          record.status = 'COMPLETED'; return record; });
        return result;
      } catch {
        stop(); await store.transaction(db => {
          const record = db.jitExecutions?.[authority.id];
          if (same(record, recordSnapshot) && record && ['INTENT', 'QUOTED', 'EXECUTING'].includes(record.status)) record.status = 'UNKNOWN';
        }); throw fail();
      }
    },
  };
}
