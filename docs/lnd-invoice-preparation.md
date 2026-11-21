# Concrete LND invoice preparation

`HttpsLndInvoiceTransport`, `createLndReversePreparation` and
`scripts/prepare-controlled-reverse.ts` connect the existing preparation harness
to explicit local operator inputs. They are not installed in HTTP or startup and
provide no payment, signing, funding, broadcast, mining, settlement, cancellation
or execution action. No VM/node request was made while implementing this change.

## Transport and recovery evidence

The only mutation endpoint is `POST /v2/invoices/hodl`. Its immutable request
contains the exact public hash as base64, value 50,750 sats, expiry 3,600 seconds,
CLTV 80 and the fixed memo. Extra request fields, changed policy, missing guard,
non-loopback HTTPS origins and endpoint credentials/query/paths are rejected.
After loading the separate invoice-creation macaroon, the transport awaits the
harness's durable pre-wire guard and sends once. It never redirects or retries.
The response projects only `payment_request`; raw server responses and payment
addresses/preimages are not returned or persisted by the transport.

Both operations enforce TLS verification, 15-second socket inactivity, a 30-second
absolute deadline including credentials and guard work (configurable 10 ms through
60 seconds), a 256 KiB response limit, JSON content type and complete JSON parsing.
Cancellation during credentials/guard work prevents a later POST. Cancellation or
timeout after sending does not prove that LND failed to create the invoice.

Lookup uses only `GET /v1/invoice/{lowercase-hex-hash}` with read-only credentials.
It recognizes absence only for HTTP 404 plus gRPC JSON code 5, one of the two
documented messages (`unable to locate invoice`, `there are no existing invoices`),
and absent/empty details. HTML/proxy 404, other status/code/message combinations,
authentication failures, malformed replies and transport errors stay uncertain.
HTTP 200 requires a normalized invoice whose exact hash matches the query.

