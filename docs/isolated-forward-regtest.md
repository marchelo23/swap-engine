# BTC on-chain → Lightning in isolated regtest

The forward service is internal; no HTTP route or financial web capability is
enabled. The caller supplies the authenticated owner's ID (never a body field),
and the operator pins one provider LND, one payee and one direct channel.
Keep one durable `Store` per payer; do not replace or clone it to retry a send.

Admission validates a fixed-amount regtest invoice (1,000–200,000 sats) before
requesting a fresh native SegWit address from the Core provider wallet. The
reservation is exclusive to the owner and invoice hash. Use a single output for
the exact quoted amount (invoice plus 100 sats); the fixture does not implement
refunds or return unused fee reserve. Core must attest a wallet-controlled,
unspent output with at least two confirmations, and LND must agree with Core's
tip. Before sending, the adapter also checks that the channel funding is still
unspent and has at least six confirmations. An active channel flag alone is not
enough after rebuilding an isolated chain.

`ForwardExecutor` records an irrevocable send intent before using LND Router
REST. `UNKNOWN` is not authorization to resend, even when LND returns no
payment or a failure. Recovery reopens the same journal, tracks on the same
payer, and requires matching hash, preimage, amount and fee evidence before
recording `SUCCEEDED`. The preimage is not persisted.

To verify on the existing `swap-engine-iso-regtest` stack:

```sh
npx tsx scripts/verify-forward-isolated.ts --spend-isolated-regtest
```

This is an opt-in **funded** fixture: it uses the existing Core wallet to fund
its own reserved output, mines two blocks, and pays Alice 5,000 regtest sats.
It requires exactly one eligible direct channel with live funding and outbound
liquidity. The script rejects a wrong owner, wrong amount, duplicate invoice and
unconfirmed deposit, simulates loss of the terminal payment response, reopens
the store, verifies one send and one tracking request, and checks settlement on
Alice independently. It retains the private journal outside the repository for
reconciliation. If the script fails after a send intent, investigate and
reconcile that record rather than sending the invoice again.

## Isolated validation (2026-11-25)

The first journaled attempt failed before any HTLC was sent: LND listed a stale
channel as active, but Core no longer had its funding output. That invoice was
not resent. A new 200,000-sat channel was opened on the same isolated nodes and
confirmed in Core. With a new invoice, the fixture observed two deposit
confirmations, one Router send, one Router track after reopening the journal,
and Alice independently reported `SETTLED` for 5,000 sats. This is
self-funded laboratory evidence, not an externally funded user swap.
