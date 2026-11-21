# Regtest block miner (DS-02)

Status: implemented and tested offline; **not deployed or activated**. The
systemd timer must not be enabled until the shared mining/deadline protection is
reviewed by swap execution/recovery and Codex.

## Scope

- Bitcoin **regtest only**. The script rejects any chain other than the exact
  literal `regtest`; it never touches mainnet, testnet, signet, Ark or
  Elements/Liquid.
- Existing Bitcoin Core RPC and existing `lqwd-lab` wallet only. No second
  daemon, no daemon restart, no wallet creation/reset and no wallet deletion.
- One persistent wallet-owned address. The address is created once and stored in
  a mode-600 file; it is never regenerated per tick.
- One RPC `generatetoaddress` call with exactly one block per execution. No CPU
  or GPU proof-of-work mining.

## Files

- `scripts/regtest-block-miner.ts` — CLI.
- `src/regtest-mining/RegtestMiner.ts` — validated mining, state and pause logic.
- `src/regtest-mining/MiningLock.ts` — shared advisory lock.
- `src/regtest-mining/Config.ts` — environment/path configuration.
- `deploy/regtest-block-miner.service` — `Type=oneshot`, no retry loop.
- `deploy/regtest-block-miner.timer` — boot + 10-minute timer, persistent.
- `deploy/regtest-miner.env.example` — paths only; no credential contents.

## Persistent state

Default data directory: `/home/truja/.local/share/lqwd-regtest-miner` (mode 700).

- `mining-address` (mode 600): one wallet-owned `bcrt1…` address.
- `status.json` (mode 600): chain, wallet, address, last height/hash/timestamp,
  blocks mined, failures, pause state and `coinbaseMaturityHeight`.
- `miner.log` (mode 600): sanitized JSON events only; never RPC bodies or
  credentials.
- `miner.lock` (mode 600): shared coordination lock.
- `pause.json` (mode 600): temporary pause marker for deadline/expiration tests.

## Commands

These are prepared commands, **not executed in this task**:

```bash
# From the repository root, after installing the release and env file:
install -d -m 700 "$HOME/.config" "$HOME/.local/share/lqwd-regtest-miner"
install -m 600 deploy/regtest-miner.env.example "$HOME/.config/lqwd-regtest-miner.env"
install -m 644 deploy/regtest-block-miner.service deploy/regtest-block-miner.timer "$HOME/.config/systemd/user/"
systemctl --user daemon-reload
loginctl enable-linger truja
systemctl --user enable --now regtest-block-miner.timer

systemctl --user list-timers regtest-block-miner.timer
systemctl --user status regtest-block-miner.service
node --import tsx scripts/regtest-block-miner.ts --status

# Timer respects pause. On-demand is explicit and ignores pause but still uses
# the shared lock.
node --import tsx scripts/regtest-block-miner.ts --pause "expiry-test"
node --import tsx scripts/regtest-block-miner.ts --resume
node --import tsx scripts/regtest-block-miner.ts --on-demand

# Rollback/disable:
systemctl --user stop regtest-block-miner.timer
systemctl --user disable regtest-block-miner.timer
```

The service uses `%h/projects/swap-engine` as its working directory. Adjust only
the release path after an independently reviewed deployment; do not alter
existing `bitcoin-regtest.service`, LND units or wallets.

## Shared lock and HTLC/CLTV coordination

The timer, on-demand control, swap execution and recovery must use the **same**
lock file (`MINER_LOCK_FILE`, default
`/home/truja/.local/share/lqwd-regtest-miner/miner.lock`).

- Timer path: `--once` takes the lock non-blocking; if a swap/recovery owner holds
  it, the timer logs `locked` and exits without mining.
- Swap execution/recovery: import `withMiningLock` or `acquireMiningLock` from
  `src/regtest-mining/MiningLock.ts` and hold the lock around funding, claim
  publication, settlement and other block-sensitive irreversible actions. Use a
  bounded TTL covering only the critical action; never hold it across a human
  wait.
- On-demand confirmation after funding/claim: `--on-demand` performs exactly one
  block, ignores a pause marker, and still respects the shared lock. It must be
  called deliberately by the operator/coordinator; the timer is not an automatic
  confirmation loop.
- Pause: `--pause` and `--resume` are temporary controls for CLTV/expiration
  tests. A pause prevents timer mining; it does not cancel the timer. Restore
  timer operation explicitly after the test.
- Mining advances block height and therefore consumes script/HTLC block-based
  deadlines. Never batch-mine; do not mine while a swap action owns the lock;
  re-run current CLTV checks after any mined block.

The timer is **not activated** and no real two-tick evidence exists in this
worktree task. Mock tests below prove the script contract; live enablement and
two-tick/`list-timers` evidence require the reviewed deployment step.

## Coinbase maturity and Operations

Blocks are generated to the existing persistent `lqwd-lab` address. Coinbase
rewards are wallet rewards, not swap deltas, and are **immature for 100 blocks**.
They must not be counted as spendable swap/on-chain liquidity in Operations while
immature. `status.json` records `coinbaseMaturityHeight = minedHeight + 100` for
operator visibility. No Operations backend file is changed here; integration
must keep coinbase rewards separate from swap balance deltas.

## Tests

`tests/regtestMiner.test.ts` uses a mock Core RPC and temporary private
directories. It covers:

- one address persisted across two ticks and exactly one block per tick;
- wrong chain, IBD/header readiness, missing wallet and wrong-wallet rejection
  before `generatetoaddress`;
- existing address not owned by the wallet (no replacement address);
- ambiguous mining evidence recorded once with no retry;
- pause blocks timer mining while explicit on-demand mines one block;
- shared lock blocks a second miner and stale dead-PID locks are recovered;
- deploy units are oneshot, 10-minute, persistent and regtest-only.

`npm run build` and the focused test file pass locally. No VM service, timer or
wallet was changed by this task.
