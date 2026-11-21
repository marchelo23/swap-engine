# Fresh controlled reverse swap: review proposal

**Not authorized or executed.** This proposes one isolated regtest run; the selected
input is pending explicit approval. Fresh custody, invoice, swap and authorization
do not yet exist. No payment/signing/broadcast/mining command below was run.
Latest [preparation CLI VM validation](vm-preparation-cli-validation.md) confirms
the selected public roles/outpoints but observes both LND sync flags false at
17:31 UTC. Preparation is blocked; historical synchronized evidence below is not
current authorization or current readiness.

## Exact scope and refreshed evidence

Checked read-only on `truja@192.168.56.108` at **2026-11-18 09:28:11 UTC**.
Core and both LND nodes agreed at height **134**, hash
`4863b764a4b3f3c8a5f976b3e62a69338b7e388fabc863f9142ff531285c2b98`.

| Role | Exact selection |
| --- | --- |
| Lightning source / client | Alice, `03bd5a96ed1bf8be9211082f5fae1ee1b206625197abed0d92fc1ee5fc8f6c1553`, REST `https://127.0.0.1:8081` |
| Invoice recipient / on-chain funder | Provider, `028da6db7cde29666a95581fa6899e549a80d848212dacf868b2793e9b2b84dc00`, REST `https://127.0.0.1:8080`; Core `http://127.0.0.1:18443`, wallet `lqwd-lab` |
| Only permitted first-hop channel | `135239930281985`; funding `ecdb39ab0a5a0fb71fc5b72e4544c0f894a99a68bd94883ec5947819a90f085f:1` |
| Proposed funding input, approval pending | `bcd16e1bfa03a65a7013a88a1f0de6e85dde8f530ddd5dd7385b929204522e64:0`, **4,981,994,360 sats**, 18 confirmations, safe/spendable/solvable/native P2WPKH, wallet-owned and exactly unspent |
| Input's current address | `bcrt1q7tk762uy6d23c0ltwldgn4mvavsynmwgsh6xmq`, script `0014f2eded2b84d3551c3feb77da89d76ceb2049edc8` |
| Client claim destination | `bcrt1qzaursu8mptw77dln8d0yy884udfkgacrtd7rd2`; found in Alice's existing external-address inventory |
| Provider change, refund and mining destination | `bcrt1qz62y94lnjfj4sqmzwsap2fvleqxkua95znqfwj`; Core reports wallet ownership |

The input is large: approval must name this complete outpoint/value, not merely
the 50,000-satoshi principal. Exactly one input is allowed. Funding must have the
50,000-satoshi HTLC output and return **all** remaining value less the bounded
funding fee to the provider destination. At the 1,000-satoshi fee ceiling, change
is at least **4,981,943,360 sats**. No extra input, recipient or fee bump is allowed.
The fresh HTLC address/script cannot be known until fresh public keys/hash exist.

| Amount or limit | Exact value |
| --- | --- |
| HTLC principal | 50,000 sats |
| Service fee / Lightning invoice | 750 / **50,750 sats** |
| Client claim fee / net receipt | **500 / 49,500 sats** |
| Expected client cost | **1,250 sats**; direct routing must prove zero fees |
| Routing policy ceiling | 100 sats; current direct-channel adapter rejects any nonzero fee |
| Funding policy | 2 sat/vB; total funding fee **1–1,000 sats**, paid by provider |
| Quote / authorization expiry | Quote 120 seconds; approval no later than quote expiry, proposed maximum 90 seconds after issuance |
| Invoice / payment observation | Invoice expiry 3,600 seconds, CLTV delta 80; send timeout 60 seconds; client absolute deadline 120 seconds |
| Timeout | At unchanged height 134, **164**; preparation must use fresh `H + 30`, and a changed height requires a new reviewed public plan |
| HTLC acceptance / claim window | Every accepted incoming HTLC expires at least timeout + 40 (**204** for timeout 164); fresh readiness needs 20–40 blocks remaining; funding/claim gates require at least 10 |
| Mining | At most **two one-block requests**, one for exact funding and one for exact claim, at most 1,000,000 attempts each; rewards to provider destination |

