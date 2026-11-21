import { createHash, randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { Transaction, address, networks } from 'bitcoinjs-lib';
import { z } from 'zod';
import type { Store } from '../persistence/Store.js';
import { Store as StoreFile } from '../persistence/Store.js';
import type { Database, Swap } from '../core/SwapTypes.js';
import { GuestAdmission } from './GuestAdmission.js';
import { invoiceBudget } from '../core/SwapManager.js';
import { preparationSpecSchema, preparationDigest, type PreparationSpec, type PreparationApproval } from '../core/ReversePreparation.js';
import { createLndReversePreparation } from '../core/LndReversePreparation.js';
import { reverseRoutingSchema, type ReverseTestPlan } from '../core/ReverseTestPlan.js';
import { verifyHtlcSpend } from '../bitcoin/SpendEvidence.js';
import { HoldInvoiceManager } from '../lightning/HoldInvoiceManager.js';
import { updateSwapRevision } from '../core/SwapStateMachine.js';
import type { Invoice } from '../lightning/LndClient.js';
import type { GuestExecution } from './GuestExecution.js';
import { MiningLockBusyError, withMiningLock } from '../mining/MiningLock.js';
import { minerPauseFile, updateActiveSwapPause, type ActiveSwap } from '../mining/ActiveSwapPolicy.js';

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const pubkey = z.string().regex(/^(02|03)[a-f0-9]{64}$/);
const keyPattern = /^[A-Za-z0-9_-]{8,128}$/;
const prepareSchema = z.object({ recoveryCommitment: hash }).strict();
const claimSchema = z.object({ signedClaimHex: z.string().regex(/^[0-9a-f]+$/).min(20).max(200000),
  expectedRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER) }).strict();
const digest = (domain: string, ...parts: string[]) => {
  const value = createHash('sha256').update(domain);
  for (const part of parts) value.update('\0').update(part);
  return value.digest('hex');
};
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** The server never stores a claim private key or preimage. The client keeps the
 * recovery bundle; only its commitment and the capability hash are persisted. */
export const guestReversePolicySchema = z.object({ mode: z.literal('regtest'), isolationId: z.uuid(),
  providerNode: pubkey, payerNode: pubkey, routing: reverseRoutingSchema, refundPublicKey: pubkey,
  refundDestination: z.string().refine(value => {
    try { return value.startsWith('bcrt1') && address.toOutputScript(value, networks.regtest).length > 0; } catch { return false; }
  }),
  funding: z.object({ txid: hash, vout: z.number().int().nonnegative().max(0xffffffff),
    valueSats: z.number().int().min(61000).max(Number.MAX_SAFE_INTEGER) }).strict(),
  runsDirectory: z.string().refine(isAbsolute) }).strict();
export type GuestReversePolicy = z.infer<typeof guestReversePolicySchema>;

export type GuestReverseClients = {
  bitcoin: { origin: string; call<T>(method: string, params?: unknown[], wallet?: boolean): Promise<T>;
    confirmed(txid: string): Promise<{ hex: string; confirmations: number }> };
  provider: { origin: string; call<T>(path: string, body?: unknown): Promise<T>;
    assertRegtest(): Promise<{ chains: Array<{ chain: string; network: string }>; synced_to_chain: boolean }> };
  payer: { origin: string; call<T>(path: string, body?: unknown): Promise<T>;
    assertRegtest(): Promise<{ chains: Array<{ chain: string; network: string }>; synced_to_chain: boolean }> };
  invoices: { origin: string;
    create(request: { hash: string; sats: number; expirySeconds: number; cltvDelta: number },
      beforeRequest: () => Promise<void>, signal?: AbortSignal): Promise<{ payment_request: string }>;
    lookup(paymentHash: string, signal?: AbortSignal): Promise<{ status: 'ABSENT' } | { status: 'PRESENT'; invoice: Invoice }> };
  tip(): Promise<number>;
  now?: () => number;
};

export type GuestPrepared = { plan: ReverseTestPlan; swapId: string; invoice: string; invoiceExpiresAt: number };
export type GuestPreparation = { prepare(): Promise<GuestPrepared> };
export type GuestPreparationFactory = (store: Store, spec: PreparationSpec,
  clients: GuestReverseClients, approval: PreparationApproval) => GuestPreparation;
export type GuestStoreFactory = (directory: string) => Promise<Store>;

export class GuestReverseError extends Error {
  constructor(readonly status: number, readonly code: string) { super(code); }
}

