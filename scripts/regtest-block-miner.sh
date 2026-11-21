#!/usr/bin/env bash
set -euo pipefail
umask 077

# Bitcoin regtest only. One block per invocation. No CPU/GPU proof-of-work.
# The kernel flock is shared with swap execution/recovery for CLTV protection.

CMD="${1:---once}"
DATA_DIR="${MINER_DATA_DIR:-/home/truja/.local/share/lqwd-regtest-miner}"
ADDRESS_FILE="${MINER_ADDRESS_FILE:-$DATA_DIR/mining-address}"
STATE_FILE="${MINER_STATE_FILE:-$DATA_DIR/status.json}"
LOG_FILE="${MINER_LOG_FILE:-$DATA_DIR/miner.log}"
LOCK_FILE="${MINER_LOCK_FILE:-$DATA_DIR/miner.lock}"
PAUSE_FILE="${MINER_PAUSE_FILE:-$DATA_DIR/pause.json}"
PENDING_FILE="${MINER_PENDING_FILE:-$DATA_DIR/pending.json}"
WALLET="${BITCOIN_WALLET:-lqwd-lab}"
CORE_DATADIR="${BITCOIN_DATADIR:-/home/truja/.bitcoin}"
CLI="${BITCOIN_CLI:-bitcoin-cli}"
ADDRESS_LABEL="${MINER_ADDRESS_LABEL:-lqwd-regtest-miner}"

now() { date -u +%Y-%m-%dT%H:%M:%SZ; }
core() { "$CLI" -regtest -datadir="$CORE_DATADIR" "$@"; }
core_wallet() { "$CLI" -regtest -datadir="$CORE_DATADIR" -rpcwallet="$WALLET" "$@"; }
sync_path() { sync -f "$1"; }

log_event() {
  local event="$1"; shift
  jq -cn --arg at "$(now)" --arg event "$event" "$@" >> "$LOG_FILE"
  chmod 600 "$LOG_FILE" 2>/dev/null || true
}

default_state() {
  jq -n --arg wallet "$WALLET" '{chain:null,wallet:$wallet,address:null,lastAttemptAt:null,lastSuccessAt:null,lastHeight:null,lastBlockHash:null,blocksMined:0,coinbaseMaturityHeight:null,failures:0,lastFailureAt:null,lastFailureReason:null,paused:false,pausedAt:null,pausedReason:null}'
}

ensure_state() {
  if [[ ! -s "$STATE_FILE" ]]; then
    local tmp; tmp=$(mktemp "$STATE_FILE.XXXXXX")
    default_state > "$tmp"
    chmod 600 "$tmp"; sync_path "$tmp"; mv "$tmp" "$STATE_FILE"; sync_path "$DATA_DIR"
  fi
}

record_failure() {
  local reason="$1" at; at=$(now)
  local tmp; tmp=$(mktemp "$STATE_FILE.XXXXXX")
  jq --arg at "$at" --arg reason "$reason" '.lastAttemptAt=$at | .failures += 1 | .lastFailureAt=$at | .lastFailureReason=$reason' "$STATE_FILE" > "$tmp"
  chmod 600 "$tmp"; sync_path "$tmp"; mv "$tmp" "$STATE_FILE"; sync_path "$DATA_DIR"
  log_event failed --arg reason "$reason" --argjson failures "$(jq -r '.failures' "$STATE_FILE")"
}

record_success() {
  local height="$1" hash="$2" address="$3" at; at=$(now)
  local tmp; tmp=$(mktemp "$STATE_FILE.XXXXXX")
  jq --arg at "$at" --argjson height "$height" --arg hash "$hash" --arg address "$address" --arg wallet "$WALLET" \
    '.blocksMined = (if .lastBlockHash == $hash then .blocksMined else (.blocksMined + 1) end) | .chain="regtest" | .wallet=$wallet | .address=$address | .lastAttemptAt=$at | .lastSuccessAt=$at | .lastHeight=$height | .lastBlockHash=$hash | .coinbaseMaturityHeight=($height+100) | .paused=false | .pausedAt=null | .pausedReason=null' \
    "$STATE_FILE" > "$tmp"
  chmod 600 "$tmp"; sync_path "$tmp"; mv "$tmp" "$STATE_FILE"; sync_path "$DATA_DIR"
}

