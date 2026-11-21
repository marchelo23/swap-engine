#!/usr/bin/env bash
# Strict fail-closed validator for public Ark Docker E2E evidence artifacts.
# Enforces an exact file allowlist, size limit, strict JSON schemas (keys, types,
# allowed values), zero secret/credential patterns, zero raw/multiline log dumps,
# and stages ONLY validated canonical JSON files into <approved_dir>.
set -euo pipefail
umask 077

fail() {
  printf 'Ark evidence-validator: %s\n' "$*" >&2
  exit 1
}

[[ $# == 2 ]] || fail "usage: validate-e2e-evidence.sh <source_dir> <approved_dir>"
src=$1
dst=$2

[[ -n "$src" && -n "$dst" && "$src" != "/" && "$dst" != "/" ]] ||
  fail "invalid source or destination path"
[[ "$src" != "$dst" ]] || fail "source and approved directory must differ"
[[ -d "$src" && ! -L "$src" ]] || fail "missing or unsafe source directory: $src"
[[ ! -L "$dst" ]] || fail "refusing symlink approved directory: $dst"

command -v jq >/dev/null || fail "missing jq"

dst_parent=$(dirname -- "$dst")
[[ -d "$dst_parent" && ! -L "$dst_parent" ]] || mkdir -p -- "$dst_parent"
[[ ! -L "$dst_parent" ]] || fail "refusing symlink parent for approved directory"

# Always clear stale approved artifacts first so a failed run never leaves old files.
if [[ -e "$dst" ]]; then
  [[ -d "$dst" && ! -L "$dst" ]] || fail "approved path exists and is not a directory: $dst"
  rm -rf -- "$dst"
fi

tmp_stage=$(mktemp -d "$dst_parent/.ark-approved-evidence.XXXXXXXX")
chmod 0700 "$tmp_stage"
cleanup() {
  rm -rf -- "$tmp_stage"
}
trap cleanup EXIT

expected_files=(
  boarding.json
  matrix.json
  offboard.json
  renewal.json
  restart.json
  transfer.json
)

# Fail closed if any required file is missing or any unexpected file/dir/dotfile is present.
actual_entries=()
while IFS= read -r entry; do
  [[ -z "$entry" ]] && continue
  actual_entries+=("$entry")
done < <(find "$src" -mindepth 1 -maxdepth 1 -printf '%f\n' | LC_ALL=C sort)

expected_sorted=$(printf '%s\n' "${expected_files[@]}")
actual_sorted=$(printf '%s\n' "${actual_entries[@]}")
if [[ "$actual_sorted" != "$expected_sorted" ]]; then
  for req in "${expected_files[@]}"; do
    if ! printf '%s\n' "$actual_sorted" | grep -Fxq "$req"; then
      fail "missing required evidence file: $req"
    fi
  done
  for found in "${actual_entries[@]}"; do
    if ! printf '%s\n' "$expected_sorted" | grep -Fxq "$found"; then
      fail "unexpected unapproved entry in evidence directory: $found"
    fi
  done
  fail "evidence directory entries do not match strict allowlist"
fi

max_bytes=65536

# Common jq library embedded in every schema validation invocation.
jq_common='
def is_hex64: type == "string" and test("^[0-9a-f]{64}$");
def is_outpoint: type == "string" and test("^[0-9a-f]{64}:[0-9]+$");
def is_pubkey: type == "string" and test("^(02|03)[0-9a-f]{64}$");
def is_bcrt1: type == "string" and test("^bcrt1[a-z0-9]{14,90}$");
def is_tark1: type == "string" and test("^tark1[a-z0-9]{20,160}$");
def is_uint: type == "number" and (. == floor) and . >= 0;
def is_int: type == "number" and (. == floor);
def is_dec_str: type == "string" and test("^[0-9]+(\\.[0-9]+)?$");
def is_uint_str: type == "string" and test("^[0-9]+$");
def exact_keys($ks): type == "object" and ((keys_unsorted | sort) == ($ks | sort));

def is_balance:
  exact_keys(["confirmed_sats","pending_recovery_sats","pre_confirmed_sats","recoverable_sats","total_sats"]) and
  (.confirmed_sats | is_uint) and
  (.pending_recovery_sats | is_uint) and
  (.pre_confirmed_sats | is_uint) and
  (.recoverable_sats | is_uint) and
  (.total_sats | is_uint);

def is_wallets_balance:
  exact_keys(["alice","bob"]) and (.alice | is_balance) and (.bob | is_balance);

def is_vtxo:
  exact_keys(["amount_sats","ark_txid","commitment_txids","created_at","expires_at","is_expired","is_spent","is_swept","is_unrolled","origin","outpoint","settled_by","spent_by"]) and
  (.amount_sats | is_uint) and
  (.ark_txid == null or (.ark_txid | is_hex64)) and
  (.commitment_txids | type == "array" and all(.[]; is_hex64)) and
  (.created_at | is_int) and
  (.expires_at | is_int) and
  (.is_expired | type == "boolean") and
  (.is_spent | type == "boolean") and
  (.is_swept | type == "boolean") and
  (.is_unrolled | type == "boolean") and
  (.origin == "batch_leaf" or .origin == "ark_transfer") and
  (.outpoint | is_outpoint) and
  (.settled_by == null or (.settled_by | is_hex64)) and
  (.spent_by == null or (.spent_by | is_hex64));

def is_confirmed_tx:
  exact_keys(["blockhash","fee_sats","height","locktime","txid"]) and
  (.blockhash | is_hex64) and
  (.txid | is_hex64) and
  (.fee_sats | is_uint) and
  (.height | is_uint and . >= 1) and
  (.locktime | is_uint);

def no_secrets_or_raw_logs:
  [ .. | (if type == "object" then keys_unsorted[] else empty end),
         (if type == "string" then . else empty end) ] |
  all(.[];
    (length <= 256) and
    (test("[\\x00-\\x1f]") | not) and
    (test("(mnemonic|xprv|tprv|private_key|privkey|rpcpassword|ark_lab_|-----begin|macaroon|wallet\\.dat|\\.cookie|compose\\.env|password|secret|bearer |gh[pousr]_|github_pat_|https?://[^/\\s@:]+:[^/\\s@]+@|\\bseed\\b|stack backtrace|traceback|panicked at|\\[error\\]|\\[warn\\]|\\[debug\\])"; "i") | not)
  );
'

validate_file() {
  local name=$1 schema=$2 path="$src/$1" size
  [[ -f "$path" && ! -L "$path" && -r "$path" ]] || fail "unsafe or unreadable file: $name"
  size=$(wc -c < "$path")
  (( size > 0 && size <= max_bytes )) || fail "file size out of bounds ($size bytes): $name"

  # Reject NUL bytes or obvious sensitive tokens in raw bytes before JSON parsing.
  if ! LC_ALL=C tr -d '\000' < "$path" | cmp -s - "$path"; then
    fail "binary NUL byte detected in $name"
  fi
  if grep -Eqi '(mnemonic|xprv|tprv|private_key|privkey|rpcpassword|ark_lab_|-----begin|macaroon|wallet\.dat|\.cookie|compose\.env|password|secret|bearer |gh[pousr]_|github_pat_|https?://[^/[:space:]@:]+:[^/[:space:]@]+@|\bseed\b|stack backtrace|traceback|panicked at)' "$path"; then
    fail "sensitive token or raw log marker detected in $name"
  fi

  # Enforce single JSON document (jq -se length == 1), zero secrets/control chars, and strict schema.
  jq -se "${jq_common}
    length == 1 and
    (.[0] | type == \"object\" and no_secrets_or_raw_logs and (${schema}))
  " "$path" >/dev/null || fail "strict schema validation failed for $name"

  # Stage canonical sanitized JSON copy only after passing all checks.
  jq -S '.' "$path" > "$tmp_stage/$name"
  chmod 0600 "$tmp_stage/$name"
}

schema_matrix='
  exact_keys(["genesis","network","operator_restart","project","source","stages"]) and
  .network == "regtest" and
  .genesis == "0f9188f13cb7b2c71f2a335e3a4fc328bf5beb436012afca590b1a11466e2206" and
  (.project | type == "string" and test("^swap-engine-ark-docker-e2e(-[a-z0-9]{1,12})?$")) and
  .source == "live isolated docker-e2e stack" and
  (.stages |
    exact_keys([
      "adapter_arkd_read","boarding","boarding_operator_outage",
      "cooperative_offboard","indexer_unavailable","live_mutation_timeout",
      "operator_restart","operator_unavailable","rpc_unavailable",
      "stale_vtxo_and_renewal","transfer_and_client_restart","unilateral_exit"
    ]) and
    .boarding == "PASSED" and
    .boarding_operator_outage == "PASSED" and
    .transfer_and_client_restart == "PASSED" and
    .cooperative_offboard == "PASSED" and
    .stale_vtxo_and_renewal == "PASSED" and
    (.adapter_arkd_read == "PASSED" or .adapter_arkd_read == "SKIPPED") and
    .operator_unavailable == "PASSED" and
    .operator_restart == "PASSED" and
    .rpc_unavailable == "PASSED" and
    .indexer_unavailable == "PASSED" and
    .unilateral_exit == "SKIPPED" and
    .live_mutation_timeout == "SKIPPED"
  ) and
  (.operator_restart |
    exact_keys(["balance","balances_unchanged","vtxos","vtxos_unchanged"]) and
    .balances_unchanged == true and
    .vtxos_unchanged == true and
    (.balance | is_wallets_balance) and
    (.vtxos | exact_keys(["alice","bob"]) and
      (.alice | type == "array" and length >= 1 and all(.[]; is_vtxo)) and
      (.bob | type == "array" and length >= 1 and all(.[]; is_vtxo)))
  )
'

schema_boarding='
  exact_keys([
    "address","after_sats","before_sats","boarding_fee_sats","commitment","funding",
    "funding_transactions_to_address","input","invalid_funding_preflight","network",
    "operator_unavailable","reconciled_original_input","same_input_retry","vtxo"
  ]) and
  .network == "regtest" and
  (.input | is_outpoint) and
  (.reconciled_original_input == .input) and
  (.address | is_bcrt1) and
  (.funding | is_confirmed_tx) and
  (.commitment | is_confirmed_tx) and
  (.vtxo | is_vtxo) and
  (.before_sats | is_uint) and
  (.after_sats | is_uint) and
  (.boarding_fee_sats | is_int) and
  .funding_transactions_to_address == 1 and
  .invalid_funding_preflight == "PASSED" and
  .same_input_retry == "PASSED" and
  .operator_unavailable == "PASSED"
'

schema_transfer='
  exact_keys([
    "after","ark_txid","before","change","client_restart","fee_sats","finality",
    "finalize_retry","input","inputs_consumed","insufficient_input","network",
    "original_txid_recovered_from_pending","protocol","received","recipient_credits",
    "spent_input_read_only","submit_ack_discarded"
  ]) and
  .network == "regtest" and
  .protocol == "Ark (not Lightning)" and
  (.ark_txid | is_hex64) and
  .finality == "finalized preconfirmation, not a Bitcoin confirmation" and
  (.before | is_wallets_balance) and
  (.after | is_wallets_balance) and
  (.input | is_vtxo) and
  (.change | is_vtxo) and
  (.received | is_vtxo) and
  (.fee_sats | is_int) and
  .submit_ack_discarded == true and
  .original_txid_recovered_from_pending == true and
  .inputs_consumed == 1 and
  .recipient_credits == 1 and
  .spent_input_read_only == "PASSED" and
  .finalize_retry == "PASSED" and
  .client_restart == "PASSED" and
  .insufficient_input == "PASSED"
'

schema_offboard='
  exact_keys([
    "address","ark_after_sats","ark_before_sats","bitcoin_after_sats","bitcoin_before_sats",
    "change","commitment","insufficient_input","method","network","output","params",
    "spent","sub_dust_change","unilateral_exit","user_fee_sats","wrong_network"
  ]) and
  .network == "regtest" and
  .method == "cooperative" and
  (.address | is_bcrt1) and
  (.commitment | is_confirmed_tx) and
  (.output | exact_keys(["amount_sats","vout"]) and (.amount_sats | is_uint) and (.vout | is_uint)) and
  (.spent | is_vtxo) and
  (.change | is_vtxo) and
  (.params |
    exact_keys(["boardingExitDelay","fees","unilateralExitDelay"]) and
    (.boardingExitDelay | is_uint_str) and
    (.unilateralExitDelay | is_uint_str) and
    (.fees | exact_keys(["intentFee","txFeeRate"]) and
      (.txFeeRate | is_dec_str) and
      (.intentFee | exact_keys(["offchainInput","offchainOutput","onchainInput","onchainOutput"]) and
        (.offchainInput | is_dec_str) and (.offchainOutput | is_dec_str) and
        (.onchainInput | is_dec_str) and (.onchainOutput | is_dec_str)))
  ) and
  (.ark_before_sats | is_uint) and
  (.ark_after_sats | is_uint) and
  (.bitcoin_before_sats | is_uint) and
  (.bitcoin_after_sats | is_uint) and
  (.user_fee_sats | is_int) and
  .wrong_network == "PASSED" and
  .insufficient_input == "PASSED" and
  .sub_dust_change == "PASSED" and
  .unilateral_exit == "SKIPPED"
'

schema_renewal='
  exact_keys(["commitment","renewed","source","stale_rejection","stale_vtxo"]) and
  .source == "live" and
  .stale_rejection == "PASSED" and
  (.stale_vtxo | is_outpoint) and
  (.commitment | is_confirmed_tx) and
  (.renewed | is_vtxo)
'

schema_restart='
  exact_keys([
    "container_ids_unchanged","containers","core_height","core_tip","e2e_balances",
    "e2e_balances_unchanged","e2e_vtxo_counts","e2e_vtxos_unchanged","full_stack_restart",
    "normal_wallets","normal_wallets_unchanged","operator_balance_btc","operator_signer",
    "status_unchanged","volumes","volumes_unchanged"
  ]) and
  .full_stack_restart == "PASSED" and
  .status_unchanged == true and
  .normal_wallets_unchanged == true and
  .e2e_balances_unchanged == true and
  .e2e_vtxos_unchanged == true and
  .container_ids_unchanged == true and
  .volumes_unchanged == true and
  (.core_height | is_uint and . >= 1) and
  (.core_tip | is_hex64) and
  (.operator_signer | is_pubkey) and
  (.operator_balance_btc |
    exact_keys(["connectorsAccount","mainAccount"]) and
    (.connectorsAccount | exact_keys(["available","locked"]) and (.available | is_dec_str) and (.locked | is_dec_str)) and
    (.mainAccount | exact_keys(["available","locked"]) and (.available | is_dec_str) and (.locked | is_dec_str))
  ) and
  (.normal_wallets |
    exact_keys(["addresses","balance","vtxos"]) and
    (.addresses | exact_keys(["alice","bob"]) and
      all(.alice, .bob;
        exact_keys(["ark","boarding","onchain"]) and
        (.ark | type == "array" and length >= 1 and all(.[]; is_tark1)) and
        (.boarding | type == "array" and length >= 1 and all(.[]; is_bcrt1)) and
        (.onchain | is_bcrt1))) and
    (.balance | is_wallets_balance) and
    (.vtxos | exact_keys(["alice","bob"]) and
      (.alice | type == "array" and all(.[]; is_vtxo)) and
      (.bob | type == "array" and all(.[]; is_vtxo)))
  ) and
  (.e2e_balances | is_wallets_balance) and
  (.e2e_vtxo_counts | exact_keys(["alice","bob"]) and (.alice | is_uint) and (.bob | is_uint)) and
  (.volumes | type == "array" and length >= 1 and all(.[]; type == "string" and test("^swap_engine_ark_e2e(_[a-z0-9]{1,12})?_[a-z0-9_]+$"))) and
  (.containers | type == "array" and length >= 1 and all(.[]; type == "string" and test("^ark_e2e(_[a-z0-9]{1,12})?_[a-z0-9_]+=[0-9a-f]{12,64}$")))
'

validate_file matrix.json "$schema_matrix"
validate_file boarding.json "$schema_boarding"
validate_file transfer.json "$schema_transfer"
validate_file offboard.json "$schema_offboard"
validate_file renewal.json "$schema_renewal"
validate_file restart.json "$schema_restart"

mv -- "$tmp_stage" "$dst"
trap - EXIT

jq -nc '{event:"e2e_evidence_validation",status:"PASSED",approved_files:["boarding.json","matrix.json","offboard.json","renewal.json","restart.json","transfer.json"]}'