const realPreparation: GuestPreparationFactory = (store, spec, clients, approval) => {
  // `mode: 'prepare'` returns the harness; the union return type is narrowed here.
  const harness = createLndReversePreparation(store, spec, {
    bitcoin: clients.bitcoin, provider: clients.provider, payer: clients.payer, invoices: clients.invoices,
    // Public-only custody: the client keeps the private claim key and preimage.
    custody: async () => ({ paymentHash: spec.client.paymentHash, claimPublicKey: spec.client.claimPublicKey,
      refundPublicKey: spec.refundPublicKey }),
  }, approval, 'prepare') as { prepare(): Promise<{ plan: ReverseTestPlan; request: { swapId: string } }> };
  return { async prepare() {
    const prepared = await harness.prepare();
    const swap = store.read().swaps[prepared.request.swapId];
    if (!swap?.invoice) throw new Error('Prepared invoice missing');
    return { plan: prepared.plan, swapId: prepared.request.swapId, invoice: swap.invoice,
      invoiceExpiresAt: (clients.now ?? Date.now)() + prepared.plan.invoiceExpirySeconds * 1000 };
  } };
};

const recoveryFields = ['capabilityToken', 'swapId', 'paymentHash', 'claimPublicKey', 'claimPrivateKey',
  'preimage', 'destination', 'refundPublicKey', 'timeoutHeight', 'htlcAddress', 'witnessScript'] as const;

/** Guest-capability reverse preparation. The quote admission is reused as the
 * guest identity; every invoice/claim mutation is fenced by a durable attempt.
 * It never signs a claim, never reveals the preimage and never treats an
 * ACCEPTED hold invoice as settled.
 */
export class GuestReverse {
  readonly admission: GuestAdmission;
  private readonly policy: GuestReversePolicy;
  private readonly clients: GuestReverseClients;
  private readonly preparation: GuestPreparationFactory;
  private readonly broadcast?: (hex: string) => Promise<string>;
  private readonly storeFactory: GuestStoreFactory;
  private readonly now: () => number;
  private readonly execution?: GuestExecution;
  private readonly lock: <T>(work: () => Promise<T>) => Promise<T>;
  private readonly pauseFile: string;
  private readonly queues = new Map<string, Promise<unknown>>();
  private timer?: ReturnType<typeof setInterval>;

  constructor(private readonly store: Store, policy: unknown, clients: GuestReverseClients,
    options: { preparation?: GuestPreparationFactory; broadcast?: (hex: string) => Promise<string>;
      storeFactory?: GuestStoreFactory; execution?: GuestExecution;
      lock?: <T>(work: () => Promise<T>) => Promise<T>; lockFile?: string; pauseFile?: string } = {}) {
    this.policy = guestReversePolicySchema.parse(policy);
    if (this.policy.providerNode === this.policy.payerNode ||
      this.policy.routing.providerOrigin === this.policy.routing.payerOrigin ||
      this.policy.routing.bitcoinOrigin !== clients.bitcoin.origin ||
      this.policy.routing.providerOrigin !== clients.provider.origin ||
      this.policy.routing.payerOrigin !== clients.payer.origin ||
      this.policy.routing.providerOrigin !== clients.invoices.origin) throw new Error('Guest reverse endpoints or nodes differ');
    this.clients = clients; this.preparation = options.preparation ?? realPreparation;
    this.broadcast = options.broadcast; this.storeFactory = options.storeFactory ?? (directory => StoreFile.open(directory));
    this.execution = options.execution;
    this.lock = options.lock ?? (<T>(work: () => Promise<T>) => withMiningLock(work, { lockFile: options.lockFile }));
    this.pauseFile = options.pauseFile ?? minerPauseFile();
    this.now = clients.now ?? Date.now; this.admission = new GuestAdmission(store, this.now);
  }

  /** Step 1: capability-authenticated quote (existing admission primitive). */
  async quote(authorization: string | undefined, idempotencyKey: string, raw: unknown) {
    return this.admission.reserve(authorization, idempotencyKey, raw);
  }

