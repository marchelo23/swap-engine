#!/usr/bin/env bash
set -euo pipefail
umask 077

export ARK_LAB_NETWORK_MODE=docker
export CARGO_HOME="${CARGO_HOME:-/home/arklab/.cargo}"
export CARGO_INCREMENTAL=0

ARK_DIR=/workspace/ark
STATE_DIR=/workspace/data/ark
E2E_DIR="$STATE_DIR/e2e"
EVIDENCE_DIR="$E2E_DIR/evidence"
FUNDING_DIR="$STATE_DIR/operator-funding"
BIN="$ARK_DIR/target/debug/ark-lab"

fail() {
  printf 'ark-sdk: %s\n' "$*" >&2
  exit 1
}

http_curl() {
  curl -q --noproxy '*' --silent --fail --max-time 5 "$@"
}

service_base_url() {
  case "$1" in
    arkd) printf '%s' "http://arkd:7070" ;;
    arkd-admin) printf '%s' "http://arkd:7071" ;;
    esplora) printf '%s' "http://mempool_api:8999/api" ;;
    nbxplorer) printf '%s' "http://nbxplorer:32838" ;;
    signer) printf '%s' "http://arkd-signer:6061" ;;
    *) fail "disallowed internal service: $1" ;;
  esac
}

validate_rel_path() {
  local p=$1
  [[ "$p" == /* && "$p" != *".."* && ! "$p" =~ [[:space:]] ]] || fail "invalid internal path"
}

validate_evidence_name() {
  case "$1" in
    matrix.json|boarding.json|transfer.json|offboard.json|renewal.json|\
    status-before.json|status-after.json|wallets-before.json|wallets-after.json|restart.json)
      return 0
      ;;
    *) fail "disallowed evidence filename: $1" ;;
  esac
}

validate_fence_name() {
  case "$1" in
    funding-intent.json|funding-txid|ark-txid|offboard-txid) return 0 ;;
    *) fail "disallowed fence filename: $1" ;;
  esac
}

assert_no_sensitive_tokens() {
  local payload=$1
  if printf '%s' "$payload" | grep -Eqi '(mnemonic|xprv|private_key|rpcpassword|ark_lab_|-----begin)'; then
    fail "refusing to emit or store payload containing sensitive token"
  fi
}

cmd="${1:-idle}"
shift || true

case "$cmd" in
  idle)
    trap 'exit 0' TERM INT
    while :; do
      sleep 60 &
      wait $! || true
    done
    ;;

  info)
    sdk_rev=$(grep -oE 'rust-sdk\?rev=[0-9a-f]{40}' "$ARK_DIR/Cargo.lock" | head -n 1 | cut -d= -f2)
    jq -n \
      --arg rustc "$(rustc --version)" \
      --arg cargo "$(cargo --version)" \
      --arg sdk_rev "${sdk_rev:-unknown}" \
      --arg network_mode "$ARK_LAB_NETWORK_MODE" \
      --argjson uid "$(id -u)" \
      '{rustc:$rustc, cargo:$cargo, rust_sdk_rev:$sdk_rev, network_mode:$network_mode, uid:$uid}'
    ;;

  unit)
    cd "$ARK_DIR"
    cargo fmt --all -- --check
    cargo clippy --locked --offline --all-targets --all-features -- -D warnings
    cargo test --locked --offline --lib --tests
    ;;

  integration)
    cd "$ARK_DIR"
    [[ -f "$ARK_DIR/ark-lab/tests/adapter_arkd_read.rs" ]] || fail "adapter_arkd_read.rs not present in this revision"
    cargo test --locked --offline -p ark-lab --test adapter_arkd_read -- --ignored --nocapture
    ;;

  has-integration-test)
    [[ -f "$ARK_DIR/ark-lab/tests/adapter_arkd_read.rs" ]]
    ;;

  cli)
    exec "$BIN" "$@"
    ;;

  jq)
    exec jq "$@"
    ;;

  http-get)
    [[ $# == 2 ]] || fail "usage: http-get <service> <path>"
    base=$(service_base_url "$1")
    validate_rel_path "$2"
    http_curl "${base}${2}"
    ;;

  admin-wallet-init)
    IFS= read -r password || fail "missing operator wallet password on stdin"
    [[ "$password" =~ ^[a-f0-9]{64}$ ]] || fail "invalid operator wallet credential format"
    status=$(http_curl "http://arkd:7071/v1/admin/wallet/status")
    if ! jq -e '.initialized == true' <<<"$status" >/dev/null; then
      http_curl "http://arkd:7071/v1/admin/wallet/seed" |
        jq -ce --rawfile password <(printf '%s' "$password") 'select(.seed | length > 0) | {seed, $password}' |
        http_curl -H 'Content-Type: application/json' --data-binary @- "http://arkd:7071/v1/admin/wallet/create" >/dev/null ||
        fail "operator wallet creation failed"
    fi
    status=$(http_curl "http://arkd:7071/v1/admin/wallet/status")
    if ! jq -e '.unlocked == true' <<<"$status" >/dev/null; then
      jq -cn --rawfile password <(printf '%s' "$password") '{$password}' |
        http_curl -H 'Content-Type: application/json' --data-binary @- "http://arkd:7071/v1/admin/wallet/unlock" >/dev/null || true
    fi
    unset password
    http_curl "http://arkd:7071/v1/admin/wallet/status" |
      jq -c '{initialized, unlocked, synced}'
    ;;

  admin-set-zero-fees)
    printf '%s\n' '{"fees":{"offchainInputFee":"0.0","onchainInputFee":"0.0","offchainOutputFee":"0.0","onchainOutputFee":"0.0"}}' |
      http_curl -H 'Content-Type: application/json' --data-binary @- "http://arkd:7071/v1/admin/intentFees" >/dev/null
    ;;

  state-init)
    [[ -d "$STATE_DIR" && ! -L "$STATE_DIR" ]] || fail "invalid state directory"
    chmod 0700 "$STATE_DIR"
    [[ -O "$STATE_DIR" && $(stat -c '%a' "$STATE_DIR") == 700 ]] || fail "state directory must be owned by arklab with mode 0700"
    mkdir -p -- "$FUNDING_DIR"
    chmod 0700 "$FUNDING_DIR"
    ;;

  op-funding-slot-read)
    [[ $# == 1 && "$1" =~ ^(0[1-9]|1[0-9]|2[01])$ ]] || fail "invalid funding slot"
    file="$FUNDING_DIR/$1"
    if [[ ! -e "$file" && ! -L "$file" ]]; then
      exit 2
    fi
    [[ -f "$file" && ! -L "$file" && -O "$file" && $(stat -c '%a' "$file") == 600 ]] ||
      fail "unsafe operator funding intent for slot $1"
    cat -- "$file"
    ;;

  op-funding-slot-reserve)
    [[ $# == 2 && "$1" =~ ^(0[1-9]|1[0-9]|2[01])$ && "$2" == bcrt1* ]] || fail "invalid funding slot reservation"
    mkdir -p -- "$FUNDING_DIR"
    chmod 0700 "$FUNDING_DIR"
    file="$FUNDING_DIR/$1"
    (set -o noclobber; printf '%s\n' "$2" > "$file") && chmod 0600 "$file" && sync -f "$file" ||
      fail "cannot durably reserve operator funding slot $1"
    ;;

  e2e-claim)
    [[ ! -L "$STATE_DIR" && ! -L "$E2E_DIR" ]] || fail "symlink in e2e state path"
    mkdir -- "$E2E_DIR" 2>/dev/null || fail "fixture already claimed; inspect original state, never repeat funding"
    chmod 0700 "$E2E_DIR"
    mkdir -- "$E2E_DIR/fixture" "$EVIDENCE_DIR"
    chmod 0700 "$E2E_DIR/fixture" "$EVIDENCE_DIR"
    ;;

  e2e-fence)
    [[ $# == 1 ]] || fail "usage: e2e-fence <name>"
    validate_fence_name "$1"
    payload=$(cat)
    file="$E2E_DIR/$1"
    (set -o noclobber; printf '%s\n' "$payload" > "$file") && chmod 0600 "$file" && sync -f "$file" ||
      fail "cannot durably write e2e fence $1"
    ;;

  e2e-write-evidence)
    [[ $# == 1 ]] || fail "usage: e2e-write-evidence <name>"
    validate_evidence_name "$1"
    payload=$(cat)
    jq -e 'type == "object"' <<<"$payload" >/dev/null || fail "evidence $1 must be a JSON object"
    assert_no_sensitive_tokens "$payload"
    mkdir -p -- "$EVIDENCE_DIR"
    tmp=$(mktemp "$EVIDENCE_DIR/.tmp.XXXXXXXX")
    printf '%s\n' "$payload" | jq '.' > "$tmp"
    mv -- "$tmp" "$EVIDENCE_DIR/$1"
    ;;

  e2e-read-evidence)
    [[ $# == 1 ]] || fail "usage: e2e-read-evidence <name>"
    validate_evidence_name "$1"
    file="$EVIDENCE_DIR/$1"
    [[ -f "$file" && ! -L "$file" ]] || fail "missing evidence file $1"
    payload=$(cat -- "$file")
    jq -e 'type == "object"' <<<"$payload" >/dev/null || fail "invalid evidence JSON in $1"
    assert_no_sensitive_tokens "$payload"
    printf '%s\n' "$payload"
    ;;

  e2e-stage-set)
    [[ $# == 2 ]] || fail "usage: e2e-stage-set <stage> <status>"
    file="$EVIDENCE_DIR/matrix.json"
    [[ -f "$file" && ! -L "$file" ]] || fail "missing matrix.json"
    tmp=$(mktemp "$EVIDENCE_DIR/.matrix.XXXXXXXX")
    jq --arg stage "$1" --arg status "$2" '.stages[$stage]=$status' "$file" > "$tmp"
    mv -- "$tmp" "$file"
    ;;

  e2e-matrix-merge)
    [[ $# == 1 ]] || fail "usage: e2e-matrix-merge <key>"
    [[ "$1" =~ ^[a-z0-9_]+$ ]] || fail "invalid matrix key"
    file="$EVIDENCE_DIR/matrix.json"
    [[ -f "$file" && ! -L "$file" ]] || fail "missing matrix.json"
    payload=$(cat)
    jq -e 'type == "object"' <<<"$payload" >/dev/null || fail "merge value must be a JSON object"
    assert_no_sensitive_tokens "$payload"
    tmp=$(mktemp "$EVIDENCE_DIR/.matrix.XXXXXXXX")
    jq --arg key "$1" --argjson val "$payload" '.[$key]=$val' "$file" > "$tmp"
    mv -- "$tmp" "$file"
    ;;

  *)
    fail "unknown subcommand: $cmd"
    ;;
esac
