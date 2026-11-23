# Isolated Elements regtest lab — prepared commands and evidence

Branch `review/liquid-regtest-lab` from `b10e4a7`. **No installation or VM write
was performed.** The VM was inspected read-only: `elementsd`, `elements-cli` and
Docker are absent; `sudo` requires a password; ports 7040/7041/7042 are closed.
Existing Core (18443) and LND (8080/10009) remain untouched. No mainnet, Ark
mutation, global restart, secret disclosure or concurrent local inference.

## Portable configuration

Use `deploy/liquid-regtest-lab.env.example`. It is cookie-only, execution-disabled
and has placeholders for the attested chain/wallet/genesis/policy asset. The
existing `.env.liquid.regtest.example` remains the canonical contract; this lab
overlay isolates the datadir, ports and wallet.

## Install (user-space; run only on the authorized lab host)

The official release tag used for source inspection is `elements-23.3.4`
(`elements-22.1.1` has the same RPC field behavior). Download the official
`x86_64-linux-gnu` release archive and its checksum from
`https://github.com/ElementsProject/elements/releases/tag/elements-23.3.4`,
verify it, then extract without sudo:

```bash
mkdir -p "$HOME/.local/opt"
# Select the actual x86_64-linux-gnu archive from that release page and verify
# it against the published checksums before extracting.
tar -xf elements-23.3.4-x86_64-linux-gnu.tar.gz -C "$HOME/.local/opt"
export PATH="$HOME/.local/opt/elements-23.3.4/bin:$PATH"
elementsd --version
```

If the operator instead uses a reviewed system package, install it only with the
approved privileges; that was not available or attempted here.

## Isolated daemon (no VM Core/LND touch)

```bash
export ELEMENTS_DATADIR="$HOME/.local/share/lqwd-elements-regtest"
mkdir -p -m 700 "$ELEMENTS_DATADIR"
elementsd -datadir="$ELEMENTS_DATADIR" -chain=elementsregtest -server=1 -daemon=1 \
  -rpcbind=127.0.0.1 -rpcallowip=127.0.0.1 -rpcport=7042 -port=7043 -listen=0 \
  -validatepegin=0 -txindex=1 -fallbackfee=0.0002
elements-cli -datadir="$ELEMENTS_DATADIR" -rpcwait getblockchaininfo
```

This is a separate datadir/process on 127.0.0.1:7042; it does not restart or
change the existing Core or LND. Stop only this lab with
`elements-cli -datadir="$ELEMENTS_DATADIR" stop`.

## Local wallet and test funding

```bash
elements-cli -datadir="$ELEMENTS_DATADIR" createwallet lqwd-liquid
ADDR=$(elements-cli -datadir="$ELEMENTS_DATADIR" -rpcwallet=lqwd-liquid getnewaddress)
elements-cli -datadir="$ELEMENTS_DATADIR" -rpcwallet=lqwd-liquid generatetoaddress 101 "$ADDR"
```

`generatetoaddress` mines only the isolated Elements regtest and funds the new
lab wallet with the policy/fee asset. Do not use the VM Core wallet or miner.

## Attested identity / policy asset (read-only RPC)

`getsidechaininfo` in stock Elements **22.1.1 and 23.3.4 does not expose
`fee_asset`**; its source (`src/rpc/blockchain.cpp`) returns `pegged_asset` and
`parent_pegged_asset`. `-feeasset` is a startup argument (`src/init.cpp`) and
`policyAsset = -feeasset || pegged_asset`; it is configurable and must not be
equated with `pegged_asset`. The current app's
`getsidechaininfo.fee_asset` expectation fails closed and needs a reviewed fix.

Independent read-only attestation from the coinbase (the miner's policy asset):

```bash
C="elements-cli -datadir=$ELEMENTS_DATADIR"
CHAIN=$($C getblockchaininfo | jq -r .chain)
GENESIS=$($C getblockhash 0)
HEIGHT=$($C getblockcount)
TIP=$($C getblockhash "$HEIGHT")
POLICY=$($C getblock "$TIP" 2 | jq -r '.tx[0].vout[0].asset')
SIDE=$($C getsidechaininfo)
PARENT=$($C getsidechaininfo | jq -r .parent_blockhash)
WALLET=$($C -rpcwallet=lqwd-liquid getwalletinfo | jq -r .walletname)
printf 'chain=%s\ngenesis=%s\nparent=%s\npolicy=%s\nwallet=%s\n' \
  "$CHAIN" "$GENESIS" "$PARENT" "$POLICY" "$WALLET"
```

Sanitized evidence to require (no cookie, key, preimage or password):
- `chain` must be exactly `elementsregtest`.
- `walletname` must equal `ELEMENTS_WALLET` (`lqwd-liquid` here).
- `parent_blockhash` must equal `LIQUID_PARENT_GENESIS_HASH`.
- `getblockhash 0` must equal `LIQUID_GENESIS_HASH`.
- `tx[0].vout[0].asset` from a mined block must equal `LIQUID_POLICY_ASSET`.
- Do not accept `pegged_asset` as a fallback for the policy asset.

The app's read-only Elements allowlist (`getblockchaininfo`, `getblockhash`,
`getsidechaininfo`, `getwalletinfo`) currently lacks `getblock`; deriving the
coinbase policy asset needs a reviewed allowlist/identity change. Until then the
lab can be attested manually with the commands above, while app startup remains
fail-closed.

## Coordination / open blockers

- No Elements binary, Docker or passwordless sudo on `LQWD-SWAPS`; no install
  was attempted. A user-space install and the commands above are prepared for an
  authorized host.
- The Specialist's `feat/liquid-regtest-preflight` is not modified; this branch
  only prepares the isolated lab/env and the fee-asset evidence. No Boltz or
  Chain Swap provider exists in the repo.
- Need the reviewed coinbase/`getblock` attestation change, or an explicit
  operator-provided `-feeasset` policy plus independent evidence, before the app
  can attest a real Elements policy asset.
- No secrets were read or printed; cookie authentication is used by path only.
