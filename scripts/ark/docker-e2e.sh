#!/usr/bin/env bash
# Thin host orchestrator for the fully Dockerized Arkade Rust SDK regtest lab.
# Host prerequisites: POSIX/Bash shell + Docker Engine/Compose v2 (or Podman +
# podman-compose). No host Rust/Cargo, jq, curl, openssl, ss, docker.sock mount,
# host networking, or host port bindings are required.
set -euo pipefail
umask 077

root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)
project=swap-engine-ark-docker-e2e
compose_file="$root/deploy/ark/docker-compose.docker-e2e.yml"
state="$root/data/ark/docker-e2e"
env_file="$state/compose.env"
export_dir="$state/evidence"
owner_label=io.swap-engine.ark.worktree
lab_label=io.swap-engine.ark.lab
genesis=0f9188f13cb7b2c71f2a335e3a4fc328bf5beb436012afca590b1a11466e2206

services=(bitcoin postgres nbxplorer fulcrum mempool_mariadb mempool_api redis arkd_wallet arkd_signer arkd sdk)
compose_services=(bitcoin postgres nbxplorer fulcrum mempool_api redis arkd-wallet arkd-signer arkd ark-sdk)
volumes=(bitcoin_data postgres_data nbxplorer_data fulcrum_data mariadb_data mempool_cache wallet_data arkd_data sdk_state)

fail() {
  printf 'Ark docker-e2e: %s\n' "$*" >&2
  exit 1
}

# Never hand the lifecycle flock FD to container-engine subprocesses.
docker() { command docker "$@" 9>&-; }

setup_engine() {
  local version endpoint
  command -v docker >/dev/null || fail "missing docker CLI"
  unset DOCKER_HOST DOCKER_CONTEXT CONTAINER_HOST CONTAINER_CONNECTION PODMAN_HOST
  version=$(docker compose version) || fail "Docker Compose unavailable"
  compose_prefix=(docker compose)
  if [[ "$version" == *podman-compose* ]]; then
    compose_prefix+=(--in-pod false)
  else
    endpoint=$(docker context inspect --format '{{.Endpoints.docker.Host}}') || fail "cannot inspect Docker context"
    [[ "$endpoint" == unix:///* ]] || fail "Docker context must use a local Unix socket"
  fi
  docker info --format '{{.ServerVersion}}' >/dev/null || fail "local container engine unavailable"
  unset ARK_LAB_WORKTREE ARK_LAB_RPC_PASSWORD ARK_LAB_DB_PASSWORD ARK_LAB_SIGNER_KEY ARK_LAB_WALLET_PASSWORD
}

setup_state() {
  [[ ! -L "$root/data" && ! -L "$root/data/ark" && ! -L "$state" ]] || fail "symlink in lab state path"
  mkdir -p -- "$root/data" "$root/data/ark" "$state"
  chmod 0700 "$root/data/ark" "$state"
  [[ -O "$state" && $(stat -c '%a' "$state") == 700 ]] || fail "$state must be owned by you with mode 0700"
  if command -v flock >/dev/null; then
    [[ ! -L "$state/lifecycle.lock" ]] || fail "symlink in lab lock path"
    exec 9>"$state/lifecycle.lock"
    flock -n 9 || fail "another docker-e2e command is active"
  fi
}

rand_hex32() {
  if command -v od >/dev/null && [[ -r /dev/urandom ]]; then
    od -An -tx1 -N32 /dev/urandom | tr -d ' \t\r\n'
  elif command -v openssl >/dev/null; then
    openssl rand -hex 32
  else
    fail "cannot generate random lab credentials (need /dev/urandom+od or openssl)"
  fi
}

assert_owner() {
  local kind=$1 name=$2 listing format existing owner lab
  case "$kind" in
    container)
      listing=$(docker ps -a --format '{{.Names}}')
      format="{{index .Config.Labels \"$owner_label\"}}|{{index .Config.Labels \"$lab_label\"}}"
      ;;
    network)
      listing=$(docker network ls --format '{{.Name}}')
      format="{{index .Labels \"$owner_label\"}}|{{index .Labels \"$lab_label\"}}"
      ;;
    volume)
      listing=$(docker volume ls --format '{{.Name}}')
      format="{{index .Labels \"$owner_label\"}}|{{index .Labels \"$lab_label\"}}"
      ;;
  esac || fail "cannot list local $kind objects"
  while IFS= read -r existing; do
    [[ "$existing" == "$name" ]] || continue
    owner=$(docker "$kind" inspect --format "$format" "$name") || fail "cannot inspect $kind $name"
    lab=${owner#*|}
    owner=${owner%%|*}
    [[ "$owner" == "$root" && "$lab" == "docker-e2e" ]] ||
      fail "refusing to use foreign $kind $name"
    return 0
  done <<<"$listing"
}

assert_resources() {
  local name members
  assert_owner network swap_engine_ark_e2e_net
  for name in "${services[@]}"; do assert_owner container "ark_e2e_$name"; done
  for name in "${volumes[@]}"; do assert_owner volume "swap_engine_ark_e2e_$name"; done
  members=$(docker ps -a --filter "label=com.docker.compose.project=$project" --format '{{.Names}}')
  while IFS= read -r name; do
    [[ -z "$name" ]] && continue
    [[ " ${services[*]/#/ark_e2e_} " == *" $name "* ]] ||
      fail "unexpected container $name in project $project"
  done <<<"$members"
}

