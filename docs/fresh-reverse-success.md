# Fresh regtest reverse swap completed

Verified **2026-11-18 22:28:41 UTC**; swap
`629d3df3-af89-430a-b17e-aecf60b5e1d8` is **COMPLETED**, revision **20**.
Alice paid **50,750 sats**; the provider invoice is **SETTLED**, payer
**SUCCEEDED**, routing fee **0**. Alice's wallet independently lists the confirmed
**49,500-sat** claim UTXO at its existing recipient address
`bcrt1qzaursu8mptw77dln8d0yy884udfkgacrtd7rd2`.

| Evidence | Result |
| --- | --- |
| Invoice/payment hash | `6f5545ff556fcea9dff65178787115d9a08c4a74d1d194f8b664f586863fe41c` |
| Funding / exact HTLC outpoint | `710a474d7fe1856c89c9a9bbcd1d94eeee07ff5e8600c3ec26d1c31b546a5d28:0`, **50,000 sats**, **2 confirmations** |
| Claim transaction | `e7006540b498bccbc02faa3b6ad82192661c0daca7ab8d32b9a5cb87d88e2d60`, **1 confirmation** |
| Funding / claim / route fees | **306 / 500 / 0 sats**, within 1,000 / 500 / 100 ceilings |
| Exact provider input | `bcd16e1bfa03a65a7013a88a1f0de6e85dde8f530ddd5dd7385b929204522e64:0`, **4,981,994,360 sats** |
| Provider change | Funding vout **1**, **4,981,944,054 sats**, `bcrt1qz62y94lnjfj4sqmzwsap2fvleqxkua95znqfwj` |
| Approved direct channel | `135239930281985`, funding `ecdb39ab0a5a0fb71fc5b72e4544c0f894a99a68bd94883ec5947819a90f085f:1` |
| Confirmation mining | Exactly **two** requests, heights **136 → 138** |
| Journal / restart proof | One payer send, eight runtime actions DONE, JIT COMPLETED; separate-process lookup-only reconciliation returned **DONE** |

Independent Core evidence verified the active-chain transactions, exact input and
outpoint, valid claim witness/signature, destinations and fee arithmetic. The
original input and HTLC are now spent by this fresh transaction/claim; change and
Alice's receipt are unspent and confirmed. Wallet locks are zero.

Before this run, the prior `771f48bd...` attempt was independently confirmed
CANCELED/FAILED with zero fee and its input released. Its recovered journal was
preserved; that released input was then spent by this new successful funding
transaction. Fresh keys/hash, encrypted primary/backup restore, Alice ownership,
node identity/synchronization, channel liquidity and exact fee bounds were proven
before one-shot execution. No action was blindly retried and no additional
readiness block was needed in this task. General HTTP live creation stays closed.

Run: `/home/truja/reverse-controlled-runs/run-ef5eae12-e301-4c21-a35c-7386f7a1fe48`.
Encrypted local backup: sibling `backup-ef5eae12-e301-4c21-a35c-7386f7a1fe48`;
existing private password escrow remains on the VM, never printed/copied.
Source: `/tmp/swap-execute-65271e8c0549.IoeXl5Bp/source-fixed`, archive SHA-256
`15501b12d9c0dcad83f69c770d00738f53b14f3e114b241d73e3db86c7722a19`
(previously verified build and 301 passing tests, one platform skip).

Sanitized evidence: `/tmp/swap-fresh-b87856ac7e67.HyYZmB9f/` contains
`execution-result.json`, `independent-completion-evidence.json`,
`alice-receipt.json`, `execute.stdout`, `reconcile.stdout`, preparation/readiness
receipts and the one-shot operator script. No further financial work remains for
this authorized bounded test.
