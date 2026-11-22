export type OperatorBindingExpectation = { wallet: string; genesisHash: string; bitcoinOrigin: string; providerOrigin: string;
  payerOrigin: string; providerNode?: string; payerNode?: string; bitcoinCookiePath: string;
  providerCertPath: string; providerReadMacaroonPath: string; payerCertPath: string; payerReadMacaroonPath: string };
export type OperatorBindingSpec = { wallet: string; providerNode: string; payerNode: string;
  routing: { bitcoinOrigin: string; providerOrigin: string; payerOrigin: string } };
export type OperatorBindingPaths = { bitcoinCookiePath: string; providerCertPath: string;
  providerReadMacaroonPath: string; payerCertPath: string; payerReadMacaroonPath: string };

/** Binds a reviewed CLI/owned spec to the same attested runtime configuration
 * before any journal or action-capable port is opened. */
export function assertOperatorBinding(spec: OperatorBindingSpec, paths: OperatorBindingPaths,
  expected: OperatorBindingExpectation) {
  if (spec.wallet !== expected.wallet || spec.providerNode !== expected.providerNode ||
    spec.payerNode !== expected.payerNode || spec.routing.bitcoinOrigin !== expected.bitcoinOrigin ||
    spec.routing.providerOrigin !== expected.providerOrigin || spec.routing.payerOrigin !== expected.payerOrigin ||
    paths.bitcoinCookiePath !== expected.bitcoinCookiePath || paths.providerCertPath !== expected.providerCertPath ||
    paths.providerReadMacaroonPath !== expected.providerReadMacaroonPath ||
    paths.payerCertPath !== expected.payerCertPath || paths.payerReadMacaroonPath !== expected.payerReadMacaroonPath)
    throw new Error('OPERATOR_BINDING_MISMATCH');
}

/** Same binding plus live read-only chain/wallet/LND identity attestation. Runs
 * before Store.open/action ports; any failure is execution-disabling. */
export async function attestOperatorBinding(clients: {
  bitcoin: { call<T>(method: string, params?: unknown[], wallet?: boolean): Promise<T> };
  provider: { call<T>(path: string): Promise<T> };
  payer: { call<T>(path: string): Promise<T> };
}, spec: OperatorBindingSpec, paths: OperatorBindingPaths, expected: OperatorBindingExpectation) {
  assertOperatorBinding(spec, paths, expected);
  const chain = await clients.bitcoin.call<{ chain: string; initialblockdownload: boolean; bestblockhash: string }>('getblockchaininfo');
  if (chain.chain !== 'regtest' || chain.initialblockdownload !== false || !/^[a-f0-9]{64}$/.test(chain.bestblockhash))
    throw new Error('OPERATOR_BINDING_MISMATCH');
  const genesis = await clients.bitcoin.call<string>('getblockhash', [0]);
  if (genesis !== expected.genesisHash) throw new Error('OPERATOR_BINDING_MISMATCH');
  const wallets = await clients.bitcoin.call<string[]>('listwallets');
  const wallet = await clients.bitcoin.call<{ walletname?: string }>('getwalletinfo', [], true);
  if (!wallets.includes(spec.wallet) || wallet.walletname !== spec.wallet) throw new Error('OPERATOR_BINDING_MISMATCH');
  for (const [client, node] of [[clients.provider, spec.providerNode], [clients.payer, spec.payerNode]] as const) {
    const info = await client.call<{ identity_pubkey?: string; chains?: Array<{ chain: string; network: string }>; synced_to_chain?: boolean }>('/v1/getinfo');
    if (info.identity_pubkey !== node || info.synced_to_chain !== true ||
      !info.chains?.some(c => c.chain === 'bitcoin' && c.network === 'regtest'))
      throw new Error('OPERATOR_BINDING_MISMATCH');
  }
}
