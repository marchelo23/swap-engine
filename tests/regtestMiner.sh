#!/usr/bin/env bash
set -euo pipefail

# Linux-only adversarial regression tests for scripts/regtest-block-miner.sh.
# A mock bitcoin-cli is used; no real node, wallet, mining or credentials.

ROOT=$(cd "$(dirname "$0")/.." && pwd)
SCRIPT="$ROOT/scripts/regtest-block-miner.sh"
TMP=$(mktemp -d)
DATA="$TMP/data"
STATE="$TMP/mock-state.json"
MOCK="$TMP/bin/bitcoin-cli"
OUT=''
RC=0
MOCK_MODE=normal
MOCK_DELAY=0
MOCK_COINBASE_ADDRESS=''
MOCK_PARENT_MISMATCH=0
cleanup() { rm -rf "$TMP"; }
trap cleanup EXIT

for c in bash jq flock mktemp date sync; do command -v "$c" >/dev/null || { echo "missing $c" >&2; exit 2; }; done
[[ -f "$SCRIPT" ]] || { echo "missing miner script" >&2; exit 2; }

mkdir -p "$TMP/bin"
hash_for() { printf '%064x' "$1"; }
reset_state() {
  MOCK_MODE=normal; MOCK_DELAY=0; MOCK_COINBASE_ADDRESS=''; MOCK_PARENT_MISMATCH=0
  rm -rf "$DATA"; mkdir -p "$DATA"; chmod 700 "$DATA"
  jq -n --arg hash "$(hash_for 139)" --arg address 'bcrt1qmockaddress000000000000000000000000' \
    '{chain:"regtest",blocks:139,headers:139,bestblockhash:$hash,initialblockdownload:false,wallet:"lqwd-lab",address:$address,addressCalls:0,owned:true,mineCalls:0}' > "$STATE"
}
fail() { echo "FAIL: $*" >&2; exit 1; }

cat > "$MOCK" <<'MOCKEOF'
#!/usr/bin/env bash
set -euo pipefail
args=("$@")
method=''
start=-1
for i in "${!args[@]}"; do
  case "${args[$i]}" in
    getblockchaininfo|listwallets|getwalletinfo|getaddressinfo|getnewaddress|generatetoaddress|getblockhash|getblock) method="${args[$i]}"; start=$((i+1)); break;;
  esac
done
params=("${args[@]:start}")
state="${MOCK_STATE_FILE:?}"
write_state() { local tmp; tmp=$(mktemp "$state.XXXXXX"); jq "$@" "$state" > "$tmp"; chmod 600 "$tmp"; mv "$tmp" "$state"; }
case "$method" in
  getblockchaininfo) jq -c '{chain,blocks,headers,bestblockhash,initialblockdownload}' "$state";;
  listwallets) jq -c '[.wallet]' "$state";;
  getwalletinfo) jq -c '{walletname:.wallet}' "$state";;
  getaddressinfo) jq -c '{address:.address,ismine:.owned,iswatchonly:false}' "$state";;
  getnewaddress) write_state '.addressCalls += 1'; jq -r '.address' "$state";;
  getblockhash)
    height="${params[0]:-0}"
    if [[ "${MOCK_PARENT_MISMATCH:-0}" == "1" ]]; then printf '%064x\n' "$((height + 500))"; else printf '%064x\n' "$height"; fi;;
  getblock)
    height=$(jq -r '.blocks' "$state")
    verbosity="${params[1]:-1}"
    previous=$(printf '%064x' "$((height - 1))")
    coinbase="${MOCK_COINBASE_ADDRESS:-$(jq -r '.address' "$state")}"
    if [[ "$verbosity" == "2" ]]; then
      jq -cn --arg hash "${params[0]}" --arg prev "$previous" --arg addr "$coinbase" --argjson height "$height" \
        '{hash:$hash,height:$height,previousblockhash:$prev,tx:[{vout:[{scriptPubKey:{address:$addr}}]}]}'
    else
      jq -cn --arg hash "${params[0]}" --arg prev "$previous" --argjson height "$height" \
        '{hash:$hash,height:$height,previousblockhash:$prev}'
    fi;;
  generatetoaddress)
    mode="${MOCK_MODE:-normal}"
    [[ "$mode" == "fail" ]] && exit 1
    [[ "$mode" == "slow" ]] && sleep "${MOCK_DELAY:-1}"
    height=$(( $(jq -r '.blocks' "$state") + 1 ))
    hash=$(printf '%064x' "$height")
    if [[ "$mode" == "ambiguous" ]]; then
      state_hash=$(printf '%064x' "$((height + 100))")
      returned_hash=$(printf '%064x' "$((height + 200))")
      write_state --arg h "$state_hash" --argjson height "$height" '.blocks=$height | .headers=([.headers,$height]|max) | .bestblockhash=$h | .mineCalls += 1'
      printf '["%s"]\n' "$returned_hash"
      exit 0
    fi
    write_state --arg h "$hash" --argjson height "$height" '.blocks=$height | .headers=([.headers,$height]|max) | .bestblockhash=$h | .mineCalls += 1'
    printf '["%s"]\n' "$hash";;
  *) exit 2;;
