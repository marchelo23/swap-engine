# Controlled reverse execution boundary

`createControlledReverseBackend` connects the existing runner to a local,
explicitly installed operator capability. It supplies no real node transports and
is not registered with the HTTP server or application startup. The existing live
creation gate and `ENABLE_LIVE_SWAPS` rejection are unchanged. Neither a request
body nor an environment flag grants execution authority.

A local authorization must bind an approval UUID, exact swap ID and revision,
isolated regtest scope UUID, expiry no later than the approved quote, and a digest
of the complete verified plan plus exact funding input and a two-block maximum.
The plan binds the selected channel ID/funding outpoint and all three node
origins; changing any pin invalidates approval. Routing and public node identities
are retained in the durable reservation for read-only recovery. Legacy plans or
controlled records missing routing pins fail closed and need operator review.
The plan continues to have `executionApproved: false`: execution authority is a
separate, expiring local capability, never a plan-field toggle. Input objects are
copied before use.

Before reserving execution, the backend requires one active swap in the store,
the exact fresh quote/contract/destination, unchanged revision and journal,
regtest readiness, pinned provider/payer identities, restored client/refund public
key identities, an approved confirmed/safe/spendable input, independently decoded
invoice hash/amount/payee/CLTV/expiry, and sufficient claim window. The trusted
runtime's `inspect` must derive this evidence from real read-only node calls and
custody verification. An isolation UUID is an operator scope assertion; node
isolation cannot be established from an LND network label alone.

The backend atomically reserves a `controlledExecutions` record before invoking
the runner. Every swap can consume only one reservation, across backend instances
and restarts. The existing runner then journals payment, funding, claim and mining
intents and applies accepted-HTLC, exact claim witness, settlement and actual payer
completion checks. Public results contain only ID, state and revision. Raw RPC
failures are not returned through the backend execution error.

Mining requests must reference the precise funding or journaled claim transaction
and the runner's current durable mining intent. One block of budget is consumed
before each `mineOne` call, including unknown outcomes; at most two requests are
allowed. The observed chain height must increase by exactly one per request, and
the existing runner independently verifies confirmation. A misbehaving transport
or external miner cannot be undone: unexpected height changes quarantine the run.
The concrete `mineOne` adapter must request exactly one block and must never retry
an uncertain mining RPC.

An ambiguous run is recorded as `UNKNOWN` and refuses another execution,
regardless of unused mining budget. Startup recovery also sends an interrupted
execution reservation with no payment intent to `MANUAL_REVIEW`. Existing
evidence reconciliation remains available separately; it does not clear or reuse
execution authorization. Automatic cancellation or refund is unavailable here.

## Work still required before real execution

1. Provision and independently inspect a dedicated, isolated regtest node context,
   with pinned endpoint identities, the approved wallet/UTXO/destinations, a
   complete public plan, and verified client/provider custody restoration.
2. Install and review the [local runtime assembly](controlled-runtime.md) using the existing
   `controlledReversePorts`, the [bounded controlled payer](controlled-payer.md),
   accepted-invoice observer, client-only claim signer, exact spender observer,
   and one-block miner. The assembly has mocked-node coverage; actual
   LND/TLS/macaroons and held-payment behavior still require isolated validation.
3. Assemble the [concrete read-only readiness inspector](controlled-readiness.md)
   with the verified node scope and existing custody vaults; prevent HTTP callers
   from forging evidence or installing approval capabilities, and validate its
   strict single-channel constraints against the isolated nodes.
4. Review operator approval issuance and revocation, isolation guarantees, audit
   retention and concurrency across processes. The store remains single-writer
   and requires deliberate lock recovery after an actual process crash.
5. Validate actual Core consensus, exact funding fees/inputs, LND multipart and
   deadline behavior, bounded mining, confirmed claims/refunds, reorgs and lost
   replies in the isolated context before considering a real execution approval.

Current tests use fake node ledgers and synthetic signatures, including complete
runner execution and store reopen/recovery scenarios. They establish application
invariants, not real consensus or an executed reverse swap. No real payer client,
credential access, broadcast, mining, VM change or frontend change is involved.
