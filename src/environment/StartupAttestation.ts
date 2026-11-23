import type { Config } from '../config.js';
import type { RailId } from '../core/RailContract.js';
import { verifyBitcoinIdentity, verifyLiquidIdentity, verifyLndIdentity } from './Identity.js';
import { confirmedAssetEvidence, type ConfirmedAssetEvidence } from '../liquid/ConfirmedAssetEvidence.js';

type BitcoinReader = { origin?: string; call<T>(method: string, params?: unknown[], wallet?: boolean): Promise<T> };
type LndReader = { origin?: string; call<T>(path: string, body?: unknown): Promise<T> };
type LiquidReader = { origin?: string; call<T>(method: string, params?: unknown[], wallet?: boolean): Promise<T> };

export type StartupScope = { environment: Config['environment']; deploymentId: string;
  genesisHash: string | null; wallet: string; bitcoinOrigin?: string | null;
  providerOrigin?: string | null; payerOrigin?: string | null; providerNode?: string | null; payerNode?: string | null;
  liquidOrigin?: string | null; liquidWallet?: string | null; liquidGenesisHash?: string | null;
  liquidChainName?: string | null; liquidPolicyAsset?: string | null; liquidParentGenesisHash?: string | null;
  liquidAssetEvidence?: ConfirmedAssetEvidence;
  verified: Partial<Record<RailId, boolean>> };

/** Read-only startup attestation. It runs before the journal/lock is opened and
 * never constructs a write-capable port. Ark/Liquid remain explicitly
 * unverified until a reviewed read-only probe is injected. */
