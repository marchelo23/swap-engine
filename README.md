# LQWD Swap Engine v0.1

Experimental TypeScript components for non-custodial Lightning-to-Bitcoin reverse
submarine swaps on Bitcoin regtest. **This milestone is incomplete: live swap
creation is disabled. It is neither audited nor production-ready.**

## Project overview and business motivation

A reverse swap lets a user move Lightning liquidity to a Bitcoin output while
keeping their channel open. A held Lightning payment and an on-chain P2WSH HTLC
share the same SHA-256 payment hash. The user generates the secret locally. The
provider learns the secret only when the user claims the on-chain output, then
uses it to settle the held Lightning payment. This implementation does not accept
custodial deposits or forward ordinary payments as a substitute for a swap.

## Architecture

```mermaid
flowchart LR
  U[User: secret and claim key] --> API[Loopback HTTP API]
  API --> M[Quotes and reservations]
  M --> DB[Atomic persistent store]
  C[Coordinator component] --> DB
  C --> P[Verified adapter ports]
  P -. pending live wiring .-> L[LND hold invoices]
  P -. pending observer .-> B[Bitcoin Core regtest]
  U --> H[P2WSH HTLC claim]
  H --> B
  L --> LC[LND REST client component]
  B --> BC[Bitcoin RPC component]
```

See [protocol invariants and architecture](docs/architecture.md),
[security limitations](docs/security.md), and [verification results](docs/results.md).

## Supported rails and development status

Bitcoin regtest and Lightning regtest have implemented protocol components.
There is no working live service yet. Liquid, Rootstock, Arkade and RGB are
**planned only**; no adapters for those rails exist.

| Component | Implemented | Still required |
| --- | --- | --- |
| LND | Local TLS REST client, hold/create/lookup/cancel/settle, subscription, balance inspection | Live v0.21.6-beta compatibility tests, reconnect worker |
| Bitcoin | P2WSH construction and verification, signed claim/refund, PSBT lockup preparation, broadcasting, active-chain confirmation lookup | Live consensus tests, spending-transaction discovery, reorg tracking |
| Coordinator | Durable action intents, accepted-HTLC checks, confirmation gates, settlement recheck, conservative recovery | Production adapter wiring, deterministic action reconciliation, automatic refund orchestration |
| Liquidity | Amount limits, fee budgets, monetary reservations under one writer | Outpoint journal, reconciliation against external wallet activity |
| API | Explicit schemas and all five routes | Live reverse-swap creation intentionally returns 503 |
| Keys | User and provider keys are separate; offline builders accept caller keys | Secure persistent provider refund-key manager and client wallet |

## Regtest setup

Use Node.js 22 or later (validated here with Node.js 24.19.0). Run inside the
existing Ubuntu VM so loopback addresses refer to the existing nodes. Do not reset
chain data, create replacement wallets, overwrite LND configuration, or close channels.

```bash
npm ci
npm run build
npm test
cp deploy/regtest.env.example .env.regtest
# Review paths locally; .env.regtest contains file paths, never copied credentials.
# Node does not automatically load .env.regtest:
node --env-file=.env.regtest --import tsx scripts/inspect.ts
node --env-file=.env.regtest --import tsx src/main.ts
```

For offline simulation with no node connectivity, copy
`deploy/simulation.env.example` to `.env.simulation` and use
`node --env-file=.env.simulation --import tsx src/main.ts` instead.

The sample uses Bitcoin cookie authentication with the existing `lqwd-lab` wallet.
LND must already have a **local HTTPS REST listener** (usually 8080), a matching
TLS certificate and a readable macaroon. The supplied gRPC port 10009 is not a
REST endpoint. Discovery and configuration are manual; this project never edits
LND configuration. The example uses a read-only macaroon. For an optional Alice
balance source, set `ALICE_LND_REST_URL`, `ALICE_LND_TLS_CERT_PATH`, and
`ALICE_LND_MACAROON_PATH` together to use Alice's loopback HTTPS listener,
certificate, and read-only macaroon.
Node credentials stay on the VM and are never copied into the repository.

