# Retained invoice and bounded just-in-time execution

The previous handoff expired because short execution deadlines started before
independent verification and human review. On 2026-11-18 UTC:

| Event | Time |
| --- | --- |
| Quote issued / expires | 17:47:48.733 / 17:49:48.733 |
| Unapproved request issued / expires | 17:47:51.226 / 17:49:21.226 |
| Independent verification and recovery | 17:48:53 |
| Final handoff check | 17:51:39 |

About 230 seconds elapsed after quote issuance. Its 120-second lifetime and the
request's 90-second lifetime worked as configured. An OPEN one-hour hold invoice
does not extend either deadline. Neither old expiry was edited.

## Implemented sequence

`createJustInTimeReverse` accepts existing durable preparation and read-only
adapters. It has no invoice-creation adapter. `review()` verifies the retained
OPEN, unpaid invoice with no HTLC history, independent decoding, pinned nodes,
regtest height and restored custody. It returns a stable terms digest without
issuing a quote, changing application state or granting execution authority.
This digest binds the complete original plan/specification, exact invoice digest,
original swap/revision, input/value, custody identities, destinations, channel,
fee ceilings and fixed time/block budgets.

After explicit operator approval of those terms, a separate strict
`JitAuthorization` permits **one** new quote and immediate local execution.
Its scope is `isolated-regtest-one-requote-and-execute`, start window at most ten
minutes, quote lifetime exactly 120,000 ms, execution window exactly 90,000 ms,
and block limit exactly two. It is not an extension of the expired request.

1. Recheck the existing invoice, node identity and custody within 30 seconds.
2. Fsync a unique JIT INTENT before requesting a new application quote. Once
   consumed, this swap cannot be requoted/executed again through this API, even
   with another authorization UUID or after restart.
3. Obtain one quote through the existing fee policy. Require identical monetary
   terms; bind it to the same swap/invoice/contract with one revision increment.
   Preserve the original preparation, request and original quote as history.
   Never overwrite a concurrently changed quote or journal. The original
   fingerprint continues to identify the original swap-creation request.
4. Complete the concrete input/wallet/channel/fee/height/custody inspector and
   repeat invoice verification within a shared 30-second preparation budget.
   Require at least 90 seconds remaining on the new quote and at least 150
   seconds remaining on the invoice. No human handoff occurs inside this budget.
5. Persist the exact new execution approval and EXECUTING status before invoking
   the existing runtime. Bind plan digest, input, swap/revision and isolation.
6. Enforce the 90-second deadline with both monotonic and nondecreasing wall
   clocks. The concrete runtime checks this fence before mutations, and the
   payer repeats it after credentials load immediately before the POST.
   Timeout aborts local observations; LND remains `cancelable=false`.
7. Publish JIT COMPLETED only after matching durable completed swap/execution
   evidence. An uncertain quote, action, acknowledgment, clock or conflict leaves
   a consumed UNKNOWN attempt. Cleanup preserves another actor's newer record.

A crash before quote installation leaves the original plan in the preparation
and JIT intent even if the quote manager pruned its expired quote index entry.
That is an inspection barrier, never permission to obtain another quote. A crash
after execution approval uses that persisted approval/plan and the existing
runtime's lookup-only `reconcile(revision)`; do not call `run()` again. Recovery
does not grant unused mining, funding, payment or settlement authority.

## Current exact plan and retained evidence

Final read-only VM check at **2026-11-18 18:21:29.733 UTC** confirmed OPEN, paid zero,
zero HTLCs, restored custody, revision **3**, one quote/swap/preparation and zero
JIT/controlled executions. The state-file and public-artifact hashes were
unchanged. Core and both LND nodes were synced at **135**, hash
`2d303a7392d749e199a0d8014a5190b7be82072bfd02cae7e426ce2c19324bfd`.

Run: `/home/truja/reverse-controlled-runs/run-73b9bedd-ab29-4b74-89a2-13fa07ca78f4`.
Swap: `e8f26d8e-4feb-41b0-85d2-00b318c17e4b`.
Retained hash: `8a2c173be5eb26e0aed6f3ef329f1592e67956c4d03457e53cc661a140024793`.
Invoice expiry: **18:47:49 UTC**, CLTV **80**. Timeout remains **165**, minimum
accepted incoming HTLC expiry **205**; existing readiness needs at least twenty
blocks before timeout. This task created no new invoice, quote or authority.

Stable review digest:
`3244d7c12f9accc9b9bf8ca87ab61561e3add88118310a7867e6b3c79576a089`.
This digest is review material, not an approval. It becomes invalid on any bound
state/revision/terms change; current invoice and runtime checks must still pass.

