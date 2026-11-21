#!/usr/bin/env bash
source "$(dirname -- "${BASH_SOURCE[0]}")/common.sh"
setup_engine
setup_state
assert_resources
assert_host_networks existing
check_ports

if [[ ! -e "$env_file" && ! -L "$env_file" ]]; then
  # A lost env file must not rotate existing operator credentials.
  [[ -z $(docker ps -a --filter "label=$owner_label=$root" --format '{{.Names}}') &&
     -z $(docker volume ls --filter "label=$owner_label=$root" --format '{{.Name}}') ]] ||
    fail "restore $env_file from your private backup before starting"
  command -v openssl >/dev/null || fail "missing openssl"
  tmp=$(mktemp "$state/compose.env.XXXXXXXX")
  {
    printf 'ARK_LAB_WORKTREE=%s\n' "$root"
    for name in RPC_PASSWORD DB_PASSWORD WALLET_PASSWORD SIGNER_KEY; do
      value=$(openssl rand -hex 32) || fail "cannot generate lab credentials"
      printf 'ARK_LAB_%s=%s\n' "$name" "$value"
    done
  } >"$tmp"
  mv -- "$tmp" "$env_file"
fi
require_env

compose up -d --no-recreate bitcoin postgres >&2
wait_for "Bitcoin RPC" core getblockchaininfo
validate_chain
if ! core listwallets | jq -e 'index("ark-lab-miner") != null' >/dev/null; then
  if core listwalletdir | jq -e '.wallets | any(.name == "ark-lab-miner")' >/dev/null; then
    core loadwallet ark-lab-miner true >/dev/null
  else
    core -named createwallet wallet_name=ark-lab-miner load_on_startup=true >/dev/null
  fi
fi
mine() {
  local address
  address=$(miner getnewaddress) || return
  miner generatetoaddress "$1" "$address" >/dev/null
}
height=$(core getblockcount)
if ((height < 101)); then mine "$((101 - height))"; fi
wait_for "PostgreSQL" compose exec -T postgres pg_isready -h 127.0.0.1 -U postgres

compose up -d --no-recreate nbxplorer fulcrum mempool_api >&2
wait_for "regtest indexers" validate_indexers

compose up -d --no-recreate redis arkd-signer arkd-wallet arkd >&2
wait_for "operator admin API" admin_get wallet/status
password=$(sed -n 's/^ARK_LAB_WALLET_PASSWORD=//p' "$env_file")
[[ "$password" =~ ^[a-f0-9]{64}$ ]] || fail "invalid operator wallet credential"
wallet_status=$(admin_get wallet/status)
if ! jq -e '.initialized == true' <<<"$wallet_status" >/dev/null; then
  admin_get wallet/seed |
    jq -ce --rawfile password <(printf '%s' "$password") 'select(.seed | length > 0) | {seed, $password}' |
    admin_post wallet/create || fail "operator wallet creation failed"
fi
if ! admin_get wallet/status | jq -e '.unlocked == true' >/dev/null; then
  jq -cn --rawfile password <(printf '%s' "$password") '{$password}' | admin_post wallet/unlock ||
    # The env unlocker might win the race.
    wait_for "operator wallet unlock" valid_wallet
fi
unset password
wait_for "operator wallet sync" valid_wallet
wait_for "regtest operator" valid_operator

source "$root/scripts/ark/bootstrap-funding.sh"
bootstrap_funding
funded() { wallet_total | jq -e '. > 0'; }
wait_for "funded operator wallet" funded
printf '%s\n' '{"fees":{"offchainInputFee":"0.0","onchainInputFee":"0.0","offchainOutputFee":"0.0","onchainOutputFee":"0.0"}}' |
  admin_post intentFees || fail "cannot set regtest intent fees"
wait_for "indexers after bootstrap" validate_indexers
wait_for "signer health check" signer_ready
report_status
