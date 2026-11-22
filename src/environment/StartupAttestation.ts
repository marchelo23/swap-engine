import type { Config } from '../config.js';
import type { RailId } from '../core/RailContract.js';
import { verifyBitcoinIdentity, verifyLndIdentity } from './Identity.js';

type BitcoinReader = { call<T>(method: string, params?: unknown[], wallet?: boolean): Promise<T> };
type LndReader = { call<T>(path: string, body?: unknown): Promise<T> };

export type StartupScope = { environment: Config['environment']; deploymentId: string;
  genesisHash: string | null; wallet: string; verified: Partial<Record<RailId, boolean>> };

/** Read-only startup attestation. It runs before the journal/lock is opened and
 * never constructs a write-capable port. Ark/Liquid remain explicitly
 * unverified until a reviewed read-only probe is injected. */
export async function attestStartup(config: Config, clients: {
  bitcoin?: BitcoinReader | null; provider?: LndReader | null; alice?: LndReader | null }): Promise<StartupScope> {
  const verified: Partial<Record<RailId, boolean>> = {};
  let genesisHash: string | null = null; let wallet = '';
  if (config.rails.onchain.enabled) {
    if (!clients.bitcoin) throw new Error('ONCHAIN_ATTESTATION_UNAVAILABLE');
    const chain = await clients.bitcoin.call('getblockchaininfo');
    const genesis = await clients.bitcoin.call<string>('getblockhash', [0]);
    if (!config.bitcoinNetwork || !config.bitcoinGenesisHash) throw new Error('BITCOIN_ATTESTATION_UNAVAILABLE');
    verifyBitcoinIdentity(chain, genesis, { name: config.bitcoinNetwork, genesisHash: config.bitcoinGenesisHash,
      signetChallenge: config.signetChallenge ?? undefined });
    const wallets = await clients.bitcoin.call<string[]>('listwallets');
    const walletInfo = await clients.bitcoin.call<{ walletname?: string }>('getwalletinfo', [], true);
    if (!wallets.includes(config.rails.onchain.wallet) || walletInfo.walletname !== config.rails.onchain.wallet)
      throw new Error('WALLET_IDENTITY_MISMATCH');
    genesisHash = genesis; wallet = config.rails.onchain.wallet; verified.onchain = true;
  }
  if (config.rails.lightning.enabled) {
    if (!clients.provider) throw new Error('LIGHTNING_ATTESTATION_UNAVAILABLE');
    if (!config.bitcoinNetwork) throw new Error('LIGHTNING_ATTESTATION_UNAVAILABLE');
    const expected = config.bitcoinNetwork;
    verifyLndIdentity(await clients.provider.call('/v1/getinfo'), expected);
    if (config.rails.lightning.alice) {
      if (!clients.alice) throw new Error('ALICE_ATTESTATION_UNAVAILABLE');
      verifyLndIdentity(await clients.alice.call('/v1/getinfo'), expected);
    }
    verified.lightning = true;
  }
  if (config.deploymentId === null) throw new Error('DEPLOYMENT_ID_REQUIRED');
  return { environment: config.environment, deploymentId: config.deploymentId, genesisHash, wallet, verified };
}
