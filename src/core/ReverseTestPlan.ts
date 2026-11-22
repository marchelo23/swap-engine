import { assertRegtestAddress } from '../bitcoin/AddressPolicy.js';
import { z } from 'zod';
import type { Quote } from './SwapTypes.js';
import { buildHtlc, type Contract } from '../bitcoin/HtlcBuilder.js';
import { validateQuoteFields } from '../utils/satoshiMath.js';
import { invoiceBudget } from './SwapManager.js';

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const pubkey = z.string().regex(/^(02|03)[a-f0-9]{64}$/);
const amount = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const channelId = z.string().regex(/^[1-9][0-9]{0,19}$/).refine(v => BigInt(v) <= 0xffffffffffffffffn);
const origin = (protocol: string) => z.string().refine(value => {
  try { const url = new URL(value); return url.origin === value && url.protocol === protocol &&
    ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname); } catch { return false; }
});
export const reverseRoutingSchema = z.object({ channelId,
  channelPoint: z.string().regex(/^[a-f0-9]{64}:(0|[1-9][0-9]{0,9})$/).refine(value => Number(value.split(':')[1]) <= 0xffffffff),
  bitcoinOrigin: origin('http:'), providerOrigin: origin('https:'), payerOrigin: origin('https:') }).strict();
export type ReverseRouting = z.infer<typeof reverseRoutingSchema>;
export const reverseTestPlanSchema = z.object({ network: z.literal('regtest'), wallet: z.string().regex(/^[A-Za-z0-9._-]{1,120}$/),
  createdAt: amount, tipHeight: z.number().int().min(1).max(499_999_969),
  providerNode: pubkey, payerNode: pubkey, claimDestination: z.string(), refundDestination: z.string(),
  routing: reverseRoutingSchema,
  contract: z.object({ paymentHash: hash, claimPublicKey: pubkey, refundPublicKey: pubkey, timeoutHeight: amount }).strict(),
  address: z.string(), witnessScript: z.string().regex(/^[a-f0-9]+$/),
  quote: z.object({ id: z.uuid(), amountSats: amount, serviceFeeSats: amount, invoiceSats: amount,
    fundingReserveSats: amount, claimFeeSats: amount, expiresAt: amount }).strict(),
  invoiceExpirySeconds: z.literal(3600), invoiceCltvDelta: z.literal(80),
  routingFeeLimitSats: z.union([z.literal(0), z.literal(100)]), fundingFeeLimitSats: z.literal(1000),
  executionApproved: z.literal(false),
}).strict();
export type ReverseTestPlan = z.infer<typeof reverseTestPlanSchema>;

export function verifyReverseTestPlan(value: unknown): ReverseTestPlan {
  const plan = reverseTestPlanSchema.parse(value);
  validateQuoteFields(plan.quote);
  const legacy = plan.quote.amountSats === 50000 && plan.quote.invoiceSats === 50750 && plan.quote.serviceFeeSats === 750;
  let current = false;
  try { const budget = invoiceBudget(plan.quote.invoiceSats); current = Object.entries(budget).every(([key, value]) => plan.quote[key as keyof typeof budget] === value); } catch { /* Invalid budgets remain rejected. */ }
  if ((!legacy && !current) || plan.routingFeeLimitSats !== (legacy ? 100 : 0) || plan.quote.claimFeeSats !== 500 ||
    plan.quote.fundingReserveSats !== plan.fundingFeeLimitSats || plan.contract.timeoutHeight !== plan.tipHeight + 30 ||
    plan.providerNode === plan.payerNode || plan.routing.providerOrigin === plan.routing.payerOrigin) throw new Error('Reverse plan differs from test contract');
  const contract = buildHtlc(plan.contract);
  if (contract.address !== plan.address || contract.witnessScript.toString('hex') !== plan.witnessScript) throw new Error('Reverse contract reconstruction failed');
  assertRegtestAddress(plan.claimDestination);
  assertRegtestAddress(plan.refundDestination);
  return plan;
}

export function createReverseTestPlan(quote: Quote, tipHeight: number, client: { paymentHash: string; claimPublicKey: string },
  refundPublicKey: string, destinations: { claim: string; refund: string }, nodes: { provider: string; payer: string }, routing: ReverseRouting,
  wallet: string): ReverseTestPlan {
  const contract: Contract = { ...client, refundPublicKey, timeoutHeight: tipHeight + 30 };
  const htlc = buildHtlc(contract);
  return verifyReverseTestPlan({ network: 'regtest', wallet, createdAt: Date.now(), tipHeight,
    providerNode: nodes.provider, payerNode: nodes.payer, routing, claimDestination: destinations.claim, refundDestination: destinations.refund,
    contract, address: htlc.address, witnessScript: htlc.witnessScript.toString('hex'), quote,
    invoiceExpirySeconds: 3600, invoiceCltvDelta: 80, routingFeeLimitSats: quote.invoiceSats === 50750 ? 100 : 0, fundingFeeLimitSats: 1000, executionApproved: false });
}
