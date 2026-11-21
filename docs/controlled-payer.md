# Controlled LND payer adapter

`ControlledLndPayer` provides `startPayment` and `waitAccepted` for the existing
controlled runtime. `HttpsLndPaymentTransport` implements LND v0.21.6-beta's
`POST /v2/router/send` stream and explicit `GET /v2/router/track/{payment_hash}`
observation. These are the official
[REST mappings](https://github.com/lightningnetwork/lnd/blob/v0.21.6-beta/lnrpc/routerrpc/router.yaml)
and [router request contract](https://github.com/lightningnetwork/lnd/blob/v0.21.6-beta/lnrpc/routerrpc/router.proto).
Neither class is installed in application startup or exposed over HTTP; the live
execution gate remains disabled.

The adapter requires the exact verified plan, funding input and local backend
approval. The runner must already have persisted its payment `INTENT`, and the
backend must have reserved its matching isolated execution. Before any request
or credential load the adapter consumes a durable `payerSend` attempt UUID in
that execution record. Existing attempts are never sent again, including after
a crash, a failed response, cancellation, or a new adapter instance.

The mandatory plan routing section pins the channel ID, exact funding outpoint
and Core/provider/payer origins. The complete plan participates in the approval
digest, and the reserved execution retains these routing and node identities.
Older plans or controlled records without these pins require review and new
authorization; they are never assigned a channel automatically.

Payer node identity, synchronized Bitcoin regtest and wallet state are checked,
and the inspection client and streaming transport must use the approved origin,
and the independent payer invoice decoder must match the exact amount, hash,
provider public key, network, expiry and CLTV. After credential loading, a final
guard checks the current durable intent, plan, isolation and authorization expiry
immediately before creating the POST. TLS verification is mandatory, endpoints
must be loopback HTTPS, and arbitrary paths, request fields and fee limits are
rejected. The POST requests 60 seconds to start an HTLC, a 100-satoshi fee limit,
at most 16 parts, and no self-payment or AMP. Its mandatory `outgoing_chan_ids`
contains exactly the approved channel ID. The active payer channel must still
match its approved peer and funding outpoint before sending, after credentials
load, and after success. There is no alternate-channel fallback.

The returned handle is asynchronous. The client has a 120-second absolute
deadline by default (maximum configurable deadline 300 seconds), a 15-second
socket inactivity limit, 2 MB total response limit, 256 KiB buffered-frame limit
and 128 nonblank update limit. Streaming updates must have exact payment identity,
satoshi/millisatoshi amounts, supported status/failure reason and fees within the
existing limit. Success additionally requires a matching preimage hash, which is
verified only in memory and omitted from results, journals and errors. Every
attempt must include a direct one-hop route over the approved channel to the
provider with exact per-part amounts and zero forwarding fees. Unique attempts,
bounded parts and exact successful totals are required; missing routes, another
channel, extra hops, partial success or remaining in-flight parts fail closed.
The existing 100-satoshi policy cap is unchanged; this direct-channel adapter
accepts only zero fees, following LND's single-hop route contract.

`waitAccepted` requires both an observed payer `IN_FLIGHT` update and the exact
provider `ACCEPTED` invoice, with accepted HTLC amounts and deadlines validated by
the existing hold-invoice manager. Its polling and lookup waits race the bounded
payment result. The runner also stops new funding or claim publication after a
known payer observation failure; confirmed claims still undergo normal evidence
checks before settlement so a published claim can be reconciled safely.

`stopClient()` is idempotent and closes only local observation. The send request
sets `cancelable=false`; closing the connection does not cancel the remote LND
payment loop or promise that held HTLCs failed. LND documents that its send timeout
does not abort in-flight HTLCs. Disconnects, EOF, malformed/truncated responses,
HTTP errors, unknown statuses, timeout and cancellation persist uncertainty and
require reconciliation. There is no reconnect, retry, cancellation RPC, or send
fallback. A definitive supported `FAILED` update is recorded separately, without
automatically freeing swap reservations.

`trackExisting(hash)` opens only a GET stream for the already journaled hash. It
can observe after approval expiry or process restart and does not clear `UNKNOWN`
or `INTENT` execution records, initiate a payment, or retry a send. Existing
read-only payer recovery and exact chain/invoice reconciliation remain the
authority for deciding what evidence has been proven.

Tests drive the actual HTTPS request and streaming parser code with mocked Node
request/response objects and synthetic credentials. They cover chunk boundaries,
cancel/timeout/error handling, pre-request races, orphaned crash intents, explicit
GET tracking, concurrent instances and full fake-ledger runner completion. This
does not validate TLS or LND against real nodes. Remaining work includes assembling
the [local runtime assembly](controlled-runtime.md) and
[concrete readiness inspector](controlled-readiness.md) with the independently
verified isolated scope and custody vaults, approval provisioning,
and isolated real-node consensus/reorg/lost-reply tests before execution approval.
