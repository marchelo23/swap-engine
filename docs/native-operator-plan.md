# Native controlled reverse operator

Historical snapshot: use [the latest recovery/fix report](controlled-run-recovery.md)
before any command below. The authorized local-regtest profile now supports the
protected Core cookie and verified local encrypted backup; the first real attempt
was safely unwound and the newer fixed source explicitly requests PSBT v0.

The native loader is implemented and tested. **Real execution remains blocked**
by missing restricted Core credentials/active whitelist, unsafe LND credential
ancestors, unverified independent custody backup and missing operator approval.
The retained invoice is now **CANCELED**, unpaid, with zero HTLCs; it cannot be
revived. No real invoice creation, payment, signing, broadcast, mining, credential
baking, permission change, Core configuration change or restart was performed.

## Evidence

At **2026-11-18 19:10:10.591 UTC on the VM**, client and refund custody restored
twice through separate vault opens, matching the original payment hash and public
keys. Ciphertext, state and public-artifact hashes were unchanged. No backup,
action-path or JIT-authorization configuration exists in the retained run:
`/home/truja/reverse-controlled-runs/run-73b9bedd-ab29-4b74-89a2-13fa07ca78f4`.
Its hash is
`8a2c173be5eb26e0aed6f3ef329f1592e67956c4d03457e53cc661a140024793`;
the invoice expired at 18:47:49 UTC and now reports CANCELED, paid zero, no HTLCs.
The native `--review-jit-only` command rejected it, emitted only a sanitized stop
message, retained the identical store hash and released its writer lock.

Core and both LND nodes agreed at height **135**, hash
`2d303a7392d749e199a0d8014a5190b7be82072bfd02cae7e426ce2c19324bfd`;
both LND chain/wallet synchronization flags were true. At **19:18:47.211 UTC**,
the pinned channel was active with zero pending/unsettled HTLCs and **4,843,720
sats** of usable payer-local/provider-remote liquidity after reserves and
commitment fee. Core confirmed provider ownership of the change destination.
At **19:22:28 UTC**, Alice's existing address inventory contained the exact claim
destination. Wallet locks remained zero; the selected input remained unspent,
noncoinbase and confirmed 19 times.

Provider invoice macaroon permissions are exactly `invoices:read/write`; payer
router permissions are exactly `offchain:read/write`. Local decode output was
captured and reduced to permissions; no macaroon contents were printed/copied.
Both `.lnd` and `.lnd-alice` are **775**. The new native guard rejects those
group-writable ancestors even though their `data/` descendants are 700. The
Core configuration contains no RPC whitelist. No independent backup was verified;
the existing separate password escrow and vaults share the VM's failure domain.

## Scope and ceilings for the next reviewed fresh run

| Item | Exact selection |
| --- | --- |
| Lightning source | Alice `03bd5a96ed1bf8be9211082f5fae1ee1b206625197abed0d92fc1ee5fc8f6c1553`, `https://127.0.0.1:8081` |
| Invoice recipient/Core funder | Provider `028da6db7cde29666a95581fa6899e549a80d848212dacf868b2793e9b2b84dc00`, `https://127.0.0.1:8080`; Core `http://127.0.0.1:18443`, wallet `lqwd-lab` |
| Only route | Channel `135239930281985`, funding `ecdb39ab0a5a0fb71fc5b72e4544c0f894a99a68bd94883ec5947819a90f085f:1` |
| Approved input candidate | `bcd16e1bfa03a65a7013a88a1f0de6e85dde8f530ddd5dd7385b929204522e64:0`, **4,981,994,360 sats** |
| Principal / service / invoice | **50,000 / 750 / 50,750 sats** |
| Claim fee / net receipt | **500 / 49,500 sats** |
| Route | Wire ceiling **100 sats**, maximum payer debit **50,850 sats**; direct-route evidence must prove zero fee, expected debit **50,750 sats** |
| Funding | **2 sat/vB**, at most **1,000 sats**, exactly one input and the exact HTLC/change outputs |
| Provider change | At least **4,981,943,360 sats** to `bcrt1qz62y94lnjfj4sqmzwsap2fvleqxkua95znqfwj` |
| Client claim | `bcrt1qzaursu8mptw77dln8d0yy884udfkgacrtd7rd2` |
| Time | Fresh `H+30` timeout; at H135 this is **165**, minimum accepted HTLC expiry **205**; invoice CLTV 80, expiry 3,600 s |
| Execution | One quote 120 s; preparation at most 30 s; execution at most 90 s; at most two single-block requests |

