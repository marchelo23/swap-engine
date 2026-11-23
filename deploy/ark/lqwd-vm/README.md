# LQWD VM Ark overlay

Status: prepared, not applied. The coordinator instructed no changes to the VM or
live Docker while LND is unsynced. This directory is an overlay plus a runbook
for the operator; it does not start anything by itself.

## Safety invariants

- No Bitcoin Core config change, no Core restart, no mining, no funding, no
  wallet mutation, no swap execution.
- The existing `swap-engine-ark-regtest` lab, its containers, volumes, networks,
  compose file and env file are not referenced or modified.
- New resources use the `swap-engine-ark-lqwd-vm` project and the
  `ark_lqwd_*` / `swap_engine_ark_lqwd_*` names by default. Every name is
  configurable in `compose.env`.
- Every new host port binds `127.0.0.1` by default.
- The only VM-side process is a loopback RPC gateway that reads the existing
  Core cookie and enforces a method allowlist.
- The SSH key can only forward the configured gateway and P2P loopback ports;
  it cannot run a shell.

## Verified read-only evidence

Observed on 2026-11-22. No VM or live Docker state was changed.

| Item | Value |
| --- | --- |
| Core chain | `regtest` |
| Core blocks | `195` |
| Core best block hash | `3cd3c4ff0a2285577dec6db74b9c57152f5a768f13abfbe32a12c54fa11b8335` |
| Core genesis hash | `0f9188f13cb7b2c71f2a335e3a4fc328bf5beb436012afca590b1a11466e2206` |
| Core initial block download | `false` |
| Core version | `320100` (`/Satoshi:32.1.0/`) |
| Core RPC bind | `127.0.0.1:18443` |
| Core P2P bind | `0.0.0.0:18444` |
| Core ZMQ | `28332` raw block, `28333` raw tx |
| Loaded wallet | `lqwd-lab` |
| VM destination | `truja@192.168.56.108` |
| VM user | `truja` uid `1000` |
| VM Node | `/usr/bin/node` `v22.22.1` |
| VM bitcoin-cli | `/usr/local/bin/bitcoin-cli` |
| VM listeners on 18446/37170/37171/33100/32938 | none |
| LND | coordinator reports height `205`, not syncing on an incomplete disk branch; not touched |

Existing lab baseline captured at `2026-11-22T23:17:33Z`:

| Container | ID | State |
| --- | --- | --- |
| `ark_lab_bitcoin` | `df5abebf5803` | Up |
| `ark_lab_postgres` | `85d7de98bf4a` | Up |
| `ark_lab_nbxplorer` | `bed45031392f` | Up |
| `ark_lab_fulcrum` | `077309ae696a` | Up |
| `ark_lab_mempool_api` | `cdb5159dabec` | Up |
| `ark_lab_redis` | `740b9abd3f9f` | Up |
| `ark_lab_arkd_wallet` | `c7e3dc076147` | Up |
| `ark_lab_arkd_signer` | `7c415c630761` | Up, healthy |
| `ark_lab_arkd` | `f3591e994ef4` | Up |

Baseline volumes: `swap_engine_ark_arkd_data`,
`swap_engine_ark_bitcoin_data`, `swap_engine_ark_fulcrum_data`,
`swap_engine_ark_mempool_cache`, `swap_engine_ark_nbxplorer_data`,
`swap_engine_ark_postgres_data`, `swap_engine_ark_wallet_data`.
Baseline networks: `swap_engine_ark_net`, `swap_engine_ark_host_net`.
The full snapshot is at
`C:\Users\rodri\AppData\Local\Temp\opencode\ark-lqwd-vm-baseline.json`.

### Re-verified on 2026-11-22 (read-only)

A later read-only pass over the same VM (no VM write, no container start or
stop) confirmed:

| Item | Value |
| --- | --- |
| Core chain | `regtest` |
| Core genesis | `0f9188f13cb7b2c71f2a335e3a4fc328bf5beb436012afca590b1a11466e2206` (unchanged) |
| Core tip at capture | height `206`, hash `17d85aaa7a82584929a3bc5dbaf39fd903a1b6abb42841dc53cc97b5db421291` |
| Core initial block download | `false` |
| Loaded Core wallet | `lqwd-lab` (descriptor, private keys enabled, no external signer) |
| Core wallet balance | trusted `4799.80739426` BTC, immature `3675.00032326` BTC |
| Core mempool | loaded, 2 transactions |
| VM listeners | only `127.0.0.1:18443` (RPC) and `0.0.0.0:18444` (P2P); no new-lab port was listening |
| Signer | remains a file-held lab secret; `signer-pubkey.mjs` derives the compressed pubkey to pin in `ARK_EXPECTED_SIGNER` |

