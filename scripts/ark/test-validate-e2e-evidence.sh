#!/usr/bin/env bash
# Offline functional regression tests for scripts/ark/validate-e2e-evidence.sh.
# Uses 100% synthetic fictitious regtest-shaped fixtures (no real keys or secrets).
set -euo pipefail
umask 077

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
validator="${ARK_EVIDENCE_VALIDATOR:-$script_dir/validate-e2e-evidence.sh}"
[[ -f "$validator" ]] || { echo "missing $validator" >&2; exit 1; }

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

fail() {
  printf 'test-validate-e2e-evidence FAIL: %s\n' "$*" >&2
  exit 1
}

tx1="1111111111111111111111111111111111111111111111111111111111111111"
tx2="2222222222222222222222222222222222222222222222222222222222222222"
tx3="3333333333333333333333333333333333333333333333333333333333333333"
tx4="4444444444444444444444444444444444444444444444444444444444444444"
tx5="5555555555555555555555555555555555555555555555555555555555555555"
blk1="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
blk2="bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
blk3="cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
blk4="dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"
genesis="0f9188f13cb7b2c71f2a335e3a4fc328bf5beb436012afca590b1a11466e2206"
pubkey="0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798"
bcrt_a="bcrt1p0000000000000000000000000000000000000000000000000000000000a"
bcrt_b="bcrt1p0000000000000000000000000000000000000000000000000000000000b"
tark_a="tark1q000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000a"
tark_b="tark1q000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000b"