  /** Step 2: create one hold invoice only after the client commits to a recovery
   * bundle. A repeated key returns the same invoice; an uncertain RPC consumes
   * the attempt and can never create a second invoice automatically. */
  async prepare(admissionId: string, authorization: string | undefined, idempotencyKey: string, raw: unknown) {
    const admission = this.admission.status(admissionId, authorization);
    if (!admission) throw new GuestReverseError(404, 'GUEST_NOT_FOUND');
    const now = this.now();
    if (admission.expiresAt <= now) throw new GuestReverseError(410, 'GUEST_QUOTE_EXPIRED');
    const input = prepareSchema.parse(raw);
    if (!keyPattern.test(idempotencyKey)) throw new GuestReverseError(400, 'IDEMPOTENCY_KEY_REQUIRED');
    const budget = invoiceBudget(admission.invoiceSats);
    for (const key of ['amountSats', 'serviceFeeSats', 'invoiceSats', 'fundingReserveSats', 'claimFeeSats'] as const)
      if (admission[key] !== budget[key]) throw new GuestReverseError(409, 'GUEST_TERMS_MISMATCH');
    const requestKey = digest('guest-prepare-v2', admissionId, idempotencyKey);
    const fingerprint = digest('guest-prepare-terms-v1', JSON.stringify({ admissionId, recoveryCommitment: input.recoveryCommitment }));
    const existing = this.store.read().guestSwaps?.[admissionId];
    if (existing) {
      if (existing.requestKey !== requestKey || existing.fingerprint !== fingerprint) throw new GuestReverseError(409, 'GUEST_PREPARE_CONFLICT');
      if (existing.status === 'PREPARING') throw new GuestReverseError(409, 'GUEST_PREPARE_IN_PROGRESS');
      if (existing.status === 'PREPARATION_UNKNOWN') throw new GuestReverseError(503, 'GUEST_PREPARATION_UNCERTAIN');
      if (existing.status === 'EXPIRED') throw new GuestReverseError(410, 'GUEST_QUOTE_EXPIRED');
      return this.status(admissionId, authorization);
    }
    const attemptId = randomUUID(); const runDirectory = join(this.policy.runsDirectory, admissionId);
    await this.store.transaction(db => {
      if (db.guestSwaps?.[admissionId]) throw new GuestReverseError(409, 'GUEST_PREPARE_IN_PROGRESS');
      (db.guestSwaps ??= {})[admissionId] = { id: admissionId, admissionId, requestKey, fingerprint,
        recoveryCommitment: input.recoveryCommitment, status: 'PREPARING', attemptId, runDirectory,
        createdAt: now, updatedAt: now };
    });
    let prepared: GuestPrepared;
    try {
      const tip = await this.clients.tip();
      if (!Number.isSafeInteger(tip) || tip < 1 || tip > 499_999_969) throw new GuestReverseError(503, 'GUEST_CHAIN_UNAVAILABLE');
      const spec = preparationSpecSchema.parse({ id: admissionId, isolationId: this.policy.isolationId, tipHeight: tip,
        providerNode: this.policy.providerNode, payerNode: this.policy.payerNode, routing: this.policy.routing,
        client: { paymentHash: admission.paymentHash, claimPublicKey: admission.claimPublicKey },
        sourceAmountSats: admission.invoiceSats, refundPublicKey: this.policy.refundPublicKey,
        claimDestination: admission.destination, refundDestination: this.policy.refundDestination, input: this.policy.funding });
      const approval: PreparationApproval = { id: spec.id, specDigest: preparationDigest(spec),
        scope: 'isolated-regtest-invoice-only', expiresAt: now + 120000 };
      prepared = await this.withRun(admissionId, runDirectory, async runStore => {
        const result = await this.preparation(runStore, spec, this.clients, approval).prepare();
        this.assertPrepared(admission, result.plan);
        return result;
      });
    } catch (error) {
      await this.store.transaction(db => {
        const row = db.guestSwaps?.[admissionId];
        if (row?.attemptId === attemptId && row.status === 'PREPARING') { row.status = 'PREPARATION_UNKNOWN'; row.updatedAt = this.now(); }
      }).catch(() => {});
      if (error instanceof GuestReverseError) throw error;
      throw new GuestReverseError(503, 'GUEST_PREPARATION_UNCERTAIN');
    }
    await this.store.transaction(db => {
      const row = db.guestSwaps?.[admissionId];
      if (!row || row.attemptId !== attemptId || row.status !== 'PREPARING') throw new GuestReverseError(503, 'GUEST_PREPARATION_UNCERTAIN');
      row.status = 'INVOICE_CREATED'; row.swapId = prepared.swapId; row.invoice = prepared.invoice;
      row.invoiceExpiresAt = prepared.invoiceExpiresAt; row.timeoutHeight = prepared.plan.contract.timeoutHeight;
      row.updatedAt = this.now();
    });
    return this.status(admissionId, authorization);
  }