The tip advanced between reads (`195` to `206`), so it is dynamic. Re-capture
`blocks` and `bestblockhash` immediately before starting the lab and before any
funding, and pass those exact values to the readiness check. Never reuse the
table's tip as a live expectation.

## Topology

```text
Windows / Docker Desktop
  ark_lqwd_tunnel --ssh--> VM 127.0.0.1:<gateway-port> (gateway) --> VM Core 127.0.0.1:<core-rpc-port>
                         VM 127.0.0.1:<p2p-port> (P2P)

  ark_lqwd_nbxplorer  --RPC--> tunnel:<tunnel-rpc-port>
  ark_lqwd_fulcrum    --RPC--> tunnel:<tunnel-rpc-port>
  ark_lqwd_mempool_api --RPC--> tunnel:<tunnel-rpc-port>, --electrum--> ark_lqwd_fulcrum:<fulcrum-port>
  ark_lqwd_arkd       --> ark_lqwd_mempool_api:<mempool-internal-port>/api,
                          ark_lqwd_nbxplorer:<nbxplorer-internal-port>,
                          ark_lqwd_postgres:<postgres-port>,
                          ark_lqwd_redis:<redis-port>,
                          ark_lqwd_arkd_wallet:<wallet-port>,
                          ark_lqwd_arkd_signer:<signer-port>

Host loopback only by default:
  127.0.0.1:<arkd-port>/<arkd-admin-port>  arkd
  127.0.0.1:<mempool-port>                 mempool API
  127.0.0.1:<nbxplorer-port>               NBXplorer
```

## Files

- `docker-compose.yml`: isolated project, no `bitcoin` service, no old lab
  resource names. Hosts, ports, paths, users, keys and destinations are
  variables with portable defaults.
- `Dockerfile.tunnel`: Alpine plus OpenSSH client and `nc`.
- `rpc-gateway.mjs`: loopback JSON-RPC gateway. Default profile `minimal` is
  exactly `getblockchaininfo`, `getrawtransaction`, `gettxout`. Profile
  `indexer-readonly` adds only the chain, mempool and index reads needed by the
  Ark indexers. It exposes no wallet RPCs, no `scantxoutset`, and no path other
  than `/`. It requires inbound Basic auth, rejects non-loopback bind/upstream
  addresses, caps request body, response size and time, and forwards a
  canonical re-serialization of the validated JSON-RPC objects. Secrets stay in
  files: the Core cookie is re-read from disk on every allowed request, the SSH
  key and `known_hosts` are bind-mounted read-only files, and the gateway's own
  credentials live only in a mode-600 env file on the VM. Nothing secret is
  baked into an image or a committed file.
- `verify-readiness.mjs`: exact-hash readiness check for Ark `/v1/info`,
  mempool tip and NBXplorer status.
- `signer-pubkey.mjs`: derives the compressed pubkey from the 32-byte signer
  key so the signer can be pinned before startup.
- `compose.env.example`: placeholders only. Copy it outside the repository and
  keep it mode 600.
- `gateway.env.example`: placeholders only for the VM-side gateway; copy it to a
  mode-600 file on the VM.

## Apply (operator, after approval)

Set the lab values once in this shell. The evidence table above records the
actual values; the overlay defaults and examples stay portable.

```powershell
$vmHost = '<vm-host>'
$vmUser = '<vm-user>'
$vm = "$vmUser@$vmHost"
$adminKey = '<path-to-admin-key>'
$gatewayPort = '<vm-gateway-port>'
$p2pPort = '<vm-p2p-port>'
$coreRpcPort = '<core-rpc-port>'
$dir = "$env:TEMP\ark-lqwd-vm"
```

For this lab the values were `truja@192.168.56.108`, gateway `18446`, P2P
`18444`, Core RPC `18443` and the administrative key
`C:/Users/rodri/.ssh/id_ed25519_swapvm`. Those are evidence, not defaults.

### 0. Capture the expected tip

