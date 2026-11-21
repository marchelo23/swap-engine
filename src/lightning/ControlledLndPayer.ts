import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { setTimeout as delay } from 'node:timers/promises';
import type { Store } from '../persistence/Store.js';
import type { Swap } from '../core/SwapTypes.js';
import type { PaymentEvidence, ReverseTestControls } from '../core/ReverseTestRunner.js';
import { controlledRunDigest, type ControlledRunApproval } from '../core/ControlledReverseBackend.js';
import { verifyReverseTestPlan, type ReverseTestPlan } from '../core/ReverseTestPlan.js';
import type { ApprovedFundingInput } from '../bitcoin/ControlledFunding.js';
import type { LndClient } from './LndClient.js';
import { assertRecoveryNode } from './LndPayerRecovery.js';
import { verifyDecodedHoldInvoice } from './InvoiceVerification.js';
import { HoldInvoiceManager } from './HoldInvoiceManager.js';
import { trackPaymentPath, type PaymentStreamTransport } from './LndPaymentTransport.js';
import { verifyApprovedPaymentRoutes } from './LndRouteEvidence.js';

const integer = z.string().regex(/^(0|[1-9][0-9]{0,19})$/);
const eventSchema = z.object({ payment_hash: z.string().regex(/^[a-f0-9]{64}$/),
  status: z.enum(['INITIATED', 'IN_FLIGHT', 'SUCCEEDED', 'FAILED']), value_sat: integer, value_msat: integer,
  fee_sat: integer, fee_msat: integer, failure_reason: z.enum(['FAILURE_REASON_NONE', 'FAILURE_REASON_TIMEOUT', 'FAILURE_REASON_NO_ROUTE',
    'FAILURE_REASON_ERROR', 'FAILURE_REASON_INCORRECT_PAYMENT_DETAILS', 'FAILURE_REASON_INSUFFICIENT_BALANCE', 'FAILURE_REASON_CANCELED']) });
type Handle = Awaited<ReturnType<ReverseTestControls['startPayment']>>;
type Observation = { handle: Handle; controller: AbortController; inFlight: boolean };

/** Explicit controlled capability; never installed by HTTP startup. Stopping closes the local
 * client only. SendPaymentV2 uses cancelable=false: held HTLCs may still settle after shutdown.
 */