  /** Read-only projection; it never creates, pays, signs, settles, broadcasts or mines. */
  async status(admissionId: string, authorization: string | undefined) {
    const admission = this.admission.status(admissionId, authorization);
    if (!admission) throw new GuestReverseError(404, 'GUEST_NOT_FOUND');
    const row = this.store.read().guestSwaps?.[admissionId];
    if (!row) return this.quoteView(admission);
    if (row.status !== 'INVOICE_CREATED') return this.rowView(row, admission, row.status === 'PREPARATION_UNKNOWN'
      ? 'PREPARATION_UNKNOWN' : row.status);
    let run: { swap?: Swap; plan?: ReverseTestPlan } | undefined;
    try {
      run = await this.withRun(admissionId, row.runDirectory, async runStore => {
        const db = runStore.read(); const swap = row.swapId ? db.swaps[row.swapId] : undefined;
        const plan = db.reversePreparations?.[admissionId]?.plan;
        return { swap: swap ? structuredClone(swap) : undefined, plan: plan ? structuredClone(plan) : undefined };
      });
    } catch { return this.rowView(row, admission, 'MANUAL_REVIEW'); }
    if (!run?.swap || !run.plan) return this.rowView(row, admission, 'MANUAL_REVIEW');
    let invoice: Invoice | undefined; let invoiceState = 'UNKNOWN';
    try {
      const found = await this.clients.invoices.lookup(admission.paymentHash);
      if (found.status === 'PRESENT') { invoice = found.invoice; invoiceState = found.invoice.state; } else invoiceState = 'ABSENT';
    } catch { invoiceState = 'UNKNOWN'; }
    const state = await this.classify(admission, run.swap, invoice, invoiceState);
    return this.rowView(row, admission, state, run.swap, run.plan, invoiceState);
  }

  /** Step 3: verify and broadcast the client's signed claim exactly once. No
   * server-side key or preimage is used. Without an injected broadcaster the
   * endpoint stays closed. */
  async submitClaim(admissionId: string, authorization: string | undefined, idempotencyKey: string, raw: unknown) {
    const admission = this.admission.status(admissionId, authorization);
    if (!admission) throw new GuestReverseError(404, 'GUEST_NOT_FOUND');
    if (!this.broadcast) throw new GuestReverseError(503, 'GUEST_BROADCAST_NOT_CONFIGURED');
    const input = claimSchema.parse(raw);
    if (!keyPattern.test(idempotencyKey)) throw new GuestReverseError(400, 'IDEMPOTENCY_KEY_REQUIRED');
    const row = this.store.read().guestSwaps?.[admissionId];
    if (!row || row.status !== 'INVOICE_CREATED' || !row.swapId) throw new GuestReverseError(409, 'GUEST_INVOICE_NOT_READY');
    const txid = Transaction.fromHex(input.signedClaimHex).getId();
    const requestKey = digest('guest-claim-v2', admissionId, idempotencyKey);
    const fingerprint = digest('guest-claim-terms-v1', JSON.stringify({ admissionId, txid, expectedRevision: input.expectedRevision }));
    if (row.claim) {
      if (row.claim.requestKey !== requestKey || row.claim.fingerprint !== fingerprint) throw new GuestReverseError(409, 'GUEST_CLAIM_CONFLICT');
      if (row.claim.status === 'BROADCAST') return this.claimView(row, txid);
      if (row.claim.status === 'UNKNOWN') throw new GuestReverseError(503, 'GUEST_CLAIM_UNCERTAIN');
      throw new GuestReverseError(409, 'GUEST_CLAIM_IN_PROGRESS');
    }
    const result = await this.withRun(admissionId, row.runDirectory, async runStore => {
      try {
        return await this.lock(async () => {
          const swap = runStore.read().swaps[row.swapId!];
          if (!swap || !swap.lockup || !['LOCKUP_BROADCAST', 'LOCKUP_CONFIRMED'].includes(swap.state) || swap.revision !== input.expectedRevision)
            throw new GuestReverseError(409, 'GUEST_CLAIM_NOT_READY');
          if (swap.clientClaimIntent) {
            if (swap.clientClaimIntent.txid === txid && swap.clientClaimIntent.status === 'BROADCAST') {
              await this.recordClaim(row, requestKey, fingerprint, txid, admission, 'BROADCAST');
              return this.claimView(row, txid, swap.revision);
            }
            throw new GuestReverseError(409, 'GUEST_CLAIM_CONFLICT');
          }
          const manager = await this.assertAccepted(admission, swap);
          this.verifyClaim(swap, admission, input.signedClaimHex);
          const tip = await this.clients.tip();
          if (!Number.isSafeInteger(tip) || tip > swap.contract.timeoutHeight - 10) throw new GuestReverseError(409, 'GUEST_CLTV_WINDOW_CLOSED');
          const updated = await updateSwapRevision(runStore, swap.id, swap.revision, value => {
            if (value.clientClaimIntent || value.state !== swap.state || !value.lockup) throw new GuestReverseError(409, 'GUEST_CLAIM_CONFLICT');
            value.clientClaimIntent = { txid, destination: admission.destination, feeSats: value.quote.claimFeeSats, status: 'INTENT' };
          });
          await this.recordClaim(row, requestKey, fingerprint, txid, admission, 'INTENT');
          try {
            this.verifyClaim(updated, admission, input.signedClaimHex);
            const after = await this.clients.invoices.lookup(admission.paymentHash);
            if (after.status !== 'PRESENT') throw new Error('invoice uncertain');
            manager.assertAccepted(after.invoice, admission.paymentHash, updated.quote.invoiceSats, updated.contract.timeoutHeight, 40);
            if (await this.clients.tip() > updated.contract.timeoutHeight - 10) throw new Error('claim window closed');
            if (await this.broadcast!(input.signedClaimHex) !== txid) throw new Error('claim broadcast identity mismatch');
          } catch {
            await runStore.transaction(db => {
              const value = db.swaps[updated.id];
              if (value?.clientClaimIntent?.txid === txid && value.clientClaimIntent.status === 'INTENT') value.clientClaimIntent.status = 'UNKNOWN';
            }).catch(() => {});
            await this.recordClaim(row, requestKey, fingerprint, txid, admission, 'UNKNOWN').catch(() => {});
            throw new GuestReverseError(503, 'GUEST_CLAIM_UNCERTAIN');
          }
          const final = await updateSwapRevision(runStore, updated.id, updated.revision, value => {
            if (value.clientClaimIntent?.txid !== txid || value.clientClaimIntent.status !== 'INTENT')
              throw new GuestReverseError(409, 'GUEST_CLAIM_CONFLICT');
            value.clientClaimIntent.status = 'BROADCAST';
          });
          await this.recordClaim(row, requestKey, fingerprint, txid, admission, 'BROADCAST');
          return this.claimView(row, txid, final.revision);
        });
      } catch (error) {
        if (error instanceof MiningLockBusyError) throw new GuestReverseError(503, 'GUEST_EXECUTION_LOCK_BUSY');
        throw error;
      }
    });
    await this.refreshMiningPause().catch(() => {});
    return result;
  }

