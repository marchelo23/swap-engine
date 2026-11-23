# Isolated Elements regtest lab — installed evidence

Installed on `LQWD-SWAPS` under the existing `truja` account with the user's
direct authorization. Installation is user-space only; no sudo/system package or
global service was changed. Existing Core (18443) and LND (8080/10009) were not
restarted or modified. No mainnet, Ark mutation, secret disclosure or concurrent
local inference.

## Installed binary and paths

- `Elements Core v23.3.4` at `/home/truja/.local/opt/elements-23.3.4/bin/`
  (`elementsd`, `elements-cli`), with user symlinks in `/home/truja/.local/bin/`.
- Isolated datadir: `/home/truja/.local/share/lqwd-elements-regtest` (mode 700).
- Daemon config: `/home/truja/.local/share/lqwd-elements-regtest/elements.conf`
  (mode 600, cookie auth, no RPC password).
- Lab environment: `/home/truja/.config/lqwd-liquid-regtest.env` (mode 600,
  paths/public attested values only; no cookie, key or preimage).
- Repo overlay: `deploy/liquid-regtest-lab.env.example` (placeholders; portable).

The daemon was smoke-tested, then stopped. Start/stop only the isolated lab:

```bash
export PATH="$HOME/.local/bin:$PATH"
elementsd -datadir="$HOME/.local/share/lqwd-elements-regtest" -daemon=1
elements-cli -datadir="$HOME/.local/share/lqwd-elements-regtest" getblockchaininfo
elements-cli -datadir="$HOME/.local/share/lqwd-elements-regtest" stop
```

RPC is loopback-only on `127.0.0.1:7042`; P2P is disabled. The final
`elements.conf` places network/RPC options in `[elementsregtest]`, avoiding the
earlier `-rpcbind` section warning.

## Isolated lab evidence (sanitized)

- `chain`: `elementsregtest`
- `height`: `101`; `genesis`: `cd179c84c35f51825f20a3b91a18d45f0c53b5ceb744a5b6ef8f0babe809396f`
- `bestblockhash`: `d6901f95dc66ce0d5b738b9eb0c34ba6e12dee2e99f20e845fbbd92c051a2800`
- wallet: `lqwd-liquid`; created and funded locally with 101 regtest blocks
- policy/coinbase asset (`getblock.tx[0].vout[0].asset`):
  `b2e15d0d7a0c94e4e2ce0fe6e8691b9e451377f6e46e8045a86f7c4b5d4f0f23`
- `getsidechaininfo.pegged_asset`: same value as the coinbase policy asset
- `getsidechaininfo.parent_pegged_asset`: null
- `getsidechaininfo.parent_blockhash`:
  `0f9188f13cb7b2c71f2a335e3a4fc328bf5beb436012afca590b1a11466e2206`
- `getsidechaininfo` has no `fee_asset` field (`has_fee_asset=false`)

## Attestation finding (important)

Stock Elements **22.1.1 and 23.3.4** `getsidechaininfo` exposes `pegged_asset`
and `parent_pegged_asset`, not `fee_asset`. `-feeasset` is a startup option and
`policyAsset = -feeasset || pegged_asset`; it is configurable and must not be
silently equated with `pegged_asset`. The current app's
`getsidechaininfo.fee_asset` expectation fails closed. The independent policy
asset evidence is the coinbase output asset from `getblock` (as recorded above);
the app's read-only allowlist needs `getblock` and a reviewed identity change
before it can attest this lab. No `pegged_asset` fallback was introduced.

## Portable `.env`

Use `deploy/liquid-regtest-lab.env.example` as the repository template. The
installed lab values correspond to:

```dotenv
APP_ENV=liquid-regtest
DEPLOYMENT_ID=lqwd-elements-regtest-2026-11-23
PORT=3400
DATA_DIR=/home/truja/.local/share/lqwd-liquid-regtest/state
SPEND_POLICY=disabled
LIQUID_NETWORK=elementsregtest
LIQUID_EXECUTION_ENABLED=false
ELEMENTS_RPC_URL=http://127.0.0.1:7042
ELEMENTS_COOKIE_PATH=/home/truja/.local/share/lqwd-elements-regtest/elementsregtest/.cookie
ELEMENTS_WALLET=lqwd-liquid
LIQUID_POLICY_ASSET=b2e15d0d7a0c94e4e2ce0fe6e8691b9e451377f6e46e8045a86f7c4b5d4f0f23
LIQUID_PARENT_GENESIS_HASH=0f9188f13cb7b2c71f2a335e3a4fc328bf5beb436012afca590b1a11466e2206
LIQUID_GENESIS_HASH=cd179c84c35f51825f20a3b91a18d45f0c53b5ceb744a5b6ef8f0babe809396f
LIQUID_CONFIRMATION_POLICY=read-only
```

No secret values are present in the env file or this report: cookie authentication
is referenced by path and wallet keys are not exported.

## Open items

- App/identity fix: allow `getblock` in the read-only Elements client and attest
  `policyAsset` from the coinbase, not `getsidechaininfo.fee_asset`; keep
  fail-closed and add tests. This branch does not modify `Identity.ts` or
  `StartupAttestation.ts`.
- The Specialist's `feat/liquid-regtest-preflight` remains separate; no state or
  preflight code was modified or overlapped. No Boltz/Chain provider is installed
  or attested.
- The isolated daemon is stopped after the smoke test; no global restart, Core/LND
  touch, mainnet, Ark mutation, secret disclosure, merge or push.