Channel is active with no pending HTLCs. Prior exact funding evidence showed
5,000,000-satoshi unspent channel capacity and 4,843,720 sats of usable payer-local
and provider-remote liquidity after reserves/commitment fee, above 50,850 needed.
No input was locked; chain height stayed 134. [VM evidence and test results](vm-controlled-runtime-verification.md)
record build plus 223 passing tests and one Windows-only skip.

## Approval boundaries and preparation defect

The old plan is expired, lacks routing pins and refers to a CANCELED invoice;
there is no matching swap in the inspected root store. Never reuse its payment
hash, edit its expiry, revive that invoice, or copy its quote into a fresh plan.
Existing private custody records remain untouched.

`scripts/verify-hold-invoice.ts` obtains a *second* quote rather than using the
plan's exact quote ID/expiry. The execution backend compares the complete quote,
so chaining the existing preparation helpers is insufficient. The proposed
commands below instead create **one quote in one private store**, bind it to the
plan and swap, then create the invoice through `invoiceOnlyPorts`. This inline
operator harness is a review proposal, not an installed or real-node-tested CLI.
The [implemented preparation harness](controlled-preparation.md) now provides the
single-quote, revision-fenced orchestration and mocked restart tests. It supersedes
the inline preparation orchestration below. The [concrete LND preparation CLI](lnd-invoice-preparation.md)
now supplies the guarded transport and definitive lookup; use that path after
separate approval and real-node compatibility review. The old inline commands are
historical proposals, not a substitute for its guards. No execution authority is
granted by these examples.

Two explicit approvals are required: (1) preparation, including new durable keys,
application store/quote and one unpaid invoice; (2) the resulting exact digest,
input, swap revision, isolation UUID and expiring one-shot execution capability.
The 120-second quote is intentionally not extended; if review or readiness takes
too long, stop and obtain a separately reviewed fresh preparation. Never auto-renew.
Independent verification that this VM/node context is isolated remains an operator
requirement; a regtest label or generated isolation UUID does not prove it.

## Commands: read-only recheck

From Windows, authenticate with the existing key; run the remaining commands in
a VM Bash session. No credentials are copied or placed in command arguments.

```powershell
ssh -t -i C:/Users/rodri/.ssh/id_ed25519_swapvm -o BatchMode=yes -o StrictHostKeyChecking=yes truja@192.168.56.108
```

```bash
export SOURCE=/tmp/swap-runtime-37e637ddd8aa.kjmDM115/final-source
printf '%s\n' '554ab3ee7cf14f8437d58f17263ca4bf183433088eafbb745bf4f2cdc1b76226  /tmp/swap-runtime-37e637ddd8aa.kjmDM115/source-final.tgz' | sha256sum -c -
cd "$SOURCE"
BTC=(bitcoin-cli -regtest -rpcconnect=127.0.0.1 -rpcport=18443 -rpccookiefile=/home/truja/.bitcoin/regtest/.cookie -rpcwallet=lqwd-lab)
"${BTC[@]}" getblockchaininfo
"${BTC[@]}" gettxout bcd16e1bfa03a65a7013a88a1f0de6e85dde8f530ddd5dd7385b929204522e64 0 true
"${BTC[@]}" getaddressinfo bcrt1qz62y94lnjfj4sqmzwsap2fvleqxkua95znqfwj
"${BTC[@]}" listlockunspent
lncli --lnddir=/home/truja/.lnd --network=regtest --rpcserver=127.0.0.1:10009 --macaroonpath=/home/truja/.lnd/data/chain/bitcoin/regtest/readonly.macaroon getinfo
lncli --lnddir=/home/truja/.lnd --network=regtest --rpcserver=127.0.0.1:10009 --macaroonpath=/home/truja/.lnd/data/chain/bitcoin/regtest/readonly.macaroon listchannels
lncli --lnddir=/home/truja/.lnd-alice --network=regtest --rpcserver=127.0.0.1:10010 --macaroonpath=/home/truja/.lnd-alice/data/chain/bitcoin/regtest/readonly.macaroon getinfo
lncli --lnddir=/home/truja/.lnd-alice --network=regtest --rpcserver=127.0.0.1:10010 --macaroonpath=/home/truja/.lnd-alice/data/chain/bitcoin/regtest/readonly.macaroon listchannels
```

