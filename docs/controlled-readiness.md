# Concrete read-only controlled readiness

`createControlledReadiness` supplies `ControlledRunRuntime.inspect` using the
existing Bitcoin RPC, LND, invoice decoder and active-chain confirmation adapters.
It never prepares a wallet transaction, locks or unlocks inputs, pays, signs,
broadcasts, mines, creates keys, or updates the swap journal. The HTTP execution
gate remains unchanged.

Install it locally with an immutable `ReadinessScope`: isolation UUID, approved
channel ID and exact channel funding outpoint, plus the expected loopback Core,
provider and payer origins. Pass read-only clients configured for those origins,
which must also match the mandatory routing pins in the approved plan. Pass
the existing store/swap ID, and a custody inspection callback. For existing
encrypted custody, `persistedReadinessCustody(clientVault, refundKeys)` restores
the client record and reads the provider refund key using the existing vault
classes, returns only the hash/public keys, and destroys restored client material
in memory. It never replaces or generates custody.

The inspector rejects:

- Stale/modified plans or journals, another active swap, any existing execution
  record, uncertain intent, or quote expiry.
- Non-regtest, initial download, unequal Core block/header heights, mismatched
  Core/LND hashes or heights, wrong node public IDs, missing peers, or incomplete
  LND chain/wallet synchronization.
- An unloaded/wrong wallet, watch-only/private-keys-disabled wallet, external
  signer, scanning state, or an encrypted wallet with less than 60 seconds of
  unlock time remaining. It never unlocks or loads a wallet.
- An absent, duplicated, locked, unsafe, unsolvable or non-owned approved input.
  The serialized confirmed transaction, wallet UTXO and mempool-aware `gettxout`
  must agree on exact outpoint, script, amount and confirmations. Inputs are
  native P2WPKH and conservatively require at least 101 coinbase confirmations.
  The one selected input must cover principal, the existing 1,000-satoshi funding
  reserve and the existing 10,000-satoshi wallet reserve; unrelated wallet entries
  cannot supply that proof. The exact refund/change address must be wallet-owned.
- Insufficient claim window: this initial readiness check requires 20–40 blocks
  remaining and an invoice CLTV delta covering the on-chain timeout plus 40.
- Relay or mempool fee floors above the existing fixed 2 sat/vB funding policy.
  Unsigned in-memory size models with maximum witness lengths verify the approved
  funding budget and claim fee; no signature or spendable transaction is created.
- Directional liquidity shortfalls. Both nodes must report exactly one active
  direct channel, matching the approved ID/outpoint, opposing public identities
  and capacity, with no pending HTLCs or unsettled balance and no zero-conf flag.
  Payer local and provider remote balances must each cover the invoice plus the
  routing-fee allowance after reserves and a conservative commitment-fee
  subtraction. Both sides' negotiated HTLC minimum, maximum pending amount and
  acceptance counts must support the amount. Opposite-direction balances and
  other channels are never aggregated. The channel funding transaction and its
  exact still-unspent capacity output are independently checked with Core.
- A substituted/non-open invoice, wrong independent invoice decoding, or missing
  restored client/refund custody identities.

Before returning, the inspector rechecks node tips/identities, channel views,
wallet inventory and locks, approved/channel UTXOs, fee floors, unpaid invoice,
Core tip and local journal. Changes or lookup errors fail closed without an
automatic retry. Public errors contain a fixed stage code rather than remote
response text. Returned readiness contains explicit public fields only.

Wire contracts were checked against LND v0.21.6-beta's
[channel definitions](https://github.com/lightningnetwork/lnd/blob/v0.21.6-beta/lnrpc/lightning.proto)
and Bitcoin Core's [gettxout](https://bitcoincore.org/en/doc/30.0.0/rpc/blockchain/gettxout/)
and [listunspent](https://bitcoincore.org/en/doc/30.0.0/rpc/wallet/listunspent/)
documentation. Core 30 deprecates `spendable` as always true; it is not sufficient
by itself, so wallet key configuration, solvability and exact address ownership
are also required.

This is a point-in-time inspection, not a lock on channel capacity or a proof of
network isolation. The scope is an operator assertion that must be independently
verified. The controlled payer restricts its first hop to this approved channel
and verifies direct route evidence. The [local runtime assembly](controlled-runtime.md)
connects the one-block miner and exact spender observer. Remaining work is isolated deployment,
approval provisioning/revocation, and isolated real-node consensus, routing, TLS,
permission, reorg and crash tests. These checks grant no execution authority and
do not weaken the existing local authorization or HTTP gates.