require_env() {
  local line key val seen=""
  local expected_keys="ARK_LAB_WORKTREE ARK_LAB_RPC_PASSWORD ARK_LAB_DB_PASSWORD ARK_LAB_WALLET_PASSWORD ARK_LAB_SIGNER_KEY"
  [[ ! -L "$root/data" && ! -L "$root/data/ark" && ! -L "$state" ]] || fail "symlink in lab state path"
  [[ -f "$env_file" && ! -L "$env_file" && -O "$env_file" &&
     $(stat -c '%a' "$env_file") == 600 && $(stat -c '%h' "$env_file") == 1 ]] ||
    fail "missing or unsafe $env_file; start creates it on a fresh lab"
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

compose_build_env() {
  ARK_LAB_WORKTREE="$root" \
  ARK_LAB_RPC_PASSWORD="" \
  ARK_LAB_DB_PASSWORD="" \
  ARK_LAB_WALLET_PASSWORD="" \
  ARK_LAB_SIGNER_KEY="" \
    "${compose_prefix[@]}" -p "$project" -f "$compose_file" "$@"
}

require_running() {
  local name running
  running=$(docker ps --filter "label=$owner_label=$root" --filter "label=$lab_label=docker-e2e" --format '{{.Names}}')
  for name in "${services[@]}"; do
    [[ "$name" == mempool_mariadb ]] && continue
    grep -Fxq "ark_e2e_$name" <<<"$running" || fail "ark_e2e_$name not running"
  done
}

# Internal container helpers: all execution happens inside the private lab network
# against ownership-validated container names (avoids per-call Compose YAML startup overhead).
sdk() {
  docker exec -i ark_e2e_sdk /workspace/ark/scripts/sdk-entrypoint.sh "$@"
}

sdk_jq() {
  docker exec -i ark_e2e_sdk /workspace/ark/scripts/sdk-entrypoint.sh jq "$@"
}

lab_normal() {
  sdk cli "$@"
}

lab_e2e() {
  sdk cli --e2e-fixture "$@"
}

core() {
  docker exec -i ark_e2e_bitcoin sh -ec '
    password=$(printf "%s\n" "$BITCOIN_EXTRA_ARGS" | sed -n "s/^rpcpassword=//p")
    exec bitcoin-cli -regtest -rpcuser=ark-lab -rpcpassword="$password" "$@"
  ' sh "$@"
}

miner() {
  core -rpcwallet=ark-lab-miner "$@"
}

wait_for() {
  local description=$1
  shift
  local i
  for ((i=0; i<90; i++)); do
    if "$@" >/dev/null 2>&1; then return 0; fi
    sleep 2
  done
  fail "timed out waiting for $description"
}

validate_chain() {
  local chain block0
  chain=$(core getblockchaininfo | sdk_jq -er '.chain')
  block0=$(core getblockhash 0)
  [[ "$chain" == regtest && "$block0" == "$genesis" ]] ||
    fail "unexpected Core chain ($chain) or genesis ($block0)"
}

validate_indexers() {
  local tip height e_tip e_height
  tip=$(core getbestblockhash) && height=$(core getblockcount) &&
    e_tip=$(sdk http-get esplora /blocks/tip/hash) &&
    e_height=$(sdk http-get esplora /blocks/tip/height) &&
    [[ "$e_tip" == "$tip" && "$e_height" == "$height" ]] &&
    sdk http-get nbxplorer /v1/cryptos/BTC/status |
      sdk_jq -e --argjson height "$height" \
        '.isFullySynched == true and .networkType == "Regtest" and .syncHeight == $height' >/dev/null
}

valid_wallet() {
  sdk http-get arkd-admin /v1/admin/wallet/status |
    sdk_jq -e '.initialized and .unlocked and .synced' >/dev/null
}

valid_operator() {
  sdk http-get arkd /v1/info |
    sdk_jq -e '.network == "regtest" and (.signerPubkey | length > 0)' >/dev/null
}

signer_ready() {
  sdk http-get signer /healthz >/dev/null
}

wallet_total() {
  sdk http-get arkd-admin /v1/admin/wallet/balance |
    sdk_jq -er '[.mainAccount.available, .mainAccount.locked] | map(tonumber) | add'
}

mine_blocks() {
  local count=$1 address
  address=$(miner getnewaddress) || return 1
  miner generatetoaddress "$count" "$address" >/dev/null
  wait_for "indexers after mining" validate_indexers
}

confirmed_utxo() {
  local txid=$1 vout=$2 sats=$3 response
  response=$(core gettxout "$txid" "$vout") || return
  sdk_jq -se --argjson sats "$sats" '
    select(length == 1) | .[0] |
    select(type == "object" and length > 0 and
      (.confirmations | type == "number" and . >= 1) and
      (.value | type == "number" and (. * 1e8 | round) == $sats))' <<<"$response"
}

miner_history() {
  local filter=$1 key=$2 page length skip=0
  while :; do
    page=$(miner listtransactions '*' 1000 "$skip" false) || return
    length=$(sdk_jq -ser '
      select(length == 1) | .[0] |
      select(type == "array" and length <= 1000 and all(.[]; type == "object" and (.category | type == "string"))) |
      length' <<<"$page") || return
    sdk_jq -c --arg key "$key" "$filter" <<<"$page" || return
    if (( length < 1000 )); then break; fi
    skip=$((skip + length))
  done
}

bootstrap_operator_funding() {
  local prefix=ark-lab-operator-bootstrap
  local history legacy count i slot match expected address txid balance unconfirmed=0 sent rc

  history=$(miner_history '.[] | select((.comment // "") | startswith($key))' "$prefix") ||
    fail "cannot reconcile operator funding history"
  history=$(sdk_jq -cse --arg prefix "$prefix" '
    select(all(.[];
      (.comment == $prefix or (.comment | test("^" + $prefix + "-(0[1-9]|1[0-9]|2[01])$"))) and
      .category == "send" and .amount == -1 and .abandoned == false and
      (.txid | test("^[0-9a-f]{64}$")) and (.address | startswith("bcrt1")) and
      (.confirmations | type == "number" and . >= 0))) |
    select(length == (map(.txid) | unique | length) and length <= 21)
  ' <<<"$history") || fail "ambiguous operator funding in miner wallet; no funds sent"
  legacy=$(sdk_jq -er --arg prefix "$prefix" '[.[] | select(.comment == $prefix)] | length' <<<"$history")
  count=$(sdk_jq -er 'length' <<<"$history")

  for ((i=1; i<=21; i++)); do
    printf -v slot '%02d' "$i"
    match=$(sdk_jq -ce --arg comment "$prefix-$slot" '[.[] | select(.comment == $comment)]' <<<"$history")
    rc=0
    expected=$(sdk op-funding-slot-read "$slot") || rc=$?
    if (( i <= legacy || i > count )); then
      [[ "$rc" == 2 && "$match" == '[]' ]] ||
        fail "unresolved operator funding slot $slot; reconcile original, never re-fund"
      continue
    fi
    [[ "$rc" == 0 && "$expected" == bcrt1* ]] &&
      sdk_jq -e --arg address "$expected" 'length == 1 and .[0].address == $address' <<<"$match" >/dev/null ||
      fail "ambiguous operator funding slot $slot; no funds sent"
  done

  while IFS= read -r txid; do
    [[ -n "$txid" ]] || continue
    core getmempoolentry "$txid" >/dev/null ||
      fail "original operator funding is not in active chain or mempool"
    unconfirmed=1
  done <<<"$(sdk_jq -r '.[] | select(.confirmations == 0) | .txid' <<<"$history")"

  if (( count == 0 )); then
    balance=$(wallet_total) || fail "cannot establish operator wallet balance"
    sdk_jq -e 'type == "number" and . >= 0' <<<"$balance" >/dev/null ||
      fail "cannot establish operator wallet balance"
    if sdk_jq -e '. > 0' <<<"$balance" >/dev/null; then return 0; fi
    sent=$(miner_history '.[] | select(.category == "send") | .txid' "$prefix") ||
      fail "cannot establish fresh operator funding history"
    [[ -z "$sent" ]] || fail "operator bootstrap history is ambiguous; no funds sent"
  fi

  if (( count < 21 )); then
    address=$(sdk http-get arkd-admin /v1/admin/wallet/address |
      sdk_jq -er '.address | select(startswith("bcrt1"))') ||
      fail "cannot obtain regtest operator address"
    core validateaddress "$address" | sdk_jq -e '.isvalid == true' >/dev/null ||
      fail "invalid operator funding address"
    for ((i=count+1; i<=21; i++)); do
      printf -v slot '%02d' "$i"
      sdk op-funding-slot-reserve "$slot" "$address" ||
        fail "cannot durably reserve operator funding slot $slot; no send attempted"
      txid=$(miner sendtoaddress "$address" 1 "$prefix-$slot") ||
        fail "uncertain operator funding slot $slot; reconcile original, never re-fund"
      [[ "$txid" =~ ^[0-9a-f]{64}$ ]] ||
        fail "ambiguous operator funding slot $slot; reconcile original, never re-fund"
      unconfirmed=1
    done
  fi

  if (( unconfirmed == 1 )); then
    mine_blocks 1
  fi
}

report_status() {
  local tip height op wallet balance db sdk_info
  require_running
  validate_chain
  validate_indexers || fail "NBXplorer or Esplora not synced"
  db=$(docker exec -i ark_e2e_postgres psql -U postgres -Atc \
    "SELECT count(*) FROM pg_database WHERE datname IN ('nbxplorer','projection','event')")
  [[ "$db" == 3 ]] || fail "missing lab databases"
  [[ $(docker exec -i ark_e2e_redis redis-cli --raw ping) == PONG ]] || fail "Redis unavailable"
  signer_ready || fail "signer is not healthy"
  valid_wallet || fail "operator wallet not ready"
  valid_operator || fail "operator unavailable or wrong network"
  height=$(core getblockcount)
  tip=$(core getbestblockhash)
  wallet=$(sdk http-get arkd-admin /v1/admin/wallet/status)
  balance=$(sdk http-get arkd-admin /v1/admin/wallet/balance)
  op=$(sdk http-get arkd /v1/info)
  sdk_info=$(sdk info)
  sdk_jq -n \
    --arg project "$project" \
    --arg network "swap_engine_ark_e2e_net (internal)" \
    --arg genesis "$genesis" \
    --arg tip "$tip" \
    --argjson height "$height" \
    --argjson op "$op" \
    --argjson wallet "$wallet" \
    --argjson balance "$balance" \
    --argjson sdk "$sdk_info" \
    '{project:$project, network:$network,
      core:{chain:"regtest", $genesis, $height, bestBlockHash:$tip},
      indexers:"synced", postgres:"ready", redis:"ready", signer:"healthy",
      sdk:$sdk,
      operator:($op | {network, signerPubkey, forfeitPubkey, forfeitAddress,
                       sessionDuration, unilateralExitDelay, boardingExitDelay, dust, version}),
      wallet:($wallet | {initialized, unlocked, synced}),
      operatorBalanceBtc:$balance}'
}

cmd_build() {
  setup_engine
  printf '=== Building Docker Arkade Rust SDK image (project: %s) ===\n' "$project"
  docker --version
  docker compose version
  compose_build_env build ark-sdk
  printf '=== SDK image metadata ===\n'
  docker run --rm --network none --user 1000:1000 --cap-drop ALL \
    --security-opt no-new-privileges:true swap-engine-ark-sdk:local info
}

cmd_unit() {
  setup_engine
  printf '=== Running offline unit & contract suite inside ark-sdk container (--network none) ===\n'
  docker run --rm --network none --user 1000:1000 --cap-drop ALL \
    --security-opt no-new-privileges:true swap-engine-ark-sdk:local unit
}

cmd_start() {
  setup_engine
  setup_state
  assert_resources

  if [[ ! -e "$env_file" && ! -L "$env_file" ]]; then
    [[ -z $(docker ps -a --filter "label=$owner_label=$root" --filter "label=$lab_label=docker-e2e" --format '{{.Names}}') &&
       -z $(docker volume ls --filter "label=$owner_label=$root" --filter "label=$lab_label=docker-e2e" --format '{{.Name}}') ]] ||
      fail "restore $env_file from your private backup before starting"
    local tmp name value
    tmp=$(mktemp "$state/compose.env.XXXXXXXX")
    {
      printf 'ARK_LAB_WORKTREE=%s\n' "$root"
      for name in RPC_PASSWORD DB_PASSWORD WALLET_PASSWORD SIGNER_KEY; do
        value=$(rand_hex32)
        [[ "$value" =~ ^[a-f0-9]{64}$ ]] || fail "generated invalid credential format"
        printf 'ARK_LAB_%s=%s\n' "$name" "$value"
      done
    } >"$tmp"
    chmod 0600 "$tmp"
    mv -- "$tmp" "$env_file"
  fi
  require_env

  compose up -d --no-recreate bitcoin postgres ark-sdk >&2
  wait_for "ark-sdk container" sdk info
  sdk state-init
  wait_for "Bitcoin Core RPC" core getblockchaininfo
  validate_chain
  if ! core listwallets | sdk_jq -e 'index("ark-lab-miner") != null' >/dev/null; then
    if core listwalletdir | sdk_jq -e '.wallets | any(.name == "ark-lab-miner")' >/dev/null; then
      core loadwallet ark-lab-miner true >/dev/null
    else
      core -named createwallet wallet_name=ark-lab-miner load_on_startup=true >/dev/null
    fi
  fi
  local height address
  height=$(core getblockcount)
  if (( height < 101 )); then
    address=$(miner getnewaddress)
    miner generatetoaddress "$((101 - height))" "$address" >/dev/null
  fi
  wait_for "PostgreSQL" docker exec -i ark_e2e_postgres pg_isready -h 127.0.0.1 -U postgres

  compose up -d --no-recreate nbxplorer fulcrum mempool_api >&2
  wait_for "regtest indexers" validate_indexers

  compose up -d --no-recreate redis arkd-signer arkd-wallet arkd >&2
  wait_for "operator admin API" sdk http-get arkd-admin /v1/admin/wallet/status

  local password
  password=$(sed -n 's/^ARK_LAB_WALLET_PASSWORD=//p' "$env_file")
  [[ "$password" =~ ^[a-f0-9]{64}$ ]] || fail "invalid operator wallet credential"
  printf '%s\n' "$password" | sdk admin-wallet-init >/dev/null
  unset password

  wait_for "operator wallet sync" valid_wallet
  wait_for "regtest operator" valid_operator

  bootstrap_operator_funding
  funded() { wallet_total | sdk_jq -e '. > 0'; }
  wait_for "funded operator wallet" funded

  sdk admin-set-zero-fees || fail "cannot set regtest intent fees"
  wait_for "indexers after bootstrap" validate_indexers
  wait_for "signer health check" signer_ready
  report_status
}

cmd_status() {
  setup_engine
  require_env
  assert_resources
  report_status
}

cmd_wallets() {
  setup_engine
  setup_state
  require_env
  assert_resources
  require_running
  validate_chain
  valid_operator || fail "operator unavailable"

  local init_out addr_out bal_out vtxo_out res_a res_b
  init_out=$(lab_normal init-wallets)
  addr_out=$(lab_normal addresses)
  [[ "$init_out" == "$addr_out" ]] || fail "normal wallet addresses changed between init and query"
  bal_out=$(lab_normal balance)
  vtxo_out=$(lab_normal list-vtxos)
  res_a=$(lab_normal restore alice)
  res_b=$(lab_normal restore bob)
  sdk_jq -n \
    --argjson addresses "$addr_out" \
    --argjson balance "$bal_out" \
    --argjson vtxos "$vtxo_out" \
    --argjson restore_alice "$res_a" \
    --argjson restore_bob "$res_b" \
    '{scope:"normal persistent wallets A/B (separate from E2E fixture)",
      addresses:$addresses.wallets,
      balance:$balance.wallets,
      vtxos:$vtxos.wallets,
      restore:{alice:$restore_alice.wallets.alice.entries_found, bob:$restore_bob.wallets.bob.entries_found}}'
}

cmd_integration() {
  setup_engine
  require_env
  assert_resources
  require_running
  validate_chain
  valid_operator || fail "operator unavailable"
  sdk integration
}

export_public_evidence() {
  local dest=${1:-$export_dir} name
  [[ ! -L "$dest" ]] || fail "refusing symlink export dir"
  mkdir -p -- "$dest"
  for name in matrix.json boarding.json transfer.json offboard.json renewal.json restart.json; do
    if sdk e2e-read-evidence "$name" > "$dest/$name.tmp" 2>/dev/null; then
      mv -- "$dest/$name.tmp" "$dest/$name"
    else
      rm -f -- "$dest/$name.tmp"
    fi
  done
}

cmd_e2e() {
  setup_engine
  setup_state
  assert_resources
  require_env
  require_running
  validate_chain
  validate_indexers || fail "indexers must be synchronized"
  valid_operator || fail "local regtest operator unavailable"
  valid_wallet || fail "operator wallet not ready"

  sdk e2e-claim

  local matrix_init
  matrix_init=$(sdk_jq -n --arg genesis "$genesis" --arg project "$project" '
    {network:"regtest", project:$project, $genesis, source:"live isolated docker-e2e stack",
      stages:{
        boarding:"PENDING",
        boarding_operator_outage:"PENDING",
        transfer_and_client_restart:"PENDING",
        cooperative_offboard:"PENDING",
        stale_vtxo_and_renewal:"PENDING",
        adapter_arkd_read:"PENDING",
        operator_unavailable:"PENDING",
        operator_restart:"PENDING",
        rpc_unavailable:"PENDING",
        indexer_unavailable:"PENDING",
        unilateral_exit:"SKIPPED",
        live_mutation_timeout:"SKIPPED"}}')
  printf '%s\n' "$matrix_init" | sdk e2e-write-evidence matrix.json

  e2e_stage=""
  e2e_stopped=""
  finish_e2e() {
    local rc=$?
    if [[ -n "${e2e_stopped:-}" ]]; then
      docker start "$e2e_stopped" >/dev/null || rc=1
    fi
    if (( rc != 0 )) && [[ -n "${e2e_stage:-}" ]]; then
      sdk e2e-stage-set "$e2e_stage" FAILED >/dev/null 2>&1 || true
      printf '[stage] %s -> FAILED (exit %s)\n' "$e2e_stage" "$rc" >&2
    fi
    export_public_evidence "$export_dir" || true
    sdk e2e-read-evidence matrix.json || true
    exit "$rc"
  }
  trap finish_e2e EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM

  stop_service() {
    e2e_stopped=$1
    docker stop -t 30 "$e2e_stopped" >/dev/null
  }
  resume_service() {
    docker start "$e2e_stopped" >/dev/null
    e2e_stopped=""
  }
  mark_stage() {
    sdk e2e-stage-set "$1" "$2"
    printf '[stage] %-28s -> %s\n' "$1" "$2" >&2
  }

  expect_lab_error() {
    local pattern=$1 output rc=0
    shift
    output=$(lab_e2e "$@" 2>&1) || rc=$?
    [[ "$rc" == 1 && "$output" == "$pattern"* ]] ||
      fail "expected $pattern for $1 (exit $rc, got: $output)"
  }

  in_mempool() { core getmempoolentry "$1" >/dev/null; }

  confirmed_tx() {
    local txid=$1 block height tx
    tx=$(core getrawtransaction "$txid" 2)
    block=$(sdk_jq -er 'select(.confirmations >= 1) | .blockhash' <<<"$tx")
    height=$(core getblockheader "$block" | sdk_jq -er '.height')
    sdk_jq -ce --argjson height "$height" '
      select(.fee != null) |
      {txid, blockhash, height:$height, locktime, fee_sats:(.fee * 1e8 | round)}' <<<"$tx"
  }

  funding_preflight() {
    local address=$1 amount_sats=$2 minimum=$3
    [[ "$address" == bcrt1p* ]] || return 1
    core validateaddress "$address" | sdk_jq -e '.isvalid == true' >/dev/null || return 1
    (( amount_sats >= minimum )) || return 1
    miner getbalances | sdk_jq -e --argjson amount "$amount_sats" \
      '(.mine.trusted * 1e8 | round) > $amount' >/dev/null
  }

  assert_only_boarding_funding() {
    local address=$1 txid=$2 rows
    rows=$(miner_history '.[] | select(.category == "send" and .address == $key)' "$address") ||
      fail "cannot reconcile original boarding funding"
    sdk_jq -se --arg tx "$txid" 'length == 1 and
      (.[0] | .txid == $tx and .comment == "ark-lab-e2e-boarding" and
        .amount == -0.002 and .confirmations >= 1 and .abandoned == false)' <<<"$rows" >/dev/null
  }

  # --- Stage 1 & 2: Boarding + boarding operator outage ---
  e2e_stage=boarding
  local addresses addr dust before funding raw vout boarding_input funding_proof
  local result commitment batch_proof after leaf alice_input
  addresses=$(lab_e2e init-wallets)
  addr=$(sdk_jq -er '.wallets.alice.boarding[0]' <<<"$addresses")
  dust=$(sdk http-get arkd /v1/info | sdk_jq -er '.dust | tonumber')
  before=$(lab_e2e balance alice)
  sdk_jq -e '.wallets.alice.total_sats == 0' <<<"$before" >/dev/null
  if funding_preflight "$addr" 1 "$dust" ||
     funding_preflight "$addr" 2100000000000000 "$dust" ||
     funding_preflight '1BitcoinEaterAddressDontSendf59kuE' 200000 "$dust"; then
    fail "invalid funding preflight accepted"
  fi
  funding_preflight "$addr" 200000 "$dust"
  sdk_jq -nc --arg addr "$addr" '{address:$addr, amount_sats:200000}' |
    sdk e2e-fence funding-intent.json
  funding=$(miner sendtoaddress "$addr" 0.002 ark-lab-e2e-boarding)
  [[ "$funding" =~ ^[0-9a-f]{64}$ ]] || fail "ambiguous funding; reconcile original, never re-fund"
  printf '%s\n' "$funding" | sdk e2e-fence funding-txid
  mine_blocks 1
  raw=$(core getrawtransaction "$funding" 1)
  vout=$(sdk_jq -er --arg addr "$addr" '[.vout[] | select(.scriptPubKey.address == $addr and .value == 0.002)] |
    select(length == 1) | .[0].n' <<<"$raw")
  boarding_input="$funding:$vout"
  funding_proof=$(confirmed_tx "$funding")
  confirmed_utxo "$funding" "$vout" 200000 >/dev/null
  assert_only_boarding_funding "$addr" "$funding"

  e2e_stage=boarding_operator_outage
  stop_service ark_e2e_arkd
  expect_lab_error ArkOperatorUnavailable board alice "$boarding_input"
  confirmed_utxo "$funding" "$vout" 200000 >/dev/null
  assert_only_boarding_funding "$addr" "$funding"
  resume_service
  wait_for "operator after boarding outage" valid_operator
  wait_for "operator wallet after boarding outage" valid_wallet
  confirmed_utxo "$funding" "$vout" 200000 >/dev/null

  result=$(lab_e2e board alice "$boarding_input")
  commitment=$(sdk_jq -er '.wallets.alice.commitment_txid' <<<"$result")
  wait_for "boarding commitment in Core mempool" in_mempool "$commitment"
  mine_blocks 1
  batch_proof=$(confirmed_tx "$commitment")
  core getrawtransaction "$commitment" 1 |
    sdk_jq -e --arg funding "$funding" --argjson vout "$vout" \
      'any(.vin[]; .txid == $funding and .vout == $vout)' >/dev/null
  assert_only_boarding_funding "$addr" "$funding"
  mark_stage boarding_operator_outage PASSED

  e2e_stage=boarding
  after=$(lab_e2e balance alice)
  leaf=$(lab_e2e list-vtxos alice | sdk_jq -ce --arg tx "$commitment" '
    [.wallets.alice[] | select(.origin == "batch_leaf" and (.is_spent | not) and
      (.commitment_txids | index($tx)))] | select(length == 1) | .[0]')
  alice_input=$(sdk_jq -er '.outpoint' <<<"$leaf")
  sdk_jq -e '.wallets.alice.confirmed_sats == 200000' <<<"$after" >/dev/null
  lab_e2e board alice "$boarding_input" | sdk_jq -e '.wallets.alice.commitment_txid == null' >/dev/null
  sdk_jq -n --arg input "$boarding_input" --arg address "$addr" \
    --argjson funding "$funding_proof" --argjson commitment "$batch_proof" \
    --argjson vtxo "$leaf" --argjson before "$before" --argjson after "$after" \
    '{network:"regtest",$input,$address,$funding,$commitment,$vtxo,
      before_sats:$before.wallets.alice.total_sats,
      after_sats:$after.wallets.alice.total_sats,
      boarding_fee_sats:(200000 - $after.wallets.alice.total_sats),
      invalid_funding_preflight:"PASSED",same_input_retry:"PASSED",
      operator_unavailable:"PASSED",funding_transactions_to_address:1,
      reconciled_original_input:$input}' | sdk e2e-write-evidence boarding.json
  mark_stage boarding PASSED

  # --- Stage 3: Ark transfer A -> B + ack loss / client restart ---
  e2e_stage=transfer_and_client_restart
  local pending ark_txid spent_check rows alice_spent alice_change bob_vtxo bob_input
  before=$(lab_e2e balance)
  sdk_jq -e '.wallets | .alice.confirmed_sats == 200000 and .bob.total_sats == 0' <<<"$before" >/dev/null
  expect_lab_error ArkInvalidAmount transfer-submit "$alice_input" 500000
  lab_e2e pending | sdk_jq -e '.wallets.alice.pending_ark_txids == []' >/dev/null
  # Discard submit acknowledgement; recover original TXID from a fresh process.
  lab_e2e transfer-submit "$alice_input" 75000 >/dev/null
  pending=$(lab_e2e pending)
  ark_txid=$(sdk_jq -er '.wallets.alice.pending_ark_txids | select(length == 1) |
    .[0] | select(test("^[0-9a-f]{64}$"))' <<<"$pending")
  printf '%s\n' "$ark_txid" | sdk e2e-fence ark-txid
  lab_e2e transfer-finalize "$ark_txid" | sdk_jq -e '.wallets.alice.finalize_attempted == true' >/dev/null
  lab_e2e pending | sdk_jq -e '.wallets.alice.pending_ark_txids == []' >/dev/null
  lab_e2e transfer-finalize "$ark_txid" | sdk_jq -e '.wallets.alice.finalize_attempted == false' >/dev/null
  spent_check=$(lab_e2e verify-spent "$alice_input")
  sdk_jq -e '.wallets.alice | .spent == true and .spendable == false' <<<"$spent_check" >/dev/null
  after=$(lab_e2e balance)
  sdk_jq -e --argjson before "$before" '.wallets |
    .alice.pre_confirmed_sats == 125000 and .bob.pre_confirmed_sats == 75000 and
    ($before.wallets.alice.total_sats - .alice.total_sats == 75000) and
    (.bob.total_sats - $before.wallets.bob.total_sats == 75000)' <<<"$after" >/dev/null
  rows=$(lab_e2e list-vtxos)
  alice_spent=$(sdk_jq -ce --arg input "$alice_input" --arg tx "$ark_txid" \
    '[.wallets.alice[] | select(.is_spent and .ark_txid == $tx)] |
    select(length == 1 and .[0].outpoint == $input) | .[0]' <<<"$rows")
  alice_change=$(sdk_jq -ce --arg tx "$ark_txid" '
    [.wallets.alice[] | select(.outpoint | startswith($tx + ":"))] | select(length == 1) |
    .[0] | select(.amount_sats == 125000 and .origin == "ark_transfer" and (.is_spent | not))' <<<"$rows")
  bob_vtxo=$(sdk_jq -ce --arg tx "$ark_txid" '
    [.wallets.bob[] | select(.outpoint | startswith($tx + ":"))] | select(length == 1) |
    .[0] | select(.amount_sats == 75000 and .origin == "ark_transfer" and (.is_spent | not))' <<<"$rows")
  bob_input=$(sdk_jq -er '.outpoint' <<<"$bob_vtxo")
  [[ "$(lab_e2e balance)" == "$after" && "$(lab_e2e list-vtxos)" == "$rows" ]] || fail "restart snapshot changed"
  sdk_jq -n --arg tx "$ark_txid" --argjson before "$before" --argjson after "$after" \
    --argjson input "$alice_spent" --argjson change "$alice_change" --argjson received "$bob_vtxo" '
    {network:"regtest",protocol:"Ark (not Lightning)",ark_txid:$tx,
      finality:"finalized preconfirmation, not a Bitcoin confirmation",
      before:$before.wallets, after:$after.wallets, $input, $change, $received,
      fee_sats:(([$before.wallets[].total_sats] | add) - ([$after.wallets[].total_sats] | add)),
      submit_ack_discarded:true, original_txid_recovered_from_pending:true,
      inputs_consumed:1, recipient_credits:1, spent_input_read_only:"PASSED",
      finalize_retry:"PASSED", client_restart:"PASSED", insufficient_input:"PASSED"}' |
    sdk e2e-write-evidence transfer.json
  mark_stage transfer_and_client_restart PASSED

  # --- Stage 4: Cooperative offboarding confirmed on Bitcoin Core ---
  e2e_stage=cooperative_offboard
  local ob_addr descriptor tx bitcoin_before bitcoin_after params ob_output ob_vout spent change
  ob_addr=$(lab_e2e addresses bob | sdk_jq -er '.wallets.bob.onchain')
  before=$(lab_e2e balance bob)
  sdk_jq -e '.wallets.bob.total_sats == 75000' <<<"$before" >/dev/null
  descriptor=$(sdk_jq -nc --arg addr "$ob_addr" '["addr("+$addr+")"]')
  tx=$(core scantxoutset start "$descriptor")
  bitcoin_before=$(sdk_jq -ser 'select(length == 1) | .[0] | select(.success == true) |
    .total_amount | select(type == "number" and . == 0)' <<<"$tx")
  expect_lab_error ArkNetworkMismatch offboard-coop "$bob_input" 1BitcoinEaterAddressDontSendf59kuE 30000
  expect_lab_error ArkInvalidAmount offboard-coop "$bob_input" "$ob_addr" 100000
  expect_lab_error ArkInvalidAmount offboard-coop "$bob_input" "$ob_addr" 74800
  params=$(sdk http-get arkd /v1/info | sdk_jq -ce '{unilateralExitDelay,boardingExitDelay,fees}')
  result=$(lab_e2e offboard-coop "$bob_input" "$ob_addr" 30000)
  commitment=$(sdk_jq -er '.wallets.bob.commitment_txid' <<<"$result")
  printf '%s\n' "$commitment" | sdk e2e-fence offboard-txid
  wait_for "offboarding commitment in Core mempool" in_mempool "$commitment"
  mine_blocks 1
  tx=$(core getrawtransaction "$commitment" 1)
  ob_output=$(sdk_jq -ce --arg addr "$ob_addr" '[.vout[] | select(.scriptPubKey.address == $addr and .value == 0.0003)] |
    select(length == 1) | .[0] | {vout:.n, amount_sats:(.value * 1e8 | round)}' <<<"$tx")
  ob_vout=$(sdk_jq -er .vout <<<"$ob_output")
  confirmed_utxo "$commitment" "$ob_vout" 30000 >/dev/null
  tx=$(core scantxoutset start "$descriptor")
  bitcoin_after=$(sdk_jq -ser --arg tx "$commitment" --argjson vout "$ob_vout" '
    select(length == 1) | .[0] |
    select(.success == true and (.unspents | length == 1 and .[0].txid == $tx and .[0].vout == $vout)) |
    .total_amount | select(type == "number") | . * 1e8 | round | select(. == 30000)' <<<"$tx")
  after=$(lab_e2e balance bob)
  sdk_jq -e '.wallets.bob.confirmed_sats == 45000 and .wallets.bob.total_sats == 45000' <<<"$after" >/dev/null
  rows=$(lab_e2e list-vtxos bob)
  spent=$(sdk_jq -ce --arg input "$bob_input" --arg tx "$commitment" '
    .wallets.bob[] | select(.outpoint == $input and .settled_by == $tx)' <<<"$rows")
  change=$(sdk_jq -ce --arg tx "$commitment" '.wallets.bob[] | select(.origin == "batch_leaf" and
    (.is_spent | not) and .amount_sats == 45000 and (.commitment_txids | index($tx)))' <<<"$rows")
  sdk_jq -n --arg address "$ob_addr" --argjson commitment "$(confirmed_tx "$commitment")" \
    --argjson output "$ob_output" --argjson spent "$spent" --argjson change "$change" \
    --argjson before "$before" --argjson after "$after" --argjson params "$params" \
    --argjson bitcoin_before_sats "$bitcoin_before" --argjson bitcoin_after_sats "$bitcoin_after" '
    {network:"regtest",method:"cooperative",$address,$commitment,$output,$spent,$change,$params,
      ark_before_sats:$before.wallets.bob.total_sats,ark_after_sats:$after.wallets.bob.total_sats,
      $bitcoin_before_sats,$bitcoin_after_sats,
      user_fee_sats:($before.wallets.bob.total_sats - $after.wallets.bob.total_sats - ($bitcoin_after_sats - $bitcoin_before_sats)),
      wrong_network:"PASSED",insufficient_input:"PASSED",sub_dust_change:"PASSED",unilateral_exit:"SKIPPED"}' |
    sdk e2e-write-evidence offboard.json
  mark_stage cooperative_offboard PASSED

  # --- Stage 5: Stale VTXO rejection and renewal ---
  e2e_stage=stale_vtxo_and_renewal
  local old block renewed
  old=$(sdk e2e-read-evidence transfer.json | sdk_jq -er '.change.outpoint')
  is_stale() {
    lab_e2e list-vtxos alice | sdk_jq -e --arg old "$old" \
      'any(.wallets.alice[]; .outpoint == $old and .is_expired and (.is_spent | not))' >/dev/null
  }
  wait_for "Alice's VTXO to become stale (SDK expiry)" is_stale
  expect_lab_error ArkInputNotSpendable transfer-submit "$old" 75000
  result=$(lab_e2e settle-vtxo alice "$old")
  commitment=$(sdk_jq -er '.wallets.alice.commitment_txid' <<<"$result")
  wait_for "renewal commitment in Core mempool" in_mempool "$commitment"
  mine_blocks 1
  block=$(confirmed_tx "$commitment")
  rows=$(lab_e2e list-vtxos alice)
  sdk_jq -e --arg old "$old" --arg tx "$commitment" 'any(.wallets.alice[];
     .outpoint == $old and .is_spent and .settled_by == $tx)' <<<"$rows" >/dev/null
  renewed=$(sdk_jq -ce --arg tx "$commitment" '.wallets.alice[] | select(
    .origin == "batch_leaf" and .amount_sats == 125000 and (.is_spent | not) and (.commitment_txids | index($tx)))' <<<"$rows")
  sdk_jq -n --arg old "$old" --argjson commitment "$block" --argjson renewed "$renewed" \
    '{source:"live",stale_rejection:"PASSED",stale_vtxo:$old,$commitment,$renewed}' |
    sdk e2e-write-evidence renewal.json
  mark_stage stale_vtxo_and_renewal PASSED

  # --- Stage 6: Live SDK read integration test against arkd (#54/PR #63) ---
  e2e_stage=adapter_arkd_read
  if sdk has-integration-test; then
    sdk integration >&2
    mark_stage adapter_arkd_read PASSED
  else
    mark_stage adapter_arkd_read SKIPPED
  fi

  # --- Stage 7 & 8: Operator outage + funded operator restart persistence ---
  e2e_stage=operator_unavailable
  local balance_before balance_after rows_before rows_after
  restart_snapshot_ready() {
    lab_e2e list-vtxos | sdk_jq -e '.wallets | all(.alice, .bob;
      [.[] | select(.is_spent | not)] | length == 1 and .[0].is_expired)' >/dev/null
  }
  wait_for "stable fixture balances after VTXO expiry" restart_snapshot_ready
  balance_before=$(lab_e2e balance | sdk_jq -ceS '.wallets')
  rows_before=$(lab_e2e list-vtxos | sdk_jq -ceS '.wallets')
  sdk_jq -e '.alice.recoverable_sats == 125000 and .alice.total_sats == 125000 and
    .bob.recoverable_sats == 45000 and .bob.total_sats == 45000' <<<"$balance_before" >/dev/null
  sdk_jq -e '(.alice | length) > 0 and (.bob | length) > 0' <<<"$rows_before" >/dev/null
  stop_service ark_e2e_arkd
  expect_lab_error ArkOperatorUnavailable offboard-coop "$bob_input" "$ob_addr" 30000
  mark_stage operator_unavailable PASSED

  e2e_stage=operator_restart
  resume_service
  wait_for "operator restart" valid_operator
  wait_for "operator wallet restart" valid_wallet
  balance_after=$(lab_e2e balance | sdk_jq -ceS '.wallets')
  rows_after=$(lab_e2e list-vtxos | sdk_jq -ceS '.wallets')
  [[ "$balance_before" == "$balance_after" ]] || fail "wallet balances changed across operator restart"
  [[ "$rows_before" == "$rows_after" ]] || fail "VTXOs changed across operator restart"
  sdk_jq -n --argjson balance "$balance_after" --argjson vtxos "$rows_after" \
    '{balances_unchanged:true, vtxos_unchanged:true, $balance, $vtxos}' |
    sdk e2e-matrix-merge operator_restart
  mark_stage operator_restart PASSED

  # --- Stage 9: Core RPC outage ---
  e2e_stage=rpc_unavailable
  stop_service ark_e2e_bitcoin
  if core getblockchaininfo >/dev/null 2>&1; then fail "expected dedicated Core RPC to fail"; fi
  resume_service
  wait_for "Core restart" core getblockchaininfo
  validate_chain
  wait_for "indexers after Core restart" validate_indexers
  mark_stage rpc_unavailable PASSED

  # --- Stage 10: Esplora indexer outage ---
  e2e_stage=indexer_unavailable
  stop_service ark_e2e_mempool_api
  expect_lab_error ArkIndexerUnavailable offboard-coop "$bob_input" "$ob_addr" 30000
  resume_service
  wait_for "Esplora restart" validate_indexers
  mark_stage indexer_unavailable PASSED

  e2e_stage=""
}

cmd_stop() {
  setup_engine
  setup_state
  assert_resources
  [[ -e "$env_file" ]] || exit 0
  require_env
  local existing i name
  existing=$(docker ps --filter "label=$owner_label=$root" --filter "label=$lab_label=docker-e2e" --format '{{.Names}}')
  for ((i=${#services[@]}-1; i>=0; i--)); do
    name="ark_e2e_${services[i]}"
    if grep -Fxq "$name" <<<"$existing"; then
      docker stop -t 30 "$name" >/dev/null
    fi
  done
  local remaining
  remaining=$(docker ps --filter "label=$owner_label=$root" --filter "label=$lab_label=docker-e2e" --format '{{.Names}}')
  [[ -z "$remaining" ]] || fail "owned containers still running after stop: $remaining"
  printf 'Stopped all owned containers for %s (non-destructive; containers and volumes preserved).\n' "$project"
}

cmd_restart_check() {
  setup_engine
  require_env
  assert_resources
  require_running

  local status_before status_after normal_before normal_after e2e_bal_before e2e_bal_after
  local e2e_vtxo_before e2e_vtxo_after cids_before cids_after vols_before vols_after

  restart_e2e_stable() {
    lab_e2e list-vtxos | sdk_jq -e '.wallets | all(.alice, .bob;
      [.[] | select(.is_spent | not)] | length == 1 and .[0].is_expired)' >/dev/null
  }
  wait_for "stable post-expiry fixture snapshot" restart_e2e_stable

  status_before=$(report_status | sdk_jq -ceS '.')
  normal_before=$(sdk_jq -n \
    --argjson addr "$(lab_normal addresses)" \
    --argjson bal "$(lab_normal balance)" \
    --argjson vtxo "$(lab_normal list-vtxos)" \
    '{addresses:$addr.wallets, balance:$bal.wallets, vtxos:$vtxo.wallets}' | sdk_jq -ceS '.')
  e2e_bal_before=$(lab_e2e balance | sdk_jq -ceS '.wallets')
  e2e_vtxo_before=$(lab_e2e list-vtxos | sdk_jq -ceS '.wallets')
  cids_before=$(docker ps -a --filter "label=$owner_label=$root" --filter "label=$lab_label=docker-e2e" \
    --format '{{.Names}}={{.ID}}' | sort)
  vols_before=$(docker volume ls --filter "label=$owner_label=$root" --filter "label=$lab_label=docker-e2e" \
    --format '{{.Name}}' | sort)

  # Full non-destructive stack stop and restart via subshell calls so locks release cleanly.
  bash "$0" stop
  bash "$0" start >/dev/null

  status_after=$(report_status | sdk_jq -ceS '.')
  normal_after=$(sdk_jq -n \
    --argjson addr "$(lab_normal addresses)" \
    --argjson bal "$(lab_normal balance)" \
    --argjson vtxo "$(lab_normal list-vtxos)" \
    '{addresses:$addr.wallets, balance:$bal.wallets, vtxos:$vtxo.wallets}' | sdk_jq -ceS '.')
  e2e_bal_after=$(lab_e2e balance | sdk_jq -ceS '.wallets')
  e2e_vtxo_after=$(lab_e2e list-vtxos | sdk_jq -ceS '.wallets')
  cids_after=$(docker ps -a --filter "label=$owner_label=$root" --filter "label=$lab_label=docker-e2e" \
    --format '{{.Names}}={{.ID}}' | sort)
  vols_after=$(docker volume ls --filter "label=$owner_label=$root" --filter "label=$lab_label=docker-e2e" \
    --format '{{.Name}}' | sort)

  [[ "$status_before" == "$status_after" ]] || fail "stack status changed across full restart"
  [[ "$normal_before" == "$normal_after" ]] || fail "normal wallets A/B changed across full restart"
  [[ "$e2e_bal_before" == "$e2e_bal_after" ]] || fail "E2E fixture balances changed across full restart"
  [[ "$e2e_vtxo_before" == "$e2e_vtxo_after" ]] || fail "E2E fixture VTXOs changed across full restart"
  [[ "$cids_before" == "$cids_after" ]] || fail "container IDs changed across full restart (recreation occurred)"
  [[ "$vols_before" == "$vols_after" ]] || fail "volumes changed across full restart"

  local report
  report=$(sdk_jq -n \
    --argjson status "$status_after" \
    --argjson normal "$normal_after" \
    --argjson e2e_balances "$e2e_bal_after" \
    --argjson e2e_vtxos "$e2e_vtxo_after" \
    --arg cids "$cids_after" \
    --arg vols "$vols_after" \
    '{full_stack_restart:"PASSED",
      status_unchanged:true,
      normal_wallets_unchanged:true,
      e2e_balances_unchanged:true,
      e2e_vtxos_unchanged:true,
      container_ids_unchanged:true,
      volumes_unchanged:true,
      core_height:$status.core.height,
      core_tip:$status.core.bestBlockHash,
      operator_signer:$status.operator.signerPubkey,
      operator_balance_btc:$status.operatorBalanceBtc,
      normal_wallets:$normal,
      e2e_balances:$e2e_balances,
      e2e_vtxo_counts:{alice:($e2e_vtxos.alice | length), bob:($e2e_vtxos.bob | length)},
      volumes:($vols | split("\n") | map(select(length > 0))),
      containers:($cids | split("\n") | map(select(length > 0)))}')
  printf '%s\n' "$report" | sdk e2e-write-evidence restart.json
  export_public_evidence "$export_dir"
  printf '%s\n' "$report"
}

cmd_export() {
  setup_engine
  require_env
  assert_resources
  require_running
  export_public_evidence "${1:-$export_dir}"
  printf 'Exported sanitized public evidence JSONs to %s\n' "${1:-$export_dir}"
}

case "${1:-}" in
  build) shift; [[ $# == 0 ]] || fail "usage: docker-e2e.sh build"; cmd_build ;;
  unit) shift; [[ $# == 0 ]] || fail "usage: docker-e2e.sh unit"; cmd_unit ;;
  start) shift; [[ $# == 0 ]] || fail "usage: docker-e2e.sh start"; cmd_start ;;
  status) shift; [[ $# == 0 ]] || fail "usage: docker-e2e.sh status"; cmd_status ;;
  wallets) shift; [[ $# == 0 ]] || fail "usage: docker-e2e.sh wallets"; cmd_wallets ;;
  e2e) shift; [[ $# == 0 ]] || fail "usage: docker-e2e.sh e2e"; cmd_e2e ;;
  integration) shift; [[ $# == 0 ]] || fail "usage: docker-e2e.sh integration"; cmd_integration ;;
  restart-check) shift; [[ $# == 0 ]] || fail "usage: docker-e2e.sh restart-check"; cmd_restart_check ;;
  stop) shift; [[ $# == 0 ]] || fail "usage: docker-e2e.sh stop"; cmd_stop ;;
  export-evidence) shift; cmd_export "$@" ;;
  *)
    fail "usage: docker-e2e.sh <build|unit|start|status|wallets|e2e|integration|restart-check|stop|export-evidence>"
    ;;
esac
