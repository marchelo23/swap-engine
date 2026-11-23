export type QuoteEconomics = {
  minAmountSats: number; maxAmountSats: number; serviceFeeBaseSats: number; serviceFeeBps: number;
  fundingReserveSats: number; claimFeeSats: number; ttlMs: number;
};
export type InvoiceEconomics = {
  minSats: number; maxSats: number; serviceFeeBaseSats: number; serviceFeeDivisor: number;
  fundingReserveSats: number; claimFeeSats: number; ttlMs: number;
};
export type ReadinessBudget = { confirmations: 1; maxBlocks: 2; timeoutMs: 90_000 };
export type EconomicsConfig = { quote: QuoteEconomics; invoice: InvoiceEconomics; readiness: ReadinessBudget };
export const MAX_OWNED_DEBIT_SATS = 1_000_000;
export const CONTROLLED_FUNDING_CHANGE_BUFFER_SATS = 10_000;

export const LEGACY_ECONOMICS: EconomicsConfig = Object.freeze({
  quote: Object.freeze({ minAmountSats: 10_000, maxAmountSats: 1_000_000, serviceFeeBaseSats: 500,
    serviceFeeBps: 50, fundingReserveSats: 1_000, claimFeeSats: 500, ttlMs: 120_000 }),
  invoice: Object.freeze({ minSats: 11_000, maxSats: 50_000, serviceFeeBaseSats: 500,
    serviceFeeDivisor: 200, fundingReserveSats: 1_000, claimFeeSats: 500, ttlMs: 120_000 }),
  readiness: Object.freeze({ confirmations: 1, maxBlocks: 2, timeoutMs: 90_000 }),
});
export const OWNED_ECONOMICS: EconomicsConfig = Object.freeze({
  ...LEGACY_ECONOMICS,
  invoice: Object.freeze({ ...LEGACY_ECONOMICS.invoice, maxSats: MAX_OWNED_DEBIT_SATS }),
});
export function validateEconomics(economics: EconomicsConfig): void {
  const { quote, invoice } = economics;
  const quoteFee = quote.serviceFeeBaseSats + Math.ceil(quote.minAmountSats * quote.serviceFeeBps / 10_000);
  if (!Number.isSafeInteger(quote.minAmountSats) || quote.minAmountSats < 10_000 ||
    quote.maxAmountSats < quote.minAmountSats || quote.maxAmountSats > 1_000_000 ||
    quoteFee < 0 || quoteFee >= quote.minAmountSats || quote.fundingReserveSats < 1_000 ||
    quote.claimFeeSats < 500 || quote.claimFeeSats >= quote.minAmountSats || quote.ttlMs < 30_000)
    throw new Error('ECONOMICS_UNSAFE');
  const invoiceFee = invoice.serviceFeeBaseSats + Math.ceil(invoice.minSats / invoice.serviceFeeDivisor);
  const principal = invoice.minSats - invoiceFee;
  if (!Number.isSafeInteger(invoice.minSats) || invoice.minSats < 11_000 ||
    !Number.isSafeInteger(invoice.maxSats) || invoice.maxSats < invoice.minSats || invoice.maxSats > MAX_OWNED_DEBIT_SATS ||
    !Number.isSafeInteger(invoice.serviceFeeDivisor) || invoice.serviceFeeDivisor < 1 ||
    invoiceFee < 0 || principal <= 0 || invoice.fundingReserveSats < 1_000 ||
    invoice.claimFeeSats < 500 || invoice.claimFeeSats >= principal || invoice.ttlMs < 30_000)
    throw new Error('ECONOMICS_UNSAFE');
}
export function isLegacyEconomics(economics: EconomicsConfig): boolean {
  return JSON.stringify(economics) === JSON.stringify(LEGACY_ECONOMICS);
}