esac
MOCKEOF
chmod +x "$MOCK"

run_miner() {
  set +e
  OUT=$(MINER_DATA_DIR="$DATA" BITCOIN_CLI="$MOCK" BITCOIN_DATADIR="$TMP/core" BITCOIN_WALLET=lqwd-lab \
    MOCK_STATE_FILE="$STATE" MOCK_MODE="$MOCK_MODE" MOCK_DELAY="$MOCK_DELAY" \
    MOCK_COINBASE_ADDRESS="$MOCK_COINBASE_ADDRESS" MOCK_PARENT_MISMATCH="$MOCK_PARENT_MISMATCH" \
    bash "$SCRIPT" "$@" 2>&1)
  RC=$?
  set -e
}
state_value() { jq -r "$1" "$STATE"; }
assert_mined() { [[ "$RC" -eq 0 && "$OUT" == *'"status":"mined"'* ]] || fail "expected mined, rc=$RC out=$OUT"; }
assert_failed() { [[ "$RC" -ne 0 && "$OUT" == *"\"failure\":\"$1\""* ]] || fail "expected $1, rc=$RC out=$OUT"; }

test_one_address_two_ticks() {
  reset_state
  run_miner --once; assert_mined; [[ "$(state_value .blocks)" -eq 140 ]] || fail 'height 140'; [[ "$(state_value .addressCalls)" -eq 1 ]] || fail 'address calls 1'
  run_miner --once; assert_mined; [[ "$(state_value .blocks)" -eq 141 ]] || fail 'height 141'; [[ "$(state_value .addressCalls)" -eq 1 ]] || fail 'address reused'
  run_miner --status; [[ "$(jq -r '.status.blocksMined' <<< "$OUT")" -eq 2 ]] || fail "status blocksMined: $OUT"
}

test_wrong_chain_and_wallet() {
  reset_state; jq '.chain="main"' "$STATE" > "$TMP/s" && mv "$TMP/s" "$STATE"; run_miner --once; assert_failed CORE_WRONG_CHAIN; [[ "$(state_value .mineCalls)" -eq 0 ]] || fail 'mined wrong chain'
  reset_state; jq '.wallet="other"' "$STATE" > "$TMP/s" && mv "$TMP/s" "$STATE"; run_miner --once; assert_failed WALLET_NOT_LOADED; [[ "$(state_value .mineCalls)" -eq 0 ]] || fail 'mined without wallet'
}

test_address_ownership() {
  reset_state; jq '.owned=false' "$STATE" > "$TMP/s" && mv "$TMP/s" "$STATE"; run_miner --once; assert_failed ADDRESS_NOT_OWNED; [[ "$(state_value .mineCalls)" -eq 0 ]] || fail 'mined unowned address'
}

test_pause_and_on_demand() {
  reset_state; run_miner --pause expiry-test; [[ "$OUT" == *'"paused":true'* ]] || fail 'pause'
  run_miner --once; [[ "$OUT" == *'"status":"paused"'* ]] || fail 'timer did not pause'; [[ "$(state_value .mineCalls)" -eq 0 ]] || fail 'mined while paused'
  run_miner --on-demand; assert_mined; [[ "$(state_value .mineCalls)" -eq 1 ]] || fail 'on-demand'
  run_miner --resume; run_miner --status; [[ "$(jq -r '.paused' <<< "$OUT")" == "false" ]] || fail "resume: $OUT"
}

