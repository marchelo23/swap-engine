# Sourced by the E2E harness, after validating ownership, chain and indexers.
mine() {
  local address
  address=$(miner getnewaddress)
  miner generatetoaddress "$1" "$address" >/dev/null
  wait_for "indexers after mining" validate_indexers
}

assert_only_boarding_funding() {
  local address=$1 txid=$2 rows
  rows=$(miner_history '.[] | select(.category == "send" and .address == $key)' "$address") ||
    fail "cannot reconcile original boarding funding"
  jq -se --arg tx "$txid" 'length == 1 and
    (.[0] | .txid == $tx and .comment == "ark-lab-e2e-boarding" and
      .amount == -0.002 and .confirmations >= 1 and .abandoned == false)' <<<"$rows" >/dev/null
}

confirmed_tx() {
  local txid=$1 block height tx
  tx=$(core getrawtransaction "$txid" 2)
  block=$(jq -er 'select(.confirmations >= 1) | .blockhash' <<<"$tx")
  height=$(core getblockheader "$block" | jq -er '.height')
  jq -ce --argjson height "$height" '
    select(.fee != null) |
    {txid, blockhash, height:$height, locktime, fee_sats:(.fee * 1e8 | round)}' <<<"$tx"
}

in_mempool() { core getmempoolentry "$1" >/dev/null; }

funding_preflight() {
  local address=$1 amount_sats=$2 minimum=$3
  [[ "$address" == bcrt1p* ]] || return 1
  core validateaddress "$address" | jq -e '.isvalid == true' >/dev/null || return 1
  (( amount_sats >= minimum )) || return 1
  miner getbalances | jq -e --argjson amount "$amount_sats" \
    '(.mine.trusted * 1e8 | round) > $amount' >/dev/null
}

boarding() {
  local addresses addr dust funding raw vout result commitment before after leaf
  addresses=$(lab init-wallets)
  addr=$(jq -er '.wallets.alice.boarding[0]' <<<"$addresses")
  dust=$(http "$api" | jq -er '.dust | tonumber')
  before=$(lab balance alice)
  jq -e '.wallets.alice.total_sats == 0' <<<"$before" >/dev/null
  if funding_preflight "$addr" 1 "$dust" ||
     funding_preflight "$addr" 2100000000000000 "$dust" ||
     funding_preflight '1BitcoinEaterAddressDontSendf59kuE' 200000 "$dust"; then
    fail "invalid funding preflight accepted"
  fi
  funding_preflight "$addr" 200000 "$dust"
  # `run_dir` is an exclusive, permanent attempt fence, claimed by the
  # harness before reaching this function. Never repeat sendtoaddress.
  (set -o noclobber; jq -nc --arg addr "$addr" '{address:$addr, amount_sats:200000}' > "$run_dir/funding-intent.json") &&
    sync -f "$run_dir/funding-intent.json" || fail "cannot durably fence boarding intent"
  funding=$(miner sendtoaddress "$addr" 0.002 ark-lab-e2e-boarding)
  [[ "$funding" =~ ^[0-9a-f]{64}$ ]] || fail "ambiguous funding; reconcile original, never re-fund"
  (set -o noclobber; printf '%s\n' "$funding" > "$run_dir/funding-txid") &&
    sync -f "$run_dir/funding-txid" || fail "cannot record boarding funding txid"
  mine 1
  raw=$(core getrawtransaction "$funding" 1)
  vout=$(jq -er --arg addr "$addr" '[.vout[] | select(.scriptPubKey.address == $addr and .value == 0.002)] |
    select(length == 1) | .[0].n' <<<"$raw")
  boarding_input="$funding:$vout"
  funding_proof=$(confirmed_tx "$funding")
  confirmed_utxo "$funding" "$vout" 200000 >/dev/null
  assert_only_boarding_funding "$addr" "$funding"
  stage=boarding_operator_outage
  stop_service ark_lab_arkd
  expect_lab_error ArkOperatorUnavailable board alice "$boarding_input"
  confirmed_utxo "$funding" "$vout" 200000 >/dev/null
  assert_only_boarding_funding "$addr" "$funding"
  resume_service
  wait_for "operator after boarding outage" valid_operator
  wait_for "operator wallet after boarding outage" valid_wallet
  confirmed_utxo "$funding" "$vout" 200000 >/dev/null
  result=$(lab board alice "$boarding_input")
  commitment=$(jq -er '.wallets.alice.commitment_txid' <<<"$result")
  wait_for "boarding commitment in Core mempool" in_mempool "$commitment"
  mine 1
  batch_proof=$(confirmed_tx "$commitment")
  core getrawtransaction "$commitment" 1 | jq -e --arg funding "$funding" --argjson vout "$vout" \
    'any(.vin[]; .txid == $funding and .vout == $vout)' >/dev/null
  assert_only_boarding_funding "$addr" "$funding"
  stage_set boarding_operator_outage PASSED
  stage=boarding
  after=$(lab balance alice)
  leaf=$(lab list-vtxos alice | jq -ce --arg tx "$commitment" '
    [.wallets.alice[] | select(.origin == "batch_leaf" and (.is_spent | not) and
      (.commitment_txids | index($tx)))] | select(length == 1) | .[0]')
  alice_input=$(jq -er '.outpoint' <<<"$leaf")
  jq -e '.wallets.alice.confirmed_sats == 200000' <<<"$after" >/dev/null
  lab board alice "$boarding_input" | jq -e '.wallets.alice.commitment_txid == null' >/dev/null
  jq -n --arg input "$boarding_input" --arg address "$addr" --argjson funding "$funding_proof" \
    --argjson commitment "$batch_proof" --argjson vtxo "$leaf" \
    --argjson before "$before" --argjson after "$after" \
    '{network:"regtest",$input,$address,$funding,$commitment,$vtxo,
      before_sats:$before.wallets.alice.total_sats,after_sats:$after.wallets.alice.total_sats,
      boarding_fee_sats:(200000 - $after.wallets.alice.total_sats),
      invalid_funding_preflight:"PASSED",same_input_retry:"PASSED",
      operator_unavailable:"PASSED",funding_transactions_to_address:1,
      reconciled_original_input:$input}' > "$evidence/boarding.json"
}
