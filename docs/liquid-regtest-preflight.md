# Liquid regtest readiness on the b10e4a7 environment contract

This change delivers a read-only diagnostic, not an executable swap adapter.
No Elements/Boltz deployment, payment, wallet creation, signing, mining or
broadcast was performed by this implementation. Test fixtures are explicitly
offline evidence; the VM was not accessed for implementation or testing.

## Stock Elements confirmed-asset evidence

DeepSeek's later installed-lab report (commit `3a0da80`,
`docs/liquid-regtest-lab.md`) supplies public identity values for Elements
23.3.4 at height 101. This implementation consumes live RPC responses when run
against that lab; it never substitutes those recorded values for a current RPC.

When `fee_asset` is absent, startup and preflight now collect a separate,
limited evidence object. This path is restricted to `APP_ENV=liquid-regtest`,
`SPEND_POLICY=disabled`, `LIQUID_NETWORK=elementsregtest`, read-only confirmation
policy, a pinned native genesis and a loopback reader matching the configured
origin. It checks wallet identity, synced chain and Bitcoin regtest parent.

The probe reads the current tip with `getblockhash(height)` and
`getblock(hash, 2)`, checks the requested hash/height and positive confirmation,
and verifies that the first transaction has exactly one coinbase input. An
explicit coinbase output asset must match `LIQUID_POLICY_ASSET`. Independently,
wallet-scoped `listunspent` must contain a positive, confirmed, safe, spendable
UTXO of that same asset. The output need not be the coinbase UTXO: this proves
asset equality, not that the wallet owns that particular coinbase. A zero-value
coinbase output can establish the observed asset identifier but never a balance
or fee-policy claim. Confidential coinbase asset commitments alone are rejected.

