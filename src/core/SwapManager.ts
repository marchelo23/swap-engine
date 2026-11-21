import { randomUUID } from 'node:crypto';
import { buildHtlc, sha256, type Contract } from '../bitcoin/HtlcBuilder.js';
import { assertLiquidity, type Balances } from '../liquidity/LiquidityManager.js';
import { Store } from '../persistence/Store.js';
import { transition } from './SwapStateMachine.js';
import type { Quote, Swap } from './SwapTypes.js';

/** User-specified Lightning debit, bounded by the existing controlled regtest profile. */
export function invoiceBudget(invoiceSats: number) {
  if (!Number.isSafeInteger(invoiceSats) || invoiceSats < 11_000 || invoiceSats > 50_000) throw new Error('Amount must be 11000..50000 sats');
  const serviceFeeSats = 500 + Math.ceil(invoiceSats / 200);
  return { amountSats: invoiceSats - serviceFeeSats, serviceFeeSats, invoiceSats, fundingReserveSats: 1000, claimFeeSats: 500 };
}

export class SwapManager {
  constructor(readonly store: Store) {}
  async quote(amountSats: number, now = Date.now()): Promise<Quote> {
    if (!Number.isSafeInteger(amountSats) || amountSats < 10_000 || amountSats > 1_000_000) throw new Error('Amount must be 10000..1000000 sats');
    const serviceFeeSats = 500 + Math.ceil(amountSats * 0.005);
    const quote = { id: randomUUID(), amountSats, serviceFeeSats, invoiceSats: amountSats + serviceFeeSats, fundingReserveSats: 1000, claimFeeSats: 500, expiresAt: now + 120_000 };
    return this.store.transaction(db => {
      for (const [id, q] of Object.entries(db.quotes)) if (q.expiresAt < now) delete db.quotes[id];
      db.quotes[quote.id] = quote; return quote;
    });
  }
  async quoteInvoice(invoiceSats: number, now = Date.now()): Promise<Quote> {
    const quote = { id: randomUUID(), ...invoiceBudget(invoiceSats), expiresAt: now + 120_000 };
    return this.store.transaction(db => {
      for (const [id, q] of Object.entries(db.quotes)) if (q.expiresAt < now) delete db.quotes[id];
      db.quotes[quote.id] = quote; return quote;
    });
  }
  async create(quoteId: string, idempotencyKey: string, contract: Contract, tip: number, balances: Balances, now = Date.now()): Promise<Swap> {
    buildHtlc(contract);
    if (!/^[a-zA-Z0-9_-]{8,128}$/.test(idempotencyKey)) throw new Error('Invalid idempotency key');
    const fingerprint = sha256(Buffer.from(JSON.stringify({ quoteId, paymentHash: contract.paymentHash, claimPublicKey: contract.claimPublicKey, refundPublicKey: contract.refundPublicKey, timeoutHeight: contract.timeoutHeight }))).toString('hex');
    return this.store.transaction(db => {
      const previous = Object.values(db.swaps).find(s => s.idempotencyKey === idempotencyKey);
      if (previous) {
        if (previous.fingerprint !== fingerprint) throw new Error('Idempotency key conflict');
        return previous;
      }
      const quote = db.quotes[quoteId];
      if (!quote || quote.expiresAt <= now) throw new Error('Quote expired or missing');
      if (Object.values(db.swaps).some(s => s.quote.id === quoteId)) throw new Error('Quote already consumed');
      if (Object.values(db.swaps).some(s => s.contract.paymentHash === contract.paymentHash)) throw new Error('Payment hash already used');
      if (!Number.isSafeInteger(tip) || tip < 0 || contract.timeoutHeight < tip + 20 || contract.timeoutHeight > tip + 40) throw new Error('Refund height must be 20..40 blocks ahead');
      assertLiquidity(db, balances, quote.amountSats, quote.invoiceSats, quote.fundingReserveSats);
      const swap: Swap = { id: randomUUID(), idempotencyKey, fingerprint, quote, contract, state: 'CREATED', revision: 0, createdAt: now, updatedAt: now, history: [{ state: 'CREATED', at: now }] };
      transition(swap, 'QUOTED', now);
      db.swaps[swap.id] = swap;
      return swap;
    });
  }
  get(id: string) { return this.store.read().swaps[id]; }
}
