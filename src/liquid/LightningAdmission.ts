import { z } from 'zod';
import { verifyDecodedHoldInvoice } from '../lightning/InvoiceVerification.js';

export const liquidLightningUnavailable = () => ({
  route: 'liquid-to-lightning' as const, available: false as const, executionEnabled: false as const,
  reason: 'LIQUID_LIGHTNING_ATOMIC_ADAPTER_UNAVAILABLE' as const,
  atomicAdapterInstalled: false as const, invoiceValidationAvailable: false as const,
  recoveryAvailable: false as const, refundAvailable: false as const,
});

/** Syntax only. No invoice signature verification, quote, swap or reservation is
 * implied by parsing this request. The authenticated API always returns 503. */
export const LiquidLightningRequest = z.object({
  route: z.literal('liquid-to-lightning'),
  invoice: z.string().regex(/^lnbcrt[0-9a-z]{20,4096}$/),
  debitSats: z.number().int().min(10_000).max(1_000_000),
}).strict();

const sats = z.number().int().nonnegative().safe();
const debitSchema = z.object({
  debitSats: sats.positive(), inputSats: sats.positive(), ownChangeSats: sats,
  lockupSats: sats.positive(), networkFeeSats: sats,
}).strict();

/** Review helper only, not an executable quote or a transaction parser. A future
 * attested adapter must derive these values from independently decoded Elements
 * inputs/outputs, verify every asset and ownership, and reject other outputs.
 * Reserves/refund budgets cannot be silently added to the exact debit. */
export function verifyExactLiquidDebit(value: unknown): void {
  const b = debitSchema.parse(value);
  if (BigInt(b.inputSats) - BigInt(b.ownChangeSats) !== BigInt(b.debitSats) ||
    BigInt(b.lockupSats) + BigInt(b.networkFeeSats) !== BigInt(b.debitSats))
    throw new Error('LIQUID_EXACT_DEBIT_MISMATCH');
}

const invoiceExpectation = z.object({ paymentHash: z.string().regex(/^[a-f0-9]{64}$/),
  payeePublicKey: z.string().regex(/^(02|03)[a-f0-9]{64}$/), invoiceSats: sats.positive(),
  minFinalCltv: z.number().int().positive().safe(), quoteExpiresAt: sats.positive() }).strict();

/** Offline review primitive. A caller must independently decode/verify the exact
 * BOLT11 with an attested regtest node/SDK; raw client JSON is not that evidence.
 * There is deliberately no API dependency injection that can enable this route. */
export function verifyLiquidLightningInvoice(paymentRequest: string, decoded: unknown,
  expectation: unknown, now = Date.now()): void {
  const expected = invoiceExpectation.parse(expectation);
  if (!Number.isSafeInteger(now) || now < 0 || expected.quoteExpiresAt <= now)
    throw new Error('LIQUID_QUOTE_EXPIRED');
  verifyDecodedHoldInvoice(paymentRequest, decoded, expected, now);
  const timing = z.object({ timestamp: z.string().regex(/^\d+$/), expiry: z.string().regex(/^\d+$/) }).parse(decoded);
  if (BigInt(expected.quoteExpiresAt) + 60_000n >= (BigInt(timing.timestamp) + BigInt(timing.expiry)) * 1000n)
    throw new Error('LIQUID_INVOICE_EXPIRY_MARGIN');
}