The API binds only to `127.0.0.1:3000`. `ENABLE_LIVE_SWAPS=true` causes startup to
fail, rather than bypassing the incomplete observer/recovery boundary. The explicit
`APP_MODE` selects `simulation` (default; no node connectivity, clearly labeled in
health and startup output) or `regtest` (read-only deployment; loopback-only
Core/LND clients and real preflight diagnostics). `mainnet` and other modes are
rejected. Health reports component mode; it does not claim the nodes are ready. For
live preflight and exact next steps see [the VM runbook](docs/regtest-runbook.md).

### Provision a local account

Run the provisioning script in an interactive terminal from the repository root.

```bash
npm exec -- tsx scripts/provision-auth.ts
```

Enter your chosen username, the `ADMIN` role, and a password of at least 12
characters. The password prompt hides input. Repeat with the `USER` role if you
need an account without access to operational liquidity. The script saves salted
scrypt hashes in `data/auth/users.json` by default. If you set `AUTH_STORE_PATH`,
use the same path when provisioning and starting the server. When the override is
in `.env`, provision with `node --env-file=.env --import tsx scripts/provision-auth.ts`.

For an isolated simulation or read-only regtest lab, the explicit
`--allow-short-lab-password` option accepts at least four characters for an
`ADMIN` account. Use the same hidden prompt and keep the preview on direct
loopback HTTP, without a proxy or tunnel. Accounts provisioned with this option
are restricted to direct loopback requests. The default remains 12 characters.

```bash
npm exec -- tsx scripts/provision-auth.ts --allow-short-lab-password
```

The API loads local accounts on sign-in. Sessions last one hour and expire on
server restart. Keep the API on the isolated regtest loopback interface and use
the same origin for the application and API requests.

## API documentation

For the existing Ubuntu VM, see [regtest read-only deployment instructions](docs/ubuntu-deployment.md)
and the uninstalled [systemd service template](deploy/swap-engine.service).
`GET /v1/preflight` reports read-only node/wallet/channel diagnostics in `regtest`
mode; it returns 503 while prerequisites are unresolved, and 503 with
`DIAGNOSTICS_NOT_CONFIGURED` in offline `simulation` mode. UI, quote and component
health endpoints remain available. Runtime clients deny all node mutations, even
after sync. `POST /v1/swaps/reverse` remains 503 in both modes.

### Local estimate interface

Run `npm start` and open **http://127.0.0.1:3000/**. The responsive three-panel
interface shows Lightning input, swap calculation, and Bitcoin on-chain output.
It is regtest simulation only and calls `POST /v1/quotes`; it never creates a
swap, payment invoice, address, or transaction. Quote generation does not require
running Bitcoin/LND nodes. The server still binds only to loopback.

The input is the HTLC principal in whole sats (10,000–1,000,000). Fees and the
Lightning invoice total come from the API. Net received is `amountSats - claimFeeSats`;
net sats lost is `invoiceSats - net received`. For 50,000 sats these are 49,500
received and 1,250 lost. Funding reserve is not an additional client fee. Estimates
clear on input changes and expiry; request errors require a fresh estimate.
On-chain to Lightning is visibly **NOT IMPLEMENTED**. Live swaps remain disabled.
No frontend build step or additional dependencies are required.

Pure satoshi accounting helpers, implemented by Qwen and independently reviewed,
are in `src/utils/satoshiMath.ts`. They validate monetary quote fields and invoice
consistency, calculate net received and total user cost, and exclude the provider's
funding reserve from that cost. They consume quote values without changing the
API's fee policy or enabling execution. Tests cover both helper boundaries and
actual quote endpoint responses.

All amounts are integer satoshis; timestamps are Unix milliseconds. Requests use
`Content-Type: application/json`, strict object schemas, and an 8 KiB body limit.
Schemas are in `src/api/schemas.ts`. Responses never contain private keys or a
preimage. Quotes are estimates; they do not reserve liquidity.