export class ControlledLndPayer {
  private readonly plan: ReverseTestPlan;
  private readonly approval: ControlledRunApproval;
  private readonly observations = new Map<string, Observation>();
  constructor(private readonly store: Store, plan: ReverseTestPlan, input: ApprovedFundingInput,
    approval: ControlledRunApproval, private readonly payer: Pick<LndClient, 'call' | 'origin'>,
    private readonly provider: Pick<LndClient, 'lookup' | 'origin'>, private readonly transport: PaymentStreamTransport,
    private readonly deadlineMs = 120000, private readonly pollMs = 250, private readonly executionGuard?: () => void) {
    this.plan = verifyReverseTestPlan(structuredClone(plan)); this.approval = structuredClone(approval);
    this.assertEndpoints();
    if (approval.planDigest !== controlledRunDigest(this.plan, input, approval.swapId, approval.isolationId) ||
      approval.scope !== 'isolated-regtest-reverse' || approval.maxBlocks !== 2 ||
      !Number.isSafeInteger(approval.expiresAt) || approval.expiresAt > this.plan.quote.expiresAt ||
      !Number.isSafeInteger(deadlineMs) || deadlineMs < 10 || deadlineMs > 300000 ||
      !Number.isSafeInteger(pollMs) || pollMs < 1 || pollMs > 1000) throw new Error('Invalid controlled payer authorization or bounds');
  }
  async startPayment(swap: Swap): Promise<Handle> {
    this.executionGuard?.();
    swap = structuredClone(swap);
    const attemptId = randomUUID();
    await this.store.transaction(db => {
      this.executionGuard?.();
      const current = db.swaps[swap.id]; const run = db.controlledExecutions?.[this.approval.id];
      if (this.approval.expiresAt <= Date.now() || swap.id !== this.approval.swapId || swap.revision !== this.approval.expectedRevision || !current ||
        current.revision !== swap.revision + 1 || current.state !== 'INVOICE_CREATED' || current.invoice !== swap.invoice ||
        JSON.stringify(current.contract) !== JSON.stringify(this.plan.contract) || JSON.stringify(current.quote) !== JSON.stringify(this.plan.quote) ||
        current.clientPayment?.status !== 'INTENT' || current.clientPayment.hash !== this.plan.contract.paymentHash ||
        current.clientPayment.feeLimitSats !== this.plan.routingFeeLimitSats || current.pendingAction || current.lockup ||
        !run || run.swapId !== swap.id || run.status !== 'INTENT' || run.planDigest !== this.approval.planDigest ||
        run.isolationId !== this.approval.isolationId || run.payerSend) {
        throw new Error('Payer send requires fresh durable authorized intent; reconcile instead of retrying');
      }
      if (JSON.stringify(run.routing) !== JSON.stringify(this.plan.routing) || run.providerNode !== this.plan.providerNode || run.payerNode !== this.plan.payerNode) throw new Error('Approved routing context missing or changed');
      run.payerSend = { attemptId, hash: this.plan.contract.paymentHash, status: 'INTENT' };
    });
    const observation = this.observe(false, swap.invoice!, attemptId);
    this.observations.set(swap.id, observation);
    return observation.handle;
  }
  /** Closes local observations only; LND cancelable=false leaves remote HTLCs intact. */
  stopObservations() { for (const observation of this.observations.values()) observation.controller.abort(); }
  /** Lookup stream only: no send fallback, no replay and no clearing UNKNOWN execution state. */
  trackExisting(paymentHash: string): Handle {
    const run = this.store.read().controlledExecutions?.[this.approval.id];
    if (paymentHash !== this.plan.contract.paymentHash || run?.swapId !== this.approval.swapId || run.planDigest !== this.approval.planDigest ||
      run.payerSend?.hash !== paymentHash || JSON.stringify(run.routing) !== JSON.stringify(this.plan.routing) ||
      run.providerNode !== this.plan.providerNode || run.payerNode !== this.plan.payerNode) throw new Error('Tracking requires an existing journaled approved payment');
    return this.observe(true).handle;
  }
  async waitAccepted(swap: Swap): Promise<void> {
    const observation = this.observations.get(swap.id);
    if (!observation) throw new Error('Payer client unavailable; reconcile');
    const terminal = observation.handle.result.then(() => { throw new Error('Payer completed before acceptance observation'); });
    void terminal.catch(() => {});
    try {
      while (!observation.controller.signal.aborted) {
        const invoice = await Promise.race([this.provider.lookup(this.plan.contract.paymentHash), terminal]);
        if (observation.controller.signal.aborted) throw new Error();
        if (invoice.payment_request !== swap.invoice || !['OPEN', 'ACCEPTED'].includes(invoice.state)) throw new Error();
        if (invoice.state === 'ACCEPTED' && observation.inFlight) {
          new HoldInvoiceManager({ lookup: hash => this.provider.lookup(hash), settle: async () => { throw new Error(); },
            cancel: async () => { throw new Error(); } }).assertAccepted(invoice, this.plan.contract.paymentHash,
              this.plan.quote.invoiceSats, this.plan.contract.timeoutHeight, 40);
          return;
        }
        await Promise.race([delay(this.pollMs, undefined, { signal: observation.controller.signal }), terminal]);
      }
      throw new Error();
    } catch { throw new Error('Payer acceptance uncertain; reconcile existing payment'); }
  }
  private assertEndpoints() {
    if (this.payer.origin !== this.plan.routing.payerOrigin || this.transport.origin !== this.plan.routing.payerOrigin ||
      this.provider.origin !== this.plan.routing.providerOrigin) throw new Error('Payer inspection and send endpoints must match the approved plan');
  }
  private async assertChannel(signal: AbortSignal) {
    this.assertEndpoints(); signal.throwIfAborted();
    const channels = z.object({ channels: z.array(z.object({ active: z.boolean(), chan_id: z.string(), channel_point: z.string(),
      remote_pubkey: z.string(), zero_conf: z.literal(false) })).max(1000) }).parse(await this.payer.call('/v1/channels')).channels;
    this.assertEndpoints(); signal.throwIfAborted();
    const found = channels.filter(c => c.chan_id === this.plan.routing.channelId);
    if (found.length !== 1 || !found[0]!.active || found[0]!.channel_point !== this.plan.routing.channelPoint ||
      found[0]!.remote_pubkey !== this.plan.providerNode) throw new Error('Approved payer channel missing or changed');
  }
  private observe(tracking: boolean, invoice?: string, attemptId?: string): Observation {
    const controller = new AbortController();
    let inFlight = false; let terminalStatus: 'SUCCEEDED' | 'FAILED' | 'UNKNOWN' = 'UNKNOWN';
    const fail = () => new Error('Payer outcome uncertain or failed; reconcile existing payment without retry');
    const record = async (status: 'SUCCEEDED' | 'FAILED' | 'UNKNOWN') => {
      if (tracking) return;
      await this.store.transaction(db => {
        const sent = db.controlledExecutions?.[this.approval.id]?.payerSend;
        if (!sent || sent.attemptId !== attemptId || sent.status !== 'INTENT') throw fail();
        sent.status = status;
      });
    };
    let abort!: () => void;
    const stopped = new Promise<never>((_, reject) => {
      abort = () => reject(fail()); controller.signal.addEventListener('abort', abort, { once: true });
    });
    const timer = setTimeout(() => controller.abort(), this.deadlineMs);
    const work = async (): Promise<PaymentEvidence> => {
      await assertRecoveryNode(this.payer, this.plan.payerNode);
      await this.assertChannel(controller.signal);
      controller.signal.throwIfAborted();
      if (!tracking) {
        verifyDecodedHoldInvoice(invoice!, await this.payer.call(`/v1/payreq/${invoice}`), { paymentHash: this.plan.contract.paymentHash,
          payeePublicKey: this.plan.providerNode, invoiceSats: this.plan.quote.invoiceSats, minFinalCltv: this.plan.invoiceCltvDelta });
      }
      controller.signal.throwIfAborted();
      let paid: PaymentEvidence | undefined;
      await this.transport.stream(tracking ? trackPaymentPath(this.plan.contract.paymentHash) : '/v2/router/send', tracking ? undefined : {
        payment_request: invoice, timeout_seconds: 60, fee_limit_sat: String(this.plan.routingFeeLimitSats),
        max_parts: 16, no_inflight_updates: false, allow_self_payment: false, amp: false, cancelable: false,
        outgoing_chan_ids: [this.plan.routing.channelId],
      }, raw => {
        controller.signal.throwIfAborted();
        const p = eventSchema.parse(raw); const feeMsat = BigInt(p.fee_msat);
        if (p.payment_hash !== this.plan.contract.paymentHash || BigInt(p.value_sat) !== BigInt(this.plan.quote.invoiceSats) ||
          BigInt(p.value_msat) !== BigInt(this.plan.quote.invoiceSats) * 1000n || BigInt(p.fee_sat) !== feeMsat / 1000n ||
          feeMsat > BigInt(this.plan.routingFeeLimitSats) * 1000n ||
          ((p.status === 'FAILED') === (p.failure_reason === 'FAILURE_REASON_NONE')) || (inFlight && p.status === 'INITIATED')) throw fail();
        const routes = verifyApprovedPaymentRoutes(raw, { channelId: this.plan.routing.channelId, providerNode: this.plan.providerNode,
          valueMsat: BigInt(this.plan.quote.invoiceSats) * 1000n }, p.status, feeMsat);
        if (p.status === 'FAILED') { terminalStatus = 'FAILED'; throw fail(); }
        inFlight = p.status === 'IN_FLIGHT' && routes.hasInFlight;
        if (p.status !== 'SUCCEEDED') return false;
        const preimage = z.string().regex(/^[a-f0-9]{64}$/).parse((raw as { payment_preimage?: unknown }).payment_preimage);
        if (createHash('sha256').update(Buffer.from(preimage, 'hex')).digest('hex') !== p.payment_hash) throw fail();
        terminalStatus = 'SUCCEEDED';
        paid = { hash: p.payment_hash, status: 'SUCCEEDED', valueSats: this.plan.quote.invoiceSats, feeSats: Number((feeMsat + 999n) / 1000n) };
        return true;
      }, controller.signal, async () => {
        if (!tracking) this.executionGuard?.();
        await this.assertChannel(controller.signal);
        controller.signal.throwIfAborted();
        if (tracking) return;
        this.executionGuard?.();
        const db = this.store.read(); const current = db.swaps[this.approval.swapId]; const run = db.controlledExecutions?.[this.approval.id];
        if (this.approval.expiresAt <= Date.now() || !current || current.clientPayment?.status !== 'INTENT' ||
          current.clientPayment.feeLimitSats !== this.plan.routingFeeLimitSats || current.clientPayment.hash !== this.plan.contract.paymentHash ||
          current.pendingAction || current.lockup || current.invoice !== invoice || run?.status !== 'INTENT' ||
          JSON.stringify(current.contract) !== JSON.stringify(this.plan.contract) || JSON.stringify(current.quote) !== JSON.stringify(this.plan.quote) ||
          run.planDigest !== this.approval.planDigest || run.isolationId !== this.approval.isolationId ||
          JSON.stringify(run.routing) !== JSON.stringify(this.plan.routing) || run.providerNode !== this.plan.providerNode || run.payerNode !== this.plan.payerNode ||
          run.payerSend?.attemptId !== attemptId || run.payerSend?.status !== 'INTENT') throw fail();
      });
      if (!paid) throw fail();
      await assertRecoveryNode(this.payer, this.plan.payerNode);
      await this.assertChannel(controller.signal);
      return paid;
    };
    const result = Promise.race([work(), stopped]).then(async paid => {
      await record('SUCCEEDED'); return paid;
    }, async () => {
      controller.abort(); await record(terminalStatus === 'FAILED' ? 'FAILED' : 'UNKNOWN'); throw fail();
    }).finally(() => { clearTimeout(timer); controller.signal.removeEventListener('abort', abort); controller.abort(); });
    void result.catch(() => {}); // Caller may await only after on-chain settlement.
    return { controller, get inFlight() { return inFlight; }, handle: { result, stopClient: () => controller.abort() } };
  }
}