Observed relay/mempool floors were each **0.1 sat/vB**. All evidence must be
rechecked by the concrete inspector after the authorized JIT quote is installed.
Fresh custody/hash/contract/invoice and explicit approval of this full input and
change are required; the canceled invoice and its expired approvals remain
historical evidence. No replacement was created in this task.

## Installed loader and credential boundaries

`scripts/run-controlled-reverse.ts` has four explicit modes, with no default:
review, readiness check, execution and lookup-only reconciliation. Native loading
requires Linux, owned private files/directories, canonical paths, no links and
checksums of the specification and every execution configuration. No CLI flag,
environment value or HTTP request can install an alternate assembly.

Read inspection uses the existing read-only Core/LND adapters. Action wiring
uses a **separate** Core RPC user and separate provider-settle/payer-send
macaroons. It accepts only the exact role-scoped permission pairs above or the
narrower `uri:/invoicesrpc.Invoices/SettleInvoice` and
`uri:/routerrpc.Router/SendPaymentV2` permissions, without unsupported caveats.
Admin, signer, walletkit, cross-role and changed credentials are rejected. TLS
certificates and action credential bytes are pinned and rechecked at use.

Core requires a dedicated non-cookie `user:password` file, matching `rpcauth`,
and exactly these per-user whitelisted methods:

```text
getblockchaininfo,walletcreatefundedpsbt,walletprocesspsbt,finalizepsbt,sendrawtransaction,generatetoaddress,testmempoolaccept
```

The verifier binds the actual owned `bitcoind` PID/start identity, explicit
absolute `-conf`/`-datadir` selection and regtest arguments. It rejects includes,
unsupported overrides and a configuration written after process startup. An
explicit `rpcwhitelistdefault=0` or `1` is supported: the dedicated user's exact
whitelist is mandatory, while existing reader/LND account permissions can be
preserved. Read-only authentication probes require matching regtest chain
evidence and HTTP 403 for unlisted `getwalletinfo`. A Core cookie is never used
as an action-credential fallback. Provisioning/configuration/restart is an
operator prerequisite; none was performed here.

Before execution, an existing backup outside the run directory must contain
identical protected encrypted client/refund records. The loader restores their
public identities in place without creating, replacing, signing or exposing
keys. Its `failureDomain` declaration is an explicit operator assertion;
directory location alone cannot prove independent storage or recovery-password
availability. Independent storage/password retention still needs operator review.

Each action remains behind the existing durable intents, exact plan and route
checks. Pre-wire checks run after credential loading. SIGINT/SIGTERM close the
local payer observation and fence later actions; they do **not** cancel remote
HTLCs. A timed-out executor is drained while the single-writer lock stays held,
so late uncertainty journaling cannot overwrite a newly opened recovery process.
Unknown outcomes never cause a new quote, invoice or payment retry.

## Exact command sequence after prerequisites and explicit approval

These are future operator commands, **not executed financial actions**. First
provision reviewed restricted credentials and a verified independent encrypted
backup; safely prepare a separately authorized fresh run using the existing
invoice-only harness. Keep the canceled run intact. In the fresh run, create
owned mode-600 configuration files with these schemas (all paths absolute):

```json
{
  "bitcoinActionAuthPath": "/home/truja/reverse-controlled-credentials/core-action.auth",
  "bitcoinConfigPath": "/home/truja/.bitcoin/bitcoin.conf",
  "bitcoinPidPath": "/home/truja/.bitcoin/regtest/bitcoind.pid",
  "providerSettleMacaroonPath": "/home/truja/.lnd/data/chain/bitcoin/regtest/invoices.macaroon",
  "payerSendMacaroonPath": "/home/truja/.lnd-alice/data/chain/bitcoin/regtest/router.macaroon"
}
```

Save that as `action-credential-paths.json` only after the ancestor protection
and scoped credentials have been verified. `custody-backup.json` must contain
`directory`, `specSha256` and
`failureDomain: "operator-reviewed-independent"`; its directory must already
contain the two encrypted vault subdirectories. No backup is made automatically.

On the VM, with `RUN_DIR` set to the exact approved **fresh** private run:

```bash
cd /tmp/swap-operator-95b326f15d60.32WCWNnr/source-delivery
SPEC_SHA=$(sha256sum "$RUN_DIR/spec.json" | cut -d ' ' -f1)
ACTION_SHA=$(sha256sum "$RUN_DIR/action-credential-paths.json" | cut -d ' ' -f1)
BACKUP_SHA=$(sha256sum "$RUN_DIR/custody-backup.json" | cut -d ' ' -f1)
node --import tsx scripts/run-controlled-reverse.ts --review-jit-only \
  --run-dir "$RUN_DIR" --spec-sha256 "$SPEC_SHA"
node --import tsx scripts/run-controlled-reverse.ts --check-runtime-only \
  --run-dir "$RUN_DIR" --spec-sha256 "$SPEC_SHA" \
  --action-config-sha256 "$ACTION_SHA" --backup-config-sha256 "$BACKUP_SHA"
```

