# Environment-driven configuration

Status: implementation review candidate. Financial execution and real mining remain disabled.

## Profiles

Use exactly one of the tracked templates and replace every `/ABS` placeholder locally:

- `.env.regtest.example`
- `.env.signet.example`
- `.env.mainnet.example`
- `.env.ark.regtest.example`
- `.env.liquid.regtest.example`

`APP_ENV` selects the profile. `APP_MODE` remains a compatibility input for
`simulation`/`regtest`; conflicting `APP_ENV`/`APP_MODE` values fail closed.
Legacy Bitcoin/LND variable names remain accepted. Ark/Liquid canonical names are
`ARK_NETWORK`, `ARK_OPERATOR_URL`, `ARK_LAB_ROOT`, `ARK_CLI_PATH`,
`ARK_STORE_PATH`, `ARK_EXECUTION_ENABLED`, `ARK_CONFIRMATION_POLICY`,
`LIQUID_NETWORK`, `ELEMENTS_RPC_URL`, `ELEMENTS_WALLET`,
`ELEMENTS_COOKIE_PATH`, `LIQUID_POLICY_ASSET` and
`LIQUID_CONFIRMATION_POLICY`. Canonical/alias conflicts fail closed.

## Safety gates

- `SPEND_POLICY=disabled` is the default. `SPEND_POLICY=regtest-only` is accepted
  only for an explicit `regtest` profile; even then capabilities report
  `execution.enabled=false` and a permission remains separately required.
- Owned preparation and controlled `--serve-jit` execution require
  `SPEND_POLICY=regtest-only`; `--serve-status` and offline commands remain
  available with spending disabled.
- Mainnet/signet are read-only. `ENABLE_MAINNET_*`/`ALLOW_MAINNET_*`,
  `ENABLE_LIVE_SWAPS`, and requested reverse/forward/guest/mining feature flags
  fail startup. `FEATURE_*`/`ENABLE_*` execution flags are centralized and
  reported false.
- Ark/Liquid are configuration and read-only identity contracts only. They stay
  `configured` but not `available` until a reviewed read-only probe verifies
  them; no adapter is installed by this profile.

## Preparation spec migration

Reviewed preparation specs now carry an explicit wallet field. Recreate the spec and its SHA-256 checksum before use; old specs/digests without wallet are rejected. The owned runtime, controlled CLI readers, signing probe and Core wallet-scoped probes use this wallet instead of a developer literal.

## Startup attestation and state scope

Before opening the journal or lock, seed mode reads Core `getblockchaininfo`,
`getblockhash(0)`, `listwallets`, `getwalletinfo`, and configured LND
`/v1/getinfo` through read-only clients. Signet also requires the reviewed
`SIGNET_CHALLENGE` from `getmininginfo`; default/custom signet cannot be accepted
on genesis alone. A mismatch rejects startup before the journal/lock is created.

`DATA_DIR/.environment.json` binds the data directory to environment,
`DEPLOYMENT_ID`, observed Bitcoin genesis and wallet. A different marker is
rejected before the journal is touched. A legacy `state.json` without the marker
requires the explicit offline-regtest migration:

1. Stop all writers and preserve a backup of `DATA_DIR`.
2. Confirm the journal belongs to the same regtest chain, wallet and intended
   deployment; do not reuse it for another lab.
3. Start once with `ALLOW_LEGACY_STATE_MIGRATION=offline-regtest` and
   `DEPLOYMENT_ID` set, after review. This writes the marker only; it does not
   modify the journal.
4. Remove the migration flag and restart normally. A simulation profile pointing
   at a regtest data directory is rejected by the same marker.

## Capabilities and balances

`GET /v1/capabilities` is public read-only. Each rail reports `configured`,
`verified`, `available` and `reason`; `available` is true only when configured
and verified. `GET /v1/operations/balances` remains ADMIN-only and extends the
existing `core`/`provider`/`alice` fields with a typed `rails` array. Satoshis
are integer base units; `null` means unavailable/unknown and `0` means verified
zero.

## Remaining gaps

- Ark/Liquid have no live read-only probe in this branch; they remain
  `NOT_VERIFIED` until wired to reviewed read-only seams.
- Owned policy binding verifies configured origins, credentials and observed
  node identities before factory construction; the factory still has a legacy
  wallet name and controlled-CLI policy binding needs a focused follow-up.
- Real mining/payment, deployments and the systemd miner timer remain off.