Stop on changed identities, channel/outpoint, destination ownership, input amount,
chain/network, synchronization, fees, locks or insufficient liquidity. Readiness
must independently repeat all exact evidence checks, not trust printed balances.

## Proposed preparation command — state-changing, NOT RUN

Only after preparation approval. This creates a new durable directory and custody,
one application quote/swap and one unpaid hold invoice. It does not sign, pay,
fund, broadcast or mine. Existing node credentials are referenced at their VM
paths; provider invoice creation needs the existing mutation-capable macaroon.
Production use should verify least-privilege permissions independently.

```bash
set +x
umask 077
mkdir -p /home/truja/reverse-controlled-runs
export RUN_DIR=$(mktemp -d /home/truja/reverse-controlled-runs/run.XXXXXXXX)
IFS= read -r -s -p 'New run vault passphrase: ' TASK_VAULT_PASSWORD; printf '\n'
node --import tsx --input-type=module 3< <(printf '%s' "$TASK_VAULT_PASSWORD") <<'JS'
import { readFileSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from './src/persistence/Store.ts';
import { SecretVault } from './src/persistence/SecretVault.ts';
import { ClaimWallet } from './src/client/ClaimWallet.ts';
import { RefundKeyVault } from './src/bitcoin/RefundKeyVault.ts';
import { ReadOnlyBitcoinClient, ReadOnlyLndClient } from './src/diagnostics/ReadOnlyClients.ts';
import { LndClient } from './src/lightning/LndClient.ts';
import { SwapManager } from './src/core/SwapManager.ts';
import { SwapCoordinator } from './src/core/SwapCoordinator.ts';
import { invoiceOnlyPorts } from './src/core/InvoiceOnlyPorts.ts';
import { createReverseTestPlan } from './src/core/ReverseTestPlan.ts';
import { createControlledReadiness, persistedReadinessCustody } from './src/core/ControlledReadiness.ts';
import { controlledRunDigest } from './src/core/ControlledReverseBackend.ts';
const dir=process.env.RUN_DIR, password=readFileSync(3);
let store,cv,rv,client;
const save=async(name,value)=>{const f=await open(join(dir,name),'wx',0o600);try{await f.writeFile(JSON.stringify(value,null,2)+'\n');await f.sync();}finally{await f.close();}const d=await open(dir,'r');try{await d.sync();}finally{await d.close();}};
try {
 const bitcoin=new ReadOnlyBitcoinClient('http://127.0.0.1:18443','/home/truja/.bitcoin/regtest/.cookie','lqwd-lab');
 const provider=new LndClient('https://127.0.0.1:8080','/home/truja/.lnd/tls.cert','/home/truja/.lnd/data/chain/bitcoin/regtest/admin.macaroon');
 const payer=new ReadOnlyLndClient('https://127.0.0.1:8081','/home/truja/.lnd-alice/tls.cert','/home/truja/.lnd-alice/data/chain/bitcoin/regtest/readonly.macaroon');
 const chain=await bitcoin.call('getblockchaininfo');
 if(chain.chain!=='regtest'||chain.blocks!==134||chain.headers!==134||chain.initialblockdownload)throw Error();
 cv=await SecretVault.open(join(dir,'client-secrets'),password);rv=await SecretVault.open(join(dir,'provider-refund-keys'),password);password.fill(0);
 client=ClaimWallet.generate();await client.backup(cv);const refunds=new RefundKeyVault(rv);const refund=await refunds.create(client.paymentHash);
 store=await Store.open(join(dir,'store'));const manager=new SwapManager(store);const quote=await manager.quote(50000);
 const nodes={provider:'028da6db7cde29666a95581fa6899e549a80d848212dacf868b2793e9b2b84dc00',payer:'03bd5a96ed1bf8be9211082f5fae1ee1b206625197abed0d92fc1ee5fc8f6c1553'};
 const routing={channelId:'135239930281985',channelPoint:'ecdb39ab0a5a0fb71fc5b72e4544c0f894a99a68bd94883ec5947819a90f085f:1',bitcoinOrigin:bitcoin.origin,providerOrigin:provider.origin,payerOrigin:payer.origin};
 const input={txid:'bcd16e1bfa03a65a7013a88a1f0de6e85dde8f530ddd5dd7385b929204522e64',vout:0};
 const plan=createReverseTestPlan(quote,134,client.toJSON(),refund.publicKey,{claim:'bcrt1qzaursu8mptw77dln8d0yy884udfkgacrtd7rd2',refund:'bcrt1qz62y94lnjfj4sqmzwsap2fvleqxkua95znqfwj'},nodes,routing);
 const scope={...routing,isolationId:randomUUID()};
 const swap=await manager.create(quote.id,'fresh-'+client.paymentHash,plan.contract,134,{onchainSats:4981994360,incomingSats:4843720});
 await save('plan.json',plan);await save('context.json',{input,scope,swapId:swap.id});
 // CREATE_INVOICE is durably journaled by the existing coordinator before the POST.
 const issued=await new SwapCoordinator(store,invoiceOnlyPorts(bitcoin,provider,payer,plan)).issueInvoice(swap.id);
 if(issued.state!=='INVOICE_CREATED')throw Error();
 await createControlledReadiness(store,swap.id,scope,bitcoin,provider,payer,persistedReadinessCustody(cv,refunds))(plan,input);
 const request={id:randomUUID(),swapId:swap.id,expectedRevision:issued.revision,isolationId:scope.isolationId,scope:'isolated-regtest-reverse',maxBlocks:2,expiresAt:Math.min(quote.expiresAt,Date.now()+90000),planDigest:controlledRunDigest(plan,input,swap.id,scope.isolationId)};
 await save('approval-request.json',request);
 console.log(JSON.stringify({status:'PREPARED_UNPAID_NOT_AUTHORIZED',runDirectory:dir,request}));
} catch { console.error('Preparation stopped: preserve this directory and reconcile; do not repeat invoice creation.');process.exitCode=1; }
finally {password.fill(0);client?.destroy();cv?.close();rv?.close();await store?.close();}
JS
unset TASK_VAULT_PASSWORD
```