The probe rechecks the tip and anchor hash after collection; chain progress or
reorg invalidates the snapshot. A new read can retry later. It reads at most
10,000 returned UTXOs, emits no raw wallet rows, addresses, blinders or errors,
and never signs, funds, imports, derives addresses, mines or broadcasts.
`listunspent` and decoded `getblock` are documented in the
[Elements RPC reference](https://elementsproject.org/en/doc/23.2.1/rpc/wallet/listunspent/)
and [block reference](https://elementsproject.org/en/doc/23.2.1/rpc/blockchain/getblock/).

Successful limited evidence reports `identityVerified=true`,
`walletAssetVerified=true`, `feePolicyVerified=false`, and
`CURRENT_FEE_POLICY_UNPROVEN`. The startup scope exposes `liquidAssetEvidence`;
preflight exposes `elements.assetEvidence` with reason
`LIQUID_FEE_POLICY_UNVERIFIED`. Aggregate `verified.liquid`, public rail
availability and execution remain false. The legacy state-scope asset field
still binds the configured asset pin; it does not upgrade this evidence into a
verified policy. Existing profiles and the stronger explicit `fee_asset` path
retain their previous behavior. A conflicting/malformed reported fee asset
never falls through to the limited-evidence path.

The distinction is essential: Elements allows separate subsidy and fee assets;
its [23.3.4 chain parameters](https://github.com/ElementsProject/elements/blob/elements-23.3.4/src/chainparams.cpp)
allow `subsidyasset` and default custom-chain subsidy to zero. A historic
coinbase plus a matching wallet asset does not prove the current node fee
configuration, acceptance policy, spend authorization or provider identity.
No attested swap adapter is installed. Public capabilities remain conservative;
operators can inspect the richer diagnostic without implying swap readiness.

## Run against an existing, reviewed local lab

Copy `.env.liquid.regtest.example` to an untracked `.env`, replacing all
placeholders with reviewed values. Keep `APP_ENV=liquid-regtest`,
`SPEND_POLICY=disabled`, `LIQUID_EXECUTION_ENABLED=false` and all four
reverse/forward/guest/mining flags false. Pin `LIQUID_GENESIS_HASH` as well as
the policy asset and parent genesis. Configure the optional three Bitcoin
variables together if a destination Core wallet already exists.

```sh
npm run liquid:preflight
# Alternatively, select a specific profile without copying it:
node --env-file=.env.liquid.regtest.local --import tsx scripts/liquid-preflight.ts
```

The npm command uses the same `.env` loader as `npm start`; exported process
variables retain precedence. Do not load both profiles at once. No journal,
vault, server or wallet writer is opened. Output contains fixed error codes,
version and public chain/asset hashes, never cookies or raw RPC errors.
Exit 1 means invalid configuration; exit 2 means the diagnostic completed but
the swap route is unavailable. It intentionally cannot exit 0 in this milestone.

Local probes check synced chain, pinned native genesis, wallet, policy asset,
pegged asset and Bitcoin regtest parent. The L-BTC route additionally requires
the policy and pegged assets to match; arbitrary issued assets are unsupported.
Core is independently verified with chain/genesis and wallet reads. No Lightning
credentials or running LND are required for this diagnostic.

## Elements compatibility finding

`b10e4a7` requires `getsidechaininfo.fee_asset`. The official
[Elements 23.2.1 RPC reference](https://elementsproject.org/en/doc/23.2.1/rpc/blockchain/getsidechaininfo/)
does not list that field. Its `pegged_asset` is not sufficient evidence of the
fee asset: Elements allows a separate `feeasset` startup option, as described
in the [confidential transactions tutorial](https://elementsproject.org/elements-code-tutorial/confidential-transactions).
The current startup contract therefore fails closed on those stock responses.
The new diagnostic records the numeric node version and
`LIQUID_FEE_ASSET_UNAVAILABLE` if the limited evidence also fails. Successful
limited evidence permits read-only startup while retaining an unverified rail;
it does not invent the missing fee field or relax fee-policy verification.

Initial coordination with DeepSeek Flash (Liquid worker, 2026-11-22) confirmed the same
source-level result for Elements 22.1.1 and 23.3.4. That worker reported no
Elements binaries or Docker in the VM and a sudo password requirement; no
real RPC response or attested provider was supplied. This workspace also has
no populated Liquid profile or Elements/Boltz executable on PATH.
That initial setup inventory was superseded by DeepSeek's installed-lab report
above. Current fee-policy evidence and an attested provider are still missing;
neither a user-supplied pin, a matching coinbase nor a guessed pegged-asset
fallback proves the running node's current fee policy.

## Provider and route decision

The current user instruction excludes Boltz, superseding the earlier SDK
evaluation. The preflight no longer nominates a provider (`candidate=null`).
The separate [own-HTLC Liquid-to-Lightning assessment](liquid-lightning-blocker.md)
documents the missing Elements transaction and recovery adapters; its blocked
status is also reported as `liquidToLightning`. No provider choice or chain
identity alone installs lifecycle persistence, restart recovery or authorization.

This change installs no SDK and contacts no public swap provider. The report
says `PROVIDER_ADAPTER_NOT_INSTALLED`, `attested=false`, and `available=false`
even when local chain checks pass. Local chain identity cannot prove which
nodes a provider uses. Before enabling a future adapter, bind the reviewed
provider deployment/client version, endpoint and backend node identities to
the exact Core genesis, Elements native/parent genesis and policy asset; verify
the L-BTC/BTC direction, limits, liquidity, fee quote and expiry through the
supported client. A pair listing or a version string is not that attestation.
Retain the existing explicit permissions, spend gates and recovery export
before funding, plus independent destination confirmation verification.

Lightning fallback is disabled. A future two-phase alternative must persist
both Liquid-to-Lightning and Lightning-to-Bitcoin statuses and identifiers;
reserve aggregate lockup, routing, provider, claim and refund budgets; preserve
recovery material for both legs before spending; reconcile restart/timeout,
first-leg success with second-leg failure, ambiguous payments and independent
refund deadlines; and prove these cases with tests and authorized regtest
evidence. One successful invoice must never mark the entire route settled.

## Verification

`tests/liquidPreflight.test.ts` covers diagnostic-only behavior, missing fee
asset, incorrect identities, missing native genesis pin, reader origin,
unsynced nodes, redacted errors, exact RPC reads, mutation rejection and
redirect rejection. Existing environment/startup tests retain the previous
gates. None of these fixtures represents a completed on-chain swap.

`tests/liquidConfirmedAsset.test.ts` additionally covers stock response shapes
over a local HTTP RPC fixture, public identity values from the lab report,
zero-value coinbase versus a positive wallet UTXO, differing pegged asset,
incorrect wallet/genesis/parent/chain/origin, profile restrictions, missing and
unsafe UTXOs, orphan/unconfirmed blocks, malformed coinbase, wrong asset,
reorg detection, contradictory reported fee asset and mutation rejection.
The HTTP fixture verifies wallet RPC routing and the exact read methods.
It does not claim a live VM test or cryptographic verification independent of
the trusted local node.
