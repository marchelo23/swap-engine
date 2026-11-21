import { z } from 'zod';
import type { GuestReverseClients } from './GuestReverse.js';

const outpoint = z.object({ txid: z.string().regex(/^[a-f0-9]{64}$/),
  vout: z.number().int().nonnegative().max(0xffffffff) });
export const guestFundingInputSchema = outpoint.extend({
  valueSats: z.number().int().min(61000).max(Number.MAX_SAFE_INTEGER),
}).strict();
export type GuestFundingInput = z.infer<typeof guestFundingInputSchema>;
export const guestFundingPolicySchema = z.union([
  guestFundingInputSchema,
  z.object({ mode: z.literal('wallet'), legacyInput: guestFundingInputSchema.optional() }).strict(),
]);

const walletCoin = outpoint.extend({ amount: z.number(), confirmations: z.number().int().nonnegative(),
  safe: z.boolean(), spendable: z.boolean(), solvable: z.boolean(), scriptPubKey: z.string() });
const liveCoin = z.object({ bestblock: z.string(), confirmations: z.number().int().nonnegative(),
  coinbase: z.boolean(), value: z.number(), scriptPubKey: z.object({ hex: z.string() }) }).nullable();
const chainTip = z.object({ chain: z.literal('regtest'), initialblockdownload: z.literal(false),
  bestblockhash: z.string().regex(/^[a-f0-9]{64}$/) });

export const fundingOutpoint = (input: z.infer<typeof outpoint>) => `${input.txid}:${input.vout}`;

/** Only read the operator's configured wallet. The caller holds the shared
 * mining lock and records the reservation before an invoice can be issued. */
export async function selectGuestFunding(bitcoin: GuestReverseClients['bitcoin'], reserved: Set<string>) {
  const tip = chainTip.parse(await bitcoin.call('getblockchaininfo'));
  const inventory = z.array(walletCoin).parse(await bitcoin.call('listunspent', [1, 9999999, [], false], true));
  const locks = z.array(outpoint).parse(await bitcoin.call('listlockunspent', [], true));
  const excluded = new Set([...reserved, ...locks.map(fundingOutpoint)]);
  const candidates = inventory.filter(coin => coin.safe && coin.spendable && coin.solvable && coin.confirmations > 0 &&
    /^0014[a-f0-9]{40}$/.test(coin.scriptPubKey) && !excluded.has(fundingOutpoint(coin)))
    .sort((a, b) => a.amount - b.amount || a.txid.localeCompare(b.txid) || a.vout - b.vout);
  for (const candidate of candidates) {
    const valueSats = Math.round(candidate.amount * 1e8);
    if (valueSats / 1e8 !== candidate.amount) continue;
    const input = guestFundingInputSchema.safeParse({ txid: candidate.txid, vout: candidate.vout, valueSats });
    if (!input.success) continue;
    const coin = liveCoin.parse(await bitcoin.call('gettxout', [candidate.txid, candidate.vout, true]));
    if (coin && coin.bestblock === tip.bestblockhash && coin.confirmations === candidate.confirmations &&
      (!coin.coinbase || coin.confirmations >= 101) && coin.value === candidate.amount && coin.scriptPubKey.hex === candidate.scriptPubKey)
      return input.data;
  }
  return undefined;
}