test_slow_holder_and_concurrent_lock() {
  reset_state; mkdir -p "$DATA"
  flock -n "$DATA/miner.lock" -c 'sleep 2' & holder=$!
  sleep 0.3
  run_miner --on-demand; [[ "$RC" -ne 0 && "$OUT" == *'"status":"locked"'* ]] || fail "slow holder: rc=$RC out=$OUT"
  [[ "$(state_value .mineCalls)" -eq 0 ]] || fail 'mined under slow holder'
  wait "$holder"; run_miner --once; assert_mined

  reset_state; MOCK_MODE=slow; MOCK_DELAY=1
  MINER_DATA_DIR="$DATA" BITCOIN_CLI="$MOCK" BITCOIN_DATADIR="$TMP/core" BITCOIN_WALLET=lqwd-lab MOCK_STATE_FILE="$STATE" MOCK_MODE="$MOCK_MODE" MOCK_DELAY="$MOCK_DELAY" bash "$SCRIPT" --on-demand > "$TMP/a" 2>&1 & p1=$!
  MINER_DATA_DIR="$DATA" BITCOIN_CLI="$MOCK" BITCOIN_DATADIR="$TMP/core" BITCOIN_WALLET=lqwd-lab MOCK_STATE_FILE="$STATE" MOCK_MODE="$MOCK_MODE" MOCK_DELAY="$MOCK_DELAY" bash "$SCRIPT" --on-demand > "$TMP/b" 2>&1 & p2=$!
  set +e; wait "$p1"; r1=$?; wait "$p2"; r2=$?; set -e
  [[ $(( (r1 == 0) + (r2 == 0) )) -eq 1 ]] || fail "concurrent owners: $r1/$r2"
  [[ "$(state_value .mineCalls)" -eq 1 ]] || fail 'concurrent mined more than once'
}

test_ambiguous_reconcile() {
  reset_state; MOCK_MODE=ambiguous; run_miner --on-demand; assert_failed AMBIGUOUS_MINE; [[ -f "$DATA/pending.json" ]] || fail 'pending missing'; [[ "$(state_value .mineCalls)" -eq 1 ]] || fail 'ambiguous mine count'
  MOCK_MODE=normal; run_miner --once; [[ "$OUT" == *'"status":"reconciled"'* ]] || fail "reconcile: $OUT"; [[ "$(state_value .mineCalls)" -eq 1 ]] || fail 'ambiguous retried'; [[ ! -e "$DATA/pending.json" ]] || fail 'pending not cleared'
}

test_unrelated_block_and_reorg_reconciliation() {
  reset_state; MOCK_MODE=ambiguous; run_miner --on-demand; assert_failed AMBIGUOUS_MINE
  MOCK_MODE=normal; MOCK_COINBASE_ADDRESS='bcrt1qother0000000000000000000000000000'; run_miner --once
  assert_failed AMBIGUOUS_COINBASE_MISMATCH; [[ -f "$DATA/pending.json" ]] || fail 'pending cleared on unrelated coinbase'; [[ "$(state_value .mineCalls)" -eq 1 ]] || fail 'mined on unrelated coinbase'
  MOCK_COINBASE_ADDRESS=''; MOCK_PARENT_MISMATCH=1; run_miner --once
  assert_failed AMBIGUOUS_PARENT_MISMATCH; [[ -f "$DATA/pending.json" ]] || fail 'pending cleared on reorg/parent mismatch'; [[ "$(state_value .mineCalls)" -eq 1 ]] || fail 'mined on parent mismatch'
}

test_crash_boundary_keeps_pending() {
  reset_state; MOCK_MODE=fail; run_miner --once; assert_failed AMBIGUOUS_MINE; [[ -f "$DATA/pending.json" ]] || fail 'pending missing after lost RPC'; [[ "$(state_value .mineCalls)" -eq 0 ]] || fail 'mined on failed RPC'
  MOCK_MODE=normal; run_miner --once; assert_failed AMBIGUOUS_UNRECONCILED; [[ -f "$DATA/pending.json" ]] || fail 'pending cleared without evidence'; [[ "$(state_value .mineCalls)" -eq 0 ]] || fail 'mined after unresolved pending'
}

test_crash_after_state_commit_before_pending_cleanup() {
  reset_state; MOCK_MODE=ambiguous; run_miner --on-demand; assert_failed AMBIGUOUS_MINE
  # Simulate a crash after record_success committed the same block but before pending cleanup.
  committed_hash=$(hash_for 240)
  jq --arg hash "$committed_hash" '.lastHeight=140 | .lastBlockHash=$hash | .blocksMined=1' "$STATE" > "$TMP/s" && mv "$TMP/s" "$STATE"
  [[ -f "$DATA/pending.json" ]] || fail 'pending missing for crash simulation'
  MOCK_MODE=normal; run_miner --once
  [[ "$OUT" == *'"status":"reconciled"'* ]] || fail "crash reconcile: $OUT"
  [[ "$(state_value .blocksMined)" -eq 1 ]] || fail "double-counted block: $(state_value .blocksMined)"
  [[ ! -e "$DATA/pending.json" ]] || fail 'pending not cleaned after idempotent reconcile'
}

test_one_address_two_ticks
test_wrong_chain_and_wallet
test_address_ownership
test_pause_and_on_demand
test_slow_holder_and_concurrent_lock
test_ambiguous_reconcile
test_unrelated_block_and_reorg_reconciliation
test_crash_boundary_keeps_pending
test_crash_after_state_commit_before_pending_cleanup
echo "regtest miner shell tests: PASS"
