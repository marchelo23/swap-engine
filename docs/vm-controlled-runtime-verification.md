# VM controlled runtime verification

Read-only verification on `truja@192.168.56.108`, 2026-11-18, used the existing
SSH key noninteractively with strict host-key checking. Existing VM credentials
were read only by local VM clients; no credentials or vault contents were copied
or printed. No financial operation, service restart or existing deployment edit
was performed. HTTP execution remains gated.

## Isolated artifact and tests

- Final source: `/tmp/swap-runtime-37e637ddd8aa.kjmDM115/final-source`.
- Snapshot: `source-final.tgz`, SHA-256
  `554ab3ee7cf14f8437d58f17263ca4bf183433088eafbb745bf4f2cdc1b76226`.
- The 105-file snapshot includes tracked and untracked source/tests/docs, excluding
  `.git`, application data, credentials and local dependencies. VM dependencies
  are a symlink to the existing installation; package-lock contents matched.
- VM: Linux, Node `v22.22.1`, npm `9.2.0`; build passed; full suite **223 passed,
  0 failed, 1 Windows-only skip**, 224 total. Both POSIX custody tests passed.
- Earlier snapshots/logs remain intact. Initial runs exposed a deadline test that
  assumed preflight completed within 30 ms, and an unsafe-permissions fixture
  neutralized by `umask 077`. Only those fixtures changed: deterministic timer
  advancement after connection, and explicit unsafe fixture permissions.
- Local build and `git diff --check` also passed; all 16 payer tests passed locally.

Evidence files in the same VM temp parent: `build-final.log`, `tests-final.log`,
`readonly.json`, `transport-readonly.json`, `payer-evidence-readonly.json`,
`input-channel-readonly.json`, `custody-metadata-readonly.json`, `spend-check.log`.
Only projected public metadata is in the node evidence reports.

## Actual node evidence

- Core `32.1.0`, provider and payer LND `0.21.6-beta`: synchronized Bitcoin regtest
  at height **134**, matching hash
  `4863b764a4b3f3c8a5f976b3e62a69338b7e388fabc863f9142ff531285c2b98`.
- Loopback REST with certificate validation and existing read-only macaroons
  worked on the VM. Unary existing-payment recovery and GET-only tracking passed
  through the current adapters for an existing historical 100,000-satoshi payment;
  this is not evidence of the planned 50,750-satoshi payment. Tracking the canceled
  plan's absent payment failed closed. Independent invoice decoding matched its
  hash, payee, 50,750-satoshi amount and CLTV 80.
- Core active-chain transaction verification and bounded exact spender observation
  passed against existing history. RPC `help` confirmed supported parameter shapes
  without invoking wallet preparation, signing, mempool validation or mining.
- Channel `135239930281985`, funding outpoint
  `ecdb39ab0a5a0fb71fc5b72e4544c0f894a99a68bd94883ec5947819a90f085f:1`:
  active, no pending HTLCs/unsettled funds, exact confirmed unspent 5,000,000-satoshi
  capacity output. Payer available and provider incoming balances after reserves
  and commitment fee were each 4,843,720 satoshis, exceeding 50,850 required.
- Wallet `lqwd-lab` was loaded, unencrypted, private-key enabled and not scanning,
  with no external signer or locked inputs. An eligible native P2WPKH candidate
  passed exact prevout, confirmation, ownership and reserve checks; it remains
  **unapproved** and was neither locked nor spent. Fee floors were 0.1 sat/vB,
  below the existing 2 sat/vB funding policy.
- Existing client/refund custody directories and records had correct ownership,
  no symlinks, and modes 700/600. Existing vaults were not decrypted or modified.
- Final height/hash and zero wallet locks matched the initial observations.

## Execution barriers and integration

The existing public plan has tip 129 / timeout 159, an expired quote, no mandatory
routing pins, and a **CANCELED** invoice. Its identities match the nodes, but the
current schema rejects it. The existing application store contains no matching
swap and no controlled execution records. Full approved readiness therefore cannot
pass; no plan, invoice, store entry or approval was manufactured to bypass this.
The attempted health GET on port 3000 was unavailable; no application was started.

For later, separately authorized integration, install the staged factory in a
local operator process with pinned loopback clients, independently verified
isolation scope, existing custody vaults, a fresh complete plan/unpaid invoice and
matching durable swap, an explicitly approved input, and a short-lived approval
binding the exact digest and revision. Unlock custody privately and supply scoped
mutation credentials only after authorization; do not expose client custody or
`execute()` through HTTP. Construction is inert, `inspect()` is read-only, and
`reconcile(revision)` observes existing evidence without resuming actions.
Actual send/settle, funding/signing/broadcast/mining, live custody restoration,
deadline behavior, isolation guarantees and real-node crash/reorg recovery remain
unverified. No such operation was attempted in this task.
