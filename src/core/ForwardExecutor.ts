import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { Store } from '../persistence/Store.js';
import { verifyDecodedHoldInvoice } from '../lightning/InvoiceVerification.js';

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const pubkey = z.string().regex(/^0[23][a-f0-9]{64}$/);
const approvalSchema = z.object({
  network: z.literal('regtest'), payerNode: pubkey, payeeNode: pubkey,
  paymentHash: hash, invoice: z.string().regex(/^lnbcrt[0-9a-z]{20,4096}$/),
  invoiceSats: z.number().int().min(1).max(200_000),
  feeLimitSats: z.number().int().min(0).max(100),
  expiresAt: z.number().int().positive(),
  deposit: z.object({ txid: hash, vout: z.number().int().min(0).max(0xffffffff),
    scriptPubKey: z.string().regex(/^(0014[a-f0-9]{40}|0020[a-f0-9]{64}|5120[a-f0-9]{64})$/),
    valueSats: z.number().int().min(1).max(200_100) }),
});
export type ForwardApproval = z.infer<typeof approvalSchema>;
type Approval = ForwardApproval;
type Status = 'INTENT' | 'UNKNOWN' | 'SUCCEEDED' | 'FAILED_INSUFFICIENT_BALANCE';
export type ForwardPaymentJournal = { payerNode: string; outpoint: string; approvalDigest: string; status: Status };
const depositSchema = approvalSchema.shape.deposit.extend({
  network: z.literal('regtest'), confirmations: z.number().int().min(2),
});
const payerSchema = z.object({ network: z.literal('regtest'), node: pubkey, ready: z.literal(true) });
const paidSchema = z.object({ status: z.literal('SUCCEEDED'), hash, preimage: hash,
  valueMsat: z.number().int().positive(), feeMsat: z.number().int().nonnegative() });
const failedSchema = z.object({ status: z.literal('FAILED'), hash,
  reason: z.literal('FAILURE_REASON_INSUFFICIENT_BALANCE'), htlcs: z.tuple([]), feeMsat: z.literal(0) });

export function parseForwardApproval(input: unknown): ForwardApproval {
  const a = approvalSchema.parse(input);
  if (a.payerNode === a.payeeNode || a.deposit.valueSats < a.invoiceSats + a.feeLimitSats)
    throw new Error('Invalid forward payer or deposit economics');
  return a;
}

export function forwardApprovalDigest(a: ForwardApproval) {
  return createHash('sha256').update(JSON.stringify(a)).digest('hex');
}

export function verifiedForwardPayment(a: ForwardApproval, raw: unknown) {
  const p = paidSchema.parse(raw);
  return p.hash === a.paymentHash && p.valueMsat === a.invoiceSats * 1000 && p.feeMsat <= a.feeLimitSats * 1000 &&
    createHash('sha256').update(Buffer.from(p.preimage, 'hex')).digest('hex') === a.paymentHash;
}

export function verifiedForwardBalanceFailure(a: ForwardApproval, raw: unknown) {
  const failed = failedSchema.safeParse(raw);
  return failed.success && failed.data.hash === a.paymentHash;
}

/** Trusted internal ports, not browser input. */
export interface ForwardPorts {
  inspectPayer(): Promise<unknown>;
  decodeInvoice(invoice: string): Promise<unknown>;
  /** Read from Core's active chain and UTXO set; missing/spent outputs must not attest. */
  inspectDeposit(txid: string, vout: number): Promise<unknown>;
  /** Must await beforeSend immediately before transmission, never retry, and bound I/O. */
  send(invoice: string, feeLimitSats: number, beforeSend: () => Promise<void>): Promise<unknown>;
  /** Read-only lookup on the same payer; a missing payment is not permission to send. */
  track(paymentHash: string): Promise<unknown>;
}

/** Only a trusted service can supply an approved plan. Requires one canonical
 * forward Store bound and locked per payerNode (`Store.openForForward`). Never wire to HTTP as-is. */
export class ForwardExecutor {
  constructor(private readonly store: Store, private readonly ports: ForwardPorts, private readonly testToken?: object) {
    store.assertForwardStore(testToken);
  }

  status(input: Approval): Status {
    const a = this.approval(input);
    this.store.assertForwardPayerBoundSync(a.payerNode, this.testToken);
    return this.entry(a).status;
  }