  private async assertAccepted(admission: NonNullable<ReturnType<GuestAdmission['status']>>, swap: Swap) {
    const found = await this.clients.invoices.lookup(admission.paymentHash);
    if (found.status !== 'PRESENT') throw new GuestReverseError(503, 'GUEST_INVOICE_UNCERTAIN');
    const manager = new HoldInvoiceManager({ lookup: async () => found.invoice,
      settle: async () => { throw new Error('Guest backend cannot settle'); },
      cancel: async () => { throw new Error('Guest backend cannot cancel'); } });
    manager.assertAccepted(found.invoice, admission.paymentHash, swap.quote.invoiceSats, swap.contract.timeoutHeight, 40);
    return manager;
  }

  private verifyClaim(swap: Swap, admission: NonNullable<ReturnType<GuestAdmission['status']>>, raw: string): Transaction {
    if (!swap.lockup) throw new GuestReverseError(409, 'GUEST_LOCKUP_MISSING');
    if (swap.contract.paymentHash !== admission.paymentHash || swap.contract.claimPublicKey !== admission.claimPublicKey ||
      swap.contract.refundPublicKey !== this.policy.refundPublicKey) throw new GuestReverseError(409, 'GUEST_CONTRACT_DIFFERS');
    let tx: Transaction;
    try {
      tx = Transaction.fromHex(raw);
      const evidence = verifyHtlcSpend(raw, tx.getId(), swap.lockup.hex, swap.lockup.vout, swap.contract);
      if (evidence.kind !== 'claim' || tx.ins.length !== 1 || tx.outs.length !== 1) throw new Error();
    } catch { throw new GuestReverseError(409, 'GUEST_CLAIM_INVALID'); }
    if (tx.outs[0]!.value !== BigInt(swap.quote.amountSats - swap.quote.claimFeeSats) ||
      !Buffer.from(tx.outs[0]!.script).equals(address.toOutputScript(admission.destination, networks.regtest)))
      throw new GuestReverseError(409, 'GUEST_CLAIM_INVALID');
    return tx;
  }