Supply the vault passphrase to stdin locally; never use argv/environment or print
it. These commands cannot pay, sign, broadcast or mine. Review the resulting
full plan/digest, custody recovery and all ceilings before installing
`jit-authorization.json`. The strict envelope contains `specSha256`,
`actionConfigSha256`, `backupConfigSha256`, and `authorization` with a fresh UUID,
exact reviewed `termsDigest`, scope
`isolated-regtest-one-requote-and-execute`, VM-clock `issuedAt/startBefore`
(at most ten minutes apart), `maxBlocks:2`, `quoteLifetimeMs:120000` and
`executionWindowMs:90000`. Use VM time: host and VM clocks were materially
different during this task, and future-dated approval is rejected.

Only after that separate approval, the following single invocation can perform
financial actions and consume its one-shot authority:

```bash
AUTH_SHA=$(sha256sum "$RUN_DIR/jit-authorization.json" | cut -d ' ' -f1)
node --import tsx scripts/run-controlled-reverse.ts --execute-jit \
  --run-dir "$RUN_DIR" --spec-sha256 "$SPEC_SHA" \
  --action-config-sha256 "$ACTION_SHA" --backup-config-sha256 "$BACKUP_SHA" \
  --authorization-sha256 "$AUTH_SHA"
```

Never repeat it after a crash or uncertain result. With the persisted JIT UUID
and current swap revision, reconciliation loads **only read credentials**, needs
no password/action configuration, and performs no suggested next action:

```bash
node --import tsx scripts/run-controlled-reverse.ts --reconcile-only \
  --run-dir "$RUN_DIR" --spec-sha256 "$SPEC_SHA" \
  --jit-id "$JIT_ID" --expected-revision "$CURRENT_REVISION"
```

Keep orphan locks until process exit and journal state have been independently
verified; there is no automatic lock deletion or resume. If no execution approval
was durably installed, inspect the retained quote/invoice evidence without retry.

Cancellation/refund are intentionally unavailable in this loader. Existing offline
tests prove CLTV-bound refund signatures, exact outpoint/witness confirmation,
observed invoice cancellation and no retry after lost cancellation replies.
After funding, unknown payment/claim/cancellation evidence remains MANUAL_REVIEW.
An operator must separately authorize cancellation/refund recovery, verify the
exact unspent lockup and refund key/destination, wait until CLTV, and observe the
confirmed refund and invoice cancellation. Native mutation-capable refund/resume
assembly and real-node failure/reorg validation remain execution-readiness gaps;
read-only reconciliation does not fill them. The current canceled unpaid run
has no payment, funding or lockup to refund.

## Tests, source and files

Local build passed. VM build/full tests and Linux lifecycle tests are retained
under `/tmp/swap-operator-95b326f15d60.32WCWNnr/`; dependency lock JSON matched
the existing VM installation, and no dependency installation or deployment
replacement occurred. Source archive SHA-256:
`c4088d646b15044fa7e7c96d9d89ecf632168c65f5a1dd8117060133457d5ae5`.
Final logs: `build-delivery.log`, `tests-delivery.log`. The delivery build passed
and its full suite ran **297 tests: 296 passed, one Windows-only skip, zero
failures**, including the native payer MAC/TLS/EOF contract and the lock retained
during late uncertainty journaling. A full Windows run encountered the
existing intermittent atomic-rename persistence failure; its twelve JIT tests
passed on rerun. No persistence safety check was relaxed.

VM evidence: `custody-node-evidence.json`, `scope-fees.json`,
`claim-ownership.json`, `native-review.stderr` and `native-help.json`.

Files changed only in this task: `scripts/run-controlled-reverse.ts`,
`src/operator/OperatorFiles.ts`, `src/operator/NativeActionCredentials.ts`,
`src/operator/CustodyBackup.ts`, `src/core/ControlledReverseRuntime.ts`,
`tests/nativeOperator.test.ts`, `tests/nativeOperator.posix.test.ts`,
`tests/controlledReverseRuntime.test.ts`, and this report. Existing work, fee
policy, frontend and HTTP execution gate were preserved; no commit/merge/push.
