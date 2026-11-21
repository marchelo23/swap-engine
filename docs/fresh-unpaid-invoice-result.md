# Fresh unpaid controlled reverse invoice

One authorized **50,750-satoshi hold invoice** was created and independently
verified OPEN, unpaid, with zero HTLCs at **2026-11-18 17:48:53 UTC**.
The native lookup-only recovery CLI passed in a new invocation, retained revision
3 and reused the identical public artifact. No payment, wallet signing, transaction
broadcast or mining was performed; no execution authorization was installed.

## Exact result

| Field | Value |
| --- | --- |
| VM run directory | `/home/truja/reverse-controlled-runs/run-73b9bedd-ab29-4b74-89a2-13fa07ca78f4` |
| Swap / revision | `e8f26d8e-4feb-41b0-85d2-00b318c17e4b` / **3** |
| Preparation ID | `73b9bedd-ab29-4b74-89a2-13fa07ca78f4` |
| Isolation assertion | `e30d40fa-03d4-4e3d-8d8a-62cf8846b93e` |
| Fresh payment hash | `8a2c173be5eb26e0aed6f3ef329f1592e67956c4d03457e53cc661a140024793` |
| Client claim public key | `027024ab692217dc1a33246ba86088df3e6c9846c2e80799bcf34705dc7dbf8e50` |
| Provider refund public key | `0248aba91999bb790b5b1300f6160fe2709502d7c212ef0a7dd7798dbf6505ff01` |
| Fresh HTLC address | `bcrt1qsvyhhp7r6zhd6f9xa2rhlup5v8l24tcwxg7rk5j8ftszj0sakc0qvtp3u8` |
| Timeout / minimum accepted HTLC expiry | **165 / 205** |
| Principal / service / invoice | **50,000 / 750 / 50,750 sats** |
| Claim fee / client net | **500 / 49,500 sats** |
| Funding / routing ceilings | 2 sat/vB and at most **1,000 sats**; routing policy cap 100 sats, current direct-route adapter requires **zero** routing fee |
| Quote UUID | `b117df1f-4533-4c3f-a976-f399856fa5ca` |
| Quote expires | **2026-11-18 17:49:48.733 UTC** |
| Unapproved execution-request UUID | `96e88b84-ba62-480e-b6d5-fa6e5a38dc24` |
| Request digest | `80c52c5609505339009217ddf24eca64d8a9a18e8b9c5973230f1ed425dc8ecc` |
| Request expires | **2026-11-18 17:49:21.226 UTC** |
| Invoice expires | **2026-11-18 18:47:49 UTC**; invoice CLTV 80, expiry 3,600 seconds |
| Reviewed spec SHA-256 | `85ca63106d016c44e7883600c4327ce6f12638f0a8aa2c9e3c120ed77a323b34` |
| Public artifact SHA-256 | `82def5155d5f88aca59a1a06b70af3be9669fed1450a5b8a9b56f23a7e1cfe2f` |

At **2026-11-18 17:51:39 UTC**, a final GET confirmed OPEN, paid 0 and zero HTLCs,
and **both the quote and execution request were expired**. No renewal was attempted.
These are exact historical deadlines, not renewable authority. Stop: do not pay,
edit expiry, install stale authority,
recreate the invoice or rerun creation. The invoice remaining OPEN does not extend
the quote or permit payment. A separately reviewed future plan is required.

## Safeguards and custody

Core and both LND nodes were synchronized at height **135**, block
`2d303a7392d749e199a0d8014a5190b7be82072bfd02cae7e426ce2c19324bfd`.
Both LND chain/wallet sync flags were true before preparation and after verification.
The selected channel remained active with no pending/unsettled HTLCs, and wallet
locks remained zero. Exactly one quote, swap, preparation and durable invoice
attempt exist in the fresh store. There is no client payment, funding intent,
lockup, pending action or controlled execution reservation.

The existing invoice-scoped macaroon was decoded locally without exposing its
contents: its only permissions are `invoices:read` and `invoices:write`. It is a
regular owned single-link file protected by the owned mode-700 `.lnd/data`
ancestor. An initial file-mode-only admin credential check failed; admin was not
used, no credential permissions were changed, and no credentials were copied.

Fresh client preimage/claim key and provider refund key were generated on the VM,
stored in role/hash-bound encrypted vault records, then the wallets/vaults were
closed and reopened. Restored hash/public keys matched before invoice creation;
native CLI preparation and recovery verified them again. Directories/records are
owned, private (700/600), exclusive and fsynced. Passphrase contents were never
logged, passed in argv/environment or copied off the VM. Owner-only recovery
escrow is outside the public artifact/custody directories at
`/home/truja/reverse-controlled-passphrases/73b9bedd-ab29-4b74-89a2-13fa07ca78f4.passphrase`.
This is same-VM operator escrow, not an independent disaster-recovery backup;
operator backup/retention review remains required before any payment/funding.

Independent payer decoding matched the new hash, provider payee, **50,750,000
msat**, CLTV 80 and expiry. The raw payment request and all private key/preimage
material remain in the private VM store/vaults, outside this report.

The source is the previously tested snapshot
`631d3e5d37e10de63e9b8ba7d8bce94b6a4bf5458c4d0131b17ec48c6e9241cf`
at `/tmp/swap-preparation-c7255bc86dbb.rMEJk8rc/source` (VM build and 264 tests
passed, one Windows-only skip). No application source or HTTP gate changed here.

## Roles, selected input and evidence locations

Provider invoice recipient/Core funder:
`028da6db7cde29666a95581fa6899e549a80d848212dacf868b2793e9b2b84dc00`.
Alice Lightning source/client:
`03bd5a96ed1bf8be9211082f5fae1ee1b206625197abed0d92fc1ee5fc8f6c1553`.
Only channel `135239930281985`, funding outpoint
`ecdb39ab0a5a0fb71fc5b72e4544c0f894a99a68bd94883ec5947819a90f085f:1`.
Selected future funding input remains unspent and **not approved for spending**:
`bcd16e1bfa03a65a7013a88a1f0de6e85dde8f530ddd5dd7385b929204522e64:0`,
**4,981,994,360 sats**. A later spending approval must protect all change, at least
4,981,943,360 sats at the funding-fee ceiling, to provider destination
`bcrt1qz62y94lnjfj4sqmzwsap2fvleqxkua95znqfwj`.
Client claim destination remains Alice-owned
`bcrt1qzaursu8mptw77dln8d0yy884udfkgacrtd7rd2`.

VM run files: `spec.json`, `credential-paths.json` (paths only),
`preparation-approval.json` (invoice-only), `prepared-public.json`, `store/state.json`,
`client-secrets/`, `provider-refund-keys/`. No execution `approval.json` exists.
Sanitized audit files are under `/tmp/swap-fresh-442e48ecdb07.PrflpJeY/`:
`run-location.json`, `custody-summary.json`, `preparation-authority.json`,
`invoice-evidence.json`, `final-deadline-check.json`; bootstrap source is also retained there. Do not copy
private vault/password/store contents into logs or reset any preparation journal.

Remaining blockers: expired quote/request, separate input/spending and execution
approval, newly reviewed current chain/invoice evidence, independent custody backup review, and actual
financial/crash/reorg validation. This task authorized and performed preparation
only. No payment, transaction signing/broadcast or mining command is authorized
by its successful result.