export async function attestStartup(config: Config, clients: {
  bitcoin?: BitcoinReader | null; provider?: LndReader | null; alice?: LndReader | null;
  liquid?: LiquidReader | null }): Promise<StartupScope> {
  const verified: Partial<Record<RailId, boolean>> = {};
  let genesisHash: string | null = null; let wallet = ''; let bitcoinOrigin: string | null = null;
  let providerOrigin: string | null = null; let payerOrigin: string | null = null;
  let providerNode: string | null = null; let payerNode: string | null = null;
  let liquidOrigin: string | null = null; let liquidWallet: string | null = null; let liquidGenesisHash: string | null = null;
  let liquidChainName: string | null = null; let liquidPolicyAsset: string | null = null; let liquidParentGenesisHash: string | null = null;
  let liquidAssetEvidence: ConfirmedAssetEvidence | undefined;
  if (config.rails.onchain.enabled) {
    if (!clients.bitcoin) throw new Error('ONCHAIN_ATTESTATION_UNAVAILABLE');
    if (!config.bitcoinNetwork || !config.bitcoinGenesisHash) throw new Error('BITCOIN_ATTESTATION_UNAVAILABLE');
    const chain = await clients.bitcoin.call('getblockchaininfo');
    const genesis = await clients.bitcoin.call<string>('getblockhash', [0]);
    const mining = config.bitcoinNetwork === 'signet' ? await clients.bitcoin.call('getmininginfo') : undefined;
    verifyBitcoinIdentity(chain, genesis, { name: config.bitcoinNetwork, genesisHash: config.bitcoinGenesisHash,
      signetChallenge: config.signetChallenge ?? undefined }, mining);
    const wallets = await clients.bitcoin.call<string[]>('listwallets');
    const walletInfo = await clients.bitcoin.call<{ walletname?: string }>('getwalletinfo', [], true);
    if (!wallets.includes(config.rails.onchain.wallet) || walletInfo.walletname !== config.rails.onchain.wallet)
      throw new Error('WALLET_IDENTITY_MISMATCH');
    genesisHash = genesis; wallet = config.rails.onchain.wallet; bitcoinOrigin = clients.bitcoin.origin ?? null;
    verified.onchain = true;
  }
  if (config.rails.lightning.enabled) {
    if (!clients.provider) throw new Error('LIGHTNING_ATTESTATION_UNAVAILABLE');
    if (!config.bitcoinNetwork) throw new Error('LIGHTNING_ATTESTATION_UNAVAILABLE');
    const expected = config.bitcoinNetwork;
    const providerInfo = await clients.provider.call<{ identity_pubkey?: string }>('/v1/getinfo');
    verifyLndIdentity(providerInfo, expected);
    providerOrigin = clients.provider.origin ?? null;
    providerNode = providerInfo.identity_pubkey ?? null;
    if (!providerNode || !/^(02|03)[a-f0-9]{64}$/.test(providerNode)) throw new Error('LND_IDENTITY_MISMATCH');
    if (config.rails.lightning.alice) {
      if (!clients.alice) throw new Error('ALICE_ATTESTATION_UNAVAILABLE');
      const aliceInfo = await clients.alice.call<{ identity_pubkey?: string }>('/v1/getinfo');
      verifyLndIdentity(aliceInfo, expected);
      payerOrigin = clients.alice.origin ?? null;
      payerNode = aliceInfo.identity_pubkey ?? null;
      if (!payerNode || !/^(02|03)[a-f0-9]{64}$/.test(payerNode)) throw new Error('LND_IDENTITY_MISMATCH');
    }
    verified.lightning = true;
  }
  if (config.rails.liquid.enabled) {
    if (!clients.liquid) throw new Error('LIQUID_ATTESTATION_UNAVAILABLE');
    const blockchain = await clients.liquid.call('getblockchaininfo');
    const genesis = await clients.liquid.call<string>('getblockhash', [0]);
    const sidechain = await clients.liquid.call('getsidechaininfo');
    const wallet = await clients.liquid.call<{ walletname?: string }>('getwalletinfo', [], true);
    let checked: { chainName: string; policyAsset: string; parentGenesisHash: string };
    try {
      checked = verifyLiquidIdentity(blockchain, sidechain, config.rails.liquid);
    } catch (error) {
      // Never use this path for a conflicting/malformed fee_asset or another profile.
      if (!(error instanceof Error) || error.message !== 'LIQUID_FEE_ASSET_UNAVAILABLE' ||
        !['regtest', 'liquid-regtest'].includes(config.environment) || config.spendPolicy !== 'disabled') throw error;
      try {
        liquidAssetEvidence = await confirmedAssetEvidence(config, clients.liquid,
          { blockchain, sidechain, genesis, wallet });
      } catch { throw new Error('LIQUID_FEE_ASSET_UNAVAILABLE: confirmed wallet asset evidence failed'); }
      checked = { chainName: config.rails.liquid.chainName, policyAsset: liquidAssetEvidence.asset,
        parentGenesisHash: config.rails.liquid.parentGenesisHash };
    }
    if (config.rails.liquid.genesisHash && config.rails.liquid.genesisHash !== genesis) throw new Error('LIQUID_GENESIS_MISMATCH');
    if (wallet.walletname !== config.rails.liquid.wallet) throw new Error('LIQUID_WALLET_IDENTITY_MISMATCH');
    liquidOrigin = clients.liquid.origin ?? null; liquidWallet = config.rails.liquid.wallet; liquidGenesisHash = genesis;
    liquidChainName = checked.chainName; liquidPolicyAsset = checked.policyAsset; liquidParentGenesisHash = checked.parentGenesisHash;
    // Aggregate rail verification retains its stronger fee-policy contract.
    verified.liquid = liquidAssetEvidence === undefined;
  }
  if (config.deploymentId === null) throw new Error('DEPLOYMENT_ID_REQUIRED');
  return { environment: config.environment, deploymentId: config.deploymentId, genesisHash, wallet,
    bitcoinOrigin, providerOrigin, payerOrigin, providerNode, payerNode, liquidOrigin, liquidWallet,
    liquidGenesisHash, liquidChainName, liquidPolicyAsset, liquidParentGenesisHash,
    ...(liquidAssetEvidence ? { liquidAssetEvidence } : {}), verified };
}