write_pending() {
  local height="$1" hash="$2" at; at=$(now)
  local tmp; tmp=$(mktemp "$PENDING_FILE.XXXXXX")
  jq -n --argjson preHeight "$height" --arg preHash "$hash" --arg at "$at" '{preHeight:$preHeight,preHash:$preHash,attemptedAt:$at}' > "$tmp"
  chmod 600 "$tmp"
  sync_path "$tmp"
  mv "$tmp" "$PENDING_FILE"
  sync_path "$DATA_DIR"
}

reconcile_pending() {
  [[ -f "$PENDING_FILE" ]] || return 0
  local pre_height pre_hash chain height hash address parent header block
  pre_height=$(jq -r '.preHeight // empty' "$PENDING_FILE" 2>/dev/null || true)
  pre_hash=$(jq -r '.preHash // empty' "$PENDING_FILE" 2>/dev/null || true)
  if [[ ! "$pre_height" =~ ^[0-9]+$ || ! "$pre_hash" =~ ^[0-9a-f]{64}$ ]]; then
    record_failure AMBIGUOUS_STATE_INVALID
    printf '%s\n' '{"status":"failed","failure":"AMBIGUOUS_STATE_INVALID"}'
    exit 1
  fi
  chain=$(core getblockchaininfo 2>/dev/null || true)
  if [[ -z "$chain" ]] || ! jq -e '.chain == "regtest"' <<< "$chain" >/dev/null 2>&1; then
    record_failure CORE_WRONG_CHAIN
    printf '%s\n' '{"status":"failed","failure":"CORE_WRONG_CHAIN"}'
    exit 1
  fi
  height=$(jq -r '.blocks' <<< "$chain"); hash=$(jq -r '.bestblockhash' <<< "$chain")
  if [[ "$height" -eq $((pre_height + 1)) ]]; then
    address=$(jq -r '.address // empty' "$STATE_FILE" 2>/dev/null || true)
    [[ -n "$address" ]] || address=$(tr -d '\r\n' < "$ADDRESS_FILE" 2>/dev/null || true)
    if [[ -z "$address" ]]; then
      record_failure AMBIGUOUS_ADDRESS_UNAVAILABLE
      printf '%s\n' '{"status":"failed","failure":"AMBIGUOUS_ADDRESS_UNAVAILABLE"}'
      exit 1
    fi
    parent=$(core getblockhash "$pre_height" 2>/dev/null || true)
    if [[ "$parent" != "$pre_hash" ]]; then
      record_failure AMBIGUOUS_PARENT_MISMATCH
      printf '%s\n' '{"status":"failed","failure":"AMBIGUOUS_PARENT_MISMATCH"}'
      exit 1
    fi
    header=$(core getblock "$hash" 1 2>/dev/null || true)
    if ! jq -e --arg prev "$pre_hash" --argjson height "$((pre_height + 1))" \
      '.height == $height and .previousblockhash == $prev' <<< "$header" >/dev/null 2>&1; then
      record_failure AMBIGUOUS_PARENT_MISMATCH
      printf '%s\n' '{"status":"failed","failure":"AMBIGUOUS_PARENT_MISMATCH"}'
      exit 1
    fi
    block=$(core getblock "$hash" 2 2>/dev/null || true)
    if ! jq -e --arg addr "$address" 'any(.tx[0].vout[]; (.scriptPubKey.address? // "") == $addr)' <<< "$block" >/dev/null 2>&1; then
      record_failure AMBIGUOUS_COINBASE_MISMATCH
      printf '%s\n' '{"status":"failed","failure":"AMBIGUOUS_COINBASE_MISMATCH"}'
      exit 1
    fi
    record_success "$height" "$hash" "$address"
    rm -f "$PENDING_FILE"
    sync_path "$DATA_DIR"
    log_event reconciled --argjson height "$height" --arg hash "$hash" --arg reason 'ambiguous-generate-verified'
    printf '%s\n' "{\"status\":\"reconciled\",\"height\":$height,\"blockHash\":\"$hash\"}"
    exit 0
  fi
  local reason
  if [[ "$height" -eq "$pre_height" ]]; then reason=AMBIGUOUS_UNRECONCILED
  else reason=AMBIGUOUS_HEIGHT_CHANGED; fi
  record_failure "$reason"
  printf '%s\n' "{\"status\":\"failed\",\"failure\":\"$reason\",\"height\":$height}"
  exit 1
}

