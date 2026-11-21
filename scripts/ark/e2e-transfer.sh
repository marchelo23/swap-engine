# Uses a new CLI process for every call, including submit/finalize and restart.
expect_lab_error() {
  local pattern=$1 output rc=0
  shift
  output=$(lab "$@" 2>&1) || rc=$?
  [[ "$rc" == 1 && "$output" == "$pattern"* ]] ||
    fail "expected $pattern for $1 (exit $rc)"
}

transfer() {
  local before pending after rows alice_spent alice_change bob_vtxo spent_check
  before=$(lab balance)
  jq -e '.wallets | .alice.confirmed_sats == 200000 and .bob.total_sats == 0' <<<"$before" >/dev/null
  expect_lab_error ArkInvalidAmount transfer-submit "$alice_input" 500000
  lab pending | jq -e '.wallets.alice.pending_ark_txids == []' >/dev/null
  # Fault injection at the CLI/caller boundary: submit once, discard the
  # response including its TXID, and recover solely from a fresh process.
  lab transfer-submit "$alice_input" 75000 >/dev/null
  pending=$(lab pending)
  ark_txid=$(jq -er '.wallets.alice.pending_ark_txids | select(length == 1) |
    .[0] | select(test("^[0-9a-f]{64}$"))' <<<"$pending")
  printf '%s\n' "$ark_txid" > "$run_dir/ark-txid"
  lab transfer-finalize "$ark_txid" | jq -e '.wallets.alice.finalize_attempted == true' >/dev/null
  lab pending | jq -e '.wallets.alice.pending_ark_txids == []' >/dev/null
  lab transfer-finalize "$ark_txid" | jq -e '.wallets.alice.finalize_attempted == false' >/dev/null
  spent_check=$(lab verify-spent "$alice_input")
  jq -e '.wallets.alice | .spent == true and .spendable == false' <<<"$spent_check" >/dev/null
  after=$(lab balance)
  jq -e --argjson before "$before" '.wallets |
    .alice.pre_confirmed_sats == 125000 and .bob.pre_confirmed_sats == 75000 and
    ($before.wallets.alice.total_sats - .alice.total_sats == 75000) and
    (.bob.total_sats - $before.wallets.bob.total_sats == 75000)' <<<"$after" >/dev/null
  rows=$(lab list-vtxos)
  alice_spent=$(jq -ce --arg input "$alice_input" --arg tx "$ark_txid" \
    '[.wallets.alice[] | select(.is_spent and .ark_txid == $tx)] |
    select(length == 1 and .[0].outpoint == $input) | .[0]' <<<"$rows")
  alice_change=$(jq -ce --arg tx "$ark_txid" '
    [.wallets.alice[] | select(.outpoint | startswith($tx + ":"))] | select(length == 1) |
    .[0] | select(.amount_sats == 125000 and .origin == "ark_transfer" and (.is_spent | not))' <<<"$rows")
  bob_vtxo=$(jq -ce --arg tx "$ark_txid" '
    [.wallets.bob[] | select(.outpoint | startswith($tx + ":"))] | select(length == 1) |
    .[0] | select(.amount_sats == 75000 and .origin == "ark_transfer" and (.is_spent | not))' <<<"$rows")
  bob_input=$(jq -er '.outpoint' <<<"$bob_vtxo")
  [[ "$(lab balance)" == "$after" && "$(lab list-vtxos)" == "$rows" ]] || fail "restart snapshot changed"
  jq -n --arg tx "$ark_txid" --argjson before "$before" --argjson after "$after" \
    --argjson input "$alice_spent" --argjson change "$alice_change" --argjson received "$bob_vtxo" '
    {network:"regtest",protocol:"Ark (not Lightning)",ark_txid:$tx,finality:"finalized preconfirmation, not a Bitcoin confirmation",
      before:$before.wallets, after:$after.wallets, $input, $change, $received,
      fee_sats:(([$before.wallets[].total_sats] | add) - ([$after.wallets[].total_sats] | add)),
      submit_ack_discarded:true,original_txid_recovered_from_pending:true,
      inputs_consumed:1,recipient_credits:1,spent_input_read_only:"PASSED",
      finalize_retry:"PASSED",client_restart:"PASSED",insufficient_input:"PASSED"}' > "$evidence/transfer.json"
}