write_valid_fixture() {
  local dir=$1 adapter_status=${2:-PASSED} project=${3:-swap-engine-ark-docker-e2e}
  rm -rf "$dir"
  mkdir -p "$dir"

  cat > "$dir/matrix.json" <<JSON
{
  "network": "regtest",
  "project": "$project",
  "genesis": "$genesis",
  "source": "live isolated docker-e2e stack",
  "stages": {
    "boarding": "PASSED",
    "boarding_operator_outage": "PASSED",
    "transfer_and_client_restart": "PASSED",
    "cooperative_offboard": "PASSED",
    "stale_vtxo_and_renewal": "PASSED",
    "adapter_arkd_read": "$adapter_status",
    "operator_unavailable": "PASSED",
    "operator_restart": "PASSED",
    "rpc_unavailable": "PASSED",
    "indexer_unavailable": "PASSED",
    "unilateral_exit": "SKIPPED",
    "live_mutation_timeout": "SKIPPED"
  },
  "operator_restart": {
    "balances_unchanged": true,
    "vtxos_unchanged": true,
    "balance": {
      "alice": {"confirmed_sats":0,"pending_recovery_sats":0,"pre_confirmed_sats":0,"recoverable_sats":125000,"total_sats":125000},
      "bob": {"confirmed_sats":0,"pending_recovery_sats":0,"pre_confirmed_sats":0,"recoverable_sats":45000,"total_sats":45000}
    },
    "vtxos": {
      "alice": [{
        "amount_sats": 125000, "ark_txid": null, "commitment_txids": ["$tx5"],
        "created_at": 1700000060, "expires_at": 1700000100,
        "is_expired": true, "is_spent": false, "is_swept": false, "is_unrolled": false,
        "origin": "batch_leaf", "outpoint": "$tx5:0", "settled_by": null, "spent_by": null
      }],
      "bob": [{
        "amount_sats": 45000, "ark_txid": null, "commitment_txids": ["$tx4"],
        "created_at": 1700000040, "expires_at": 1700000080,
        "is_expired": true, "is_spent": false, "is_swept": false, "is_unrolled": false,
        "origin": "batch_leaf", "outpoint": "$tx4:0", "settled_by": null, "spent_by": null
      }]
    }
  }
}
JSON

  cat > "$dir/boarding.json" <<JSON
{
  "network": "regtest",
  "input": "$tx1:0",
  "address": "$bcrt_a",
  "funding": {"txid":"$tx1","blockhash":"$blk1","height":103,"locktime":102,"fee_sats":165},
  "commitment": {"txid":"$tx2","blockhash":"$blk2","height":104,"locktime":0,"fee_sats":262},
  "vtxo": {
    "amount_sats": 200000, "ark_txid": null, "commitment_txids": ["$tx2"],
    "created_at": 1700000010, "expires_at": 1700000050,
    "is_expired": false, "is_spent": false, "is_swept": false, "is_unrolled": false,
    "origin": "batch_leaf", "outpoint": "$tx2:0", "settled_by": null, "spent_by": null
  },
  "before_sats": 0,
  "after_sats": 200000,
  "boarding_fee_sats": 0,
  "invalid_funding_preflight": "PASSED",
  "same_input_retry": "PASSED",
  "operator_unavailable": "PASSED",
  "funding_transactions_to_address": 1,
  "reconciled_original_input": "$tx1:0"
}
JSON

  cat > "$dir/transfer.json" <<JSON
{
  "network": "regtest",
  "protocol": "Ark (not Lightning)",
  "ark_txid": "$tx3",
  "finality": "finalized preconfirmation, not a Bitcoin confirmation",
  "before": {
    "alice": {"confirmed_sats":200000,"pending_recovery_sats":0,"pre_confirmed_sats":0,"recoverable_sats":0,"total_sats":200000},
    "bob": {"confirmed_sats":0,"pending_recovery_sats":0,"pre_confirmed_sats":0,"recoverable_sats":0,"total_sats":0}
  },
  "after": {
    "alice": {"confirmed_sats":0,"pending_recovery_sats":0,"pre_confirmed_sats":125000,"recoverable_sats":0,"total_sats":125000},
    "bob": {"confirmed_sats":0,"pending_recovery_sats":0,"pre_confirmed_sats":75000,"recoverable_sats":0,"total_sats":75000}
  },
  "input": {
    "amount_sats": 200000, "ark_txid": "$tx3", "commitment_txids": ["$tx2"],
    "created_at": 1700000010, "expires_at": 1700000050,
    "is_expired": false, "is_spent": true, "is_swept": false, "is_unrolled": false,
    "origin": "batch_leaf", "outpoint": "$tx2:0", "settled_by": null, "spent_by": "$tx3"
  },
  "change": {
    "amount_sats": 125000, "ark_txid": null, "commitment_txids": ["$tx2"],
    "created_at": 1700000020, "expires_at": 1700000050,
    "is_expired": false, "is_spent": false, "is_swept": false, "is_unrolled": false,
    "origin": "ark_transfer", "outpoint": "$tx3:1", "settled_by": null, "spent_by": null
  },
  "received": {
    "amount_sats": 75000, "ark_txid": null, "commitment_txids": ["$tx2"],
    "created_at": 1700000020, "expires_at": 1700000050,
    "is_expired": false, "is_spent": false, "is_swept": false, "is_unrolled": false,
    "origin": "ark_transfer", "outpoint": "$tx3:0", "settled_by": null, "spent_by": null
  },
  "fee_sats": 0,
  "submit_ack_discarded": true,
  "original_txid_recovered_from_pending": true,
  "inputs_consumed": 1,
  "recipient_credits": 1,
  "spent_input_read_only": "PASSED",
  "finalize_retry": "PASSED",
  "client_restart": "PASSED",
  "insufficient_input": "PASSED"
}
JSON

  cat > "$dir/offboard.json" <<JSON
{
  "network": "regtest",
  "method": "cooperative",
  "address": "$bcrt_b",
  "commitment": {"txid":"$tx4","blockhash":"$blk3","height":105,"locktime":0,"fee_sats":241},
  "output": {"vout":2,"amount_sats":30000},
  "spent": {
    "amount_sats": 75000, "ark_txid": null, "commitment_txids": ["$tx2"],
    "created_at": 1700000020, "expires_at": 1700000050,
    "is_expired": false, "is_spent": true, "is_swept": false, "is_unrolled": false,
    "origin": "ark_transfer", "outpoint": "$tx3:0", "settled_by": "$tx4", "spent_by": "$tx4"
  },
  "change": {
    "amount_sats": 45000, "ark_txid": null, "commitment_txids": ["$tx4"],
    "created_at": 1700000040, "expires_at": 1700000080,
    "is_expired": false, "is_spent": false, "is_swept": false, "is_unrolled": false,
    "origin": "batch_leaf", "outpoint": "$tx4:0", "settled_by": null, "spent_by": null
  },
  "params": {
    "unilateralExitDelay": "20",
    "boardingExitDelay": "30",
    "fees": {
      "intentFee": {"offchainInput":"0.0","offchainOutput":"0.0","onchainInput":"0.0","onchainOutput":"0.0"},
      "txFeeRate": "0"
    }
  },
  "ark_before_sats": 75000,
  "ark_after_sats": 45000,
  "bitcoin_before_sats": 0,
  "bitcoin_after_sats": 30000,
  "user_fee_sats": 0,
  "wrong_network": "PASSED",
  "insufficient_input": "PASSED",
  "sub_dust_change": "PASSED",
  "unilateral_exit": "SKIPPED"
}
JSON

  cat > "$dir/renewal.json" <<JSON
{
  "source": "live",
  "stale_rejection": "PASSED",
  "stale_vtxo": "$tx3:1",
  "commitment": {"txid":"$tx5","blockhash":"$blk4","height":106,"locktime":0,"fee_sats":198},
  "renewed": {
    "amount_sats": 125000, "ark_txid": null, "commitment_txids": ["$tx5"],
    "created_at": 1700000060, "expires_at": 1700000100,
    "is_expired": false, "is_spent": false, "is_swept": false, "is_unrolled": false,
    "origin": "batch_leaf", "outpoint": "$tx5:0", "settled_by": null, "spent_by": null
  }
}
JSON

  cat > "$dir/restart.json" <<JSON
{
  "full_stack_restart": "PASSED",
  "status_unchanged": true,
  "normal_wallets_unchanged": true,
  "e2e_balances_unchanged": true,
  "e2e_vtxos_unchanged": true,
  "container_ids_unchanged": true,
  "volumes_unchanged": true,
  "core_height": 106,
  "core_tip": "$blk4",
  "operator_signer": "$pubkey",
  "operator_balance_btc": {
    "connectorsAccount": {"available":"0.00000660","locked":"0.00000000"},
    "mainAccount": {"available":"20.99798639","locked":"0.00000000"}
  },
  "normal_wallets": {
    "addresses": {
      "alice": {"ark":["$tark_a"],"boarding":["$bcrt_a"],"onchain":"$bcrt_a"},
      "bob": {"ark":["$tark_b"],"boarding":["$bcrt_b"],"onchain":"$bcrt_b"}
    },
    "balance": {
      "alice": {"confirmed_sats":0,"pending_recovery_sats":0,"pre_confirmed_sats":0,"recoverable_sats":0,"total_sats":0},
      "bob": {"confirmed_sats":0,"pending_recovery_sats":0,"pre_confirmed_sats":0,"recoverable_sats":0,"total_sats":0}
    },
    "vtxos": {"alice":[],"bob":[]}
  },
  "e2e_balances": {
    "alice": {"confirmed_sats":0,"pending_recovery_sats":0,"pre_confirmed_sats":0,"recoverable_sats":125000,"total_sats":125000},
    "bob": {"confirmed_sats":0,"pending_recovery_sats":0,"pre_confirmed_sats":0,"recoverable_sats":45000,"total_sats":45000}
  },
  "e2e_vtxo_counts": {"alice":1,"bob":1},
  "volumes": ["swap_engine_ark_e2e_bitcoin_data","swap_engine_ark_e2e_sdk_state"],
  "containers": ["ark_e2e_arkd=af17748522a9","ark_e2e_bitcoin=4142ab205459"]
}
JSON
}

