# Environment-driven configuration

Status: implementation review candidate. Financial execution and real mining remain disabled.

## Profiles

Use exactly one tracked template and copy it to an untracked local file:

```sh
cp .env.regtest.example .env.regtest.local
# Edit every /ABS path and placeholder in .env.regtest.local.
```

Templates:

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
  available with spending disabled and do not build a mutation policy.
- Mainnet/signet are read-only. `ENABLE_MAINNET_*`/`ALLOW_MAINNET_*`,
  `ENABLE_LIVE_SWAPS`, and requested reverse/forward/guest/mining feature flags
  fail startup. `FEATURE_*`/`ENABLE_*` execution flags are centralized and
  reported false.
- Liquid has a read-only Elements identity/asset/wallet attestation and remains
  execution-less. Ark can verify a configured operator and expose read-only telemetry.

## Ark operator and wallet telemetry

Use an ignored local .env file and start the app with npm start. Environment
variables exported by the shell retain precedence.

To add Ark telemetry to an existing Bitcoin and Lightning regtest profile, retain
the existing Core and LND settings and add the Ark settings from
`.env.ark.regtest.example`. Keep `APP_ENV=regtest` when using the existing
authenticated Lightning-to-on-chain flow in the same process.

- Set `ARK_ENABLED=true`, `ARK_NETWORK=regtest`, and
  `ARK_OPERATOR_URL` to the actual loopback `/v1/info` address.
- Set `ARK_EXPECTED_SIGNER_PUBKEY` to the operator key verified in the isolated
  lab. Startup verifies the network, the key and the regtest forfeit address.
- For wallet balances, set `ARK_LAB_ROOT` and `ARK_CLI_PATH` together. Use the
  collaborator's CLI built against that isolated lab, on the same host as the
  application. The lab must be installed and running separately. The app only
  invokes read commands.
- Keep `ARK_EXECUTION_ENABLED=false` and
  `ARK_CONFIRMATION_POLICY=read-only`. An unverified or unreachable operator
  yields unavailable telemetry. No historical output or address is used.

After starting the application, check `GET /v1/capabilities` for the Ark
verification result and use the authenticated Operations view to check the
operator and wallet balances. Ark writes remain unavailable in this deployment.
A submission or a returned transaction ID alone cannot prove settlement.

## Guest Lightning-to-on-chain swaps

Enable Guest on an explicitly attested Bitcoin and Lightning regtest deployment.
The preview with only Ark and Core cannot issue a Guest Lightning invoice.
Set `APP_ENV=regtest`, `GUEST_SWAP_ENABLED=true` and `SPEND_POLICY=regtest-only`.
Use the reviewed Guest policy whose wallet, Core URL, LND identities,
certificate paths and read credentials match that deployment profile.

```sh
npm start -- --guest-regtest --policy-path /ABS/PATH/guest-policy.json \
  --policy-sha256 REVIEWED_SHA256 --guest-watch
```

Guest uses a capability token and presents the encrypted recovery export before
showing the payable invoice. The user chooses a regtest destination and keeps
the recovery material. The authenticated controlled startup remains a separate
operating mode with its own reviewed policy and authorization.

## Economics

The profile templates pin the safe defaults for generic quotes and invoice
budgets. Defaults preserve existing quote and approval bytes:

- `QUOTE_MIN_SATS`, `QUOTE_MAX_SATS`, `QUOTE_SERVICE_FEE_BASE_SATS`,
  `QUOTE_SERVICE_FEE_BPS`, `QUOTE_FUNDING_RESERVE_SATS`,
  `QUOTE_CLAIM_FEE_SATS`, `QUOTE_TTL_SECONDS`
- `INVOICE_MIN_SATS`, `INVOICE_MAX_SATS`,
  `INVOICE_SERVICE_FEE_BASE_SATS`, `INVOICE_SERVICE_FEE_DIVISOR`,
  `INVOICE_FUNDING_RESERVE_SATS`, `INVOICE_CLAIM_FEE_SATS`,
  `INVOICE_TTL_SECONDS`

Amounts, fees and TTLs are validated against safe bounds, including combined
fees at the minimum amount. A fee that consumes the principal, `claimFeeSats >=
principal`, or a reserve below the reviewed 1000-sat onchain floor is rejected
with `ECONOMICS_UNSAFE`. `INVOICE_SERVICE_FEE_DIVISOR=1` is therefore rejected.

Bounded quote overrides apply to the real `POST /v1/quotes` endpoint and remain
usable in non-executing deployments. Native `--serve-jit` and owned preparation
require the reviewed legacy budget; any other validated policy fails with
`EXECUTION_ECONOMICS_UNSUPPORTED` before execution is installed. The approved
reverse protocol also keeps immutable constants: `CONFIRMATIONS_REQUIRED=1`,
`READINESS_MAX_BLOCKS=2` and `READINESS_TIMEOUT_MS=90000`; setting another value
fails with `PROTOCOL_POLICY_IMMUTABLE`.

## Preparation spec migration

Fresh live preparation, restore and execution specs now require an explicit
wallet field. Recreate those specs and SHA-256 checksums before use; omitting
wallet is rejected.