  private async classify(admission: NonNullable<ReturnType<GuestAdmission['status']>>, swap: Swap,
    invoice: Invoice | undefined, invoiceState: string) {
    // Any substitution of the guest's public terms is uncertainty, never completion.
    if (swap.contract.paymentHash !== admission.paymentHash || swap.contract.claimPublicKey !== admission.claimPublicKey ||
      swap.contract.refundPublicKey !== this.policy.refundPublicKey || swap.quote.invoiceSats !== admission.invoiceSats ||
      swap.quote.amountSats !== admission.amountSats || swap.quote.claimFeeSats !== admission.claimFeeSats ||
      swap.quote.serviceFeeSats !== admission.serviceFeeSats || swap.quote.fundingReserveSats !== admission.fundingReserveSats ||
      (invoice !== undefined && swap.invoice !== undefined && invoice.payment_request !== swap.invoice)) return 'MANUAL_REVIEW';
    if (swap.state === 'COMPLETED') {
      if (!swap.claimTxid || !swap.lockup || invoiceState !== 'SETTLED' || !invoice) return 'MANUAL_REVIEW';
      try {
        const manager = new HoldInvoiceManager({ lookup: async () => invoice,
          settle: async () => { throw new Error('read-only'); }, cancel: async () => { throw new Error('read-only'); } });
        manager.assertSettled(invoice, admission.paymentHash, swap.quote.invoiceSats);
        const claim = await this.clients.bitcoin.confirmed(swap.claimTxid);
        if (!Number.isSafeInteger(claim.confirmations) || claim.confirmations < 1) return 'MANUAL_REVIEW';
        if (verifyHtlcSpend(claim.hex, swap.claimTxid, swap.lockup.hex, swap.lockup.vout, swap.contract).kind !== 'claim') return 'MANUAL_REVIEW';
        const spend = Transaction.fromHex(claim.hex);
        if (spend.outs.length !== 1 || spend.outs[0]!.value !== BigInt(swap.quote.amountSats - swap.quote.claimFeeSats) ||
          !Buffer.from(spend.outs[0]!.script).equals(address.toOutputScript(admission.destination, networks.regtest))) return 'MANUAL_REVIEW';
      } catch { return 'MANUAL_REVIEW'; }
      return 'COMPLETED';
    }
    if (swap.state === 'LIGHTNING_SETTLED') return 'LIGHTNING_SETTLED_PENDING_CHAIN_EVIDENCE';
    if (swap.state === 'CLAIM_DETECTED') return 'CLAIM_DETECTED_NOT_SETTLED';
    if (swap.state === 'LOCKUP_BROADCAST' || swap.state === 'LOCKUP_CONFIRMED') return 'FUNDED_AWAITING_CLAIM';
    if (swap.state === 'INVOICE_ACCEPTED') return 'PAYMENT_ACCEPTED_NOT_SETTLED';
    if (swap.state === 'INVOICE_CREATED') {
      if (invoiceState === 'ACCEPTED') return 'PAYMENT_ACCEPTED_NOT_SETTLED';
      if (invoiceState === 'SETTLED') return 'MANUAL_REVIEW';
      if (invoiceState === 'CANCELED') return 'EXPIRED';
      if (invoiceState === 'UNKNOWN' || invoiceState === 'ABSENT') return invoiceState === 'UNKNOWN' ? 'UNKNOWN' : 'MANUAL_REVIEW';
      return 'INVOICE_CREATED';
    }
    if (swap.state === 'MANUAL_REVIEW') return 'MANUAL_REVIEW';
    if (swap.state === 'EXPIRED' || swap.state === 'REFUNDED' || swap.state === 'FAILED') return swap.state;
    return 'MANUAL_REVIEW';
  }

  private assertPrepared(admission: NonNullable<ReturnType<GuestAdmission['status']>>, plan: ReverseTestPlan) {
    if (plan.network !== 'regtest' || plan.providerNode !== this.policy.providerNode || plan.payerNode !== this.policy.payerNode ||
      !same(plan.routing, this.policy.routing) || plan.claimDestination !== admission.destination ||
      plan.refundDestination !== this.policy.refundDestination || plan.contract.paymentHash !== admission.paymentHash ||
      plan.contract.claimPublicKey !== admission.claimPublicKey || plan.contract.refundPublicKey !== this.policy.refundPublicKey ||
      plan.quote.invoiceSats !== admission.invoiceSats || plan.quote.amountSats !== admission.amountSats ||
      plan.quote.serviceFeeSats !== admission.serviceFeeSats || plan.quote.claimFeeSats !== admission.claimFeeSats ||
      plan.quote.fundingReserveSats !== admission.fundingReserveSats || plan.contract.timeoutHeight !== plan.tipHeight + 30)
      throw new GuestReverseError(503, 'GUEST_PREPARATION_UNCERTAIN');
  }

  private quoteView(admission: NonNullable<ReturnType<GuestAdmission['status']>>) {
    return { ...admission, recovery: { serverStoresClientSecrets: false as const, requiredBeforePayment: recoveryFields } };
  }