expect_pass() {
  local label=$1 src=$2 dst=$3 out
  out=$(bash "$validator" "$src" "$dst" 2>&1) || fail "$label unexpectedly failed: $out"
  jq -e '.status == "PASSED" and (.approved_files | length == 6)' <<<"$out" >/dev/null ||
    fail "$label unexpected output: $out"
  [[ -d "$dst" ]] || fail "$label did not create approved dir"
  local count
  count=$(find "$dst" -mindepth 1 -maxdepth 1 -type f | wc -l)
  [[ "$count" == 6 ]] || fail "$label expected 6 approved files, got $count"
}

expect_fail() {
  local label=$1 src=$2 dst=$3 rc=0
  bash "$validator" "$src" "$dst" >/dev/null 2>&1 || rc=$?
  [[ "$rc" != 0 ]] || fail "$label unexpectedly succeeded"
  [[ ! -e "$dst" ]] || fail "$label left approved dir behind on failure"
}

# 1. Valid cases (PR #63+ adapter PASSED, PR #61 adapter SKIPPED, and named instance)
write_valid_fixture "$work/valid_full" PASSED swap-engine-ark-docker-e2e
expect_pass "valid_full" "$work/valid_full" "$work/out_valid_full"

write_valid_fixture "$work/valid_pr61" SKIPPED swap-engine-ark-docker-e2e-dist
expect_pass "valid_pr61_skip_adapter" "$work/valid_pr61" "$work/out_valid_pr61"

# 2. Invalid schema cases: extra key, wrong type, disallowed value, mainnet address
write_valid_fixture "$work/bad_extra_key"
jq '.unexpected_field = "nope"' "$work/bad_extra_key/matrix.json" > "$work/bad_extra_key/matrix.json.tmp"
mv "$work/bad_extra_key/matrix.json.tmp" "$work/bad_extra_key/matrix.json"
expect_fail "extra_key" "$work/bad_extra_key" "$work/out_bad_extra_key"