The printed request, `plan.json`, exact new HTLC/script, public keys/hash, invoice
identity/amount, input value, scope and swap revision must now be reviewed. The
proposal's cached liquidity values are only reservation inputs; concrete readiness
re-reads actual nodes before permitting execution. Any failure stops preparation.

## Proposed one-shot execution command — state-changing, NOT RUN

Only after explicit approval of the exact fresh request, while unexpired. Installing
`approval.json` is a local authority change, not an approval inferred from file
existence. Do not perform this copy or call `execute()` without that authorization.
This phase can pay, lock/sign/fund, broadcast, mine and settle. It uses mutation
credentials; ordinary HTTP remains disabled and no environment flag bypasses it.

```bash
# Only after the exact request has been explicitly approved:
(umask 077; set -C; cat "$RUN_DIR/approval-request.json" > "$RUN_DIR/approval.json")
IFS= read -r -s -p 'Run vault passphrase: ' TASK_VAULT_PASSWORD; printf '\n'
node --import tsx --input-type=module 3< <(printf '%s' "$TASK_VAULT_PASSWORD") <<'JS'
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Store } from './src/persistence/Store.ts';
import { SecretVault } from './src/persistence/SecretVault.ts';
import { RefundKeyVault } from './src/bitcoin/RefundKeyVault.ts';
import { BitcoinRpcClient } from './src/bitcoin/BitcoinRpcClient.ts';
import { LndClient } from './src/lightning/LndClient.ts';
import { HttpsLndPaymentTransport } from './src/lightning/LndPaymentTransport.ts';
import { createControlledReverseRuntime } from './src/core/ControlledReverseRuntime.ts';
const dir=process.env.RUN_DIR,password=readFileSync(3);let store,cv,rv;
try {
 const json=async name=>JSON.parse(await readFile(join(dir,name),'utf8'));
 const plan=await json('plan.json'),context=await json('context.json'),approval=await json('approval.json');
 if(approval.expiresAt<=Date.now()||plan.quote.expiresAt<=Date.now())throw Error();
 store=await Store.open(join(dir,'store'));
 cv=await SecretVault.open(join(dir,'client-secrets'),password);rv=await SecretVault.open(join(dir,'provider-refund-keys'),password);password.fill(0);
 const bitcoin=new BitcoinRpcClient('http://127.0.0.1:18443','/home/truja/.bitcoin/regtest/.cookie','lqwd-lab');
 const provider=new LndClient('https://127.0.0.1:8080','/home/truja/.lnd/tls.cert','/home/truja/.lnd/data/chain/bitcoin/regtest/admin.macaroon');
 const payer=new LndClient('https://127.0.0.1:8081','/home/truja/.lnd-alice/tls.cert','/home/truja/.lnd-alice/data/chain/bitcoin/regtest/readonly.macaroon');
 const paymentTransport=new HttpsLndPaymentTransport(payer.origin,'/home/truja/.lnd-alice/tls.cert','/home/truja/.lnd-alice/data/chain/bitcoin/regtest/admin.macaroon');
 const runtime=createControlledReverseRuntime(store,plan,context.input,context.scope,approval,{bitcoin,provider,payer,paymentTransport,clientVault:cv,refundKeys:new RefundKeyVault(rv)});
 console.log(JSON.stringify(await runtime.execute())); // One call only; never loop/retry.
} catch {console.error('Execution stopped: preserve all intents and use read-only reconciliation; do not retry.');process.exitCode=1;}
finally {password.fill(0);cv?.close();rv?.close();await store?.close();}
JS
unset TASK_VAULT_PASSWORD
```

