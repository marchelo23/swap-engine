import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Store } from '../persistence/Store.js';
import { verifyDecodedHoldInvoice } from '../lightning/InvoiceVerification.js';
import { ForwardExecutor, type ForwardApproval, type ForwardPorts } from './ForwardExecutor.js';

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const node = z.string().regex(/^0[23][a-f0-9]{64}$/);
const ownerId = z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/);
const invoiceSchema = z.string().regex(/^lnbcrt[0-9a-z]{20,4096}$/);
const requestId = z.uuid();
const allocation = z.object({ address: z.string().regex(/^bcrt1q[a-z0-9]{38}$/),
  scriptPubKey: z.string().regex(/^0014[a-f0-9]{40}$/) });
const outpoint = z.object({ txid: hash, vout: z.number().int().min(0).max(0xffffffff) });
export type ForwardAdmissionRecord = Omit<ForwardApproval, 'deposit'> & {
  owner: string; address: string; scriptPubKey: string; depositSats: number;
  outpoint?: z.infer<typeof outpoint>; requestKey?: string;
};

/** Internal service only. Owner must come from trusted authentication, never a request body.
 * One persistent store per payer, shared by all admissions and recovery. */
export class ForwardAdmission {
  private readonly executor: ForwardExecutor;
  constructor(private readonly store: Store, private readonly ports: ForwardPorts & {
    allocateDeposit(): Promise<unknown>;
  }, private readonly payerNode: string, private readonly payeeNode: string) {
    node.parse(payerNode); node.parse(payeeNode);
    if (payerNode === payeeNode) throw new Error('Forward payee must differ from payer');
    this.executor = new ForwardExecutor(store, ports);
  }

  async admit(owner: string, invoice: string, invoiceSats: number, key?: string) {
    ownerId.parse(owner); invoiceSchema.parse(invoice);
    z.number().int().min(1000).max(200_000).parse(invoiceSats);
    const replay = (records: Record<string, ForwardAdmissionRecord>) => {
      const match = key && Object.entries(records).find(([, a]) => a.owner === owner && a.requestKey === key);
      if (!match) return;
      const [id, a] = match;
      if (a.invoice !== invoice || a.invoiceSats !== invoiceSats ||
        a.payerNode !== this.payerNode || a.payeeNode !== this.payeeNode) throw new Error('Forward request conflict');
      return { id, address: a.address, depositSats: a.depositSats, expiresAt: a.expiresAt };
    };
    const existing = replay(this.store.read().forwardAdmissions ?? {});
    if (existing) return existing;
    const payer = z.object({ network: z.literal('regtest'), ready: z.literal(true), node }).parse(await this.ports.inspectPayer());
    if (payer.node !== this.payerNode) throw new Error('Forward payer identity mismatch');
    const decoded = await this.ports.decodeInvoice(invoice);
    const { payment_hash: paymentHash, timestamp, expiry } = z.object({ payment_hash: hash,
      timestamp: z.string(), expiry: z.string() }).parse(decoded);
    verifyDecodedHoldInvoice(invoice, decoded, { paymentHash, payeePublicKey: this.payeeNode, invoiceSats, minFinalCltv: 1 });
    const expiresAt = (Number(timestamp) + Number(expiry) - 60) * 1000;
    const feeLimitSats = 100;
    const id = randomUUID();
    const deposit = allocation.parse(await this.ports.allocateDeposit());
    const depositSats = invoiceSats + feeLimitSats;
    return this.store.transaction(db => {
      const admissions = db.forwardAdmissions ??= {};
      const previous = replay(admissions);
      if (previous) return previous;
      if (Date.now() >= expiresAt || db.forwardPayments?.[paymentHash] || Object.values(admissions).some(a =>
        a.paymentHash === paymentHash || a.scriptPubKey === deposit.scriptPubKey || a.address === deposit.address))
        throw new Error('Forward invoice expired or invoice/deposit already reserved');
      admissions[id] = { owner, network: 'regtest', payerNode: this.payerNode, payeeNode: this.payeeNode,
        invoice, invoiceSats, paymentHash, expiresAt, feeLimitSats, ...deposit, depositSats, requestKey: key };
      return { id, address: deposit.address, depositSats, expiresAt };
    });
  }

