# Invoice-only preparation harness

`createReversePreparation` is a local operator capability with injected adapters.
It is not registered with HTTP or startup, loads no credentials by default, and
cannot pay, fund, sign, broadcast, mine, settle or cancel. Tests use synthetic
adapters only; no VM/node calls were made for this implementation.
Validation: build and `git diff --check` passed; 48 focused tests passed, including
20 preparation tests for quote/fee identity, expiry, durable wire intent, duplicate
guards, store reopen, concurrent recovery, actor conflicts and backend compatibility.

It requires a strict public `PreparationSpec`, an explicitly installed
`PreparationApproval` with scope `isolated-regtest-invoice-only`, a digest of the
entire spec, and an unexpired approval. The spec binds both node identities,
loopback origins, channel ID/funding outpoint, exact proposed funding input/value,
claim/refund destinations, public custody identities, tip and isolation UUID.
Missing authority is rejected before reads or writes. It does not generate or
replace custody: new material must already have been durably provisioned and
independently restored by the approved custody workflow.

`prepare()` reserves one preparation in a fresh isolated store, then uses the
existing `SwapManager` once to produce one 50,000-satoshi quote and one swap.
The complete quote, including UUID, expiry and every fee, is shared with the plan.
Policy remains service fee 750, invoice 50,750, claim fee 500, funding reserve
1,000 and routing ceiling 100 satoshis; nothing changes the execution gate or
downstream direct-route requirement for zero fees. Quote lifetime stays 120 seconds.
Directional liquidity is read from the exact channel after reserves/commitment
fee; full funding/value/fee/readiness evidence is required before a prepared result.

The existing `invoiceOnlyPorts` verifies the hold invoice and independent payer
decoding. The harness journals `CREATE_INVOICE` and an additional invoice attempt
before invoking its transport. A required `beforeRequest` hook runs after
credential loading, rechecks identity/channel/custody, definitive hash absence,
exact quote, approval/quote expiry, revision and intent, then consumes a durable
one-shot wire authorization. Missing or repeated guard calls cannot produce a
prepared result. The adapter must send immediately after the guard and must never
retry or fall back to another endpoint. Node authentication and transport errors
cannot be treated as proof that the invoice hash is absent.

Invoice publication uses the exact owned swap revision and snapshot. Stale actor
updates cannot be overwritten, including after a successful remote POST. Final
readiness and unpaid-invoice evidence are rechecked before publishing `READY`.
The returned status is `PREPARED_UNPAID_NOT_AUTHORIZED`; `plan.executionApproved`
stays false. The short-lived `request` is a draft for separate operator approval,
not installed execution authority. It binds the exact plan/input/swap/isolation
digest, swap revision and two-block limit, expiring within 90 seconds and never
after the original quote. Repeated retrieval rechecks evidence and never refreshes
the request or creates another quote/invoice.

`recover(expectedRevision)` performs node reads and fenced application metadata
updates only. It looks up the original hash and independently verifies the exact
OPEN, unpaid invoice and decoder evidence. With a durably authorized prior wire
attempt, it can adopt a lost reply at the expected revision and complete readiness.
Recovery revokes the earlier preparation owner before lookup; delayed creators and
parallel recoveries cannot overwrite its result. Absent, held, paid, canceled,
expired, malformed or substituted evidence remains uncertain. Pre-invoice partial
preparations, including an orphaned durable quote, require manual review; no phase
is blindly replayed. Store reopen does not grant permission to recreate anything.

## Local assembly contract

The caller installs trusted read adapters and these three narrow capabilities:

```ts
const preparation = createReversePreparation(store, spec, {
  bitcoin, provider, payer,
  custody: persistedReadinessCustody(clientVault, refundKeys),
  invoiceStatus: reviewedHashLookup, // ABSENT only for definitive not-found evidence
  createInvoice: reviewedInvoiceTransport, // await the supplied beforeRequest hook after credentials
  inspect: (id, plan, spec) => createControlledReadiness(
    store, id, { ...spec.routing, isolationId: spec.isolationId },
    bitcoin, provider, payer, persistedReadinessCustody(clientVault, refundKeys),
  )(plan, { txid: spec.input.txid, vout: spec.input.vout }),
}, preparationApproval);
const result = await preparation.prepare();
// After interruption: await preparation.recover(currentPersistedSwapRevision).
// Neither result nor recover() calls the execution runtime.
```

The [concrete LND adapter and operator CLI](lnd-invoice-preparation.md) now implement
the guarded invoice transport, definitive absence lookup, concrete inspector/custody
wiring and exclusive public artifact export. Existing `LndClient.addHoldInvoice`
still lacks a wire hook and must not replace that adapter. Fresh custody, invoice,
matching swap and input/execution approvals have not been created on real nodes.
This new path has not been staged or exercised on the VM; prior VM evidence
predates it. Actual POSIX CLI lifecycle, credential permissions, isolation,
deadlines and node/crash/reorg behavior remain unverified.
