#!/usr/bin/env bash
set -euo pipefail
umask 077

root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)
project=swap-engine-ark-regtest
compose_file="$root/deploy/ark/docker-compose.regtest.yml"
state="$root/data/ark"
env_file="$state/compose.env"
owner_label=io.swap-engine.ark.worktree
genesis=0f9188f13cb7b2c71f2a335e3a4fc328bf5beb436012afca590b1a11466e2206
api=http://127.0.0.1:37070/v1/info
admin=http://127.0.0.1:37071/v1/admin
explorer=http://127.0.0.1:33000/api
nbx=http://127.0.0.1:32838/v1/cryptos/BTC/status
services=(bitcoin postgres nbxplorer fulcrum mempool_mariadb mempool_api redis arkd_wallet arkd_signer arkd)
host_services=(bitcoin nbxplorer mempool_api arkd)
# The API now serves Esplora directly. Recognize the old proxy only for
# ownership checks and shutdown on existing labs; never start or require it.
managed_services=("${services[@]}" mempool_web)
volumes=(bitcoin_data postgres_data nbxplorer_data fulcrum_data mariadb_data mempool_cache wallet_data arkd_data)

fail() { printf 'Ark regtest: %s\n' "$*" >&2; exit 1; }

# Podman subprocesses can outlive Compose; never hand them the flock FD.
docker() { command docker "$@" 9>&-; }

setup_engine() {
  local tool version endpoint
  for tool in docker curl jq ss flock; do command -v "$tool" >/dev/null || fail "missing $tool"; done
  unset DOCKER_HOST DOCKER_CONTEXT CONTAINER_HOST CONTAINER_CONNECTION PODMAN_HOST
  version=$(docker compose version) || fail "Compose unavailable"
  compose_prefix=(docker compose)
  if [[ "$version" == *podman-compose* ]]; then
    compose_prefix+=(--in-pod false)
  else
    endpoint=$(docker context inspect --format '{{.Endpoints.docker.Host}}') || fail "cannot inspect Docker context"
    [[ "$endpoint" == unix:///* ]] || fail "Docker context must use a local Unix socket"
  fi
  docker info --format '{{.ServerVersion}}' >/dev/null || fail "local engine unavailable"
  unset ARK_LAB_WORKTREE ARK_LAB_RPC_PASSWORD ARK_LAB_DB_PASSWORD ARK_LAB_SIGNER_KEY ARK_LAB_WALLET_PASSWORD
}

setup_state() {
  [[ ! -L "$root/data" && ! -L "$state" ]] || fail "symlink in lab state path"
  mkdir -p -- "$state"
  [[ -O "$state" && $(stat -c '%a' "$state") == 700 ]] || fail "$state must be owned by you with mode 0700"
  [[ ! -L "$state/lifecycle.lock" ]] || fail "symlink in lab lock path"
  exec 9>"$state/lifecycle.lock"
  flock -n 9 || fail "another lab command is active"
}

assert_owner() {
  local kind=$1 name=$2 listing format existing owner
  case "$kind" in
    container) listing=$(docker ps -a --format '{{.Names}}'); format="{{index .Config.Labels \"$owner_label\"}}" ;;
    network) listing=$(docker network ls --format '{{.Name}}'); format="{{index .Labels \"$owner_label\"}}" ;;
    volume) listing=$(docker volume ls --format '{{.Name}}'); format="{{index .Labels \"$owner_label\"}}" ;;
  esac || fail "cannot list local $kind objects"
  while IFS= read -r existing; do
    [[ "$existing" == "$name" ]] || continue
    owner=$(docker "$kind" inspect --format "$format" "$name") || fail "cannot inspect $kind $name"
    [[ "$owner" == "$root" ]] || fail "refusing to use foreign $kind $name"
    return 0
  done <<<"$listing"
}

assert_resources() {
  local name members
  assert_owner network swap_engine_ark_net
  assert_owner network swap_engine_ark_host_net
  for name in "${managed_services[@]}"; do assert_owner container "ark_lab_$name"; done
  for name in "${volumes[@]}"; do assert_owner volume "swap_engine_ark_$name"; done
  members=$(docker ps -a --filter "label=com.docker.compose.project=$project" --format '{{.Names}}')
  while IFS= read -r name; do
    [[ -z "$name" ]] && continue
    [[ " ${managed_services[*]/#/ark_lab_} " == *" $name "* ]] ||
      fail "unexpected container $name in project $project"
  done <<<"$members"
}