```powershell
ssh -i $adminKey -o BatchMode=yes -o StrictHostKeyChecking=yes $vm "bitcoin-cli -regtest getblockchaininfo"
```

Use `blocks` and `bestblockhash` from that output as the expected height and
hash. Do not mine. If the tip advances between capture and readiness, capture
again and re-run the check.

### 1. Generate the restricted key and known_hosts

```powershell
New-Item -ItemType Directory -Force $dir | Out-Null
ssh-keygen -t ed25519 -N '""' -C 'ark-lqwd-vm-readonly' -f "$dir\ark_lqwd_vm_key"
ssh-keyscan -p 22 $vmHost 2>$null | Set-Content "$dir\known_hosts" -Encoding ascii
ssh-keygen -lf "$dir\known_hosts"
icacls "$dir\ark_lqwd_vm_key" /inheritance:r /grant:r "$env:USERNAME:(R)"
```

Verify the host-key fingerprint out-of-band before trusting `known_hosts`. Keep
the key outside the repository.

### 2. Authorize only the two forwards

```powershell
$pub = (Get-Content "$dir\ark_lqwd_vm_key.pub" -Raw).Trim()
$entry = 'restrict,port-forwarding,permitopen="127.0.0.1:' + $gatewayPort + '",permitopen="127.0.0.1:' + $p2pPort + '",command="/bin/false" ' + $pub
ssh -i $adminKey $vm "umask 077; mkdir -p ~/.ssh; touch ~/.ssh/authorized_keys; grep -qxF '$entry' ~/.ssh/authorized_keys || printf '%s\n' '$entry' >> ~/.ssh/authorized_keys"
```

Shell access must be denied:

```powershell
ssh -i "$dir\ark_lqwd_vm_key" -o BatchMode=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile="$dir\known_hosts" $vm true
```

Expect a non-zero exit and no command output. The compose tunnel uses `ssh -N`
and only the two `-L` forwards.

### 3. Start the gateway on the VM

Copy the script and the env template with the administrative key:

```powershell
ssh -i $adminKey $vm "mkdir -p ~/ark-lqwd-vm"
scp -i $adminKey deploy/ark/lqwd-vm/rpc-gateway.mjs "${vm}:~/ark-lqwd-vm/rpc-gateway.mjs"
scp -i $adminKey deploy/ark/lqwd-vm/gateway.env.example "${vm}:~/ark-lqwd-vm/gateway.env.example"
```

On the VM, create `~/ark-lqwd-vm/gateway.env` from the example and set the
profile, loopback ports, cookie path and inbound Basic auth. For the minimal
profile:

```bash
cp ~/ark-lqwd-vm/gateway.env.example ~/ark-lqwd-vm/gateway.env
chmod 600 ~/ark-lqwd-vm/gateway.env
```

Use these values for this lab; replace the placeholders in the file:

```dotenv
ARK_GATEWAY_PROFILE=minimal
ARK_GATEWAY_LISTEN_HOST=127.0.0.1
ARK_GATEWAY_LISTEN_PORT=<vm-gateway-port>
ARK_GATEWAY_UPSTREAM_HOST=127.0.0.1
ARK_GATEWAY_UPSTREAM_PORT=<core-rpc-port>
ARK_GATEWAY_COOKIE=<absolute-path-to-core-cookie>
ARK_GATEWAY_AUTH_USER=<gateway-user>
ARK_GATEWAY_AUTH_PASSWORD=<gateway-password>
```

The auth user and password must match `ARK_LQWD_GATEWAY_USER` and
`ARK_LQWD_GATEWAY_PASSWORD` in `compose.env`; the lab services already send
those Basic credentials. The gateway validates them and then injects the Core
cookie, so the lab credentials are never Core credentials. The gateway exits if
auth is missing, if either host is not `127.0.0.1`, or if the cookie is
unreadable.

Start the minimal profile first:

```bash
set -a
. ~/ark-lqwd-vm/gateway.env
set +a
nohup node ~/ark-lqwd-vm/rpc-gateway.mjs > ~/ark-lqwd-vm/gateway.log 2>&1 &
echo $! > ~/ark-lqwd-vm/gateway.pid
```

Verify on the VM:

```bash
curl -sS --user "${ARK_GATEWAY_AUTH_USER}:${ARK_GATEWAY_AUTH_PASSWORD}" \
  -H 'content-type: application/json' \
  --data '{"jsonrpc":"2.0","id":1,"method":"getblockchaininfo","params":[]}' \
  "http://127.0.0.1:${ARK_GATEWAY_LISTEN_PORT:-18446}/"
```