| Method and route | Access | Request | Response |
| --- | --- | --- | --- |
| `POST /v1/auth/login` | Public and rate-limited | JSON fields `username` and `password` | 200 with session fields and a session cookie, or generic 401 |
| `GET /v1/auth/session` | Signed in | Session cookie | 200 with session fields, or 401 |
| `POST /v1/auth/logout` | Signed in | Session cookie, origin, and CSRF token | 204, revokes the session and clears the cookie |
| `POST /v1/quotes` | Public | `{ "amountSats": 50000 }` | 201 with the quote below |
| `POST /v1/swaps/reverse` | `USER` or `ADMIN` | `{ "quoteId": "UUID", "paymentHash": "64 lowercase hex", "claimPublicKey": "compressed hex key" }` and the `Idempotency-Key` header | 503 `LIVE_SWAPS_DISABLED_OBSERVER_AND_RECOVERY_NOT_VERIFIED` for a valid request |
| `GET /v1/swaps/:id` | Disabled | UUID path | 404 until swap ownership is persisted |
| `GET /v1/health` | Public | None | 200 with `{ "status": "components-only", "liveSwapsEnabled": false, "readOnly": true, "network": "regtest", "mode": "simulation" }` (or `"mode": "regtest"`) |
| `GET /v1/preflight` | Public | None | 200 if read-only regtest prerequisites are met, or 503 |
| `GET /v1/liquidity` | `ADMIN` | Session cookie | 200 with available `onchainSats` and `incomingSats` after reservations, or 503 if nodes are unavailable |
| `GET /v1/operations/balances` | `ADMIN` | Session cookie | 200 with a read-only regtest snapshot of Core, provider LND, and optional Alice LND |
| `/v1/admin/*` | `ADMIN` | Session cookie | 503 until an admin handler is available |

Sign-in and session inspection return `{ user: { id, username, role }, csrfToken, expiresAt }`.
The browser stores the session cookie with `HttpOnly` and `SameSite=Strict`.
Send the cookie with protected requests and include `x-csrf-token` with the
returned token on protected POSTs. Those requests also require an exact
same-origin `Origin` header, which the browser sends on POSTs. Protected
routes return 401 for missing or expired sessions and 403 for insufficient
roles or failed CSRF checks.

The operations snapshot includes `network`, the UTC timestamp `capturedAt`,
and separate `core`, `provider`, and `alice` entries. Each wallet entry has
`confirmedSats` and `unconfirmedSats`. LND entries also have `localSats` and
`remoteSats` across all channels. Missing values are `null`, and a fully
unavailable LND entry is `null`. Each source must identify as Bitcoin regtest
before the server requests its balances.

```bash
curl -s http://127.0.0.1:3000/v1/health
```

The 50,000-sat quote has `serviceFeeSats: 750`, `invoiceSats: 50750`,
`fundingReserveSats: 1000`, and `claimFeeSats: 500`, plus a random `id` and
`expiresAt` two minutes ahead. The HTLC principal is 50,000 sats; a claim using
the suggested fee pays the destination **49,500 sats**. The provider pays the
funding miner fee from its service proceeds. The claim fee is an estimate that
the client must independently assess. Amount limits are 10,000–1,000,000 sats.

Core swap creation is idempotent: the same key and request return the existing
operation, including after quote expiry. Reusing a key with different parameters
fails. A quote and a payment hash can each be used only once. No public request
currently creates a swap or invoice; component tests populate operations directly.

## Swap lifecycle

The happy path is `CREATED → QUOTED → INVOICE_CREATED → INVOICE_ACCEPTED →
LOCKUP_BROADCAST → LOCKUP_CONFIRMED → CLAIM_DETECTED → LIGHTNING_SETTLED → COMPLETED`.

