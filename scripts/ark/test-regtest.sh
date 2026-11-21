#!/usr/bin/env bash
source "$(dirname -- "${BASH_SOURCE[0]}")/common.sh"
cd -- "$root"

case "${1:---unit-only}" in
  --unit-only)
    [[ $# -le 1 ]] || fail "usage: ark:test [--unit-only | --e2e]"
    bash scripts/ark/test-bootstrap-funding.sh
    cd ark
    exec cargo test --locked --lib --tests
    ;;
  --e2e) [[ $# == 1 ]] || fail "usage: ark:test --e2e" ;;
  *) fail "usage: ark:test [--unit-only | --e2e]" ;;
esac

(cd ark && cargo build --locked)
setup_engine
setup_state
assert_resources
require_env
require_running
assert_host_networks all
validate_chain
validate_indexers || fail "indexers must be synchronized"
valid_operator || fail "local regtest operator unavailable"
valid_wallet || fail "operator wallet not ready"

# A claimed run is never reused, even on a timeout or interrupted faucet.
# The worktree's normal A/B wallets are never opened by this harness.
run_dir="$state/e2e"
mkdir -- "$run_dir" || fail "fixture already claimed; inspect original state, never repeat funding"
evidence="$run_dir/evidence"
mkdir -- "$run_dir/fixture" "$evidence"
lab() { "$root/ark/target/debug/ark-lab" --e2e-fixture "$@"; }
source "$root/scripts/ark/e2e-boarding.sh"
source "$root/scripts/ark/e2e-transfer.sh"
source "$root/scripts/ark/e2e-offboard.sh"

matrix="$evidence/matrix.json"
jq -n --arg genesis "$genesis" '
  {network:"regtest",$genesis,source:"live isolated stack",
    stages:{boarding:"PENDING",boarding_operator_outage:"PENDING",transfer_and_client_restart:"PENDING",
      cooperative_offboard:"PENDING",stale_vtxo_and_renewal:"PENDING",
      operator_unavailable:"PENDING",operator_restart:"PENDING",
      rpc_unavailable:"PENDING",indexer_unavailable:"PENDING",
      unilateral_exit:"SKIPPED",live_mutation_timeout:"SKIPPED"}}' > "$matrix"
stage_set() {
  jq --arg stage "$1" --arg status "$2" '.stages[$stage]=$status' "$matrix" > "$matrix.next"
  mv -- "$matrix.next" "$matrix"
}

stage=
stopped=
finish() {
  local rc=$?
  if [[ -n "$stopped" ]]; then
    docker start "$stopped" >/dev/null || rc=1
  fi
  if ((rc != 0)) && [[ -n "$stage" ]]; then stage_set "$stage" FAILED; fi
  cat "$matrix"
  exit "$rc"
}
trap finish EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

stop_service() {
  stopped=$1
  docker stop -t 30 "$stopped" >/dev/null
}
resume_service() {
  docker start "$stopped" >/dev/null
  stopped=
}
offboard_address() { lab addresses bob | jq -er '.wallets.bob.onchain'; }

restart_snapshot_ready() {
  # The fixture expires leaves after 40s. Wait for both funded leaves to
  # enter the recovery bucket before measuring persistence, so elapsed
  # wall-clock time during a slow restart cannot change their classification.
  lab list-vtxos | jq -e '.wallets | all(.alice, .bob;
    [.[] | select(.is_spent | not)] | length == 1 and .[0].is_expired)' >/dev/null
}

operator_unavailable() {
  local address balance_before balance_after rows_before rows_after
  address=$(offboard_address)
  wait_for "stable fixture balances after VTXO expiry" restart_snapshot_ready
  balance_before=$(lab balance | jq -ceS '.wallets')
  rows_before=$(lab list-vtxos | jq -ceS '.wallets')
  jq -e '.alice.recoverable_sats == 125000 and .alice.total_sats == 125000 and
    .bob.recoverable_sats == 45000 and .bob.total_sats == 45000' <<<"$balance_before" >/dev/null
  jq -e '(.alice | length) > 0 and (.bob | length) > 0' <<<"$rows_before" >/dev/null
  stop_service ark_lab_arkd
  expect_lab_error ArkOperatorUnavailable offboard-coop "$bob_input" "$address" 30000
  stage_set "$stage" PASSED
  stage=operator_restart
  resume_service
  wait_for "operator restart" valid_operator
  wait_for "operator wallet restart" valid_wallet
  balance_after=$(lab balance | jq -ceS '.wallets')
  rows_after=$(lab list-vtxos | jq -ceS '.wallets')
  [[ "$balance_before" == "$balance_after" ]] || fail "wallet balances changed across operator restart"
  [[ "$rows_before" == "$rows_after" ]] || fail "VTXOs changed across operator restart"
  jq --argjson balance "$balance_after" --argjson vtxos "$rows_after" \
    '.operator_restart = {balances_unchanged:true,vtxos_unchanged:true,$balance,$vtxos}' \
    "$matrix" > "$matrix.next"
  mv -- "$matrix.next" "$matrix"
}

rpc_unavailable() {
  stop_service ark_lab_bitcoin
  if core getblockchaininfo >/dev/null 2>&1; then fail "expected dedicated Core RPC to fail"; fi
  # This is a read-only outage probe; never mine or fund with Core offline.
  resume_service
  wait_for "Core restart" core getblockchaininfo
  validate_chain
  wait_for "indexers after Core restart" validate_indexers
}

indexer_unavailable() {
  local address
  address=$(offboard_address)
  stop_service ark_lab_mempool_api
  expect_lab_error ArkIndexerUnavailable offboard-coop "$bob_input" "$address" 30000
  resume_service
  wait_for "Esplora restart" validate_indexers
}

stale_and_renew() {
  local old result commitment rows block renewed
  old=$(jq -er '.change.outpoint' "$evidence/transfer.json")
  is_stale() {
    lab list-vtxos alice | jq -e --arg old "$old" \
      'any(.wallets.alice[]; .outpoint == $old and .is_expired and (.is_spent | not))' >/dev/null
  }
  wait_for "Alice's VTXO to become stale (SDK expiry)" is_stale
  expect_lab_error ArkInputNotSpendable transfer-submit "$old" 75000
  result=$(lab settle-vtxo alice "$old")
  commitment=$(jq -er '.wallets.alice.commitment_txid' <<<"$result")
  wait_for "renewal commitment in Core mempool" in_mempool "$commitment"
  mine 1
  block=$(confirmed_tx "$commitment")
  rows=$(lab list-vtxos alice)
  jq -e --arg old "$old" --arg tx "$commitment" 'any(.wallets.alice[];
     .outpoint == $old and .is_spent and .settled_by == $tx)' <<<"$rows" >/dev/null
  renewed=$(jq -ce --arg tx "$commitment" '.wallets.alice[] | select(
    .origin == "batch_leaf" and .amount_sats == 125000 and (.is_spent | not) and (.commitment_txids | index($tx)))' <<<"$rows")
  jq -n --arg old "$old" --argjson commitment "$block" --argjson renewed "$renewed" \
    '{source:"live",stale_rejection:"PASSED",stale_vtxo:$old,$commitment,$renewed}' > "$evidence/renewal.json"
}

run_stage() {
  stage=$1
  "$2"
  stage_set "$stage" PASSED
  stage=
}
run_stage boarding boarding
run_stage transfer_and_client_restart transfer
run_stage cooperative_offboard offboard
run_stage stale_vtxo_and_renewal stale_and_renew
run_stage operator_unavailable operator_unavailable
run_stage rpc_unavailable rpc_unavailable
run_stage indexer_unavailable indexer_unavailable
