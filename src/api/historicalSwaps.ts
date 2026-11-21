import { z } from 'zod';

const sats = z.number().int().nonnegative().safe();
const txid = z.string().regex(/^[a-f0-9]{64}$/);
export const HistoricalSwap = z.object({
  id: z.uuid(), source: z.literal('lightning-regtest'), destination: z.literal('bitcoin-regtest'),
  amountSats: sats, invoiceSats: sats, receivedSats: sats,
  fundingTxid: txid, claimTxid: txid,
  reportedInvoiceStatus: z.literal('SETTLED'), reportedPaymentStatus: z.literal('SUCCEEDED'),
  reportedFeesSats: z.object({ funding: sats, claim: sats, routing: sats }).strict(),
  evidenceSource: z.literal('docs/fresh-reverse-success.md'),
  verificationStatus: z.literal('UNVERIFIED'),
  confirmationEvidence: z.null(),
}).strict();
export const HistoricalSwapResponse = z.object({ network: z.literal('regtest'), swaps: z.array(HistoricalSwap).max(100) }).strict();
export type HistoricalSwap = z.infer<typeof HistoricalSwap>;
export type HistoricalSwapResponse = z.infer<typeof HistoricalSwapResponse>;

// A transcription of the documented historical report, never live journal state.
export function historicalSwaps(): HistoricalSwapResponse {
  return HistoricalSwapResponse.parse({ network: 'regtest', swaps: [{
    id: '629d3df3-af89-430a-b17e-aecf60b5e1d8', source: 'lightning-regtest', destination: 'bitcoin-regtest',
    amountSats: 50000, invoiceSats: 50750, receivedSats: 49500,
    fundingTxid: '710a474d7fe1856c89c9a9bbcd1d94eeee07ff5e8600c3ec26d1c31b546a5d28',
    claimTxid: 'e7006540b498bccbc02faa3b6ad82192661c0daca7ab8d32b9a5cb87d88e2d60',
    reportedInvoiceStatus: 'SETTLED', reportedPaymentStatus: 'SUCCEEDED',
    reportedFeesSats: { funding: 306, claim: 500, routing: 0 },
    evidenceSource: 'docs/fresh-reverse-success.md', verificationStatus: 'UNVERIFIED', confirmationEvidence: null,
  }] });
}
