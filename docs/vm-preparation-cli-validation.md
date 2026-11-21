# VM preparation CLI validation and fresh proposal

Subsequent authorized preparation at height 135 succeeded after sync recovered:
see the [fresh unpaid invoice result](fresh-unpaid-invoice-result.md). The evidence
below records the earlier blocked state and is retained without alteration.

**Preparation is blocked; no real invoice was created.** At 2026-11-18
17:31:14 UTC, both LND nodes reported `synced_to_chain=false` and
`wallet_synced=false`. Their public identities, Bitcoin regtest network, height
134 and block hash matched Core. The existing identity/readiness guard rejected
them. No synchronization flag, timeout, fee policy or execution gate was weakened.
No payment, real-node signing, broadcast, mining, wallet change or service restart
was performed. Actual credentials stayed on the VM; real vaults were not decrypted.

## Artifact and actual tests

- VM: `truja@192.168.56.108`, existing SSH key with BatchMode/strict host checking.
- Source: `/tmp/swap-preparation-c7255bc86dbb.rMEJk8rc/source`.
- Archive: same parent, `source.tgz`, 119 public source/test/doc files, SHA-256
  `631d3e5d37e10de63e9b8ba7d8bce94b6a4bf5458c4d0131b17ec48c6e9241cf`;
  local and VM checksums matched. Existing deployment/data were not overwritten.
- Existing dependency installation reused by symlink after lockfile equality;
  no installation or node configuration change. Node `v22.22.1`, npm `9.2.0`.
- Build passed. Full VM suite: **264 passed, 0 failed, 1 Windows-only skip**
  (265 total). The five new POSIX CLI lifecycle cases all passed, including in
  isolation (6.7 seconds); full suite took 31.8 seconds.
- Lifecycle tests exercise the real private-directory/control-file validation,
  encrypted synthetic custody, store locks, fsync/exclusive public artifact,
  identical-result reuse, lost-reply recovery and wrong-revision rejection.
  Unsafe permissions, symlinks/hardlinks, wrong checksum/authority/password,
  existing writer locks and conflicting artifacts stop safely. Synthetic HTTPS
  adapters ensure one mock invoice creation total and no recovery writer access.
- An initial lifecycle run measured approximately 53 minutes in its first case
  and failed the fresh readiness check after the quote expired. The original log
  was preserved; rerunning with new synthetic fixtures passed. No expiry policy
  was extended or mocked away. This is evidence of fail-closed freshness behavior,
  not evidence that the first run passed.

Evidence in the VM temp parent: `build.log`, `posix-cli.log` (initial interruption),
`posix-cli-recheck.log`, `tests.log`, `read-only-evidence.json`,
`lnd-compatibility.json`. Test credentials and custody are synthetic. Test artifacts
must never be used as real execution authority. The small CLI IO seam is available
only to trusted module tests; no CLI flag/environment option installs it, and the
executable always uses native IO.

## Read-only node evidence

Core `32.1.0` is Bitcoin regtest, 134 blocks/headers, IBD false; final height/hash
remained 134 / `4863b764a4b3f3c8a5f976b3e62a69338b7e388fabc863f9142ff531285c2b98`.
Both LND nodes are `0.21.6-beta`, with the expected IDs below, but both sync flags
are false. Matching tips alone do not establish readiness.

The new `HttpsLndInvoiceTransport` with only existing read-only credentials proved:
the legacy invoice is PRESENT / CANCELED, value 50,750, paid 0; the all-zero probe
hash is definitively ABSENT. These are GET-only transport compatibility results.
The guarded preparation path still rejects the unsynchronized nodes. The probe
hash is not a proposed fresh payment hash and grants no authority.

Core wallet `lqwd-lab` is loaded, unencrypted, private-key enabled, not scanning,
and has no external signer. Exact selected input and channel funding proof passed;
wallet locks remained zero. Relay and mempool floor are 0.1 sat/vB, below funding
policy 2 sat/vB. Channel remains active, non-zero-conf, with no pending/unsettled
HTLCs and 4,843,720 sats of usable payer-local/provider-remote liquidity each.

The root application store has no matching legacy swap. The separate existing
`data/approved-reverse-test/state.json` does contain a legacy `INVOICE_CREATED`
swap, revision 2, with an expired quote; its node invoice is canceled. Neither
store has a controlled execution record. Do not import, renew or recreate this
legacy swap through the new preparation harness. Preserve it for separate review.
Existing legacy client/refund vault directories/records have ownership, no symlinks,
one record link and modes 700/600; password authentication/restoration was not tried.

## Exact fresh proposal, still unapproved

