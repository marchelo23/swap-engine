# Liquid regtest readiness on the b10e4a7 environment contract

This change delivers a read-only diagnostic, not an executable swap adapter.
No Elements/Boltz deployment, payment, wallet creation, signing, mining or
broadcast was performed. Test fixtures are explicitly offline evidence.

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
`LIQUID_FEE_ASSET_UNAVAILABLE`; it does not invent a field or relax startup.

Coordination with DeepSeek Flash (Liquid worker, 2026-11-22) confirmed the same
source-level result for Elements 22.1.1 and 23.3.4. That worker reported no
Elements binaries or Docker in the VM and a sudo password requirement; no
real RPC response or attested provider was supplied. This workspace also has
no populated Liquid profile or Elements/Boltz executable on PATH.
These are setup limitations, not evidence that Elements or Chain Swaps cannot
work. A follow-up must implement and test version-specific fee-asset evidence
from the real lab; neither a user-supplied pin nor a guessed pegged-asset
fallback proves the running node's fee policy.

## Provider and route decision

Prefer a direct L-BTC to BTC Chain Swap when an attested local provider exists.
[Boltz documents Chain Swaps](https://api.docs.boltz.exchange/lifecycle.html)
and recommends [Boltz Client for server integrations](https://api.docs.boltz.exchange/libraries.html).
Use its supported client/SDK lifecycle and recovery implementation for a future
adapter. Merely adding `boltz-core` primitives to this TypeScript project does
not implement lifecycle persistence, restart recovery or authorization.

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