  private rowView(row: NonNullable<Database['guestSwaps']>[string], admission: NonNullable<ReturnType<GuestAdmission['status']>>,
    status: string, swap?: Swap, plan?: ReverseTestPlan, invoiceState?: string) {
    return { id: row.id, status, network: 'regtest' as const, destination: admission.destination,
      paymentHash: admission.paymentHash, claimPublicKey: admission.claimPublicKey, refundPublicKey: this.policy.refundPublicKey,
      amountSats: admission.amountSats, invoiceSats: admission.invoiceSats, serviceFeeSats: admission.serviceFeeSats,
      claimFeeSats: admission.claimFeeSats, fundingReserveSats: admission.fundingReserveSats, expiresAt: admission.expiresAt,
      recoveryCommitment: row.recoveryCommitment, swapId: row.swapId ?? null, invoice: row.invoice ?? null,
      invoiceExpiresAt: row.invoiceExpiresAt ?? null, invoiceState: invoiceState ?? null,
      swapState: swap?.state ?? null, fundingTxid: swap?.lockup?.txid ?? null, claimTxid: swap?.claimTxid ?? null,
      timeoutHeight: swap?.contract.timeoutHeight ?? plan?.contract.timeoutHeight ?? null,
      htlcAddress: plan?.address ?? null, witnessScript: plan?.witnessScript ?? null,
      claimIntent: swap?.clientClaimIntent ? { txid: swap.clientClaimIntent.txid, status: swap.clientClaimIntent.status,
        feeSats: swap.clientClaimIntent.feeSats } : null,
      recovery: { commitment: row.recoveryCommitment, serverStoresClientSecrets: false as const,
        requiredBeforePayment: recoveryFields } };
  }

  private claimView(row: NonNullable<Database['guestSwaps']>[string], txid: string, revision?: number) {
    return { id: row.id, status: 'CLAIM_BROADCAST_PENDING_CONFIRMATION' as const, network: 'regtest' as const,
      swapId: row.swapId ?? null, claimTxid: txid, revision: revision ?? null,
      invoiceState: 'ACCEPTED_NOT_SETTLED' as const, recoveryCommitment: row.recoveryCommitment };
  }

  private async recordClaim(row: NonNullable<Database['guestSwaps']>[string], requestKey: string, fingerprint: string,
    txid: string, admission: NonNullable<ReturnType<GuestAdmission['status']>>, status: 'INTENT' | 'BROADCAST' | 'UNKNOWN') {
    await this.store.transaction(db => {
      const current = db.guestSwaps?.[row.id];
      if (!current || current.attemptId !== row.attemptId) throw new GuestReverseError(503, 'GUEST_STATE_CHANGED');
      if (current.claim && (current.claim.requestKey !== requestKey || current.claim.txid !== txid))
        throw new GuestReverseError(409, 'GUEST_CLAIM_CONFLICT');
      current.claim = { requestKey, fingerprint, txid, destination: admission.destination, feeSats: admission.claimFeeSats, status };
      current.updatedAt = this.now();
    });
  }

  /** Recompute the DS-02 timer pause marker from durable guest rows and live
   * invoice evidence. It never overwrites an explicit operator pause. */
  async refreshMiningPause() {
    const active: ActiveSwap[] = [];
    for (const row of Object.values(this.store.read().guestSwaps ?? {})) {
      if (row.status !== 'INVOICE_CREATED') continue;
      let swap: Swap | undefined;
      try {
        swap = await this.withRun(row.id, row.runDirectory, async runStore =>
          row.swapId ? runStore.read().swaps[row.swapId] : undefined);
      } catch { /* keep the conservative row deadline below */ }
      if (!swap) {
        active.push({ id: row.id, state: 'UNKNOWN', timeoutHeight: row.timeoutHeight ?? Number.MAX_SAFE_INTEGER, updatedAt: this.now() });
        continue;
      }
      let invoiceState = 'UNKNOWN';
      try {
        const found = await this.clients.invoices.lookup(swap.contract.paymentHash);
        invoiceState = found.status === 'PRESENT' ? found.invoice.state : 'ABSENT';
      } catch { invoiceState = 'UNKNOWN'; }
      const terminal = ['COMPLETED', 'REFUNDED', 'EXPIRED', 'FAILED'].includes(swap.state);
      const heightRisk = !!swap.clientPayment || !!swap.lockup || !!swap.fundingIntent ||
        ['INVOICE_ACCEPTED', 'LOCKUP_BROADCAST', 'LOCKUP_CONFIRMED', 'CLAIM_DETECTED', 'LIGHTNING_SETTLED',
          'MANUAL_REVIEW', 'REFUND_PENDING'].includes(swap.state) || invoiceState === 'ACCEPTED' || invoiceState === 'UNKNOWN';
      if (!terminal && heightRisk) active.push({ id: swap.id, state: swap.state,
        timeoutHeight: swap.contract.timeoutHeight, updatedAt: this.now() });
    }
    await updateActiveSwapPause(this.pauseFile, active);
  }

