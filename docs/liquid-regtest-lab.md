# Isolated Elements regtest labs — installed and spendable evidence

Installed on `LQWD-SWAPS` under the existing `truja` account with the user's
direct authorization. Installation is user-space only; no sudo/system package or
global service was changed. Existing Core (18443) and LND (8080/10009) were not
restarted or modified. No mainnet, Ark mutation, secret disclosure or concurrent
local inference.

## Installed binary

- `Elements Core v23.3.4` at `/home/truja/.local/opt/elements-23.3.4/bin/`
  (`elementsd`, `elements-cli`), with user symlinks in `/home/truja/.local/bin/`.

## Existing 7042 lab — preserved, unfunded

The original lab at `/home/truja/.local/share/lqwd-elements-regtest` (config and
`/home/truja/.config/lqwd-liquid-regtest.env`, both mode 600) remains intact and
was **not modified** by this work. It has `chain=elementsregtest`, height 101,
wallet `lqwd-liquid`, policy asset
`b2e15d0d7a0c94e4e2ce0fe6e8691b9e451377f6e46e8045a86f7c4b5d4f0f23`, genesis
`cd179c84…396f`, parent blockhash `0f9188f1…2206`, and no `fee_asset`.

It shows 0 trusted/immature and 0 unspent because it was started without
`-initialfreecoins` or a positive block subsidy: the generated blocks have a
zero subsidy. It is left as-is.

## New spendable lab on 7052 — initialfreecoins

New datadir: `/home/truja/.local/share/lqwd-elements-regtest-ifc` (mode 700).
New config: `/home/truja/.local/share/lqwd-elements-regtest-ifc/elements.conf`
(mode 600). New env: `/home/truja/.config/lqwd-liquid-regtest-ifc.env` (mode 600,
paths and public values only). Ports: RPC `127.0.0.1:7052`, P2P disabled.

Official Elements source/help confirms the mechanism:

- `-initialfreecoins=<sats>` creates OP_TRUE coins in the genesis block
  (primarily for testing; default 0).
- `-anyonecanspendaremine` treats OP_TRUE outputs as wallet funds (default true
  for custom chains; set explicitly here).
- `-con_connect_genesis_outputs=1` connects the genesis outputs; the official
  Elements functional tests use this combination with `-con_blocksubsidy=0`.
- A wallet created after the genesis needs `rescanblockchain 0` to discover the
  genesis OP_TRUE coins.

Start/stop only the new lab (the daemon was stopped after the evidence run):

```bash
export PATH="$HOME/.local/bin:$PATH"
elementsd -datadir="$HOME/.local/share/lqwd-elements-regtest-ifc" -daemon=1
elements-cli -datadir="$HOME/.local/share/lqwd-elements-regtest-ifc" getblockchaininfo
elements-cli -datadir="$HOME/.local/share/lqwd-elements-regtest-ifc" stop
```

### Sanitized spendable evidence

- `chain`: `elementsregtest`; height `1`
- `genesis`: `209577bda6bf4b5804bd46f8621580dd6d4e8bfa2d190e1c50e932492baca07d`
- `tip`: `7716ea603c5e761ed31adf662e6f53a83d1e69ff83ef80bc9426f6574841b0b1`
- wallet: `lqwd-liquid-ifc`; after `rescanblockchain 0`:
  `getbalances.mine.trusted = 21,000,000` policy-asset units.
- `listunspent`: 1 spendable output before the test, asset
  `b2e15d0d7a0c94e4e2ce0fe6e8691b9e451377f6e46e8045a86f7c4b5d4f0f23`.
- Spend test: sent `0.00001000` policy asset to a fresh wallet address; txid
  `aef4ec0c9a7109604a1f99e4c8de7dd443041641d810efc24fa10a85de070f4f`;
  mined one block; `gettransaction.confirmations = 1`; send and receive details
  use the policy asset. Afterward `listunspent` had 2 spendable outputs,
  `mine.trusted = 20,999,999.99950720`, `immature = 0.00049280` (fee coinbase).
- `getsidechaininfo.pegged_asset` equals the policy asset;
  `parent_pegged_asset = null`;
  `parent_blockhash = 0f9188f13cb7b2c71f2a335e3a4fc328bf5beb436012afca590b1a11466e2206`;
  `has_fee_asset = false`.

### Attested `.env` for the new lab

`/home/truja/.config/lqwd-liquid-regtest-ifc.env` (mode 600) contains no secret:

```dotenv
APP_ENV=liquid-regtest
DEPLOYMENT_ID=lqwd-elements-ifc-2026-11-23
PORT=3401
DATA_DIR=/home/truja/.local/share/lqwd-liquid-regtest-ifc/state
SPEND_POLICY=disabled
LIQUID_NETWORK=elementsregtest
LIQUID_EXECUTION_ENABLED=false
ELEMENTS_RPC_URL=http://127.0.0.1:7052
ELEMENTS_COOKIE_PATH=/home/truja/.local/share/lqwd-elements-regtest-ifc/elementsregtest/.cookie
ELEMENTS_WALLET=lqwd-liquid-ifc
LIQUID_POLICY_ASSET=b2e15d0d7a0c94e4e2ce0fe6e8691b9e451377f6e46e8045a86f7c4b5d4f0f23
LIQUID_PARENT_GENESIS_HASH=0f9188f13cb7b2c71f2a335e3a4fc328bf5beb436012afca590b1a11466e2206
LIQUID_GENESIS_HASH=209577bda6bf4b5804bd46f8621580dd6d4e8bfa2d190e1c50e932492baca07d
LIQUID_CONFIRMATION_POLICY=read-only
```

The repo overlay `deploy/liquid-regtest-lab.env.example` remains the portable
placeholder template. Cookie authentication is referenced by path only; no
cookie contents, private key, preimage or password are in the env or this report.

## App / coordination status

The app still requires a reviewed change to attest the coinbase policy asset via
`getblock`; `getsidechaininfo.fee_asset` is absent on stock Elements 22/23. No
`pegged_asset` fallback is allowed. The Specialist's
`feat/liquid-regtest-preflight` was not modified or overlapped. The new lab is
stopped after evidence; existing 7042, Core and LND remain intact. No Bitcoin
chain or pending Guest channel was touched.
