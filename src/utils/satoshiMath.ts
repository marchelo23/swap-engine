/**
 * Utility functions for satoshi math calculations in reverse swaps
 */
import type { Quote } from '../core/SwapTypes.js';

export class SatoshiMathError extends Error {}

/**
 * Validates that a monetary value is a non-negative safe integer
 * @param value - The value to validate
 * @returns true if valid, throws error otherwise
 */
export function validateMonetaryValue(value: number): boolean {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new SatoshiMathError('Monetary value must be a non-negative safe integer');
  }
  return true;
}

/**
 * Validates that a satoshi amount is a safe integer within valid range
 * @param amountSats - The amount to validate
 * @returns true if valid, throws error otherwise
 */
export function validateAmount(amountSats: number): boolean {
  validateMonetaryValue(amountSats);
  if (amountSats < 10_000 || amountSats > 1_000_000) {
    throw new SatoshiMathError('Amount must be between 10,000 and 1,000,000 sats');
  }
  return true;
}

/**
 * Validates all monetary fields in a quote according to the complete contract
 * @param quote - The quote to validate
 * @returns true if valid, throws error otherwise
 */
export function validateQuoteFields(quote: Quote): boolean {
  // Validate all monetary fields as non-negative safe integers
  validateMonetaryValue(quote.amountSats);
  validateMonetaryValue(quote.serviceFeeSats);
  validateMonetaryValue(quote.invoiceSats);
  validateMonetaryValue(quote.fundingReserveSats);
  validateMonetaryValue(quote.claimFeeSats);

  // Older quotes recorded the principal as the input. New exact-debit quotes
  // can have a principal below the input minimum once the service fee is deducted.
  if (quote.amountSats === 0) throw new SatoshiMathError('Principal must be positive');
  validateAmount(quote.amountSats < 10_000 ? quote.invoiceSats : quote.amountSats);

  // Validate that invoiceSats equals amount + serviceFee (exact match)
  if (quote.invoiceSats !== quote.amountSats + quote.serviceFeeSats) {
    throw new SatoshiMathError('Invoice amount must equal principal plus service fee');
  }

  // Validate claim fee does not exceed principal (allowed to equal it)
  if (quote.claimFeeSats > quote.amountSats) {
    throw new SatoshiMathError('Claim fee cannot exceed principal amount');
  }

  return true;
}

/**
 * Calculates net received satoshis (amount minus claim fee)
 * @param quote - The quote from which to calculate
 * @returns net received satoshis
 */
export function calculateNetReceivedSats(quote: Quote): number {
  validateQuoteFields(quote);
  // Net received = amountSats - claimFeeSats
  return quote.amountSats - quote.claimFeeSats;
}

/**
 * Calculates total paid satoshis (amount + service fee)
 * @param quote - The quote from which to calculate
 * @returns total paid satoshis
 */
export function calculateTotalPaidSats(quote: Quote): number {
  validateQuoteFields(quote);
  return quote.invoiceSats;
}

/**
 * Calculates the service fee from a quote
 * @param quote - The quote from which to calculate
 * @returns service fee in satoshis
 */
export function calculateServiceFee(quote: Quote): number {
  validateQuoteFields(quote);
  return quote.serviceFeeSats;
}

/**
 * Calculates net sats lost for the user (service fee + claim fee)
 * Note: fundingReserveSats belongs to provider and does not increase user loss
 * @param quote - The quote from which to calculate
 * @returns net sats lost in satoshis
 */
export function calculateNetSatsLost(quote: Quote): number {
  validateQuoteFields(quote);
  // User's loss = service fee + claim fee (fundingReserveSats is provider's)
  return quote.serviceFeeSats + quote.claimFeeSats;
}

/**
 * Calculates the total user cost (service fee + claim fee)
 * @param quote - The quote from which to calculate
 * @returns total user cost in satoshis
 */
export function calculateUserCost(quote: Quote): number {
  validateQuoteFields(quote);
  // User cost = service fee + claim fee
  return quote.serviceFeeSats + quote.claimFeeSats;
}