Completed archives are immutable evidence, not fresh execution specs. Their
reads verify the original checksum first, then use an archive-only schema that
allows a missing wallet; the historical spec bytes, custody and journal remain
unchanged and receive no execution authority. Do not rewrite a completed
archive to add wallet. The owned runtime, controlled CLI readers, signing probe
and Core wallet-scoped probes use wallet only for new live work.

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

```sh
# Stop every writer, including user services, before copying anything.
systemctl --user stop swap-engine swap-engine-owned-review
cp -a "$DATA_DIR" "$DATA_DIR.backup-$(date +%Y%m%dT%H%M%S)"
# Review that the backup/journal belongs to this regtest chain, wallet and deployment.
# Confirm no other process still holds the data directory or writer lock.
ALLOW_LEGACY_STATE_MIGRATION=offline-regtest npm start
# Startup writes the marker and performs normal recovery/reconciliation, which
# may update interrupted owned-preparation entries. Review the result, stop,
# remove ALLOW_LEGACY_STATE_MIGRATION, then restart normally.
```

Do not run the migration while any writer or reconciliation process is active.
A simulation profile pointing at a regtest data directory is rejected by the
same marker.

## Capabilities and balances

`GET /v1/capabilities` is public read-only. Each rail reports `configured`,
`verified`, `available` and `reason`; `available` is true only when configured
and verified. `GET /v1/operations/balances` remains ADMIN-only and extends the
existing `core`/`provider`/`alice` fields with a typed `rails` array. Satoshis
are integer base units; `null` means unavailable/unknown and `0` means verified
zero.

## Controlled legacy scripts

Auth and legacy-script settings are parsed once by `config()` via
`AUTH_STORE_PATH`, `AUTH_ORIGIN`, `REFUND_DESTINATION` and
`LND_ADMIN_MACAROON_PATH`. Prepare and verify use the same attested read-only
payer client as owned preparation. They do not invoke `lncli` or a second gRPC
stack:

- `ALICE_LND_REST_URL`, `ALICE_LND_TLS_CERT_PATH`,
  `ALICE_LND_MACAROON_PATH`: payer read-only REST identity. `/v2/wallet/addresses`
  supplies the existing default external address; no address is derived.
- `REFUND_DESTINATION`: explicit `bcrt1...` address. It must be Core-owned, and
  the reviewed plan must carry the same address.
- `LND_ADMIN_MACAROON_PATH`: provider admin macaroon used only by the explicit
  approved hold-invoice script, loaded after plan origins, wallet and refund
  ownership are checked.

```sh
set -a; . ./.env.regtest.local; set +a
umask 077
read -rsp 'Vault password: ' PASS; printf '\n'
printf '%s\n' "$PASS" | npx tsx scripts/prepare-reverse-plan.ts
PLAN_SHA=$(sha256sum "$DATA_DIR/reverse-test-plan.json" | awk '{print $1}')
printf '%s\n' "$PASS" | npx tsx scripts/verify-hold-invoice.ts \
  --approved-create-invoice-only --plan-sha256 "$PLAN_SHA"
unset PASS
```

The hold-invoice script rejects a plan whose `wallet`, Bitcoin/provider/payer
origin or explicit refund destination differs from the loaded profile before the
admin macaroon is used. It creates no payment and broadcasts nothing.

The owner HTTP smoke check takes an explicit owner id and username; it never
assumes `truja503`:

```sh
npx tsx scripts/check-owned-http.ts --check-http-readonly \
  --origin http://127.0.0.1:3101 --owner-id <uuid> \
  --owner-username <reviewer> --archive-id <uuid>
```

## Service installation

The shipped units are systemd **user** units. Install them without enabling or
starting them during verification:

```sh
install -d -m 700 "$HOME/.config/swap-engine" "$HOME/.config/systemd/user" \
  "$HOME/.local/share/swap-engine"
install -m 600 .env.regtest.local "$HOME/.config/swap-engine/regtest.env"
install -m 644 deploy/swap-engine.service "$HOME/.config/systemd/user/"
install -m 644 deploy/swap-engine-owned-review.service "$HOME/.config/systemd/user/"
systemctl --user daemon-reload
systemctl --user cat swap-engine.service swap-engine-owned-review.service
```

`EnvironmentFile` paths use `%h`, the user home for user units; do not reuse them
as system-unit `User=` account paths.

## Remaining gaps

For the canonical Liquid profile, `npm run liquid:preflight` provides a
read-only chain diagnostic with explicit provider and fee-asset blockers.
See [Liquid preflight](liquid-regtest-preflight.md) for the Elements compatibility
finding, direct Chain Swap SDK decision and the evidence still required.

- Elements/Liquid has a read-only identity and policy-asset/wallet attestation.
  Ark reports `NOT_VERIFIED` until a configured regtest operator matches its pinned signer.
- Linux POSIX native-operator, vault and fixture tests are skipped on non-Linux
  hosts; run them on Linux before merge.
- Real mining/payment, deployments and the systemd miner timer remain off.