  async execute(input: Approval): Promise<Status> {
    const a = this.approval(input);
    await this.store.assertForwardPayerHeld(a.payerNode, this.testToken);
    await this.checkSend(a);
    const outpoint = `${a.deposit.txid}:${a.deposit.vout}`;
    const approvalDigest = this.digest(a);
    await this.store.transaction(db => {
      const journal = db.forwardPayments ??= {};
      if (journal[a.paymentHash] || Object.values(journal).some(p => p.outpoint === outpoint))
        throw new Error('Deposit or payment already journaled; reconcile without sending');
      journal[a.paymentHash] = { outpoint, approvalDigest, payerNode: a.payerNode, status: 'INTENT' };
    });
    let paid = false;
    let wireAuthorized = false;
    try {
      const evidence = await this.ports.send(a.invoice, a.feeLimitSats, async () => {
        await this.store.assertForwardPayerHeld(a.payerNode, this.testToken);
        await this.checkSend(a);
        await this.store.assertForwardPayerHeld(a.payerNode, this.testToken);
        if (wireAuthorized || this.entry(a).status !== 'INTENT') throw new Error('Forward send intent no longer current');
        wireAuthorized = true;
      });
      await this.store.assertForwardPayerHeld(a.payerNode, this.testToken);
      await this.checkPayer(a);
      paid = wireAuthorized && this.verifiedPayment(a, evidence);
    } catch { /* An ambiguous send consumes the intent. */ }
    return this.record(a, paid ? 'SUCCEEDED' : 'UNKNOWN');
  }

  async recover(input: Approval): Promise<Status> {
    const a = this.approval(input);
    await this.store.assertForwardPayerHeld(a.payerNode, this.testToken);
    const initial = this.entry(a).status;
    if (initial === 'SUCCEEDED' || initial === 'FAILED_INSUFFICIENT_BALANCE') return initial;
    let outcome: Status = 'UNKNOWN';
    try {
      await this.checkPayer(a);
      const evidence = await this.ports.track(a.paymentHash);
      await this.store.assertForwardPayerHeld(a.payerNode, this.testToken);
      await this.checkPayer(a);
      if (initial === 'UNKNOWN' && verifiedForwardBalanceFailure(a, evidence))
        outcome = 'FAILED_INSUFFICIENT_BALANCE';
      else if (this.verifiedPayment(a, evidence)) outcome = 'SUCCEEDED';
    } catch { /* Missing, pending, malformed and failed observations do not reopen the intent. */ }
    return this.record(a, outcome);
  }

  private approval(input: Approval) {
    return parseForwardApproval(input);
  }

  private digest(a: Approval) {
    return forwardApprovalDigest(a);
  }

  private entry(a: Approval) {
    const entry = this.store.read().forwardPayments?.[a.paymentHash];
    if (!entry || entry.payerNode !== a.payerNode || entry.approvalDigest !== this.digest(a))
      throw new Error('No matching forward payment intent');
    return entry;
  }

  private async checkPayer(a: Approval) {
    if (payerSchema.parse(await this.ports.inspectPayer()).node !== a.payerNode)
      throw new Error('Forward payer identity mismatch');
  }

  private async checkSend(a: Approval) {
    if (Date.now() >= a.expiresAt) throw new Error('Forward approval expired');
    await this.checkPayer(a);
    verifyDecodedHoldInvoice(a.invoice, await this.ports.decodeInvoice(a.invoice),
      { paymentHash: a.paymentHash, payeePublicKey: a.payeeNode, invoiceSats: a.invoiceSats, minFinalCltv: 1 });
    const d = depositSchema.parse(await this.ports.inspectDeposit(a.deposit.txid, a.deposit.vout));
    if (d.txid !== a.deposit.txid || d.vout !== a.deposit.vout || d.scriptPubKey !== a.deposit.scriptPubKey ||
      d.valueSats !== a.deposit.valueSats || Date.now() >= a.expiresAt) throw new Error('Forward deposit or approval changed');
  }

  private verifiedPayment(a: Approval, raw: unknown) {
    return verifiedForwardPayment(a, raw);
  }

  private record(a: Approval, outcome: Status) {
    const digest = this.digest(a);
    return this.store.transaction(db => {
      const entry = db.forwardPayments?.[a.paymentHash];
      if (!entry || entry.payerNode !== a.payerNode || entry.approvalDigest !== digest) throw new Error('Forward intent changed');
      if (entry.status !== 'SUCCEEDED' && entry.status !== 'FAILED_INSUFFICIENT_BALANCE' &&
        (outcome !== 'FAILED_INSUFFICIENT_BALANCE' || entry.status === 'UNKNOWN')) entry.status = outcome;
      return entry.status;
    });
  }
}
