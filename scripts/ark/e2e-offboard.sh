offboard() {
  local address before result commitment tx output vout after rows spent change params
  local descriptor bitcoin_before bitcoin_after
  address=$(lab addresses bob | jq -er '.wallets.bob.onchain')
  before=$(lab balance bob)
  jq -e '.wallets.bob.total_sats == 75000' <<<"$before" >/dev/null
  descriptor=$(jq -nc --arg addr "$address" '["addr("+$addr+")"]')
  tx=$(core scantxoutset start "$descriptor")
  bitcoin_before=$(jq -ser 'select(length == 1) | .[0] | select(.success == true) |
    .total_amount | select(type == "number" and . == 0)' <<<"$tx")
  expect_lab_error ArkNetworkMismatch offboard-coop "$bob_input" 1BitcoinEaterAddressDontSendf59kuE 30000
  expect_lab_error ArkInvalidAmount offboard-coop "$bob_input" "$address" 100000
  params=$(http "$api" | jq -ce '{unilateralExitDelay,boardingExitDelay,fees}')
  result=$(lab offboard-coop "$bob_input" "$address" 30000)
  commitment=$(jq -er '.wallets.bob.commitment_txid' <<<"$result")
  printf '%s\n' "$commitment" > "$run_dir/offboard-txid"
  wait_for "offboarding commitment in Core mempool" in_mempool "$commitment"
  mine 1
  tx=$(core getrawtransaction "$commitment" 1)
  output=$(jq -ce --arg addr "$address" '[.vout[] | select(.scriptPubKey.address == $addr and .value == 0.0003)] |
    select(length == 1) | .[0] | {vout:.n, amount_sats:(.value * 1e8 | round)}' <<<"$tx")
  vout=$(jq -er .vout <<<"$output")
  confirmed_utxo "$commitment" "$vout" 30000 >/dev/null
  tx=$(core scantxoutset start "$descriptor")
  bitcoin_after=$(jq -ser --arg tx "$commitment" --argjson vout "$vout" '
    select(length == 1) | .[0] |
    select(.success == true and (.unspents | length == 1 and .[0].txid == $tx and .[0].vout == $vout)) |
    .total_amount | select(type == "number") | . * 1e8 | round | select(. == 30000)' <<<"$tx")
  after=$(lab balance bob)
  jq -e '.wallets.bob.confirmed_sats == 45000 and .wallets.bob.total_sats == 45000' <<<"$after" >/dev/null
  rows=$(lab list-vtxos bob)
  spent=$(jq -ce --arg input "$bob_input" --arg tx "$commitment" '
    .wallets.bob[] | select(.outpoint == $input and .settled_by == $tx)' <<<"$rows")
  change=$(jq -ce --arg tx "$commitment" '.wallets.bob[] | select(.origin == "batch_leaf" and
    (.is_spent | not) and .amount_sats == 45000 and (.commitment_txids | index($tx)))' <<<"$rows")
  jq -n --arg address "$address" --argjson commitment "$(confirmed_tx "$commitment")" \
    --argjson output "$output" --argjson spent "$spent" --argjson change "$change" \
    --argjson before "$before" --argjson after "$after" --argjson params "$params" \
    --argjson bitcoin_before_sats "$bitcoin_before" --argjson bitcoin_after_sats "$bitcoin_after" '
    {network:"regtest",method:"cooperative",$address,$commitment,$output,$spent,$change,$params,
      ark_before_sats:$before.wallets.bob.total_sats,ark_after_sats:$after.wallets.bob.total_sats,
      $bitcoin_before_sats,$bitcoin_after_sats,
      user_fee_sats:($before.wallets.bob.total_sats - $after.wallets.bob.total_sats - ($bitcoin_after_sats - $bitcoin_before_sats)),
      wrong_network:"PASSED",insufficient_input:"PASSED",unilateral_exit:"SKIPPED"}' > "$evidence/offboard.json"
}
