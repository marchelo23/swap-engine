# Regtest block miner (DS-02)

Status: revised Bash implementation and tests prepared; **not deployed or
activated**. The systemd timer must remain disabled until swap execution/recovery
uses the same kernel `flock` and this change is reviewed.

## Scope and current evidence

- Bitcoin **regtest only**. The script rejects any chain other than the exact
  literal `regtest`; it never touches mainnet, testnet, signet, Ark or
  Elements/Liquid.
- Existing Core RPC and existing `lqwd-lab` wallet only. No second daemon, no
  wallet creation/reset, no daemon restart.
- Read-only Core state at review time: height **165**, `initialblockdownload=false`;
  `getblockhash` 140/141/142 returned the expected hashes, so the earlier
  index/block-file mismatch is no longer present.
- Existing app release path is
  `/home/truja/deployments/lqwd-swap-engine-434f519`; unit templates use that
  deployment path, not the source checkout.
- One persistent wallet-owned address; one `generatetoaddress` block per
  invocation. No CPU/GPU mining.

## Files

- `scripts/regtest-block-miner.sh` — minimal Bash miner and controls.
- `deploy/regtest-block-miner.service` — oneshot, no retry loop.
- `deploy/regtest-block-miner.timer` — 10-minute persistent user timer.
- `deploy/regtest-miner.env.example` — paths only.
- `tests/regtestMiner.sh` — adversarial kernel-flock/mock-RPC regression tests.
- `tests/regtestMiner.test.ts` — runs the shell regression test on Linux and
  skips where Bash/flock are unavailable.

## Kernel-held shared lock

The miner opens `MINER_LOCK_FILE` (default
`/home/truja/.local/share/lqwd-regtest-miner/miner.lock`) and calls
`flock -n 9` for the lifetime of the process. There is no TTL, no lock-file JSON
read/unlink, no stale-lock eviction and no timeout-based removal of a live
holder. The kernel releases the lock when the process exits or crashes.

- Timer `--once`: if the flock is held, logs `locked` and exits without mining.
- `--on-demand`: uses the same flock. It ignores a pause marker but **cannot**
  bypass a holder, so it cannot defeat CLTV/swap protection.
- Swap execution/recovery: must use the same lock path and hold a kernel flock
  around funding, claim, settlement and other block-sensitive irreversible
  actions. Pending integration is the deployment blocker.
- Pause/resume: temporary `pause.json` controls for expiration tests; the timer
  must be restored explicitly.
- State initialization and every state mutation occur only after the flock is
  held; `--status` reads a default in memory when no state file exists.

## Persistent state

Default data directory: `/home/truja/.local/share/lqwd-regtest-miner` (mode 700).

- `mining-address` (600): one persistent owned `bcrt1…` address.
- `status.json` (600): chain, wallet, address, last height/hash/timestamps,
  blocks mined, failures, pause state and `coinbaseMaturityHeight`.
- `miner.log` (600): sanitized JSON events; no RPC bodies or credentials.
- `miner.lock`: kernel flock target; contents are not lock state.
- `pause.json` (600): temporary pause marker.
- `pending.json` (600): pre-generation height/hash for ambiguous RPC recovery.

## Ambiguous generate reconciliation

Before `generatetoaddress`, the script writes `pending.json` with the pre-height
and pre-hash, fsyncs the temporary file and the data directory, then renames it
into place before the RPC. If the reply is lost or malformed:

- Next invocation first reconciles the pending attempt.
- Exactly +1 height, `getblockhash(preHeight) == preHash`, the block header
  `previousblockhash`, and a coinbase output paying the persistent mining address
  are all mandatory. Only then is the ambiguous block recorded and pending
  cleared; no second block is mined on that invocation.
- Unchanged height, a different parent/reorg, a non-matching coinbase, or any
  larger delta: record `AMBIGUOUS_UNRECONCILED` / `AMBIGUOUS_PARENT_MISMATCH` /
  `AMBIGUOUS_COINBASE_MISMATCH` / `AMBIGUOUS_HEIGHT_CHANGED`, keep pending and
  mine nothing.

This prevents an external miner or reorg from being misattributed to this
miner, and prevents future ticks from mining again before an ambiguous
generation is understood.

## Commands

Prepared commands, not executed in this task:

```bash
# After the release has this script at scripts/regtest-block-miner.sh:
install -d -m 700 "$HOME/.config" "$HOME/.local/share/lqwd-regtest-miner"
install -m 600 deploy/regtest-miner.env.example "$HOME/.config/lqwd-regtest-miner.env"
install -m 644 deploy/regtest-block-miner.service deploy/regtest-block-miner.timer "$HOME/.config/systemd/user/"
systemctl --user daemon-reload
loginctl enable-linger truja
systemctl --user enable --now regtest-block-miner.timer

systemctl --user list-timers regtest-block-miner.timer
systemctl --user status regtest-block-miner.service
/home/truja/deployments/lqwd-swap-engine-434f519/scripts/regtest-block-miner.sh --status

# Temporary CLTV/expiry controls:
/home/truja/deployments/lqwd-swap-engine-434f519/scripts/regtest-block-miner.sh --pause "expiry-test"
/home/truja/deployments/lqwd-swap-engine-434f519/scripts/regtest-block-miner.sh --resume
/home/truja/deployments/lqwd-swap-engine-434f519/scripts/regtest-block-miner.sh --on-demand

# Rollback/disable:
systemctl --user stop regtest-block-miner.timer
systemctl --user disable regtest-block-miner.timer
```

The timer is not enabled and no real two-tick/list-timers evidence exists yet.

## Coinbase and HTLC/CLTV notes

Blocks are generated to the persistent `lqwd-lab` address. Coinbase rewards are
wallet rewards, not swap deltas, and are immature for **100 blocks**; Operations
must not count immature coinbase as spendable swap liquidity. The status records
`coinbaseMaturityHeight`.

Each mined block advances block height and consumes block-based HTLC/CLTV
margins. Never batch-mine; do not mine while a swap/recovery owner holds the
flock; re-run current CLTV checks after any block. On-demand is an explicit
operator action, not an automatic confirmation loop.

## Tests

`tests/regtestMiner.sh` uses a mock `bitcoin-cli` and real kernel `flock` to
cover: one address/two ticks, wrong chain/wallet rejection before generation,
shared-lock exclusion with a slow holder, concurrent acquisition, pause vs
on-demand, ambiguous generation reconciliation, unrelated block/coinbase,
parent/reorg mismatch and crash-boundary pending retention. `tests/
regtestMiner.test.ts` runs it on Linux. No VM service, timer, wallet or real
node was changed by this task.