# --no-recreate intentionally preserves existing containers. Detect a
# pre-split lab before treating its loopback endpoints as ready.
assert_host_networks() {
  local mode name existing networks
  mode=$1
  existing=$(docker ps -a --format '{{.Names}}') || fail "cannot list lab containers"
  for name in "${host_services[@]/#/ark_lab_}"; do
    if ! grep -Fxq "$name" <<<"$existing"; then
      [[ "$mode" == existing ]] && continue
      fail "$name is missing"
    fi
    networks=$(docker container inspect --format \
      '{{range $name, $_ := .NetworkSettings.Networks}}{{println $name}}{{end}}' "$name") ||
      fail "cannot inspect lab networks for $name"
    grep -Fxq swap_engine_ark_host_net <<<"$networks" &&
      grep -Fxq swap_engine_ark_net <<<"$networks" ||
      fail "$name requires the host bridge migration in docs/ark/operator-regtest.md"
  done
}

require_env() {
  local line key val seen=""
  local expected_keys="ARK_LAB_WORKTREE ARK_LAB_RPC_PASSWORD ARK_LAB_DB_PASSWORD ARK_LAB_WALLET_PASSWORD ARK_LAB_SIGNER_KEY"
  [[ ! -L "$root/data" && ! -L "$state" ]] || fail "symlink in lab state path"
  [[ -f "$env_file" && ! -L "$env_file" && -O "$env_file" &&
     $(stat -c '%a' "$env_file") == 600 && $(stat -c '%h' "$env_file") == 1 ]] ||
    fail "missing or unsafe $env_file; bootstrap creates it on a fresh lab"
  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ -z "$line" || "$line" == \#* ]] && continue
    [[ "$line" == *=* ]] || fail "malformed entry in $env_file"
    key=${line%%=*}
    val=${line#*=}
    case "$key" in
      ARK_LAB_WORKTREE)
        [[ "$val" == "$root" ]] || fail "mismatched worktree in $env_file"
        ;;
      ARK_LAB_RPC_PASSWORD|ARK_LAB_DB_PASSWORD|ARK_LAB_WALLET_PASSWORD|ARK_LAB_SIGNER_KEY)
        [[ "$val" =~ ^[a-f0-9]{64}$ ]] || fail "invalid credential format for $key in $env_file"
        ;;
      *)
        fail "unexpected key $key in $env_file"
        ;;
    esac
    [[ " $seen " != *" $key "* ]] || fail "duplicate key $key in $env_file"
    seen="$seen $key"
  done <"$env_file"
  for key in $expected_keys; do
    [[ " $seen " == *" $key "* ]] || fail "missing $key in $env_file"
  done
}

compose() {
  "${compose_prefix[@]}" -p "$project" -f "$compose_file" --env-file "$env_file" "$@"
}

check_ports() {
  local port name mapping running
  running=$(docker ps --filter "label=$owner_label=$root" --format '{{.Names}}')
  for mapping in 38443:bitcoin 32838:nbxplorer 33000:mempool_api 37070:arkd 37071:arkd; do
    port=${mapping%:*}
    name="ark_lab_${mapping#*:}"
    if grep -Fxq "$name" <<<"$running"; then continue; fi
    [[ -z "$(ss -Hln "sport = :$port")" ]] || fail "lab port $port already in use"
  done
}

require_running() {
  local name running
  running=$(docker ps --filter "label=$owner_label=$root" --format '{{.Names}}')
  for name in "${services[@]}"; do
    [[ "$name" == mempool_mariadb ]] && continue
    grep -Fxq "ark_lab_$name" <<<"$running" || fail "ark_lab_$name not running"
  done
}

core() {
  compose exec -T bitcoin sh -ec '
    password=$(printf "%s\n" "$BITCOIN_EXTRA_ARGS" | sed -n "s/^rpcpassword=//p")
    exec bitcoin-cli -regtest -rpcuser=ark-lab -rpcpassword="$password" "$@"
  ' sh "$@"
}

miner() { core -rpcwallet=ark-lab-miner "$@"; }