Unfunded operations can become `EXPIRED` or `FAILED` only without an uncertain
action. Funded operations retain reservations and may enter `REFUND_PENDING`.
`REFUNDED` is reserved for a future verified refund observer; it is not currently
automatically reachable. Ambiguous outcomes enter `MANUAL_REVIEW` on recovery;
that state retains reservations and cannot automatically resume.

An RPC acknowledgement cannot complete a swap. The coordinator requires a
confirmed claim spending the precise outpoint, extracts and hashes its preimage,
settles the held invoice, observes `SETTLED`, and checks confirmation again before
completion. The adapter's consensus evidence is a trust boundary; offline tests
use explicitly fake ledger/invoice ports, not real consensus.

## Liquidity requirements

The provider needs confirmed, safe, spendable on-chain UTXOs and active inbound
Lightning capacity. The reservation calculation subtracts a 10,000-sat wallet
reserve, each active swap's principal plus 1,000-sat funding budget, and each
active invoice's full value. Failed liquidity checks reject creation. Reservations
are persisted within the same serialized transaction as swap creation.

This is conservative monetary accounting, not an outpoint allocator. Core's
`lockUnspents` additionally locks selected inputs during funding preparation. A
dedicated wallet-use policy and durable outpoint reconciliation are required
before live orchestration. Pending HTLCs may be conservatively counted twice.
Channel totals do not guarantee a route or sufficient capacity on one path.

## Automated tests and reproducible offline demo

```bash
npm run build
npm test
npm run demo
npm run secrets:check  # after git init and staging
```

The demo is a named test using a real signed 50,000-sat Bitcoin HTLC transaction
and fake Bitcoin/LND ledger adapters. It verifies cryptographic linkage and the
coordinator lifecycle. **It neither sends a Lightning payment nor broadcasts a
Bitcoin transaction.** A live regtest demo is not delivered in this milestone;
the missing work is itemized in the runbook.

Actual results on November 12, 2026: TypeScript validation passed; **27/27 tests
passed**. Coverage includes claim/refund signatures, wrong preimages/keys, fee and
timeout limits, insufficient liquidity, concurrent reservations, duplicate events
and requests, failed payment/broadcast/claim cases, unconfirmed transactions,
restart handling, corrupt state, HTTP schemas and the live funding gate.
Node preflight failed because the Ubuntu VM and local credential paths are
unavailable in this Windows workspace. No live-node test succeeded. See
[the complete results and phase status](docs/results.md).

## Security and known limitations

This software is experimental and unaudited. Do not fund it with mainnet BTC.
There is no reorg-aware chain observer, durable provider key service, automatic
refund sender, fee bumping, client payment tracker, or automatic reconciliation
of uncertain external actions. Restart recovery stops affected swaps for manual
review. The API has no authentication or rate limiting and must remain local.
The state database is single-host and is not suitable for multiple replicas.
See [all currently known security limitations](docs/security.md).

## Roadmap

1. Validate Core/LND adapters inside the existing VM and add real consensus tests
   for correct and invalid claim/refund witnesses and timelocks.
2. Add secure refund-key persistence and independently verifiable client tooling.
3. Add block/mempool spend discovery, disconnect/reorg handling, and deadline worker.
4. Journal exact UTXOs and external actions; implement deterministic restart recovery.
5. Automate confirmed refunds and cancellation; implement fee bumping and budgeting.
6. Wire adapters into the API, then execute and record an actual 50,000-sat
   reverse swap and failure/restart runs without closing the existing channel.
7. Obtain independent protocol/security review before considering any broader network.
8. Evaluate Liquid, Rootstock, Arkade and RGB as separate future designs.

## GitHub publication, ownership and licensing

The repository target is [Truja503/swap-engine](https://github.com/Truja503/swap-engine).
The commissioning user explicitly authorized keeping this repository public,
superseding the original private-repository requirement. Future pushes use:

```bash
npm run secrets:check
git push -u origin main
```

`LICENSE` reserves all rights; public visibility does not grant an open-source
license. Ownership and assignment require the
applicable written agreement. Dependencies retain their own licenses.