print_status() {
  mkdir -p "$DATA_DIR"
  chmod 700 "$DATA_DIR"
  local state pause='null'
  if [[ -s "$STATE_FILE" ]]; then
    state=$(cat "$STATE_FILE")
  else
    state=$(default_state)
  fi
  [[ -f "$PAUSE_FILE" ]] && pause=$(cat "$PAUSE_FILE")
  jq -n --argjson state "$state" --argjson pause "$pause" '{status:$state,paused:($pause != null),pause:$pause}'
}

show_help() {
  cat <<'EOF'
Usage: regtest-block-miner.sh [--once|--on-demand|--status|--pause [reason]|--resume|--help]
  --once       mine exactly one block unless paused or another process holds the kernel flock
  --on-demand  explicit one-block confirmation; ignores pause but respects the shared flock
  --status     print sanitized state
  --pause      set pause.json for expiration tests
  --resume     remove pause.json
EOF
}

if [[ "$CMD" == "--help" ]]; then show_help; exit 0; fi
if [[ "$CMD" == "--status" ]]; then print_status; exit 0; fi
case "$CMD" in --once|--on-demand|--pause|--resume) ;; *) echo '{"status":"failed","failure":"INVALID_COMMAND"}'; exit 2;; esac

for required in "$CLI" jq flock mktemp date sync; do
  command -v "$required" >/dev/null 2>&1 || { echo "{\"status\":\"failed\",\"failure\":\"MISSING_COMMAND\"}"; exit 2; }
done

mkdir -p "$DATA_DIR"
chmod 700 "$DATA_DIR"

# Kernel-held lock: no timeout, no stale-file eviction, no unlink of a live lock.
exec 9>>"$LOCK_FILE"
chmod 600 "$LOCK_FILE" 2>/dev/null || true
if ! flock -n 9; then
  log_event locked --arg mode "$CMD"
  printf '%s\n' '{"status":"locked"}'
  case "$CMD" in --once) exit 0;; *) exit 1;; esac
fi

# All state mutation occurs only after the kernel flock is held.
ensure_state

if [[ "$CMD" == "--pause" ]]; then
  reason="${2:-operator-pause}"
  if [[ ! "$reason" =~ ^[A-Za-z0-9\ _.-]{1,120}$ ]]; then echo '{"status":"failed","failure":"PAUSE_REASON_INVALID"}'; exit 2; fi
  tmp=$(mktemp "$PAUSE_FILE.XXXXXX")
  jq -n --arg at "$(now)" --arg reason "$reason" '{pausedAt:$at,reason:$reason}' > "$tmp"
  chmod 600 "$tmp"; mv "$tmp" "$PAUSE_FILE"
  log_event pause --arg reason "$reason"
  printf '%s\n' '{"paused":true}'
  exit 0
fi

if [[ "$CMD" == "--resume" ]]; then
  rm -f "$PAUSE_FILE"
  log_event resume
  printf '%s\n' '{"paused":false}'
  exit 0
fi

reconcile_pending

if [[ "$CMD" == "--once" && -f "$PAUSE_FILE" ]]; then
  pause_reason=$(jq -r '.reason // "unknown"' "$PAUSE_FILE" 2>/dev/null || echo unknown)
  tmp=$(mktemp "$STATE_FILE.XXXXXX")
  jq --arg reason "$pause_reason" '.paused=true | .pausedReason=$reason' "$STATE_FILE" > "$tmp"
  chmod 600 "$tmp"; mv "$tmp" "$STATE_FILE"
  log_event paused --arg reason "$pause_reason"
  printf '%s\n' '{"status":"paused"}'
  exit 0
fi

chain=$(core getblockchaininfo 2>/dev/null || true)
if [[ -z "$chain" ]]; then record_failure CORE_RPC_ERROR; echo '{"status":"failed","failure":"CORE_RPC_ERROR"}'; exit 1; fi
chain_name=$(jq -r '.chain // empty' <<< "$chain")
if [[ "$chain_name" != "regtest" ]]; then record_failure CORE_WRONG_CHAIN; echo '{"status":"failed","failure":"CORE_WRONG_CHAIN"}'; exit 1; fi
if ! jq -e '.initialblockdownload == false and .headers >= .blocks' <<< "$chain" >/dev/null 2>&1; then
  record_failure CORE_NOT_READY; echo '{"status":"failed","failure":"CORE_NOT_READY"}'; exit 1