  /** Disabled-by-default lifecycle watcher. With no injected execution this
   * only reads evidence; it never funds, settles, completes or expires. */
  async runOnce() {
    await this.refreshMiningPause();
    let scanned = 0; let updated = 0;
    for (const row of Object.values(this.store.read().guestSwaps ?? {})) {
      if (row.status !== 'INVOICE_CREATED' || !row.swapId) continue;
      scanned++;
      try {
        updated += await this.withRun(row.id, row.runDirectory, async runStore => {
          let swap = runStore.read().swaps[row.swapId!];
          const plan = runStore.read().reversePreparations?.[row.id]?.plan;
          if (!swap || !plan || !same(swap.contract, plan.contract) || !same(swap.quote, plan.quote)) return 0;
          if (swap.state === 'MANUAL_REVIEW' || swap.pendingAction ||
            swap.clientClaimIntent?.status === 'UNKNOWN' || swap.clientClaimIntent?.status === 'INTENT') return 0;
          const found = await this.clients.invoices.lookup(plan.contract.paymentHash).catch(() => undefined);
          if (!found || found.status !== 'PRESENT') return 0;
          const invoice = found.invoice; let changes = 0;
          const manager = new HoldInvoiceManager({ lookup: async () => invoice,
            settle: async () => { throw new Error('Guest watcher cannot settle directly'); },
            cancel: async () => { throw new Error('Guest watcher cannot cancel directly'); } });
          if (invoice.state === 'CANCELED') {
            if (!swap.lockup && !swap.fundingIntent && !swap.pendingAction && !swap.clientClaimIntent && this.execution) {
              await this.execution.expire(runStore, swap); changes++;
            }
            return changes;
          }
          if (invoice.state === 'ACCEPTED' && swap.state === 'INVOICE_CREATED' &&
              !swap.lockup && !swap.fundingIntent && !swap.pendingAction &&
              (!swap.clientPayment || swap.clientPayment.status === 'IN_FLIGHT')) {
            manager.assertAccepted(invoice, plan.contract.paymentHash, swap.quote.invoiceSats, swap.contract.timeoutHeight, 40);
            if (this.execution) { swap = await this.execution.fund(runStore, swap, plan); changes++; }
          }
          if (swap.state === 'LOCKUP_BROADCAST' && this.execution) {
            swap = await this.execution.confirm(runStore, swap, plan); changes++;
          }
          if (swap.lockup && swap.claimTxid && swap.clientClaimIntent?.status === 'BROADCAST' &&
              (swap.state === 'LOCKUP_BROADCAST' || swap.state === 'LOCKUP_CONFIRMED')) {
            const claim = await this.clients.bitcoin.confirmed(swap.claimTxid).catch(() => undefined);
            if (claim && Number.isSafeInteger(claim.confirmations) && claim.confirmations >= 1) {
              verifyHtlcSpend(claim.hex, swap.claimTxid, swap.lockup.hex, swap.lockup.vout, swap.contract);
              const spend = Transaction.fromHex(claim.hex);
              if (spend.outs.length !== 1 || spend.outs[0]!.value !== BigInt(swap.quote.amountSats - swap.quote.claimFeeSats) ||
                !Buffer.from(spend.outs[0]!.script).equals(address.toOutputScript(plan.claimDestination, networks.regtest))) return changes;
              if (this.execution) { swap = await this.execution.settle(runStore, swap, plan, swap.claimTxid); changes++; }
            }
          }
          if (swap.state === 'LIGHTNING_SETTLED' && invoice.state === 'SETTLED' && this.execution) {
            swap = await this.execution.markPaid(runStore, swap, invoice); changes++;
            swap = await this.execution.complete(runStore, swap, plan); changes++;
          }
          return changes;
        });
      } catch { /* Keep the durable state for manual review; never retry here. */ }
    }
    return { scanned, updated };
  }

  /** Startup/restart reconciliation: same evidence checks and no-retry rule. */
  reconcile() { return this.runOnce(); }

  /** Explicit opt-in timer. The application does not call this by default. */
  start(intervalMs = 5000) {
    if (!this.execution) throw new GuestReverseError(503, 'GUEST_WATCHER_DISABLED');
    if (!Number.isSafeInteger(intervalMs) || intervalMs < 1000 || intervalMs > 60000) throw new Error('Invalid guest watch interval');
    if (this.timer) return;
    this.timer = setInterval(() => { void this.runOnce().catch(() => {}); }, intervalMs);
    this.timer.unref?.();
  }

  stop() { if (this.timer) clearInterval(this.timer); this.timer = undefined; }

  private withRun<T>(id: string, directory: string, work: (store: Store) => Promise<T>): Promise<T> {
    const previous = this.queues.get(id) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(async () => {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const run = await this.storeFactory(directory);
      try { return await work(run); } finally { await run.close(); }
    });
    this.queues.set(id, next.catch(() => {}));
    return next;
  }
}