The result must show `chain: regtest`, `blocks: 195` and
`bestblockhash: 3cd3c4ff0a2285577dec6db74b9c57152f5a768f13abfbe32a12c54fa11b8335`
unless the tip has legitimately advanced. A disallowed method must be denied:

```bash
curl -sS --user "${ARK_GATEWAY_AUTH_USER}:${ARK_GATEWAY_AUTH_PASSWORD}" \
  -o /dev/null -w '%{http_code}\n' -H 'content-type: application/json' \
  --data '{"jsonrpc":"2.0","id":2,"method":"sendrawtransaction","params":["00"]}' \
  "http://127.0.0.1:${ARK_GATEWAY_LISTEN_PORT:-18446}/"
```

Expect `403`. The gateway logs method names and status only, never params or the
cookie.

For the Ark indexers, the broader read-only profile is required. Edit
`~/ark-lqwd-vm/gateway.env` so `ARK_GATEWAY_PROFILE=indexer-readonly`, then
restart:

```bash
kill "$(cat ~/ark-lqwd-vm/gateway.pid)" 2>/dev/null || true
set -a
. ~/ark-lqwd-vm/gateway.env
set +a
nohup node ~/ark-lqwd-vm/rpc-gateway.mjs > ~/ark-lqwd-vm/gateway.log 2>&1 &
echo $! > ~/ark-lqwd-vm/gateway.pid
```

`indexer-readonly` is still read-only but broader than the backend's minimal
list. Do not expose it to the backend; use `minimal` for the backend's checks.
If the coordinator requires the minimal profile only, do not start the Ark
indexers; the overlay is delivered but cannot fully sync.

### 4. Create compose.env outside the repository

```powershell
Copy-Item deploy/ark/lqwd-vm/compose.env.example "$dir\compose.env"
```

Edit `$dir\compose.env`:

- `ARK_LQWD_VM_SSH_TARGET=$vm`
- `ARK_LQWD_VM_KEY_PATH=<absolute-path-to-private-key>` with forward slashes,
  for example `C:/Users/<you>/AppData/Local/Temp/ark-lqwd-vm/ark_lqwd_vm_key`
- `ARK_LQWD_VM_KNOWN_HOSTS_PATH=<absolute-path-to-known-hosts>` with forward
  slashes
- `ARK_LQWD_VM_GATEWAY_PORT=$gatewayPort`
- `ARK_LQWD_VM_P2P_PORT=$p2pPort`
- Leave the tunnel listen ports and host bind at their portable defaults unless
  they conflict.
- Replace the three `replace-with-64-hex` values with independent random
  64-character lowercase hex strings.

Generate one value per run:

```powershell
-join ((1..64) | ForEach-Object { '{0:x}' -f (Get-Random -Maximum 16) })
```

```powershell
icacls "$dir\compose.env" /inheritance:r /grant:r "$env:USERNAME:(R,W)"
```

Derive the pinned signer pubkey before startup:

```powershell
node deploy/ark/lqwd-vm/signer-pubkey.mjs $signerKey
```

Set `ARK_EXPECTED_SIGNER` to that compressed pubkey. If it does not match
`/v1/info` after startup, stop; do not proceed.

### 5. Start the isolated lab

The project name comes from `ARK_LQWD_PROJECT_NAME` in `compose.env`.

```powershell
docker compose --env-file "$dir\compose.env" -f deploy/ark/lqwd-vm/docker-compose.yml build tunnel
docker compose --env-file "$dir\compose.env" -f deploy/ark/lqwd-vm/docker-compose.yml up -d
docker compose --env-file "$dir\compose.env" -f deploy/ark/lqwd-vm/docker-compose.yml ps
```

Check the tunnel first:

```powershell
docker logs ark_lqwd_tunnel
```

It must show the two forwards and no authentication or host-key errors. If you
changed `ARK_LQWD_TUNNEL_CONTAINER`, use that name instead.

### 6. Readiness by exact hash

The tip is dynamic. Replace both expected values with the `blocks` and
`bestblockhash` captured immediately before this check; the `195` /
`3cd3c4ff...` pair is only the first captured example, not a live constant.

