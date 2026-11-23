import { z } from 'zod';
import type { Config } from '../config.js';

type Reader = { origin?: string; call<T>(method: string, params?: unknown[], wallet?: boolean): Promise<T> };
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const integer = z.number().int().nonnegative().safe();
const chain = z.object({ chain: z.literal('elementsregtest'), blocks: integer.min(1),
  bestblockhash: hash, initialblockdownload: z.literal(false) });
const side = z.object({ parent_blockhash: hash, fee_asset: z.never().optional() });
const wallet = z.object({ walletname: z.string() });
const output = z.object({ n: integer, asset: hash.optional(), value: z.number().finite().optional(),
  scriptPubKey: z.object({ hex: z.string().regex(/^(?:[a-f0-9]{2})*$/) }) });
const block = z.object({ hash, height: integer, confirmations: integer.min(1),
  tx: z.array(z.unknown()).min(1) });
const coinbase = z.object({ txid: hash, vin: z.array(z.object({
  coinbase: z.string().regex(/^(?:[a-f0-9]{2})+$/), txid: z.never().optional(),
})).length(1), vout: z.array(output).min(1) });
const utxos = z.array(z.object({ txid: hash, vout: integer, asset: hash,
  amount: z.number().finite().positive(), scriptPubKey: z.string(), confirmations: integer.min(1),
  spendable: z.literal(true), safe: z.literal(true) })).max(10_000);

export type ConfirmedAssetEvidence = {
  kind: 'confirmed-wallet-and-coinbase'; identityVerified: true; walletAssetVerified: true;
  feePolicyVerified: false; limitation: 'CURRENT_FEE_POLICY_UNPROVEN';
  asset: string; blockHash: string; blockHeight: number; confirmations: number;
};

/** Limited local-RPC evidence, never a fee-policy inference or spend permission.
 * Matches a confirmed wallet UTXO's asset to an explicit coinbase asset at the tip.
 * This proves asset equality, not ownership of that coinbase or current fee policy.
 * Chain progress/reorg during collection fails closed; retry a fresh read later. */
export async function confirmedAssetEvidence(c: Config, reader: Reader, observed: {
  blockchain: unknown; sidechain: unknown; genesis: unknown; wallet: unknown;
}): Promise<ConfirmedAssetEvidence> {
  const rail = c.rails.liquid;
  if (c.environment !== 'liquid-regtest' || c.spendPolicy !== 'disabled' || !rail.enabled ||
    rail.confirmationPolicy !== 'read-only' || rail.chainName !== 'elementsregtest' || !rail.genesisHash)
    throw new Error('LIQUID_ASSET_EVIDENCE_SCOPE_INVALID');
  if (reader.origin !== new URL(rail.rpcUrl).origin) throw new Error('LIQUID_ASSET_EVIDENCE_ORIGIN_MISMATCH');
  const before = chain.parse(observed.blockchain);
  if (hash.parse(observed.genesis) !== rail.genesisHash) throw new Error('LIQUID_GENESIS_MISMATCH');
  if (wallet.parse(observed.wallet).walletname !== rail.wallet) throw new Error('LIQUID_WALLET_IDENTITY_MISMATCH');
  if (side.parse(observed.sidechain).parent_blockhash !== rail.parentGenesisHash || rail.parentGenesisHash !== c.bitcoinGenesisHash)
    throw new Error('LIQUID_PARENT_GENESIS_MISMATCH');
  // No pegged_asset input participates in this evidence.
  const height = before.blocks;
  const blockHash = hash.parse(await reader.call('getblockhash', [height]));
  const confirmed = block.parse(await reader.call('getblock', [blockHash, 2]));
  if (blockHash !== before.bestblockhash || confirmed.hash !== blockHash || confirmed.height !== height || confirmed.confirmations !== 1)
    throw new Error('LIQUID_COINBASE_BLOCK_MISMATCH');
  const transaction = coinbase.parse(confirmed.tx[0]);
  // Parse only safe confirmed candidates; watch-only/unsafe outputs are not evidence.
  const raw = z.array(z.unknown()).max(10_000).parse(await reader.call('listunspent',
    [1, 9_999_999, [], false, { asset: rail.policyAsset }], true));
  const owned = utxos.parse(raw.filter(item => utxos.element.safeParse(item).success));
  const matched = transaction.vout.some(out => out.asset === rail.policyAsset &&
    out.value !== undefined && out.value >= 0 && owned.some(utxo => utxo.asset === out.asset));
  if (!matched) throw new Error('LIQUID_WALLET_COINBASE_ASSET_UNPROVEN');
  const after = chain.parse(await reader.call('getblockchaininfo'));
  const activeHash = hash.parse(await reader.call('getblockhash', [height]));
  if (after.blocks !== before.blocks || after.bestblockhash !== before.bestblockhash || activeHash !== blockHash)
    throw new Error('LIQUID_ASSET_EVIDENCE_CHAIN_CHANGED');
  return { kind: 'confirmed-wallet-and-coinbase', identityVerified: true, walletAssetVerified: true,
    feePolicyVerified: false, limitation: 'CURRENT_FEE_POLICY_UNPROVEN', asset: rail.policyAsset,
    blockHash, blockHeight: height, confirmations: confirmed.confirmations };
}