## Recovery command — no node mutations

After the operator process has stopped and released its store lock, use this exact
evidence-only path. It may update local application reconciliation metadata, but
cannot pay, sign, broadcast, mine, settle, cancel or resume a stage. Never delete
an uncertain intent, reuse approval, run `execute()` again, or clear a stale lock
without independently establishing that its writer is gone.

```bash
node --import tsx --input-type=module <<'JS'
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Store } from './src/persistence/Store.ts';
import { config } from './src/config.ts';
import { configuredReverseRecovery } from './src/api/reverseRecovery.ts';
const dir=process.env.RUN_DIR;let store;
try {
 const plan=JSON.parse(await readFile(join(dir,'plan.json'),'utf8'));
 const context=JSON.parse(await readFile(join(dir,'context.json'),'utf8'));
 store=await Store.open(join(dir,'store'));
 const recovery=configuredReverseRecovery(store,config({ENABLE_LIVE_SWAPS:'false',ENABLE_READ_ONLY_RECOVERY:'true',
  RECOVERY_PROVIDER_NODE_PUBKEY:plan.providerNode,RECOVERY_PAYER_NODE_PUBKEY:plan.payerNode,
  RECOVERY_PAYER_REST_URL:'https://127.0.0.1:8081',RECOVERY_PAYER_TLS_CERT_PATH:'/home/truja/.lnd-alice/tls.cert',
  RECOVERY_PAYER_MACAROON_PATH:'/home/truja/.lnd-alice/data/chain/bitcoin/regtest/readonly.macaroon'}));
 console.log(JSON.stringify(await recovery.reconcile(context.swapId,store.read().swaps[context.swapId].revision)));
} catch {console.error('Recovery evidence unavailable: retain reservations and seek manual review.');process.exitCode=1;}
finally {await store?.close();}
JS
```

Stop on ambiguous payer status/amount/hash/channel, accepted HTLC mismatch, deadline,
changed chain, missing exact witness, unexpected block advance or missing settled
invoice. Client shutdown closes observation only; it does not cancel remote held
HTLCs. Unknown external results retain reservations and one-shot action records.
If funding exists without a confirmed claim, preserve both custody roles and await
separate recovery approval. Refund signing/broadcast/cancellation is not automated
by this runtime; at tip at least 164 for this proposal, independent consensus
validation and a separate reviewed refund plan are required. Never mine extra
blocks to manufacture timeout evidence under this two-block authorization.

Missing today: new client hash/claim key and provider refund key, exact HTLC script
and address, a fresh single quote/unpaid invoice and matching private-store swap,
verified custody restoration, independently verified isolation, final UUIDs/digest/
revision/expiry and explicit input/execution approval. The inline preparation and
execution harness still needs offline review/testing before any real-node use;
node mutation permissions and actual financial/crash/reorg behavior remain unproven.