```powershell
$expectedHeight = '<captured-blocks>'
$expectedHash = '<captured-bestblockhash>'
$expectedSigner = '<compressed pubkey from signer-pubkey.mjs>'
node deploy/ark/lqwd-vm/verify-readiness.mjs --expected-height $expectedHeight --expected-hash $expectedHash --expected-signer $expectedSigner
```

If you changed the published host ports, pass the origins explicitly:

```powershell
node deploy/ark/lqwd-vm/verify-readiness.mjs --expected-height $expectedHeight --expected-hash $expectedHash --expected-signer $expectedSigner --ark http://127.0.0.1:<arkd-port> --mempool http://127.0.0.1:<mempool-port> --nbx http://127.0.0.1:<nbxplorer-port>
```

The script checks:

- Ark `/v1/info` is exactly `http://127.0.0.1:<port>/v1/info`, with
  `network=regtest`, the pinned signer, a `bcrt1` forfeit address and a known
  integer dust value.
- Mempool `/api/blocks/tip/height` and `/api/blocks/tip/hash` match the expected
  height and hash exactly.
- NBXplorer is fully synced, its sync height and chain height match, and its
  network is `Regtest`.

It exits `1` on any mismatch and prints a JSON report. Height equality alone is
not accepted.

### 7. Confirm the old lab is unchanged

```powershell
docker ps --filter "name=ark_lab_" --format "table {{.Names}}\t{{.ID}}\t{{.Status}}"
docker volume ls --filter "name=swap_engine_ark_" --format "table {{.Name}}"
docker network ls --filter "name=swap_engine_ark_" --format "table {{.Name}}\t{{.Driver}}"
```

Compare with the baseline table above. The new resources are
`swap_engine_ark_lqwd_*`; there must be no overlap.

## Funding the operator wallet with 21 BTC (separate approval, not executed here)

This is a separate, explicitly authorized operation. The overlay apply and the
read-only readiness check do not fund anything. The funding is a regtest-only
transfer from the shared VM Core wallet to the fresh
`swap-engine-ark-lqwd-vm` operator wallet. The old `swap-engine-ark-regtest`
lab keeps its own Docker Core and is not involved. Funding is liquidity, not
authorization to execute swaps.

The gateway has no wallet RPCs by design, so this transfer must not go through
it. It uses the administrative SSH path to the VM Core, while the operator
address comes from the loopback arkd admin API.

### Values to bind in the approval

Set these from the validated `compose.env`, the running new lab and the current
VM capture. The coordinator approves the exact literals; do not infer them from
an example:

```powershell
$vm = '<vm-user>@<vm-host>'
$adminKey = '<path-to-admin-key>'
$arkdPort = '<arkd-port>'                 # default 37170
$arkdAdminPort = '<arkd-admin-port>'     # default 37171
$operatorAdmin = "http://127.0.0.1:$arkdAdminPort"
$coreWallet = '<loaded-vm-core-wallet>'   # e.g. lqwd-lab
$btcTotal = 21
$slotCount = 21
```

### 1. Read-only preflight (all gates must pass)

Destination, chain, wallet and signer:

```powershell
$addr = (Invoke-RestMethod "$operatorAdmin/v1/admin/wallet/address").address
$status = Invoke-RestMethod "$operatorAdmin/v1/admin/wallet/status"
$balance = Invoke-RestMethod "$operatorAdmin/v1/admin/wallet/balance"
$info = Invoke-RestMethod "http://127.0.0.1:$arkdPort/v1/info"
if ($addr -notmatch '^bcrt1[0-9a-z]+$') { throw 'destination is not a regtest address' }
if (-not ($status.initialized -and $status.unlocked -and $status.synced)) { throw 'operator wallet not ready' }
if ($info.network -ne 'regtest') { throw 'operator is not regtest' }
if ($info.signerPubkey -ne $env:ARK_EXPECTED_SIGNER) { throw 'signer mismatch' }
if ([double]$balance.mainAccount.locked -ne 0) { throw 'operator reports locked funds' }
if ($null -ne $balance.mainAccount.pending -and [double]$balance.mainAccount.pending -ne 0) { throw 'operator reports pending funds' }
```

On the VM, read-only:

