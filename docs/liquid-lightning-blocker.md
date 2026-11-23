# Liquid to Lightning: own HTLC route, execution blocked

Base: main `c97be12`. Boltz is excluded by the coordinator's updated user
instruction. No Boltz dependency, endpoint, deployment or integration was added.
The old preflight provider suggestion is cleared; no public service or mainnet
fallback exists. The direct route needs an operator acting as the Lightning
payer and the Liquid HTLC claimant, using the project's own adapters.

## Actual lab evidence and exact blocker

DeepSeek Liquid confirmed the private Elements 23.3.4 lab on loopback 7052,
`elementsregtest`, height 2, wallet `lqwd-liquid-ops`, with one confirmed
spendable UTXO containing 21 Liquid test units. These are regtest assets, not
real BTC. Its reported genesis is
`209577bda6bf4b5804bd46f8621580dd6d4e8bfa2d190e1c50e932492baca07d`, asset is
`b2e15d0d7a0c94e4e2ce0fe6e8691b9e451377f6e46e8045a86f7c4b5d4f0f23`, and
parent genesis is Bitcoin regtest
`0f9188f13cb7b2c71f2a335e3a4fc328bf5beb436012afca590b1a11466e2206`.
The worker reported `.env` at `/home/truja/.config/lqwd-liquid-ops.env`,
spending/live flags disabled and no installed/attested swap provider. This
task did not access the VM, change its configuration or move funds. Public lab
values above are reported evidence, not a fresh attestation performed here.

The blocker is **not the wallet's balance**. The repository has no attested
Liquid lockup/claim/refund transaction adapter or durable Liquid-to-Lightning
coordinator. `HtlcBuilder`, `ClaimManager`, `RefundManager` and
`SwapCoordinator` use Bitcoin regtest addresses and `bitcoinjs-lib`
transactions/signature hashes. Their existing reverse-swap ordering is also
different from a chain-to-Lightning payment. They cannot parse, blind, sign or
verify Elements transactions by changing a URL or rail label. The read-only
Elements client intentionally cannot pay, sign or broadcast.

The current wallet/coinbase observation verifies chain, wallet and matching
asset only; it still does not prove current fee policy or provider identity.
See [the existing limited-evidence contract](liquid-regtest-preflight.md).

## Implemented safe subset

The API exposes authenticated `GET /v1/liquid/lightning/availability` and
authenticated, CSRF-protected POST paths `/v1/liquid/lightning/quotes` and
`/v1/liquid/lightning/swaps`. These POST paths accept only the strict request
shape `{ route: 'liquid-to-lightning', invoice, debitSats }` with an idempotency
key, then always return 503 `LIQUID_LIGHTNING_ATOMIC_ADAPTER_UNAVAILABLE`.
An invoice prefix is only a syntax check; the response never claims it was
decoded, signature-verified, quoted, paid or settled. Neither USER nor ADMIN
can bypass the gate. No quote ID, swap ID, invoice creation, reservation,
signing, payment, journal change or recovery claim is produced. Duplicate
blocked requests remain side-effect free; this is not a durable execution
idempotency implementation. Existing generic Bitcoin quotes are never called.

`liquid:preflight` also reports the independently blocked `liquidToLightning`
route. Mainnet and simulation do not install an executor either.

The provider-independent review primitives are unit-tested, but deliberately
not wired to produce a quote or authorize an action:

- Exact debit: `inputs - ownedChange = requestedDebit = lockup + fundingFee`.
  Every value must be a nonnegative safe integer; hidden extra reserves,
  rounding, fractional satoshis and mismatched totals are rejected. A future
  Elements parser must derive these totals from actual verified assets and
  outputs, not trust JSON supplied by a client. Refund reserves must be
  budgeted separately without silently increasing the approved debit.
- Invoice review: independently verified regtest BOLT11 decoding must match
  the pinned hash, payee, sats and millisats, with minimum CLTV and invoice/
  quote expiry margins. The existing decoder-result checker is reused; it is
  not a BOLT11 signature decoder. No such decoder is installed in this route.

## Required atomicity and recovery before any funding

The HTLC must commit to the hash of the independently verified destination
invoice. The operator/payer owns the claim key; the Liquid sender owns the
refund key. The amount, asset, confidential commitments and proofs, output
script, network/genesis, refund destination and timeout must be independently
verified from an Elements transaction, with the same invoice/hash and budget
bound to the authenticated owner and immutable approval digest.

The operator must not initiate Lightning payment until the exact HTLC funding
outpoint is confirmed on the attested private chain and sufficient claim time
remains. Paying the invoice yields the preimage; verify its hash before using
the operator claim branch. Monitor confirmed claim/refund outcomes independently.
A submitted txid, an RPC timeout, an invoice prefix or an SDK status alone
cannot mean settled. Lightning payment time limits, final CLTV, Elements block
timeouts and a conservative claim/refund margin must be reviewed together.

Before broadcasting, durably preserve the signed/recoverable refund path and
encrypted recovery material, bound to owner, asset, chain, invoice hash and
outpoint. Journal a mutation intent before every external effect; reconcile
ambiguous broadcasts/payments by txid/payment hash after restart rather than
retrying blindly. Owner-scoped idempotency must bind the entire approved digest
and reject a changed request with the same key. Never repay a settled invoice.
Failure, pending payment and refund must remain distinct; a failed invoice does
not prove the lockup was refunded. Reorg, expiry-before-funding, failed payment,
stuck claim, late preimage and refund/claim race tests are prerequisites to
enabling this own-adapter route, not implemented live assurances.

The code needed to prove those invariants is missing. This delivery therefore
reports the feature blocked, and provides only the guarded API and review
primitives. Its tests use explicit offline fixtures; none is a settled swap.
