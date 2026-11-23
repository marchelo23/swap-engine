import { z } from 'zod';

export type LiquidBalanceReader = {
  readonly origin?: string;
  call<T>(method: string, params?: unknown[], wallet?: boolean): Promise<T>;
};

export type LiquidBalanceSource = {
  reader: LiquidBalanceReader;
  chainName: string;
  policyAsset: string;
  genesisHash: string;
  parentGenesisHash: string;
  wallet: string;
  assetEvidence?: LiquidAssetEvidenceKind;
};

export type LiquidAssetEvidenceKind = 'confirmed-wallet-and-coinbase' | 'not-collected';

export type LiquidBalanceSnapshot = {
  wallet: string;
  chain: string;
  height: number;
  genesisHash: string;
  assetId: string;
  confirmedBaseUnits: number;
  unconfirmedBaseUnits: number;
  spendableBaseUnits: number;
  utxoCount: number;
  assetEvidence: LiquidAssetEvidenceKind;
  feePolicyVerified: false;
  readOnly: true;
};

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const integer = z.number().int().nonnegative().safe();
const chain = z.object({ chain: z.string().min(1), blocks: integer.min(1), bestblockhash: hash,
  initialblockdownload: z.literal(false) }).passthrough();
const sidechain = z.object({ parent_blockhash: hash, pegged_asset: hash.optional() }).passthrough();
const wallet = z.object({ walletname: z.string().min(1).max(120) }).passthrough();
const utxo = z.object({ txid: hash, vout: integer, asset: hash,
  amount: z.number().finite().nonnegative(), confirmations: integer,
  spendable: z.boolean(), safe: z.boolean().optional() }).passthrough();
const utxos = z.array(utxo).max(10_000);
const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);
const walletName = /^[A-Za-z0-9._-]{1,120}$/;

function baseUnits(amount: number): number {
  if (!Number.isFinite(amount) || amount < 0) throw new Error('LIQUID_AMOUNT_INVALID');
  const rounded = Math.round(amount * 1e8);
  if (!Number.isSafeInteger(rounded) || rounded / 1e8 !== amount) throw new Error('LIQUID_AMOUNT_INVALID');
  return rounded;
}

function sum(amounts: number[]): number {
  let total = 0n;
  for (const amount of amounts) {
    total += BigInt(amount);
    if (total > MAX_SAFE) throw new Error('LIQUID_AMOUNT_OVERFLOW');
  }
  return Number(total);
}

export async function collectLiquidBalances(source: LiquidBalanceSource): Promise<LiquidBalanceSnapshot> {
  const { reader } = source;
  if (!/^[a-z0-9]+regtest$/.test(source.chainName) || !hash.safeParse(source.policyAsset).success ||
    !hash.safeParse(source.genesisHash).success || !hash.safeParse(source.parentGenesisHash).success ||
    !walletName.test(source.wallet)) throw new Error('LIQUID_BALANCE_SCOPE_INVALID');

  const before = chain.parse(await reader.call('getblockchaininfo'));
  if (before.chain !== source.chainName) throw new Error('LIQUID_CHAIN_MISMATCH');
  const genesis = hash.parse(await reader.call('getblockhash', [0]));
  if (genesis.toLowerCase() !== source.genesisHash.toLowerCase()) throw new Error('LIQUID_GENESIS_MISMATCH');
  const side = sidechain.parse(await reader.call('getsidechaininfo'));
  if (side.parent_blockhash.toLowerCase() !== source.parentGenesisHash.toLowerCase())
    throw new Error('LIQUID_PARENT_GENESIS_MISMATCH');
  if (side.pegged_asset !== undefined && side.pegged_asset.toLowerCase() !== source.policyAsset.toLowerCase())
    throw new Error('LIQUID_PEGGED_ASSET_MISMATCH');
  const info = wallet.parse(await reader.call('getwalletinfo', [], true));
  if (info.walletname !== source.wallet) throw new Error('LIQUID_WALLET_IDENTITY_MISMATCH');

  const raw = utxos.parse(await reader.call('listunspent', [0, 9_999_999, [], true, { asset: source.policyAsset }], true));
  if (raw.some(item => item.asset.toLowerCase() !== source.policyAsset.toLowerCase()))
    throw new Error('LIQUID_UNEXPECTED_ASSET');
  if (new Set(raw.map(item => `${item.txid}:${item.vout}`)).size !== raw.length)
    throw new Error('LIQUID_DUPLICATE_OUTPOINT');
  const after = chain.parse(await reader.call('getblockchaininfo'));
  if (before.chain !== after.chain || before.blocks !== after.blocks || before.bestblockhash !== after.bestblockhash)
    throw new Error('LIQUID_BALANCE_CHAIN_CHANGED');

  const confirmed = raw.filter(item => item.confirmations >= 1);
  const unconfirmed = raw.filter(item => item.confirmations === 0);
  const spendable = confirmed.filter(item => item.spendable && item.safe === true);
  return {
    wallet: source.wallet,
    chain: before.chain,
    height: before.blocks,
    genesisHash: source.genesisHash.toLowerCase(),
    assetId: source.policyAsset.toLowerCase(),
    confirmedBaseUnits: sum(confirmed.map(item => baseUnits(item.amount))),
    unconfirmedBaseUnits: sum(unconfirmed.map(item => baseUnits(item.amount))),
    spendableBaseUnits: sum(spendable.map(item => baseUnits(item.amount))),
    utxoCount: raw.length,
    assetEvidence: source.assetEvidence ?? 'not-collected',
    feePolicyVerified: false,
    readOnly: true,
  };
}
