import { z } from 'zod';
import type { Config } from '../config.js';
import { verifyBitcoinIdentity, verifyLiquidIdentity } from '../environment/Identity.js';

type Reader = { readonly origin: string; call<T>(method: string, params?: unknown[], wallet?: boolean): Promise<T> };
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const chainSchema = z.object({ chain: z.string(), blocks: z.number().int().nonnegative().safe(),
  initialblockdownload: z.literal(false), bestblockhash: hash });
const sideSchema = z.object({ fee_asset: hash.optional(), pegged_asset: hash.optional(), parent_blockhash: hash.optional() });
const networkSchema = z.object({ version: z.number().int().nonnegative().safe() });
const walletSchema = z.object({ walletname: z.string() });

/** A diagnostic, never an authorization or proof that a provider uses these nodes.
 * No provider adapter is installed: even verified local chains cannot enable a swap. */
export async function liquidPreflight(c: Config, clients: { elements?: Reader; bitcoin?: Reader }) {
  if (c.environment !== 'liquid-regtest' || c.spendPolicy !== 'disabled' ||
    c.features.guest || c.features.forward || c.features.mining || c.features.reverse)
    throw new Error('LIQUID_PREFLIGHT_READ_ONLY_PROFILE_REQUIRED');
  const elements: { configured: boolean; verified: boolean; reason: string | null;
    version: number | null; genesisHash: string | null; feeAssetReported: boolean | null;
    peggedAsset: string | null } = { configured: c.rails.liquid.enabled, verified: false,
    reason: 'NOT_CONFIGURED', version: null, genesisHash: null, feeAssetReported: null, peggedAsset: null };
  const bitcoin = { configured: c.rails.onchain.enabled, verified: false, reason: 'NOT_CONFIGURED' as string | null };
  if (c.rails.liquid.enabled) {
    const rail = c.rails.liquid;
    elements.reason = 'ELEMENTS_PROBE_FAILED';
    if (!rail.genesisHash) elements.reason = 'LIQUID_GENESIS_PIN_REQUIRED';
    else if (!clients.elements || clients.elements.origin !== new URL(rail.rpcUrl).origin)
      elements.reason = 'ELEMENTS_READER_MISMATCH';
    else {
      try {
        const reader = clients.elements;
        elements.version = networkSchema.parse(await reader.call('getnetworkinfo')).version;
        const blockchain = chainSchema.parse(await reader.call('getblockchaininfo'));
        elements.genesisHash = hash.parse(await reader.call('getblockhash', [0]));
        const sidechain = sideSchema.parse(await reader.call('getsidechaininfo'));
        elements.feeAssetReported = sidechain.fee_asset !== undefined;
        elements.peggedAsset = sidechain.pegged_asset ?? null;
        const wallet = walletSchema.parse(await reader.call('getwalletinfo', [], true));
        // Record the compatibility failure without guessing that pegged_asset is fee_asset.
        if (!sidechain.fee_asset) elements.reason = 'LIQUID_FEE_ASSET_UNAVAILABLE';
        else if (elements.genesisHash !== rail.genesisHash) elements.reason = 'LIQUID_GENESIS_MISMATCH';
        else if (wallet.walletname !== rail.wallet) elements.reason = 'LIQUID_WALLET_IDENTITY_MISMATCH';
        else if (rail.parentGenesisHash !== c.bitcoinGenesisHash) elements.reason = 'LIQUID_PARENT_NOT_BITCOIN_REGTEST';
        else if (sidechain.pegged_asset !== rail.policyAsset) elements.reason = 'LIQUID_PEGGED_ASSET_MISMATCH';
        else {
          verifyLiquidIdentity(blockchain, sidechain, rail);
          elements.verified = true; elements.reason = null;
        }
      } catch {
        // Do not emit RPC errors, credentials, remote text, or wallet paths.
        elements.reason = 'ELEMENTS_PROBE_FAILED';
      }
    }
  }
  if (c.rails.onchain.enabled) {
    const rail = c.rails.onchain;
    bitcoin.reason = 'BITCOIN_PROBE_FAILED';
    if (!clients.bitcoin || clients.bitcoin.origin !== new URL(rail.url).origin) bitcoin.reason = 'BITCOIN_READER_MISMATCH';
    else {
      try {
        const reader = clients.bitcoin;
        const blockchain = await reader.call('getblockchaininfo');
        const genesis = hash.parse(await reader.call('getblockhash', [0]));
        verifyBitcoinIdentity(blockchain, genesis, { name: 'regtest', genesisHash: c.bitcoinGenesisHash! });
        const wallet = walletSchema.parse(await reader.call('getwalletinfo', [], true));
        if (wallet.walletname !== rail.wallet) bitcoin.reason = 'BITCOIN_WALLET_IDENTITY_MISMATCH';
        else { bitcoin.verified = true; bitcoin.reason = null; }
      } catch { bitcoin.reason = 'BITCOIN_PROBE_FAILED'; }
    }
  }
  return { schemaVersion: 1 as const, evidence: 'read-only-rpc' as const,
    environment: c.environment, deploymentId: c.deploymentId, elements, bitcoin,
    route: { preferred: 'liquid-to-bitcoin-chain' as const, available: false as const,
      provider: { candidate: 'boltz-client', installed: false, attested: false,
        reason: 'PROVIDER_ADAPTER_NOT_INSTALLED' }, lightningFallback: 'disabled' as const },
    execution: { enabled: false as const, reason: 'LIQUID_EXECUTION_FORBIDDEN' as const } };
}