| Item | Exact bound |
| --- | --- |
| Lightning source | Alice `03bd5a96ed1bf8be9211082f5fae1ee1b206625197abed0d92fc1ee5fc8f6c1553`, `https://127.0.0.1:8081` |
| Invoice recipient/Core funder | Provider `028da6db7cde29666a95581fa6899e549a80d848212dacf868b2793e9b2b84dc00`, `https://127.0.0.1:8080`; Core `http://127.0.0.1:18443`, wallet `lqwd-lab` |
| Only approved route candidate | Channel `135239930281985`, point `ecdb39ab0a5a0fb71fc5b72e4544c0f894a99a68bd94883ec5947819a90f085f:1` |
| Principal / service / invoice | **50,000 / 750 / 50,750 sats** |
| Claim fee / client net | **500 / 49,500 sats** |
| Routing | Policy ceiling **100 sats**, wire payer debit at most **50,850 sats**; direct-route evidence must show **zero fee**, expected debit **50,750 sats**, expected client cost **1,250 sats** |
| Funding fee | **2 sat/vB**, total at most **1,000 sats** |
| Selected input, explicit spending approval pending | `bcd16e1bfa03a65a7013a88a1f0de6e85dde8f530ddd5dd7385b929204522e64:0`, **4,981,994,360 sats**, 19 confirmations, noncoinbase native P2WPKH |
| Required provider change | At least **4,981,943,360 sats** to `bcrt1qz62y94lnjfj4sqmzwsap2fvleqxkua95znqfwj` |
| Client claim destination | `bcrt1qzaursu8mptw77dln8d0yy884udfkgacrtd7rd2` |

Channel was active, pending/unsettled HTLCs zero, Core wallet locks zero. Payer
local/provider remote balance was 4,896,530 sats before reserves and commitment
fee. Observed relay and mempool floors were each 0.1 sat/vB. The concrete
inspector, rather than these historical balances, must prove directional
liquidity and exact funding/fee evidence immediately before execution.

## Integration and execution barriers

Local operator assembly uses, in order, `createLndJitReaders(store, spec, clients)`,
`createJustInTimeReverse(store, spec, readers).review()`, explicit external review
of its digest and full plan, then a **separately authorized** invocation of
`createJustInTimeReverse(store, spec, readers, authority,
createJitRuntimeExecutor(store, runtimeDependencies)).run()`.
The last call changes application state and can pay, sign, broadcast and mine.
It was **not called against real nodes**. The concrete executor is single-use.

Neither HTTP startup nor the preparation CLI installs this executor. No new
execution CLI flag or environment bypass was added. A reviewed native operator
loader for the JIT approval and action credentials remains to be assembled;
an invoice-only approval, this report or the old execution request cannot
authorize it. Stop rather than hand-editing store deadlines or bypassing gates.

Before any real action: obtain explicit full-input/change/fee/execution approval,
review isolation and the custody backup/retention plan, load only existing VM
credentials locally, and perform current full readiness/recovery verification.
The encrypted client/refund vaults and separate owner-only passphrase escrow
were restored in place; same-VM escrow is not an independent disaster backup.
If the invoice expires or has any HTLC history, retain all evidence and stop.
There is no automatic cancellation, replacement invoice, payment retry or
funding/refund recovery action in this path.

## Verification

Final source snapshot:
`1448d54139b9e12e37f0796503aef24f5c97f3140e3f96841816657827814414`.
VM isolated source: `/tmp/swap-jit-c42f3da8c2c7.zNItGLjW/source-verified`.
Dependencies match the existing VM lockfile as parsed JSON; only line endings
differed. No dependency installation or root deployment replacement occurred.

Local and final VM `npm run build` passed. The final VM suite ran **282 tests:
281 passed, one Windows-only test skipped, zero failures**. Local twelve JIT
tests passed. The four-file focused
suite passed 51 tests before the final two JIT regressions were added. An
earlier full Windows run had 269 passes, seven POSIX skips and one transient
`EPERM` atomic-rename failure; its entire seven-test backend file passed on
rerun. POSIX full-suite evidence and the final read-only snapshot are retained
in the VM audit directory as `build-verified.log`, `tests-verified.log` and
`retained-review-verified.json`; the previous review is `retained-review.json`.

Coverage includes exact amounts and identities, immutable old evidence,
concurrent ownership, wrong inputs/revisions, exhausted persistence/readiness
budgets, uncertain quote replies, clock changes, late executor completion,
actor updates, no replay after restart, real mocked HTTPS pre-wire checks and
concrete runtime completion/reconciliation. Live HTTP execution remains closed.

Files changed in this task only (other preexisting work preserved):

- `src/core/JustInTimeReverse.ts` (new orchestration API)
- `src/core/SwapTypes.ts` (JIT audit record only)
- `src/core/ControlledReverseRuntime.ts` (deadline fence and single-use binding)
- `src/core/LndReversePreparation.ts` (lookup-only JIT readers)
- `src/lightning/ControlledLndPayer.ts` (pre-wire fence and observation shutdown)
- `tests/justInTimeReverse.test.ts` (new regressions)
- `tests/controlledReverseRuntime.test.ts` (concrete assembly/restart/deadline tests)
- `tests/controlledLndPayer.test.ts` (credential-delay/shutdown tests)
- `tests/lndInvoicePreparation.test.ts` (lookup-only review failures)
- `docs/jit-reverse-sequencing.md` (this report and exact plan)