The supported contract follows LND v0.21.6-beta's
[hold-invoice protobuf](https://github.com/lightningnetwork/lnd/blob/v0.21.6-beta/lnrpc/invoicesrpc/invoices.proto),
[REST mappings](https://github.com/lightningnetwork/lnd/blob/v0.21.6-beta/lnrpc/invoicesrpc/invoices.yaml),
[LookupInvoice error mapping](https://github.com/lightningnetwork/lnd/blob/v0.21.6-beta/rpcserver.go)
and [invoice errors](https://github.com/lightningnetwork/lnd/blob/v0.21.6-beta/invoices/errors.go).
Unsupported wire variants are rejected rather than guessed.

The concrete assembly checks provider identity/regtest synchronization before and
after lookup and pins every origin to the approved spec. It uses the existing
concrete readiness inspector and custody restoration callback. The original
preparation ledger consumes invoice/wire intents before calls and prevents another
creation after ambiguous responses or restart. Recovery exposes only `recover`,
constructs no writer in the CLI, and adopts only exact existing unpaid evidence at
the expected revision. Missing evidence never becomes permission to create again.

## Operator CLI

The CLI refuses default/unknown actions. It requires POSIX private owned directories,
non-symlink control files with one link and at most 64 KiB, explicit mode and the
SHA-256 of the reviewed raw `spec.json` bytes. No new custody is generated.
An existing private run directory must contain:

| Path | Contents |
| --- | --- |
| `spec.json` | Strict `PreparationSpec`: preparation/isolation UUIDs, public custody keys/hash, approved input/value, node/channel/origin pins, tip and destinations |
| `preparation-approval.json` | Preparation only: `id` equal to spec ID, `specDigest = preparationDigest(spec)`, scope `isolated-regtest-invoice-only`, unexpired `expiresAt` in milliseconds; not required for recovery |
| `credential-paths.json` | Absolute local paths using the fields below; never credential contents |
| `client-secrets/`, `provider-refund-keys/` | Existing owned private vault directories and matching encrypted records |
| `store/` | Created privately for preparation if absent; must exist for recovery; existing locks are never removed |

Example path configuration for the previously inspected VM (paths only):

```json
{
  "bitcoinCookiePath": "/home/truja/.bitcoin/regtest/.cookie",
  "providerCertPath": "/home/truja/.lnd/tls.cert",
  "providerReadMacaroonPath": "/home/truja/.lnd/data/chain/bitcoin/regtest/readonly.macaroon",
  "providerInvoiceMacaroonPath": "/path/to/existing/operator-approved/invoice-write.macaroon",
  "payerCertPath": "/home/truja/.lnd-alice/tls.cert",
  "payerReadMacaroonPath": "/home/truja/.lnd-alice/data/chain/bitcoin/regtest/readonly.macaroon"
}
```

Verify actual least-privilege credential availability independently; the example
writer path is deliberately not a provisioned credential. The writer is optional
and unused for recovery. URLs come from the reviewed spec, not this configuration.

Safe help command:

```bash
node --import tsx scripts/prepare-controlled-reverse.ts --help
```

After separate preparation approval, in the reviewed source directory on the VM:

```bash
set +x
RUN_DIR=/absolute/private/reviewed/run-directory
SPEC_SHA256=$(sha256sum "$RUN_DIR/spec.json" | cut -d ' ' -f 1)
# Compare this checksum to the independently reviewed checksum before continuing.
IFS= read -r -s -p 'Existing run vault passphrase: ' TASK_VAULT_PASSWORD; printf '\n'
printf '%s' "$TASK_VAULT_PASSWORD" | node --import tsx scripts/prepare-controlled-reverse.ts \
  --prepare-invoice-only --run-dir "$RUN_DIR" --spec-sha256 "$SPEC_SHA256"
unset TASK_VAULT_PASSWORD
```

This command may create an unpaid invoice and local application metadata, but
cannot initiate payment or execution. It requires an unexpired explicit approval;
the checksum alone grants no authority. Passphrases arrive through stdin, never
argv/environment. Errors contain fixed text rather than raw node responses.

After interruption, supply the inspected persisted swap revision:

```bash
: "${EXPECTED_REVISION:?Set this from the inspected persisted swap revision}"
IFS= read -r -s -p 'Existing run vault passphrase: ' TASK_VAULT_PASSWORD; printf '\n'
printf '%s' "$TASK_VAULT_PASSWORD" | node --import tsx scripts/prepare-controlled-reverse.ts \
  --recover-invoice-only --run-dir "$RUN_DIR" --spec-sha256 "$SPEC_SHA256" \
  --expected-revision "$EXPECTED_REVISION"
unset TASK_VAULT_PASSWORD
```

Recovery performs node reads and local journal reconciliation only. It never loads
the writer macaroon, creates an invoice, or clears an uncertain intent. The public
result is written exclusively to `prepared-public.json` and directory-fsynced;
an identical artifact can be reused, but a different existing file is not
overwritten. A draft execution request remains unapproved and is not installed by
this CLI. Errors preserve the store; do not rerun creation, delete locks or renew
quotes automatically.

Mock HTTP tests cover the actual HTTPS request/parser code, strict NotFound proof,
credential/guard cancellation, deadlines, malformed/oversized/ambiguous responses,
post-credential channel changes, concrete inspector completion and lost POST replies
across reopen with one creation total. CLI tests cover strict modes, revision
validation, dispatch with no recovery fallback, safe help and sanitized rejection.
Real POSIX CLI lifecycle, installed macaroon permissions, fresh custody provisioning,
node isolation and actual invoice compatibility remain unverified for this new
code. No fresh invoice or execution approval was created. Separately authorized
VM validation and current spec/input/quote approval remain prerequisites.

Validation in this worktree: build and `git diff --check` passed; the complete
offline suite passed **258 tests**, with **two POSIX vault tests skipped on Windows**
(260 total). New coverage includes 13 HTTP/concrete-wiring tests and three CLI
tests. Shared preparation/readiness fixtures were extracted without changing the
existing test cases.

Subsequent [VM validation](vm-preparation-cli-validation.md) passed five real POSIX
filesystem/encrypted-custody CLI lifecycle tests with synthetic node adapters and
264 tests in the full suite, and verified actual GET canceled-invoice/NotFound
compatibility. Both live LND sync flags were false, so real preparation stayed
blocked; no POST or financial operation was attempted. This supersedes the prior
POSIX/GET validation gap, while real custody and mutation compatibility remain open.