  list(owner: string) {
    return Object.entries(this.store.read().forwardAdmissions ?? {})
      .filter(([, a]) => a.owner === owner && a.payerNode === this.payerNode && a.payeeNode === this.payeeNode)
      .map(([id]) => id);
  }

  async status(owner: string, id: string, candidate?: z.infer<typeof outpoint>) {
    const a = this.owned(owner, id);
    const point = a.outpoint ?? candidate;
    let confirmations: number | null = null;
    if (point) {
      try {
        const seen = outpoint.extend({ network: z.literal('regtest'), confirmations: z.number().int().nonnegative(),
          scriptPubKey: z.string(), valueSats: z.number().int() }).parse(await this.ports.inspectDeposit(point.txid, point.vout));
        if (seen.txid === point.txid && seen.vout === point.vout &&
          seen.scriptPubKey === a.scriptPubKey && seen.valueSats === a.depositSats) confirmations = seen.confirmations;
      } catch { /* Never present missing or stale chain evidence as confirmed. */ }
    }
    const latest = this.owned(owner, id);
    if (latest.outpoint && (latest.outpoint.txid !== point?.txid || latest.outpoint.vout !== point?.vout)) confirmations = null;
    const journal = this.store.read().forwardPayments?.[a.paymentHash];
    if (journal && !latest.outpoint) throw new Error('Forward payment journal requires a bound outpoint');
    const state = journal && latest.outpoint ? this.executor.status(this.approval(latest, latest.outpoint))
      : Date.now() >= a.expiresAt ? 'EXPIRED' : 'AWAITING_DEPOSIT';
    return { id, invoice: a.invoice, invoiceSats: a.invoiceSats, address: a.address, depositSats: a.depositSats,
      expiresAt: a.expiresAt, outpoint: latest.outpoint ?? null, confirmations, requiredConfirmations: 2, state };
  }

  async submit(owner: string, id: string, candidate: z.infer<typeof outpoint>) {
    const a = this.owned(owner, id);
    if (a.outpoint && (a.outpoint.txid !== candidate.txid || a.outpoint.vout !== candidate.vout))
      throw new Error('Forward request conflict');
    if (!this.store.read().forwardPayments?.[a.paymentHash]) await this.execute(owner, id, candidate);
  }

  async execute(owner: string, id: string, candidate: z.infer<typeof outpoint>) {
    const a = this.owned(owner, id);
    const point = outpoint.parse(candidate);
    // Don't pin an outpoint until Core confirms the exact reserved script and value.
    const expected = this.approval(a, point);
    if (Date.now() >= a.expiresAt) throw new Error('Forward approval expired');
    const seen = outpoint.extend({ network: z.literal('regtest'), confirmations: z.number().int().min(2),
      scriptPubKey: z.string(), valueSats: z.number().int() }).parse(await this.ports.inspectDeposit(point.txid, point.vout));
    if (seen.txid !== point.txid || seen.vout !== point.vout || seen.scriptPubKey !== expected.deposit.scriptPubKey ||
      seen.valueSats !== expected.deposit.valueSats) throw new Error('Deposit does not match forward reservation');
    await this.store.transaction(db => {
      const record = db.forwardAdmissions![id]!;
      if (record.outpoint && (record.outpoint.txid !== point.txid || record.outpoint.vout !== point.vout))
        throw new Error('Forward reservation already bound to another outpoint');
      record.outpoint = point;
    });
    return this.executor.execute(expected);
  }

  async recover(owner: string, id: string) {
    const a = this.owned(owner, id);
    if (!a.outpoint) throw new Error('No bound forward deposit');
    return this.executor.recover(this.approval(a, a.outpoint));
  }

  private owned(owner: string, id: string) {
    ownerId.parse(owner); requestId.parse(id);
    const a = this.store.read().forwardAdmissions?.[id];
    if (!a || a.owner !== owner || a.payerNode !== this.payerNode || a.payeeNode !== this.payeeNode)
      throw new Error('Forward admission not found');
    return a;
  }

  private approval(a: ForwardAdmissionRecord, point: z.infer<typeof outpoint>): ForwardApproval {
    return { ...a, deposit: { ...point, scriptPubKey: a.scriptPubKey, valueSats: a.depositSats } };
  }
}
