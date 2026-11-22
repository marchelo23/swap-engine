import { z } from 'zod';

const hex64 = /^[a-f0-9]{64}$/;
const pubkey = /^(02|03)[a-f0-9]{64}$/;
const chainInfo = z.object({ chain: z.string().min(1), blocks: z.number().int().nonnegative(),
  bestblockhash: z.string().regex(hex64), initialblockdownload: z.boolean() }).passthrough();
const miningInfo = z.object({ signet_challenge: z.string().regex(/^[0-9a-f]+$/).optional() }).passthrough();
const lndInfo = z.object({ chains: z.array(z.object({ chain: z.string(), network: z.string() })).length(1),
  synced_to_chain: z.boolean() }).passthrough();
const arkInfo = z.object({ network: z.literal('regtest'), signerPubkey: z.string().regex(pubkey),
  forfeitAddress: z.string().startsWith('bcrt1'), dust: z.union([z.string().regex(/^\d+$/),
    z.number().int().nonnegative()]) }).passthrough();
const liquidBlockchain = z.object({ chain: z.string().min(1) }).passthrough();
const liquidSidechain = z.object({ fee_asset: z.string().regex(hex64).optional(),
  pegged_asset: z.string().regex(hex64).optional(), parent_blockhash: z.string().regex(hex64).optional() }).passthrough();

export const identityErrors = [
  'CHAIN_IDENTITY_MISMATCH', 'CHAIN_NOT_REGTEST', 'CHAIN_MAINNET_REJECTED', 'GENESIS_MISMATCH',
  'SIGNET_CHALLENGE_MISSING', 'SIGNET_CHALLENGE_MISMATCH', 'CHAIN_UNVERIFIED',
  'LND_IDENTITY_MISMATCH', 'LND_NOT_SYNCED', 'ARK_IDENTITY_MISMATCH', 'ARK_MAINNET_REJECTED',
  'LIQUID_CHAIN_MISMATCH', 'LIQUID_FEE_ASSET_UNAVAILABLE', 'LIQUID_POLICY_ASSET_MISMATCH',
  'LIQUID_PARENT_GENESIS_MISMATCH', 'LIQUID_MAINNET_REJECTED',
] as const;
export type IdentityError = typeof identityErrors[number];
export const identityError = (code: IdentityError): Error => Object.assign(new Error(code), { code });

export type BitcoinIdentityExpectation = { name: 'regtest' | 'signet' | 'mainnet';
  genesisHash: string; signetChallenge?: string };

/** Read-only chain/genesis check. Signet cannot be accepted on genesis alone:
 * default and custom signets share it, so the reviewed challenge is mandatory. */
export function verifyBitcoinIdentity(chain: unknown, genesisHash: string,
  expected: BitcoinIdentityExpectation, mining?: unknown): { name: BitcoinIdentityExpectation['name']; genesisHash: string } {
  if (!hex64.test(expected.genesisHash) || expected.genesisHash !== genesisHash) throw identityError('GENESIS_MISMATCH');
  const parsed = chainInfo.parse(chain);
  if (parsed.chain !== expected.name) {
    if (parsed.chain === 'main' && expected.name !== 'mainnet') throw identityError('CHAIN_MAINNET_REJECTED');
    throw identityError('CHAIN_IDENTITY_MISMATCH');
  }
  if (parsed.initialblockdownload !== false || !Number.isSafeInteger(parsed.blocks)) throw identityError('CHAIN_UNVERIFIED');
  if (expected.name === 'signet') {
    if (!expected.signetChallenge) throw identityError('SIGNET_CHALLENGE_MISSING');
    const challenge = miningInfo.parse(mining ?? {}).signet_challenge;
    if (!challenge || challenge.toLowerCase() !== expected.signetChallenge.toLowerCase())
      throw identityError('SIGNET_CHALLENGE_MISMATCH');
  }
  return { name: expected.name, genesisHash };
}

export function verifyLndIdentity(info: unknown, expected: 'regtest' | 'signet' | 'mainnet') {
  const parsed = lndInfo.parse(info);
  if (!parsed.synced_to_chain) throw identityError('LND_NOT_SYNCED');
  if (parsed.chains[0]!.chain !== 'bitcoin' || parsed.chains[0]!.network !== expected)
    throw identityError('LND_IDENTITY_MISMATCH');
  return { chain: 'bitcoin' as const, network: expected };
}

/** Ark is read-only here. No Ark adapter/funding implementation is installed by this contract. */
export function verifyArkIdentity(info: unknown, expectedSignerPubkey: string) {
  if (!pubkey.test(expectedSignerPubkey)) throw identityError('ARK_IDENTITY_MISMATCH');
  const parsed = arkInfo.parse(info);
  if (parsed.network !== 'regtest') throw identityError('ARK_MAINNET_REJECTED');
  if (parsed.signerPubkey !== expectedSignerPubkey) throw identityError('ARK_IDENTITY_MISMATCH');
  return parsed;
}

/** Elements getsidechaininfo: fee_asset is the policy asset. Never compare the
 * configured policy asset to pegged_asset, which is a different field. Older
 * responses without fee_asset fail closed. */
export function verifyLiquidIdentity(blockchain: unknown, sidechain: unknown,
  expected: { chainName: string; policyAsset: string; parentGenesisHash: string }) {
  const block = liquidBlockchain.parse(blockchain);
  if (block.chain === 'liquidv1' || block.chain === 'main') throw identityError('LIQUID_MAINNET_REJECTED');
  if (block.chain !== expected.chainName) throw identityError('LIQUID_CHAIN_MISMATCH');
  if (!hex64.test(expected.policyAsset) || !hex64.test(expected.parentGenesisHash))
    throw identityError('LIQUID_POLICY_ASSET_MISMATCH');
  const side = liquidSidechain.parse(sidechain);
  if (!side.fee_asset) throw identityError('LIQUID_FEE_ASSET_UNAVAILABLE');
  if (side.fee_asset.toLowerCase() !== expected.policyAsset.toLowerCase())
    throw identityError('LIQUID_POLICY_ASSET_MISMATCH');
  if (!side.parent_blockhash || side.parent_blockhash.toLowerCase() !== expected.parentGenesisHash.toLowerCase())
    throw identityError('LIQUID_PARENT_GENESIS_MISMATCH');
  return { chainName: block.chain, policyAsset: side.fee_asset.toLowerCase(),
    parentGenesisHash: side.parent_blockhash.toLowerCase() };
}
