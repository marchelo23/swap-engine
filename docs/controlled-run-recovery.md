# Controlled attempt: safely unwound; PSBT fix ready

The real swap did **not complete**. Alice's 50,750-sat payment reached ACCEPTED,
but funding stopped before signing or broadcast. Core 32 defaults to PSBT v2;
bitcoinjs expects v0. The call now explicitly passes `[..., true, 2, 0]`, retaining
transaction version 2, fixed input, 2 sat/vB and the 1,000-sat funding ceiling.
The omission came from the earlier compatibility edit; explicit v0 restores the
original funding contract rather than changing transaction or fee policy.
No further payment/funding/signing/broadcast was attempted after the coordinator
instructed recovery only.

At **2026-11-18 22:11:27 UTC**:

- Swap `771f48bd-be20-45ca-847d-afb0b85f0afc`: MANUAL_REVIEW, revision **9**;
  original intents and UNKNOWN execution/JIT records retained.
  The fixed native lookup-only CLI independently returned revision 9,
  `state: MANUAL_REVIEW`, `next: MANUAL_REVIEW` without replaying an action;
  this preserves the historical unsigned preparation intent, not an active hold.
- Hash `592fcb0970f800ebeab895e90e8f82bbf7db2e1a794f161f64763beab0651dad`:
  one journaled cancellation, invoice/HTLC **CANCELED**, payer **FAILED**, fee **0**.
  LND's terminal failure record clears its attempt array; the receiver's exact
  canceled HTLC and restored channel balances independently confirm release.
- Original input `bcd16e1bfa03a65a7013a88a1f0de6e85dde8f530ddd5dd7385b929204522e64:0`
  remains unspent, **4,981,994,360 sats**, 20 confirmations. This was the reported
  “funding identifier,” not a lockup transaction. Its unsigned preparation lock
  was released once after cancellation/failure and no-signature/broadcast proof.
- Wallet locks **0**, mempool empty, no lockup, signing or broadcast. Provider
  channel balances **100,000 local / 4,896,530 remote**; Alice balances reversed,
  no pending/unsettled HTLCs. Client payment and payer-send journal now FAILED.
- Exactly one separately journaled readiness block was mined, **135 → 136**;
  execution itself requested **0 blocks**. No mining was repeated.

Run: `/home/truja/reverse-controlled-runs/run-58df3f91-2a27-4012-b70b-0d331f980d64`.
Its `cleanup-cancel-intent.json`, `cleanup-cancel-observed.json`,
`cleanup-unlock-intent.json` and `cleanup-evidence.json` retain before/after proof.
The encrypted primary/backup custody and password escrow remain intact on the VM.

Other changes: explicit protected-cookie local regtest profile (no Core restart),
verified encrypted local-backup scope without claiming physical independence,
one-shot bearer-protected loopback `POST /v1/swaps/:id/execute`, and bounded
post-mining LND synchronization reads. The native operator invokes that API with
the exact approved swap/revision. Default API live creation remains disabled;
frontend, fee policy and existing stores were preserved. Both LND parent
directories were hardened from 775 to 700; no credentials were baked or exposed.

At **22:14:23 UTC**, read-only Core `createpsbt` with a nonexistent dummy input
proved explicit PSBT v0 decodes, default v2 is rejected by bitcoinjs, and the
transaction stays version 2. Wallet locks/mempool were unchanged. The public
unsigned fixture is `tests/fixtures/core32-createpsbt.json`.

Fixed source: `/tmp/swap-execute-65271e8c0549.IoeXl5Bp/source-fixed`, archive SHA
`15501b12d9c0dcad83f69c770d00738f53b14f3e114b241d73e3db86c7722a19`.
VM evidence/logs are in that parent, including `psbt-compatibility-evidence.json`,
`build-fixed.log`, `tests-fixed.log` and the independent reconciliation snapshot.
Local/VM builds passed; the final VM suite ran **302 tests: 301 passed, one
platform skip, zero failures**. The focused local suite passed 21 tests with five
Linux-only skips, including the real Core-format fixture regression.

Next execution must use the **fixed** source and a new run/hash/invoice/approval;
never retry the recovered attempt or clear its original intents. Recheck current
node synchronization, the same unspent input, provider change and Alice claim
destinations, route, custody and fee bounds first. No new financial run was made
after recovery; successful end-to-end execution remains unverified.