```bash
export CORE_WALLET='<loaded-vm-core-wallet>'
export ADDR='<approved-bcrt1-operator-address>'
bitcoin-cli -regtest getblockchaininfo | jq -e '.chain == "regtest" and .initialblockdownload == false'
test "$(bitcoin-cli -regtest getblockhash 0)" = 0f9188f13cb7b2c71f2a335e3a4fc328bf5beb436012afca590b1a11466e2206
bitcoin-cli -regtest -rpcwallet="$CORE_WALLET" getbalances | jq -e '.mine.trusted >= 21'
bitcoin-cli -regtest -rpcwallet="$CORE_WALLET" validateaddress "$ADDR" | jq -e '.isvalid == true'
bitcoin-cli -regtest -rpcwallet="$CORE_WALLET" listlockunspent | jq -e 'length == 0'
bitcoin-cli -regtest -rpcwallet="$CORE_WALLET" listunspent 1
```

No pending swaps or pending work. Stop if the operator reports locked/pending
funds, if the swap engine has any non-terminal swap, or if Core has an
unaccounted mempool transaction:

```powershell
# The engine's GET /v1/preflight must be 200 and its persisted store must contain
# no non-terminal swap. Inspect it with the reviewed operator tooling; do not
# edit the store. The operator wallet active/available totals must be stable
# across two reads before approving.
$balance2 = Invoke-RestMethod "$operatorAdmin/v1/admin/wallet/balance"
if ($balance.mainAccount.available -ne $balance2.mainAccount.available) { throw 'operator balance still changing' }
```

Record the current VM tip height and hash, the operator address, `$btcTotal`,
`$slotCount` and the read-only `getbalances` output. If any value changes before
execution, stop and re-review.

### 2. Execution on the VM (only after approval)

Each transfer is exactly `1` BTC with a durable slot comment. The approved total
is `21` BTC in `21` slots. Write the returned txid before continuing; a lost
reply is reconciled, never re-sent.

```bash
set -euo pipefail
: "${CORE_WALLET:?loaded VM Core wallet}"
: "${ADDR:?approved bcrt1 operator address}"
[[ "$ADDR" == bcrt1* ]]
test "$(bitcoin-cli -regtest getblockhash 0)" = 0f9188f13cb7b2c71f2a335e3a4fc328bf5beb436012afca590b1a11466e2206
for i in $(seq -w 1 21); do
  txid=$(bitcoin-cli -regtest -rpcwallet="$CORE_WALLET" sendtoaddress "$ADDR" 1 "ark-lqwd-vm-$i")
  [[ "$txid" =~ ^[0-9a-f]{64}$ ]]
  printf '%s %s\n' "$i" "$txid"
done
bitcoin-cli -regtest -rpcwallet="$CORE_WALLET" getbalances
```

The shared VM chain advances on its own, so the transfers usually confirm
without an explicit mine. Do not mine in the overlay task. Only with explicit
approval may a single confirmation block be mined to an existing VM wallet
address; never loop:

```bash
# Approved one-block confirmation only:
miner_addr=$(bitcoin-cli -regtest -rpcwallet="$CORE_WALLET" getnewaddress)
bitcoin-cli -regtest -rpcwallet="$CORE_WALLET" generatetoaddress 1 "$miner_addr"
```

### 3. Verification (Windows and VM)

```powershell
$after = Invoke-RestMethod "$operatorAdmin/v1/admin/wallet/balance"
$total = [double]$after.mainAccount.available + [double]$after.mainAccount.locked
if ($total -lt 21) { throw "operator balance $total BTC is below the approved 21 BTC" }
(Invoke-RestMethod "http://127.0.0.1:$arkdPort/v1/info") | ConvertTo-Json -Depth 5
```

```bash
for txid in <approved-funding-txids>; do
  bitcoin-cli -regtest getrawtransaction "$txid" true | jq -e '.confirmations >= 1'
done
```

The operator must report at least `21` BTC of available/locked balance, the
operator `/v1/info` must still be `regtest` with the pinned signer, and every
funding txid must be confirmed in the active chain. Preserve the address, txids
and balances as evidence. Do not start the Ark indexers or the swap engine on the
strength of this funding alone.

### 4. Failure handling

- On an uncertain `sendtoaddress` reply, reconcile with
  `bitcoin-cli -regtest -rpcwallet="$CORE_WALLET" gettransaction "$TXID"` and
  `listtransactions`, then stop. Never send the same slot twice.
- If the operator balance does not increase after the expected confirmation,
  stop and reconcile NBXplorer and operator sync; do not send more.