# Core permits an empty response for a spent/unknown outpoint. Require
# exactly one nonempty, confirmed UTXO and propagate an actual RPC failure.
confirmed_utxo() {
  local txid=$1 vout=$2 sats=$3 response
  response=$(core gettxout "$txid" "$vout") || return
  jq -se --argjson sats "$sats" '
    select(length == 1) | .[0] |
    select(type == "object" and length > 0 and
      (.confirmations | type == "number" and . >= 1) and
      (.value | type == "number" and (. * 1e8 | round) == $sats))' <<<"$response"
}

# Inspect all wallet pages, including abandoned/conflicted rows. Callers must
# decide what is safe; do not turn RPC or schema failures into an empty list.
miner_history() {
  local filter=$1 key=$2 page length skip=0
  while :; do
    page=$(miner listtransactions '*' 1000 "$skip" false) || return
    length=$(jq -ser '
      select(length == 1) | .[0] |
      select(type == "array" and length <= 1000 and all(.[]; type == "object" and (.category | type == "string"))) |
      length' <<<"$page") || return
    jq -c --arg key "$key" "$filter" <<<"$page" || return
    if (( length < 1000 )); then break; fi
    skip=$((skip + length))
  done
}

http() { curl -q --noproxy '*' --silent --fail --max-time 5 "$@"; }
admin_get() { http "$admin/$1"; }
admin_post() {
  http -H 'Content-Type: application/json' --data-binary @- "$admin/$1" >/dev/null
}

wait_for() {
  local description=$1
  shift
  local i
  for ((i=0; i<90; i++)); do
    if "$@" >/dev/null 2>&1; then return; fi
    sleep 2
  done
  fail "timed out waiting for $description"
}

validate_chain() {
  [[ $(core getblockchaininfo | jq -er '.chain') == regtest &&
     $(core getblockhash 0) == "$genesis" ]] || fail "unexpected Core chain or genesis"
}

validate_indexers() {
  local tip height
  tip=$(core getbestblockhash) && height=$(core getblockcount) &&
    [[ $(http "$explorer/blocks/tip/hash") == "$tip" &&
       $(http "$explorer/blocks/tip/height") == "$height" ]] &&
    http "$nbx" | jq -e --argjson height "$height" \
      '.isFullySynched == true and .networkType == "Regtest" and .syncHeight == $height' >/dev/null
}

valid_wallet() {
  admin_get wallet/status | jq -e '.initialized and .unlocked and .synced' >/dev/null
}

valid_operator() {
  http "$api" | jq -e '.network == "regtest" and (.signerPubkey | length > 0)' >/dev/null
}

signer_ready() {
  # Query the real endpoint from the operator's network namespace. Some
  # engine/image combinations do not import the Dockerfile HEALTHCHECK.
  compose exec -T arkd wget -q --spider -T 5 http://arkd-signer:6061/healthz
}

wallet_total() {
  admin_get wallet/balance | jq -er '[.mainAccount.available, .mainAccount.locked] | map(tonumber) | add'
}

report_status() {
  local tip height op wallet balance db
  require_running
  assert_host_networks all
  validate_chain
  validate_indexers || fail "NBXplorer or Esplora not synced"
  db=$(compose exec -T postgres psql -U postgres -Atc \
    "SELECT count(*) FROM pg_database WHERE datname IN ('nbxplorer','projection','event')")
  [[ "$db" == 3 ]] || fail "missing lab databases"
  [[ $(compose exec -T redis redis-cli --raw ping) == PONG ]] || fail "Redis unavailable"
  signer_ready || fail "signer is not healthy"
  valid_wallet || fail "operator wallet not ready"
  valid_operator || fail "operator unavailable or wrong network"
  height=$(core getblockcount)
  tip=$(core getbestblockhash)
  wallet=$(admin_get wallet/status)
  balance=$(admin_get wallet/balance)
  op=$(http "$api")
  jq -n --arg genesis "$genesis" --arg tip "$tip" --argjson height "$height" \
    --arg endpoint "$api" --argjson op "$op" --argjson wallet "$wallet" --argjson balance "$balance" \
    '{core:{chain:"regtest", $genesis, $height, bestBlockHash:$tip},
      indexers:"synced", postgres:"ready", redis:"ready", signer:"healthy",
      operator:($op | {network, signerPubkey, forfeitPubkey, forfeitAddress,
                       sessionDuration, unilateralExitDelay, boardingExitDelay, dust, version}),
      $endpoint, $wallet, operatorBalanceBtc:$balance}'
}
