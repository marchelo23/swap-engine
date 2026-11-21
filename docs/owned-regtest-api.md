# Controlled reverse API review contract

Local review branch: `review/verified-reverse-api-0d9745ea`. Executor checkpoint: `553f60c`.
No new swap was run while adding this API; the confirmed run is recorded in `fresh-reverse-success.md`.

## Existing application session integration

Reuse the **same** `Sessions` instance as the deployed auth-rbac server. Its existing
`get(req)` validates `swap_session`; its `verifyCsrf(req, session)` checks exact
Origin and `x-csrf-token`. Ownership is `session.account.id`, never a username,
browser body, forwarded identity header or operator bearer token. USER and ADMIN
can access only their own explicitly bound swaps. This adds no login route.

The mount is implemented in `src/api/server.ts`, which creates one `Sessions`
instance and passes it to `createOwnedReverseGateway`. `src/main.ts` passes that
same gateway's `operatorIO` into the native loader. Login, logout, Operations,
role checks, CSP and the frontend from main `d5e88ef` are preserved. Frontend,
auth implementation, Operations and the dependency lockfile are byte-identical
to that main revision.

Default startup mounts a closed availability handler. Only explicit native
`--controlled-reverse` serve arguments in APP_MODE=regtest can install a run;
simulation rejects installation. No HTTP request can start the loader or supply
credentials. Shutdown first closes admission, stops local client observation,
waits for operation journals and the loader, then releases both store locks and
vault custody. The old private operator capability remains in `operatorServer`
and is never mounted by the public application's server.

`ui-access.json` (protected regular file, checked SHA256) contains only:
`{"ownerId":"EXISTING_ACCOUNT_UUID","origin":"EXACT_APP_ORIGIN","port":3000}`.
The account's claim destination and prepared contract are bound by trusted operator
configuration; HTTP cannot assign ownership. The gateway uses the existing listener;
`port` is retained for the standalone lifecycle seam and creates no extra listener
when `controlled.operatorIO` is used. All Core/LND endpoints remain loopback regtest.
The handler uses the existing app listener/session policy, so an authenticated lab
browser can reach that app directly; it does not mistake the browser's remote IP
for a Core/LND endpoint or trust proxy identity headers. The separate native
lifecycle helper still binds only 127.0.0.1.

`reviewedArgs` uses existing protected run files, with these exact argument forms:

```text
--serve-jit --run-dir ABS --spec-sha256 SHA --action-config-sha256 SHA --backup-config-sha256 SHA --authorization-sha256 SHA --ui-config-sha256 SHA
--serve-status-only --run-dir ABS --spec-sha256 SHA --ui-config-sha256 SHA
```

The integrated app supplies its session instance automatically: use
`npm start -- --controlled-reverse` followed by one of those argument forms.
See `integrated-owned-reverse.md` for the exact startup environment and validation.

The first mode checks existing exact JIT authorization and custody restore, then
waits for the authenticated owner's request; it needs the existing stdin vault
passphrase. Status-only needs no passphrase or action credentials and cannot
execute. General `ENABLE_LIVE_SWAPS` stays false and cannot enable this gateway.

## Browser contract

Use the deployed login and `/v1/auth/session`; `credentials: 'same-origin'` sends
the HttpOnly cookie. Every POST needs Origin, the session's `x-csrf-token`, JSON
Content-Type, and `Idempotency-Key` (8–128 alphanumeric, underscore or hyphen).
Persist the key and exact request before sending. A timeout/202 requires status
and reconciliation; never invent a new key to repeat execution.

- `GET /v1/reverse/availability`: authenticated `{network:'regtest',
  liveSwapsEnabled:false, controlledReverseConfigured:boolean,
  executionAvailable:boolean, recoveryAvailable:boolean, preparedSwapIds:string[]}`.
  Enable the controlled button only when `executionAvailable` is true and the
  selected swap has `allowedActions:['EXECUTE']`. Missing endpoint/401/503 means
  unavailable. Default integrated startup returns 200/configured false after authentication.
- `GET /v1/swaps`: `{network:'regtest',swaps:[ownedStatus]}`.
- `GET /v1/swaps/:id`: owned status; foreign and absent IDs both 404.
- `GET /v1/swaps/:id/revision`: `{id,revision}`.
- `POST /v1/swaps/reverse`: **only** `{preparedSwapId,expectedRevision}`. Starts
  that operator-prepared and currently approved run. No arbitrary amount, keys,
  invoice, input, owner, credential or evidence fields are accepted.
