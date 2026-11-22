import { Transaction, Psbt, address, networks } from 'bitcoinjs-lib';
import { z } from 'zod';
import { BitcoinConfirmationLookup } from './BitcoinConfirmationLookup.js';

interface Rpc { call<T>(method: string, params?: unknown[], wallet?: boolean): Promise<T> }
export const signingPlanSchema = z.object({
  network: z.literal('regtest'), wallet: z.string().regex(/^[A-Za-z0-9._-]{1,120}$/),
  txid: z.string().regex(/^[a-f0-9]{64}$/), vout: z.number().int().nonnegative().max(0xffffffff),
  destination: z.string().startsWith('bcrt1'), amountSats: z.literal(50000), maxFeeSats: z.literal(1000),
  broadcast: z.literal(false),
}).strict();
export type SigningPlan = z.infer<typeof signingPlanSchema>;

/** Verify a self-spend probe before testmempoolaccept. Never broadcast its result. */
export function verifySigningProbe(raw: string, fundingHex: string, plan: SigningPlan) {
  signingPlanSchema.parse(plan);
  const funding = Transaction.fromHex(fundingHex); const tx = Transaction.fromHex(raw);
  const script = address.toOutputScript(plan.destination, networks.regtest);
  if (funding.getId() !== plan.txid || !funding.outs[plan.vout] || tx.ins.length !== 1 ||
    Buffer.from(tx.ins[0]!.hash).reverse().toString('hex') !== plan.txid || tx.ins[0]!.index !== plan.vout ||
    tx.outs.length < 1 || tx.outs.length > 2 || !tx.outs.some(out => out.value === BigInt(plan.amountSats)) ||
    tx.outs.some(out => !Buffer.from(out.script).equals(script))) throw new Error('Signing probe differs from approved self-spend plan');
  const fee = funding.outs[plan.vout]!.value - tx.outs.reduce((sum, out) => sum + out.value, 0n);
  if (fee < 1n || fee > BigInt(plan.maxFeeSats)) throw new Error('Signing probe fee exceeds approved budget');
  return { txid: tx.getId(), feeSats: Number(fee), amountSats: plan.amountSats };
}

/** Explicit signing-only test: no broadcast, input locks, payment or key creation RPC. */
export async function runSigningProbe(rpc: Rpc, plan: SigningPlan) {
  signingPlanSchema.parse(plan);
  const checkNetwork = async () => {
    const info = z.object({ chain: z.literal('regtest'), initialblockdownload: z.literal(false) })
      .parse(await rpc.call('getblockchaininfo'));
    return info;
  };
  await checkNetwork();
  const owned = z.object({ ismine: z.literal(true) }).parse(await rpc.call('getaddressinfo', [plan.destination], true));
  if (!owned.ismine) throw new Error('Destination is not owned by approved wallet');
  const previous = await new BitcoinConfirmationLookup(rpc).confirmed(plan.txid);
  const output = z.object({ scriptPubKey: z.object({ hex: z.string() }) }).parse(await rpc.call('gettxout', [plan.txid, plan.vout, true]));
  const funding = Transaction.fromHex(previous.hex);
  if (!funding.outs[plan.vout] || Buffer.from(funding.outs[plan.vout]!.script).toString('hex') !== output.scriptPubKey.hex) throw new Error('Input is not an available verified output');
  const locksBefore = await rpc.call('listlockunspent', [], true);
  const poolBefore = await rpc.call('getrawmempool');
  await checkNetwork();
  const funded = z.object({ psbt: z.string() }).parse(await rpc.call('walletcreatefundedpsbt', [
    [{ txid: plan.txid, vout: plan.vout }], [{ [plan.destination]: '0.00050000' }], 0,
    { add_inputs: false, lockUnspents: false, changeAddress: plan.destination, fee_rate: 2, replaceable: false },
    true, 2, 0, // Core 32 defaults to PSBT v2; bitcoinjs-lib 7 verifies PSBT v0.
  ], true));
  const unsigned = Psbt.fromBase64(funded.psbt).data.globalMap.unsignedTx.toBuffer();
  verifySigningProbe(Buffer.from(unsigned).toString('hex'), previous.hex, plan);
  await checkNetwork();
  const signed = z.object({ psbt: z.string() }).parse(await rpc.call('walletprocesspsbt', [funded.psbt], true));
  const final = z.object({ complete: z.literal(true), hex: z.string() }).parse(await rpc.call('finalizepsbt', [signed.psbt]));
  const summary = verifySigningProbe(final.hex, previous.hex, plan);
  await checkNetwork();
  const accepted = z.array(z.object({ txid: z.string(), allowed: z.literal(true) })).length(1)
    .parse(await rpc.call('testmempoolaccept', [[final.hex]]));
  if (accepted[0]!.txid !== summary.txid) throw new Error('Consensus probe transaction mismatch');
  const locksAfter = await rpc.call('listlockunspent', [], true);
  const poolAfter = await rpc.call('getrawmempool');
  if (JSON.stringify(locksBefore) !== JSON.stringify(locksAfter) || JSON.stringify(poolBefore) !== JSON.stringify(poolAfter) ||
    await rpc.call('gettxout', [plan.txid, plan.vout, true]) === null) throw new Error('Unexpected wallet lock/mempool/input change during signing test');
  return { ...summary, broadcast: false as const, consensusAccepted: true as const };
}