- Never delete `swap_engine_ark_lqwd_*` volumes, the operator wallet data or the
  VM wallet to retry. Preserve the txids, address and balances as evidence.

## Rollback

1. Stop and remove only the new project, keeping its volumes:

   ```powershell
   docker compose --env-file "$dir\compose.env" -f deploy/ark/lqwd-vm/docker-compose.yml down
   ```

2. Stop the VM gateway:

   ```bash
   kill "$(cat ~/ark-lqwd-vm/gateway.pid)" 2>/dev/null || true
   ```

3. Remove the restricted key line:

   ```bash
   sed -i '/ark-lqwd-vm-readonly/d' ~/.ssh/authorized_keys
   ```

4. Remove the VM gateway files:

   ```bash
   rm -rf ~/ark-lqwd-vm
   ```

5. Remove the local key, known_hosts and compose.env.

6. If the new volumes must be deleted, list them first and remove only the
   `swap_engine_ark_lqwd_*` volumes. Do not use a broad prune. `down -v` on the
   new project is acceptable only after confirming the project name; it does not
   touch `swap_engine_ark_*` from the old lab.

7. Re-check the old lab baseline.

## Why not Core rpcauth

Adding an `rpcauth` entry requires editing `bitcoin.conf` and restarting Core.
LND is unsynced and the coordinator forbade VM changes. The loopback gateway
reads the existing cookie, needs no Core restart, and is removable with the
steps above. If a permanent deployment is approved later, a dedicated
`rpcauth` user restricted to read-only methods is the cleaner long-term option.

## Known limitations

- This overlay was not applied or started. End-to-end height/hash agreement is
  not claimed; the exact expected hash and the readiness script are provided for
  the operator.
- The `minimal` gateway profile cannot fully sync NBXplorer/Fulcrum. The lab
  needs `indexer-readonly`, which is still read-only but broader than the
  backend's minimal list and must be explicitly approved.
- NBXplorer uses `NBXPLORER_NOAUTH=1` and is bound only to `127.0.0.1:32938` by
  default. It must not be published beyond loopback.
- On Windows, the tunnel container must be able to read the bind-mounted key.
  If it cannot, fix the Docker file-sharing permission or run the tunnel as
  root; do not copy the key into the image.
- The gateway allowlist is method-based, not parameter-aware. It exposes no
  wallet RPCs, no `scantxoutset`, and no path other than `/`. It requires real
  inbound Basic auth, but it does not inspect RPC parameter semantics.

## Local validation (no VM or Docker changes)

These checks run on the workstation and do not contact the VM or start the lab:

```powershell
node --check deploy/ark/lqwd-vm/rpc-gateway.mjs
node --check deploy/ark/lqwd-vm/verify-readiness.mjs
node --check deploy/ark/lqwd-vm/signer-pubkey.mjs
node --test deploy/ark/lqwd-vm/gateway.test.mjs
node --test deploy/ark/lqwd-vm/verify-readiness.test.mjs
```

Compose syntax only, with a disposable env file and dummy key paths:

```powershell
docker compose --env-file "$env:TEMP\ark-lqwd-vm-test\compose.env" -f deploy/ark/lqwd-vm/docker-compose.yml config
```

The tests use loopback mock servers and temporary cookies. They verify canonical
forwarding, duplicate-key handling, auth, method denial, path denial, size and
time limits, loopback enforcement, and exact-hash readiness. They do not execute
against the VM.

Recorded on 2026-11-22 with Node `v24.19.0` and Docker Compose `v5.5.1`. No lab
container was started:

| Check | Result |
| --- | --- |
| `node --check` on `rpc-gateway.mjs`, `verify-readiness.mjs`, `signer-pubkey.mjs` | pass |
| `gateway.test.mjs` | 22/22 pass, re-run twice |
| `verify-readiness.test.mjs` | 4/4 pass |
| `docker compose --env-file <disposable compose.env> -f deploy/ark/lqwd-vm/docker-compose.yml config` | exit `0` |
| `signer-pubkey.mjs` with a throwaway 32-byte key | compressed pubkey emitted |

The slow-upstream timeout case originally reset the socket on Windows because
the inbound socket idle timer and the upstream timeout could race. The gateway
now clears the inbound socket timer once the request body is complete and does
not destroy a response that is already committed, so the case deterministically
returns `504`.