| Role or bound | Proposal |
| --- | --- |
| Provider / Lightning invoice recipient / Core funder | `028da6db7cde29666a95581fa6899e549a80d848212dacf868b2793e9b2b84dc00`, REST `https://127.0.0.1:8080`, Core `http://127.0.0.1:18443`, wallet `lqwd-lab` |
| Alice / Lightning source / client | `03bd5a96ed1bf8be9211082f5fae1ee1b206625197abed0d92fc1ee5fc8f6c1553`, REST `https://127.0.0.1:8081` |
| Only first-hop channel | `135239930281985`, funding `ecdb39ab0a5a0fb71fc5b72e4544c0f894a99a68bd94883ec5947819a90f085f:1`, exactly unspent 5,000,000 sats, 12 confirmations |
| Selected input, **approval pending** | `bcd16e1bfa03a65a7013a88a1f0de6e85dde8f530ddd5dd7385b929204522e64:0`, exactly 4,981,994,360 sats, non-coinbase, 18 confirmations, owned native P2WPKH |
| Client claim destination | `bcrt1qzaursu8mptw77dln8d0yy884udfkgacrtd7rd2`, reverified in Alice's external address inventory |
| Provider change/refund/mining destination | `bcrt1qz62y94lnjfj4sqmzwsap2fvleqxkua95znqfwj`, reverified wallet-owned |
| Principal / service / invoice | 50,000 / 750 / **50,750 sats** |
| Claim fee / client net / expected client cost | **500 / 49,500 / 1,250 sats** |
| Funding | One exact input; 2 sat/vB; fee 1–1,000 sats; all change to provider destination, at least 4,981,943,360 sats |
| Routing | Policy ceiling 100 sats; current approved direct-route evidence requires **zero** fees and one-hop approved-channel routes |
| Fresh timeout at unchanged H=134 | **164** (`H+30`); accepted incoming HTLCs expire at least **204**; invoice CLTV delta 80, expiry 3,600 seconds |
| Freshness / mining | Quote 120 seconds, execution request at most 90 seconds and never beyond quote; at most two one-block requests, 1,000,000 attempts each |

Approval must bind the complete large input/value and change script, not only the
50,000-satoshi principal. If height, scope, identities, outpoints, destinations,
fees or freshness change, stop and review a new spec. No automatic renewal/retry.

## Commands and remaining approvals

On the VM, these are safe checks against the staged source:

```bash
cd /tmp/swap-preparation-c7255bc86dbb.rMEJk8rc/source
printf '%s\n' '631d3e5d37e10de63e9b8ba7d8bce94b6a4bf5458c4d0131b17ec48c6e9241cf  ../source.tgz' | sha256sum -c -
node --import tsx scripts/prepare-controlled-reverse.ts --help
ENABLE_LIVE_SWAPS=false node --import tsx scripts/inspect.ts
ENABLE_LIVE_SWAPS=false LND_REST_URL=https://127.0.0.1:8081 \
  LND_TLS_CERT_PATH=/home/truja/.lnd-alice/tls.cert \
  LND_MACAROON_PATH=/home/truja/.lnd-alice/data/chain/bitcoin/regtest/readonly.macaroon \
  node --import tsx scripts/inspect.ts
```

The inspections must fail while the observed sync flags remain false. Do not
mine, restart services, unlock wallets or modify nodes as a workaround in this task.
Separate diagnosis/authorization is required to resolve that readiness blocker.

After synchronized readiness and isolation are independently verified, fresh
durable client preimage/claim-key and provider refund-key records must be provisioned
and privately restored, with a new public hash/keys. Existing canceled-invoice
custody is not fresh custody. A newly reviewed `spec.json` must bind those public
identities and all selections above; no executable fresh spec exists today.
An explicit unexpired preparation approval must bind `preparationDigest(spec)`;
the CLI does not generate that authority. Absolute credential paths remain on VM,
with a separately approved invoice-write macaroon; mutation permissions have not
been tested. Use a new durable private run directory, not a test or legacy store.

The following commands are **future state-changing preparation**, not run here:

```bash
set +x
: "${RUN_DIR:?Set the new private reviewed run directory}"
: "${SPEC_SHA256:?Set the independently reviewed raw spec checksum}"
IFS= read -r -s -p 'Existing run vault passphrase: ' TASK_VAULT_PASSWORD; printf '\n'
printf '%s' "$TASK_VAULT_PASSWORD" | node --import tsx scripts/prepare-controlled-reverse.ts \
  --prepare-invoice-only --run-dir "$RUN_DIR" --spec-sha256 "$SPEC_SHA256"
unset TASK_VAULT_PASSWORD
```

On uncertain creation, preserve the exact store, both custody records, quote,
invoice/wire intents and public artifacts. Never run creation again or remove a
writer lock without independently establishing its writer is gone. With the
inspected persisted revision, this recovery command performs node reads and local
journal reconciliation only; it has no creation/payment/signing/mining capability:

```bash
: "${EXPECTED_REVISION:?Set the inspected persisted swap revision}"
IFS= read -r -s -p 'Existing run vault passphrase: ' TASK_VAULT_PASSWORD; printf '\n'
printf '%s' "$TASK_VAULT_PASSWORD" | node --import tsx scripts/prepare-controlled-reverse.ts \
  --recover-invoice-only --run-dir "$RUN_DIR" --spec-sha256 "$SPEC_SHA256" \
  --expected-revision "$EXPECTED_REVISION"
unset TASK_VAULT_PASSWORD
```

Successful preparation yields an unapproved execution request, not authority to
pay/fund. Review the new exact quote/invoice/hash/script, input, swap revision,
isolation UUID, digest and expiry before any separate execution authorization.
Actual POST compatibility, least-privilege mutation permissions, real custody
authentication and financial/crash/reorg behavior remain untested. No real
preparation or execution command was invoked in this validation task.
