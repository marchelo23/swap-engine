import { Transaction, address, networks } from 'bitcoinjs-lib';
import { z } from 'zod';
import type { Database } from '../core/SwapTypes.js';
import { preparationSpecSchema } from '../core/ReversePreparation.js';
import type { ReadOnlyBitcoinClient } from '../diagnostics/ReadOnlyClients.js';
import { verifyHtlcSpend } from '../bitcoin/SpendEvidence.js';
import { operatorStopped } from './OperatorFiles.js';
import { OWNED_ECONOMICS } from '../core/Economics.js';
import { invoiceBudget } from '../core/SwapManager.js';

const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const archivedPreparationSpecSchema = preparationSpecSchema.extend({
  wallet: z.string().regex(/^[A-Za-z0-9._-]{1,120}$/).optional() }).strict();
export type ArchivedPreparationSpec = z.infer<typeof archivedPreparationSpecSchema>;
const height = z.number().int().nonnegative().max(499999999);
const chainSchema = z.object({ chain: z.literal('regtest'), initialblockdownload: z.literal(false), blocks: height, bestblockhash: hash });
const observationSchema = z.object({ fromHeight: height, height, blockHash: hash,
  spend: z.object({ txid: hash, height, blockHash: hash }) });

/** Existing runner contract: mining intents need not contain hashes. The durable
 * observer checkpoint and fresh active-chain transaction/witness evidence are mandatory.
 * Reads only; the verified preimage is never returned or logged. */
export async function verifyArchivedChain(db: Database, spec: ArchivedPreparationSpec, ownerId: string, destination: string,
  bitcoin: Pick<ReadOnlyBitcoinClient, 'call' | 'confirmed'>) {
  const swaps = Object.values(db.swaps); const swap = swaps[0];
  const expected = spec.sourceAmountSats === undefined ? { amountSats: 50000, invoiceSats: 50750, serviceFeeSats: 750, claimFeeSats: 500, fundingReserveSats: 1000 } : invoiceBudget(spec.sourceAmountSats, OWNED_ECONOMICS.invoice);
  if (db.schema !== 1 || swaps.length !== 1 || !swap || swap.state !== 'COMPLETED' || swap.clientPayment?.status !== 'SUCCEEDED' ||
    !swap.lockup || !swap.claimTxid || db.ownedReverse?.owners[swap.id]?.ownerId !== ownerId ||
    db.ownedReverse.owners[swap.id]!.claimDestination !== destination || swap.contract.paymentHash !== spec.client.paymentHash ||
    swap.contract.claimPublicKey !== spec.client.claimPublicKey || swap.contract.refundPublicKey !== spec.refundPublicKey ||
    swap.contract.timeoutHeight !== spec.tipHeight + 30 || Object.entries(expected).some(([key, amount]) => swap.quote[key as keyof typeof expected] !== amount)) throw operatorStopped();
  const observed = observationSchema.parse(db.chainObservations?.[`${swap.lockup.txid}:${swap.lockup.vout}`]);
  if (observed.spend.txid !== swap.claimTxid || observed.fromHeight > observed.spend.height || observed.spend.height > observed.height) throw operatorStopped();
  const before = chainSchema.parse(await bitcoin.call('getblockchaininfo'));
  if (before.blocks < Math.max(spec.tipHeight, observed.height)) throw operatorStopped();
  for (const checkpoint of [observed, observed.spend])
    if (await bitcoin.call('getblockhash', [checkpoint.height]) !== checkpoint.blockHash) throw operatorStopped();
  for (const intent of swap.miningIntents ?? []) {
    if (intent.status !== 'CONFIRMED' || before.blocks <= intent.fromHeight ||
      (intent.blockHash && await bitcoin.call('getblockhash', [intent.fromHeight + 1]) !== intent.blockHash)) throw operatorStopped();
  }
  const funding = await bitcoin.confirmed(swap.lockup.txid); const claim = await bitcoin.confirmed(swap.claimTxid);
  if (funding.confirmations < 1 || claim.confirmations < 1) throw operatorStopped();
  const fundingTx = Transaction.fromHex(funding.hex); const claimTx = Transaction.fromHex(claim.hex);
  const verified = verifyHtlcSpend(claim.hex, swap.claimTxid, funding.hex, swap.lockup.vout, swap.contract);
  if (verified.kind !== 'claim' || fundingTx.getId() !== swap.lockup.txid || fundingTx.outs[swap.lockup.vout]?.value !== BigInt(expected.amountSats) ||
    claimTx.ins.length !== 1 || claimTx.outs.length !== 1 || claimTx.outs[0]!.value !== BigInt(expected.amountSats - expected.claimFeeSats) ||
    !Buffer.from(claimTx.outs[0]!.script).equals(Buffer.from(address.toOutputScript(destination, networks.regtest))) ||
    JSON.stringify(chainSchema.parse(await bitcoin.call('getblockchaininfo'))) !== JSON.stringify(before)) throw operatorStopped();
  return { id: swap.id, revision: swap.revision, fundingTxid: swap.lockup.txid, claimTxid: swap.claimTxid,
    checkpointHeight: observed.height, checkpointHash: observed.blockHash };
}
