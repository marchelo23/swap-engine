import { z } from 'zod';

const integer = z.string().regex(/^(0|[1-9][0-9]{0,19})$/).refine(v => BigInt(v) <= 0xffffffffffffffffn);
const attempt = z.object({ attempt_id: integer, status: z.enum(['IN_FLIGHT', 'SUCCEEDED', 'FAILED']),
  route: z.object({ total_amt_msat: integer, total_fees_msat: z.literal('0'), first_hop_amount_msat: integer.optional(),
    hops: z.array(z.object({ chan_id: integer, pub_key: z.string(), amt_to_forward_msat: integer, fee_msat: z.literal('0') })).length(1) }) });

/** Direct approved channel only; missing routes never establish accepted or settled evidence. */
export function verifyApprovedPaymentRoutes(raw: unknown, expected: { channelId: string; providerNode: string; valueMsat: bigint },
  status: string, feeMsat: bigint): { hasInFlight: boolean } {
  const rows = z.object({ htlcs: z.array(attempt).max(128) }).parse(raw).htlcs;
  if (new Set(rows.map(row => row.attempt_id)).size !== rows.length || feeMsat !== 0n) throw new Error('Approved route evidence invalid');
  let settled = 0n; let live = 0n; let parts = 0; let hasInFlight = false;
  for (const row of rows) {
    const hop = row.route.hops[0]!; const amount = BigInt(hop.amt_to_forward_msat);
    if (hop.chan_id !== expected.channelId || hop.pub_key !== expected.providerNode || amount < 1n ||
      BigInt(row.route.total_amt_msat) !== amount || (row.route.first_hop_amount_msat !== undefined &&
        ![0n, amount].includes(BigInt(row.route.first_hop_amount_msat)))) throw new Error('Approved route identity or amount changed');
    if (row.status !== 'FAILED') { live += amount; parts++; }
    if (row.status === 'IN_FLIGHT') hasInFlight = true;
    if (row.status === 'SUCCEEDED') settled += amount;
  }
  if (live > expected.valueMsat || parts > 16 || (status === 'INITIATED' && rows.length) ||
    (status === 'SUCCEEDED' && (settled !== expected.valueMsat || hasInFlight)) ||
    (status === 'FAILED' && (settled > 0n || hasInFlight))) throw new Error('Approved route outcome ambiguous');
  return { hasInFlight };
}
