# Local controlled runtime assembly

`createControlledReverseRuntime` assembles existing readiness, funding, payer,
client custody and spend observation adapters for one approved reverse swap.
It is an explicit local capability; construction performs no IO. It is not
installed by startup, HTTP, an environment switch or a runnable default script.
The HTTP execution gate remains closed.

The caller supplies the verified public plan, exact funding input, immutable
isolated scope, expiring local approval, pinned loopback Core/LND clients, bounded
LND payment transport, existing client vault and existing refund key vault.
Construction verifies scope, origins and the approval digest. `inspect()` uses
the existing read-only inspector and restores custody only to check identities.
`execute()` invokes the existing backend once at the approved swap revision.

The assembly delegates controlled funding and exact accepted-invoice checks to
the existing adapters. Wallet preparation/signing/finalization, each exact
broadcast, each single-block mining request and settlement additionally consume
durable `runtimeActions` entries before their external calls. Entries store only
an attempt UUID and status. Unknown results cannot be retried by reconstructing
the assembly or reopening the store. Cleanup fences its own attempt and preserves
another actor's record. Journal revisions are rechecked before mutations; funding
ownership extends across wallet stages so a newer actor cannot authorize further
signing. The existing backend and runner journals remain authoritative.

Client claim signing restores the existing `ClaimWallet`, verifies its identity,
uses confirmed exact funding and the approved destination/fee, then destroys the
wallet in memory. It never generates replacement custody. Claim broadcast requires
the exact durable claim intent, fresh funding/accepted invoice evidence, and
successful mempool validation. The spender observer scans at most 100 blocks from
the verified funding height and validates the exact outpoint, witness, signature,
destination and fee before settlement. No claim witness or preimage enters the
action ledger or public results.

Mining targets the approved wallet-owned refund address, requests exactly one
block with at most 1,000,000 attempts, and checks returned hash and exact height
increase. The backend consumes at most two blocks of budget before calls; unknown
mining results retain both the action record and consumed budget. This follows
the Core [`generatetoaddress` contract](https://developer.bitcoin.org/reference/rpc/generatetoaddress.html).
Controlled funding targets the verified Core 32 contract with seven positional
`walletcreatefundedpsbt` arguments, ending in `true, 2, 0` for bip32 derivations,
transaction version 2 and PSBT version 0. Core 32 defaults to PSBT v2, which the
current bitcoinjs parser cannot consume; omitting the seventh argument stopped
the real attempt before signing. Explicit v0 is restored without changing
funding fees or input policy; see the [actual compatibility and recovery evidence](controlled-run-recovery.md).

`reconcile(revision)` uses only existing-payment lookup, invoice lookup and active
chain evidence. It can run after approval expiry and never resumes execution,
signs, mines, settles, sends or broadcasts. Unsupported evidence remains manual;
there is no automatic refund, cancellation, unknown-action replay or new approval.

Offline tests drive the complete assembly with synthetic wallet PSBT signatures,
restored test custody, mocked LND transport and a fake chain. They cover exact
spender observation, disk intents before calls, unknown replies at every mutation
stage, store reopen, actor conflicts, unavailable custody and changed witnesses.
These tests do not establish real TLS/macaroon permissions, node isolation,
consensus, channel compatibility, deadline behavior or reorg safety.

On this Windows worktree, credential-free TCP probes to `127.0.0.1` ports 18443,
8080 and 8081 returned `ECONNREFUSED`. No node RPC, credential read or VM access
was attempted. Real vault opening also requires verified POSIX permissions.
Subsequent [VM read-only verification](vm-controlled-runtime-verification.md)
successfully staged this runtime, ran the POSIX test suite, and checked actual
Core/LND interfaces without financial operations; its evidence and current
plan/authorization barriers supersede the Windows connectivity limitation above.
Deployment into the independently verified isolated node context, explicit
approval issuance/revocation, least-privilege credentials, operator store-lock
recovery and isolated real-node compatibility/crash/reorg tests remain required.