fi
wallets=$(core listwallets 2>/dev/null || true)
if ! jq -e --arg w "$WALLET" 'index($w) != null' <<< "$wallets" >/dev/null 2>&1; then
  record_failure WALLET_NOT_LOADED; echo '{"status":"failed","failure":"WALLET_NOT_LOADED"}'; exit 1
fi
wallet_info=$(core_wallet getwalletinfo 2>/dev/null || true)
if [[ "$(jq -r '.walletname // empty' <<< "$wallet_info")" != "$WALLET" ]]; then
  record_failure WALLET_MISMATCH; echo '{"status":"failed","failure":"WALLET_MISMATCH"}'; exit 1
fi

if [[ -e "$ADDRESS_FILE" ]]; then
  address=$(tr -d '\r\n' < "$ADDRESS_FILE")
  if [[ -z "$address" ]]; then record_failure ADDRESS_FILE_EMPTY; echo '{"status":"failed","failure":"ADDRESS_FILE_EMPTY"}'; exit 1; fi
else
  address=$(core_wallet getnewaddress "$ADDRESS_LABEL" bech32 2>/dev/null || true)
  if [[ -z "$address" ]]; then record_failure ADDRESS_UNAVAILABLE; echo '{"status":"failed","failure":"ADDRESS_UNAVAILABLE"}'; exit 1; fi
  tmp=$(mktemp "$ADDRESS_FILE.XXXXXX"); printf '%s\n' "$address" > "$tmp"; chmod 600 "$tmp"; sync_path "$tmp"; mv "$tmp" "$ADDRESS_FILE"; sync_path "$DATA_DIR"
fi
if [[ ! "$address" =~ ^bcrt1[0-9a-z]{20,}$ ]]; then
  record_failure ADDRESS_NOT_REGTEST; echo '{"status":"failed","failure":"ADDRESS_NOT_REGTEST"}'; exit 1
fi
address_info=$(core_wallet getaddressinfo "$address" 2>/dev/null || true)
if ! jq -e '.ismine == true and (.iswatchonly != true)' <<< "$address_info" >/dev/null 2>&1; then
  record_failure ADDRESS_NOT_OWNED; echo '{"status":"failed","failure":"ADDRESS_NOT_OWNED"}'; exit 1
fi
sync_path "$ADDRESS_FILE"

pre_height=$(jq -r '.blocks' <<< "$chain")
pre_hash=$(jq -r '.bestblockhash' <<< "$chain")
write_pending "$pre_height" "$pre_hash"

generated=$(core_wallet generatetoaddress 1 "$address" 2>/dev/null || true)
hash=$(jq -r 'if type == "array" and length == 1 then .[0] else empty end' <<< "$generated" 2>/dev/null || true)
if [[ ! "$hash" =~ ^[0-9a-f]{64}$ ]]; then
  record_failure AMBIGUOUS_MINE
  log_event ambiguous_generate --arg address "$address" --argjson preHeight "$pre_height"
  printf '%s\n' '{"status":"failed","failure":"AMBIGUOUS_MINE"}'
  exit 1
fi

after=$(core getblockchaininfo 2>/dev/null || true)
after_height=$(jq -r '.blocks // empty' <<< "$after" 2>/dev/null || true)
after_hash=$(jq -r '.bestblockhash // empty' <<< "$after" 2>/dev/null || true)
if [[ "$after_height" -ne $((pre_height + 1)) || "$after_hash" != "$hash" ]]; then
  record_failure AMBIGUOUS_MINE
  log_event ambiguous_generate --arg address "$address" --argjson preHeight "$pre_height"
  printf '%s\n' '{"status":"failed","failure":"AMBIGUOUS_MINE"}'
  exit 1
fi

record_success "$after_height" "$hash" "$address"
rm -f "$PENDING_FILE"
sync_path "$DATA_DIR"
log_event mined --argjson height "$after_height" --arg hash "$hash" --arg address "$address"
printf '%s\n' "{\"status\":\"mined\",\"height\":$after_height,\"blockHash\":\"$hash\",\"address\":\"$address\"}"