write_valid_fixture "$work/bad_type"
jq '.before_sats = "0"' "$work/bad_type/boarding.json" > "$work/bad_type/boarding.json.tmp"
mv "$work/bad_type/boarding.json.tmp" "$work/bad_type/boarding.json"
expect_fail "wrong_type" "$work/bad_type" "$work/out_bad_type"

write_valid_fixture "$work/bad_network"
jq '.network = "mainnet"' "$work/bad_network/transfer.json" > "$work/bad_network/transfer.json.tmp"
mv "$work/bad_network/transfer.json.tmp" "$work/bad_network/transfer.json"
expect_fail "disallowed_network" "$work/bad_network" "$work/out_bad_network"

write_valid_fixture "$work/bad_stage_value"
jq '.stages.unilateral_exit = "PASSED"' "$work/bad_stage_value/matrix.json" > "$work/bad_stage_value/matrix.json.tmp"
mv "$work/bad_stage_value/matrix.json.tmp" "$work/bad_stage_value/matrix.json"
expect_fail "disallowed_stage_value" "$work/bad_stage_value" "$work/out_bad_stage_value"

write_valid_fixture "$work/bad_stage_failed"
jq '.stages.boarding = "FAILED"' "$work/bad_stage_failed/matrix.json" > "$work/bad_stage_failed/matrix.json.tmp"
mv "$work/bad_stage_failed/matrix.json.tmp" "$work/bad_stage_failed/matrix.json"
expect_fail "failed_stage_not_publishable" "$work/bad_stage_failed" "$work/out_bad_stage_failed"

write_valid_fixture "$work/bad_mainnet_addr"
jq '.address = "1BitcoinEaterAddressDontSendf59kuE"' "$work/bad_mainnet_addr/offboard.json" > "$work/bad_mainnet_addr/offboard.json.tmp"
mv "$work/bad_mainnet_addr/offboard.json.tmp" "$work/bad_mainnet_addr/offboard.json"
expect_fail "mainnet_address" "$work/bad_mainnet_addr" "$work/out_bad_mainnet_addr"

# 3. Secret / sensitive token / raw multiline log rejection
write_valid_fixture "$work/bad_secret"
jq '.source = "live xprv9s21ZrQH143K"' "$work/bad_secret/matrix.json" > "$work/bad_secret/matrix.json.tmp"
mv "$work/bad_secret/matrix.json.tmp" "$work/bad_secret/matrix.json"
expect_fail "secret_token" "$work/bad_secret" "$work/out_bad_secret"

write_valid_fixture "$work/bad_raw_log"
jq '.source = "live isolated docker-e2e stack\n2026-11-21 INFO raw container log"' "$work/bad_raw_log/matrix.json" > "$work/bad_raw_log/matrix.json.tmp"
mv "$work/bad_raw_log/matrix.json.tmp" "$work/bad_raw_log/matrix.json"
expect_fail "raw_multiline_log" "$work/bad_raw_log" "$work/out_bad_raw_log"

# 4. Extra unapproved file, extra benign directory, symlink, malformed JSON
write_valid_fixture "$work/bad_extra_file"
printf 'raw debug log\n' > "$work/bad_extra_file/debug.log"
expect_fail "extra_unapproved_file" "$work/bad_extra_file" "$work/out_bad_extra_file"

write_valid_fixture "$work/bad_extra_dir"
mkdir -p "$work/bad_extra_dir/extra_dir"
printf 'benign note\n' > "$work/bad_extra_dir/extra_dir/note.txt"
expect_fail "extra_unapproved_dir" "$work/bad_extra_dir" "$work/out_bad_extra_dir"

write_valid_fixture "$work/bad_symlink"
mv "$work/bad_symlink/renewal.json" "$work/renewal-outside.json"
ln -s "$work/renewal-outside.json" "$work/bad_symlink/renewal.json"
expect_fail "symlink_evidence_file" "$work/bad_symlink" "$work/out_bad_symlink"

write_valid_fixture "$work/bad_json"
printf '{broken json' > "$work/bad_json/renewal.json"
expect_fail "malformed_json" "$work/bad_json" "$work/out_bad_json"

# 5. Missing file cases & stale approved dir cleanup on failure
write_valid_fixture "$work/missing_restart"
rm -f "$work/missing_restart/restart.json"
mkdir -p "$work/out_missing_restart"
printf '{"stale":true}\n' > "$work/out_missing_restart/stale.json"
expect_fail "missing_restart_and_clears_stale" "$work/missing_restart" "$work/out_missing_restart"

mkdir -p "$work/empty_dir"
expect_fail "empty_dir" "$work/empty_dir" "$work/out_empty_dir"

printf '%s\n' 'PASS: strict fail-closed E2E evidence validator (valid, invalid schema/types/values/secrets/raw-logs/extra/symlink, and missing files)'