- `POST /v1/swaps/:id/execute`: alias, body `{expectedRevision}`; same key/body
  replays across the two aliases and across restart.
- `POST /v1/swaps/:id/reconcile`: body `{expectedRevision}`, its own persisted key.
  Observes invoice, payer and exact confirmed spend evidence using read credentials;
  it never pays, funds, signs, broadcasts, settles or mines.

POST 200: `{operationId,status:'SUCCEEDED',result:{id,state,revision[,next]},statusUrl}`.
POST 202: `{operationId,status:'RUNNING'|'RECONCILIATION_REQUIRED',statusUrl}`.
400 invalid body/key; 401 missing/expired session; 403 CSRF/origin; 404 foreign/absent
swap; 409 stale revision, changed key body, expired approval or prior admission;
503 unavailable. Generic quote POST returns 409/`USE_PREPARED_SWAP` while mounted.

All timestamps are Unix milliseconds. `execution.approvedUntil` is the server's
JIT **start-before** envelope, checked again on admission and during preparation.
Do not require the historical `quote.expiresAt` to remain future to enable this
JIT button: the server retains that quote as evidence, creates one identical
120-second quote at execution, requires at least 90 seconds left after readiness,
limits preparation to 30 seconds and execution to 90 seconds using its own wall
and monotonic clocks. The UI must use availability plus `allowedActions`, refresh
after errors, and treat its countdown only as information. It cannot extend a
quote, an expired invoice or authorization. See `JustInTimeReverse.ts:109–174` and
the existing expired-handoff/deadline tests.

Owned status includes `id,revision,state,display,network,quote,paymentHash,invoice,
claimPublicKey,refundPublicKey,address,witnessScript,claimDestination,timeoutHeight`,
`payment:{status,valueSats,feeSats}`, `funding:{txid,vout,feeSats}`,
`claim:{txid,feeSats,netSats}`, `execution:{status,operationId,approvedUntil}`,
and `allowedActions`. Missing evidence is null, never an invented fee. Public
HTLC script is included; secret preimage, private keys, signed PSBT/raw transaction,
internal journals, owner credentials and remote errors are excluded.

## Safety and remaining assembly

This profile remains fixed: principal 50,000 sats; invoice 50,750; claim fee 500;
funding ceiling 1,000; routing ceiling 100; approved direct channel/input/change;
maximum two blocks. Every API admission is durably journaled before JIT execution;
the existing runner still journals each financial action. Unknown/INTENT records
block another execution forever, including after restart and different keys.
Read-only reconciliation can report `MANUAL_REVIEW`; it does not promise automatic
financial recovery or authorize resuming an uncertain action.

The application mount is complete in this local branch; deployment remains
unperformed and requires review. No remote branch was modified. An existing verified completed run
can be assigned to its account through status-only mode. A fresh execution needs a
new reviewed prepared run, exact owner/destination binding, unexpired JIT authority
and passing runtime/custody checks. The previously spent input and completed invoice
are evidence, not reusable authorization. No unapproved HTTP quote/invoice creation
or unrestricted reverse execution is exposed.

## Validation evidence (API checkpoint)

Current integrated-main validation is recorded in `integrated-owned-reverse.md`.

Windows `npm run build` passed; the focused HTTP tests passed. Full Windows run hit
the existing EPERM atomic rename limitation in `reverseSafety.test.ts`; persistence
was not weakened. POSIX validation used only public source in isolated VM directory
`/tmp/owned-reverse-api-0d9745ea.0Zekl23Z/source`, with umask 077 and existing locked
dependencies: build passed, API/native focused tests 18/18, full suite 313 tests,
312 passed, one Windows-only skip, zero failures. Logs are sibling `build.log`,
`focused.log`, `full.log`; source archive SHA256:
`983b736f0964e4a5953f709c20dfeaf648311c071e2eb13f21fd0482e2b7d7b7`.
The actual auth-rbac `Sessions` class and gateway/operator IO also passed a separate
TypeScript compatibility check. Tests use mock nodes and synthetic custody only;
no real invoice, payment, signing, broadcast or mining was performed for this API.
