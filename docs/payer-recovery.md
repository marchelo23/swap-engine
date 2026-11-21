# Read-only existing-payment recovery

Recovery remains disabled by default. It does not enable reverse swap creation,
runner execution, payment sends, funding, signing, broadcasts, settlement,
cancellation, or mining. `ENABLE_LIVE_SWAPS=true` still fails startup.

An operator can configure evidence reconciliation with
`ENABLE_READ_ONLY_RECOVERY=true` and all of the following settings:

| Setting | Required value |
| --- | --- |
| `RECOVERY_PROVIDER_NODE_PUBKEY` | Independently verified provider public node ID |
| `RECOVERY_PAYER_NODE_PUBKEY` | Independently verified, different payer public node ID |
| `RECOVERY_PAYER_REST_URL` | Existing loopback HTTPS REST endpoint |
| `RECOVERY_PAYER_TLS_CERT_PATH` | Path to the existing payer TLS certificate |
| `RECOVERY_PAYER_MACAROON_PATH` | Path to an existing suitably scoped read-only macaroon |

Existing `LND_*` settings identify the provider, and `BITCOIN_*` settings identify
Bitcoin Core. Configuration creates no credentials and changes no node settings.
The operator must verify endpoint identities and credential permissions locally;
never put certificate contents, macaroons, cookies, or private material in requests.

Read the current revision with `GET /v1/swaps/:id/revision`, then request
`POST /v1/swaps/:id/reconcile` with JSON `{"expectedRevision":123}` using that
revision. Stale revisions return 409. The result contains only `id`, `revision`,
`state`, and `next`; `next` describes an observed recovery stage and executes no
action. Payment or chain evidence supplied in the HTTP body is rejected. Missing
or uncertain external evidence retains `MANUAL_REVIEW` and reservations.

The adapter uses one unary `GET /v1/payments` request with
`include_incomplete=true`, `index_offset=0`, `max_payments=100`, `reversed=false`,
`count_total_payments=false`. Existing controlled execution records require
`omit_hops=false` and their durable channel/outpoint, endpoint and public node
pins; missing pins or configuration changes fail closed. Noncontrolled legacy
reconciliation uses `omit_hops=true`. This avoids streaming and
automatic reconnection or retries. Both before and after lookup it requires the
pinned payer identity, Bitcoin regtest, and synchronized chain and wallet state.
Provider invoice lookup likewise checks the pinned provider identity.

The supported wire contract is documented in LND v0.21.6-beta's
[Lightning protobuf](https://github.com/lightningnetwork/lnd/blob/v0.21.6-beta/lnrpc/lightning.proto)
and [REST mappings](https://github.com/lightningnetwork/lnd/blob/v0.21.6-beta/lnrpc/lightning.yaml).
LND's [payment marshaling](https://github.com/lightningnetwork/lnd/blob/v0.21.6-beta/lnrpc/routerrpc/router_backend.go)
reports satoshi fees by truncating millisatoshis; this adapter verifies both fields
and rounds upward for comparison with the existing satoshi fee limit.

Only a single exact payment hash match is accepted, with ordered unique payment
indexes, matching page offsets, canonical integer quantities, exact satoshi and
millisatoshi values, and a supported consistent status/failure reason. Successful
payment evidence also requires a preimage that hashes to the payment hash.
Controlled payment evidence must include unique direct one-hop attempts over the
approved channel to the approved provider, exact amounts and zero forwarding
fees. Success requires exact settled totals with no live parts; an in-flight
payment without an actual approved in-flight route remains uncertain. Raw
responses, preimages, and HTLC data stay out of returned evidence, persisted
recovery results, logs, and propagated errors.

This deliberately small adapter refuses a full 100-record page, duplicate hash
records, absent/deleted payments, unknown or `INITIATED` statuses, malformed replies,
identity or network changes, and transport failures. Histories of 100 or more
payments need a separately reviewed bounded pagination or tracking adapter;
refusal never means the payment can be sent again. Existing unresolved mining or
external action intents still require independent reconciliation and are not
cleared merely because a payment is found.

Offline tests use mocked LND responses. Real-node REST compatibility, scoped
macaroon permissions, TLS configuration, existing wallet/index availability,
consensus and reorg behavior remain unverified in this Windows worktree.
