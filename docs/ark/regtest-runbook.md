# Arkade regtest runbook

**Bitcoin regtest funds only.** Run from the worktree root
on Ubuntu/Linux with local Docker Engine and Compose v2 (or supported Podman
Compose), Bash, Node/npm, `curl`, `jq`, `ss`, `flock`, `openssl`, and Rust via
`rustup`. No `npm ci` is needed for the Ark scripts. The SDK is pinned to
[`arkade-os/rust-sdk` v0.12.1](https://github.com/arkade-os/rust-sdk/tree/v0.12.1).

```sh
npm run ark:test -- --unit-only
npm run ark:start
npm run ark:status
npm run ark:test -- --e2e
npm run ark:stop
```

The stack binds **only** `127.0.0.1`: Core RPC `38443`, NBXplorer `32838`,
Esplora `33000`, operator `37070`, and operator admin `37071`. Keep these ports
free; the scripts reject another worktree's containers, networks and volumes.
Do not expose admin/indexers to untrusted local users. See
[operator lifecycle](operator-regtest.md) for more on isolation and readiness.

## Fixtures, batch and fees

The E2E harness claims `data/ark/e2e/` once, before mutation. It uses fresh
private wallet identities under `data/ark/e2e/fixture/data/ark/wallets/`, not
the two normal CLI wallets. The isolated Core miner funds the Alice fixture
with 200,000 sats, mines one block, waits for indexers, and joins one Ark batch
with that **specific** confirmed boarding input. Before joining, the harness
tries that outpoint with arkd stopped, proves the original UTXO is still
unspent and the miner has only that one funding transaction for the address,
then starts arkd and boards the original input. A second mined block confirms
the batch commitment and the harness checks that it spent that input. In
this fixture the operator sets all intent fees to
zero; separate Bitcoin mining fees are read from Core (funding and each
commitment), not subtracted from an off-chain balance by inference.

Alice submits 75,000 sats to Bob via Ark (not Lightning), without finalizing.
The harness discards the submit acknowledgement; a new CLI process discovers
the sole pending TXID, then finalizes it without a new submission. Retrying
finalization only queries the operator once there is nothing left to finalize;
the harness checks the final balances (125,000/75,000), TXID and VTXO ancestry,
proves exactly one input was consumed and one Bob VTXO was credited, checks
that the spent input is absent from the spendable set without sending a
replay, and compares the same snapshot in fresh processes. This is a
finalized **Ark preconfirmation**, not a
Bitcoin confirmation; Bob's 75,000-sat VTXO is then used in a cooperative
offboard batch. Independent of that transfer, the harness detects an expired
Alice change VTXO, rejects it for payment, and renews the original into a
confirmed batch leaf.

## Recovery and uncertainty

- **Do not rerun funding on timeout, disconnect or empty output.** The
  one-shot claim is intentional. Read the private `funding-intent.json`,
  `funding-txid`, `ark-txid`, `offboard-txid` and public evidence (if present).
  If funding TXID is unknown, inspect the original boarding address in the
  owned indexer and the `ark-lab-miner` wallet history for comment
  `ark-lab-e2e-boarding`; reconcile confirmed **and** mempool state. A missing
  record is not proof that it is safe to send again. Preserve the directory.
  For another independent run, provision a fresh isolated lab/runner instead
  of clearing the old fence.
- **Interrupted transfer:** `ark-lab --e2e-fixture pending` can rediscover
  the submitted TXID. `transfer-finalize <ark-txid>` only finalizes that same
  transaction if pending. `finalize_attempted:false` does **not** prove
  receipt; reconcile both wallets and the consumed input against the TXID.
  Do not create a replacement payment while the original is uncertain.
- **Cooperative exit:** Bob requests a 30,000-sat output to a fresh `bcrt1`
  address in the operator's next batch, with change back to Ark (45,000 sats
  in this fixture). Core validates the exact unspent output and commitment
  confirmation; a second `scantxoutset` measures the resulting balance.
  This output has ordinary wallet spending conditions, not an
  Ark unilateral CSV wait. After a timeout, check that exact destination on
  Core and the original VTXO's `settled_by`/spent status before taking action.
- **Unilateral rescue (not executed, not exposed in this CLI):** The pinned
  SDK can build exit branches while operator data is available. A rescue
  requires the historical tree/checkpoints, confirmed ancestors, extra BTC
  UTXOs in the owner's on-chain wallet for P2A/CPFP package relay, and Core
  `submitpackage`; each node needs confirmation before continuing to the
  next. Wait for the exact leaf or boarding script's relative CSV lock
  before spending the owner path with `send_on_chain`. The current regtest
  operator advertises delays of 20 and 30 (unilateral/boarding); verify script
  sequence type and maturity against Core rather than treating these as
  wall-clock seconds. An operator outage before collecting exit data or
  insufficient CPFP liquidity can block this procedure. Do not claim
  recovery based only on the advertised delays or a cooperative exit.
- **Stopped services:** If `ark:status` fails, confirm owned containers and
  run `ark:start` to resume non-destructively. Do not substitute other
  RPC/indexer endpoints. Harness outage tests stop only the lab's operator,
  Core and Esplora separately, then restart each; they exercise pre-submit
  guards, not a live mid-submit delay. For the funded operator restart
  comparison, the harness waits for the live leaves to reach a stable
  balance bucket before comparing full balances and VTXOs. The stalled
  submission test in the Rust suite is synthetic.
- **Backup:** Stop the stack and clients before copying its private state
  and owned persistent volumes. Preserve `compose.env`, wallet directories
  (including mnemonic and SQLite), and the original attempt fence. Do not
  publish those files, `compose config`, Docker inspection output, or raw
  service logs. `ark:stop` never removes containers, volumes, wallets or
  attempt fences.

CLI inspection examples (drop `--e2e-fixture` for the normal wallets):

```sh
ark/target/debug/ark-lab --e2e-fixture addresses
ark/target/debug/ark-lab --e2e-fixture balance
ark/target/debug/ark-lab --e2e-fixture list-vtxos
ark/target/debug/ark-lab --e2e-fixture restore bob
ark/target/debug/ark-lab --e2e-fixture pending
```

## Evidence and CI

See the [local execution record](regtest-evidence.md) for verified identifiers
and command results.
The separate [ArkAdapter contract](ark-adapter.md) (#54) adds declared mock
tests and opt-in SDK reads using the completed #53 fixture.

`data/ark/e2e/evidence/matrix.json` marks each stage `PENDING` before execution,
`PASSED` after verification, `FAILED` on error and `SKIPPED` for intentionally
omitted cases. The four other JSON files contain only public regtest
identifiers, amounts, parameters and results. They exclude credentials,
signing material, transactions' signatures, and logs.

| Check | Layer | What counts as evidence |
| --- | --- | --- |
| Boarding, Ark transfer/acknowledgement loss, cooperative exit, stale renewal | Live | TXIDs, Core heights/block hashes and fees, VTXO outpoints, balances |
| Operator, Core RPC and Esplora outage | Live | Dedicated service stopped, request fails closed before mutation, readiness restored; funded fixture balances and VTXOs identical across operator restart |
| Offboard submission timeout | Unit / simulated | A stalled future produces `ArkSubmissionUncertain`; live mid-mutation timeout `SKIPPED` |
| Unilateral exit | Not run | `SKIPPED`; no confirmed unroll or rescue TXID |

`Ark lab unit tests` runs checks without services. `Ark lab regtest (opt-in)`
requires `workflow_dispatch` with `run_e2e: true`, starts and stops a dedicated
Ubuntu runner stack and uploads only the five allowlisted evidence files.
Neither workflow changes the Node CI.
