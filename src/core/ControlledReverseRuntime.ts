import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { performance } from 'node:perf_hooks';
import { Transaction, address, networks } from 'bitcoinjs-lib';
import { z } from 'zod';
import type { Store } from '../persistence/Store.js';
import type { SecretVault } from '../persistence/SecretVault.js';
import type { RefundKeyVault } from '../bitcoin/RefundKeyVault.js';
import type { BitcoinRpcClient } from '../bitcoin/BitcoinRpcClient.js';
import type { LndClient } from '../lightning/LndClient.js';
import type { PaymentStreamTransport } from '../lightning/LndPaymentTransport.js';
import type { ApprovedFundingInput } from '../bitcoin/ControlledFunding.js';
import type { Swap } from './SwapTypes.js';
import { ClaimWallet } from '../client/ClaimWallet.js';
import { BitcoinConfirmationLookup } from '../bitcoin/BitcoinConfirmationLookup.js';
import { BitcoinSpendObserver } from '../bitcoin/BitcoinSpendObserver.js';
import { verifyHtlcSpend } from '../bitcoin/SpendEvidence.js';
import { ControlledLndPayer } from '../lightning/ControlledLndPayer.js';
import { HoldInvoiceManager } from '../lightning/HoldInvoiceManager.js';
import { LndPayerRecovery, assertRecoveryNode } from '../lightning/LndPayerRecovery.js';
import { createReverseRecovery } from '../api/reverseRecovery.js';
import { createControlledReadiness, persistedReadinessCustody, type ReadinessScope } from './ControlledReadiness.js';
import { controlledReversePorts } from './ControlledReversePorts.js';
import { createControlledReverseBackend, controlledRunDigest, type ControlledRunApproval } from './ControlledReverseBackend.js';
import { verifyReverseTestPlan, type ReverseTestPlan } from './ReverseTestPlan.js';
import type { JitExecutor } from './JustInTimeReverse.js';

type Dependencies = {
  bitcoin: Pick<BitcoinRpcClient, 'origin' | 'call'>;
  provider: Pick<LndClient, 'origin' | 'call' | 'lookup' | 'settle'>;
  payer: Pick<LndClient, 'origin' | 'call'>;
  paymentTransport: PaymentStreamTransport;
  clientVault: SecretVault;
  refundKeys: Pick<RefundKeyVault, 'publicKey'>;
};
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const chainSchema = z.object({ chain: z.literal('regtest'), initialblockdownload: z.literal(false),
  blocks: z.number().int().nonnegative().max(499999999), bestblockhash: hash });
const unavailable = () => new Error('Controlled runtime uncertain or unauthorized; reconcile without retry');

/** Local operator assembly only. Construction performs no IO, custody restore or execution.
 * Supplied clients are trusted transports; no HTTP route or environment flag installs this capability.
 */
export function createControlledReverseRuntime(store: Store, suppliedPlan: ReverseTestPlan, suppliedInput: ApprovedFundingInput,
  suppliedScope: ReadinessScope, suppliedApproval: ControlledRunApproval, deps: Dependencies, executionGuard?: () => void) {
  const plan = verifyReverseTestPlan(structuredClone(suppliedPlan));
  const input = structuredClone(suppliedInput); const scope = structuredClone(suppliedScope);
  const approval = structuredClone(suppliedApproval);
  let fundingRevision: number | undefined;
  const endpoints = () => {
    if (deps.bitcoin.origin !== plan.routing.bitcoinOrigin || deps.provider.origin !== plan.routing.providerOrigin ||
      deps.payer.origin !== plan.routing.payerOrigin || deps.paymentTransport.origin !== plan.routing.payerOrigin) throw unavailable();
  };
  endpoints();
  if (scope.isolationId !== approval.isolationId || Object.entries(plan.routing).some(([key, value]) => scope[key as keyof ReadinessScope] !== value) ||
    approval.planDigest !== controlledRunDigest(plan, input, approval.swapId, approval.isolationId)) throw unavailable();
  const runContext = (active: boolean) => {
    if (active) executionGuard?.();
    endpoints();
    const db = store.read(); const swap = db.swaps[approval.swapId]; const run = db.controlledExecutions?.[approval.id];
    if (!swap || !run || run.swapId !== swap.id || run.planDigest !== approval.planDigest || run.isolationId !== scope.isolationId ||
      JSON.stringify(run.routing) !== JSON.stringify(plan.routing) || run.providerNode !== plan.providerNode || run.payerNode !== plan.payerNode ||
      JSON.stringify(swap.contract) !== JSON.stringify(plan.contract) || JSON.stringify(swap.quote) !== JSON.stringify(plan.quote) ||
      (active && (run.status !== 'INTENT' || approval.expiresAt <= Date.now()))) throw unavailable();
    return { swap, run };
  };
  const nodes = async () => {
    endpoints(); const chain = chainSchema.parse(await deps.bitcoin.call('getblockchaininfo'));
    await assertRecoveryNode(deps.provider, plan.providerNode); await assertRecoveryNode(deps.payer, plan.payerNode);
    endpoints(); return chain;
  };
  // Each external mutation has an additional durable one-shot fence. No result, raw RPC
  // response, PSBT, witness, preimage or credential is written to this action ledger.
  const once = async <T>(key: string, verify: (swap: Swap) => void, action: () => Promise<T>): Promise<T> => {
    const attemptId = randomUUID(); const snapshot = JSON.stringify(runContext(true).swap);
    const unchanged = () => {
      const context = runContext(true);
      if (JSON.stringify(context.swap) !== snapshot) throw unavailable();
      verify(context.swap); return context;
    };
    await nodes(); unchanged();
    await store.transaction(db => {
      const { run } = unchanged();
      if (run.runtimeActions?.[key]) throw unavailable();
      (db.controlledExecutions![approval.id]!.runtimeActions ??= {})[key] = { attemptId, status: 'INTENT' };
    });
    try {
      unchanged();
      const result = await action();
      await store.transaction(db => {
        const record = db.controlledExecutions?.[approval.id]?.runtimeActions?.[key];
        if (record?.attemptId !== attemptId || record.status !== 'INTENT') throw unavailable();
        record.status = 'DONE';
      });
      return result;
    } catch {
      await store.transaction(db => {
        const record = db.controlledExecutions?.[approval.id]?.runtimeActions?.[key];
        if (record?.attemptId === attemptId && record.status === 'INTENT') record.status = 'UNKNOWN';
      });
      throw unavailable();
    }
  };
  const walletMethods = new Set(['getwalletinfo', 'getaddressinfo', 'listunspent', 'listlockunspent']);
  const chainMethods = new Set(['getblockchaininfo', 'getnetworkinfo', 'getmempoolinfo', 'getrawtransaction',
    'getblockheader', 'getblockhash', 'getblock', 'gettxout', 'listwallets', 'testmempoolaccept']);
  const bitcoin = { get origin() { return deps.bitcoin.origin; },
    async call<T>(method: string, params: unknown[] = [], wallet = false): Promise<T> {
      endpoints();
      if ((wallet ? walletMethods : chainMethods).has(method)) return deps.bitcoin.call<T>(method, params, wallet);
      if (['walletcreatefundedpsbt', 'walletprocesspsbt', 'finalizepsbt'].includes(method)) {
        return once(method, swap => {
          const intent = swap.fundingIntent;
          if (swap.revision !== fundingRevision || swap.pendingAction !== 'PREPARE_LOCKUP' || swap.clientPayment?.status !== 'IN_FLIGHT' || !intent ||
            intent.txid !== input.txid || intent.vout !== input.vout || intent.changeAddress !== plan.refundDestination ||
            intent.principalSats !== plan.quote.amountSats || intent.maxFeeSats !== plan.fundingFeeLimitSats ||
            intent.signedHex || (method !== 'walletcreatefundedpsbt' && !intent.unsignedHex)) throw unavailable();
        }, () => deps.bitcoin.call<T>(method, params, wallet));
      }
      if (method === 'sendrawtransaction') {
        const raw = z.string().parse(params[0]); const txid = Transaction.fromHex(raw).getId();
        return once(`broadcast:${txid}`, swap => {
          if (wallet || params.length !== 1 || swap.pendingAction !== 'BROADCAST_LOCKUP' ||
            swap.lockup?.hex !== raw || swap.lockup.txid !== txid || swap.fundingIntent?.signedHex !== raw) throw unavailable();
        }, () => deps.bitcoin.call<T>(method, [raw]));
      }
      throw unavailable();
    },
    confirmed: (txid: string) => new BitcoinConfirmationLookup(bitcoin).confirmed(txid),
  };
  const provider = { get origin() { return deps.provider.origin; },
    call<T>(path: string, body?: unknown): Promise<T> { endpoints(); if (body !== undefined) throw unavailable(); return deps.provider.call<T>(path); },
    lookup: (paymentHash: string) => { endpoints(); if (paymentHash !== plan.contract.paymentHash) throw unavailable(); return deps.provider.lookup(paymentHash); },
    settle: (preimage: string) => once('settle', swap => {
      if (swap.pendingAction !== 'SETTLE' || !swap.claimTxid || !swap.lockup || swap.clientPayment?.status !== 'IN_FLIGHT') throw unavailable();
    }, () => deps.provider.settle(preimage)),
    cancel: async () => { throw unavailable(); },
  };
  const payer = { get origin() { return deps.payer.origin; },
    call<T>(path: string, body?: unknown): Promise<T> { endpoints(); if (body !== undefined) throw unavailable(); return deps.payer.call<T>(path); } };
  const delegated = controlledReversePorts(bitcoin, provider, payer, store, approval.swapId, plan, input);
  const ports = { ...delegated, async prepareLockup(swap: Swap) {
    if (fundingRevision !== undefined || JSON.stringify(runContext(true).swap) !== JSON.stringify(swap)) throw unavailable();
    fundingRevision = swap.revision;
    try { return await delegated.prepareLockup(swap); }
    finally { fundingRevision = undefined; }
  } };
  const inspection = createControlledReadiness(store, approval.swapId, scope, bitcoin, provider, payer,
    persistedReadinessCustody(deps.clientVault, deps.refundKeys));
  const payment = new ControlledLndPayer(store, plan, input, approval, payer, provider, deps.paymentTransport,
    120000, 250, () => { runContext(true); });
  const observer = new BitcoinSpendObserver(bitcoin, store);
  const exactClaim = (raw: string, swap: Swap) => {
    const tx = Transaction.fromHex(raw);
    if (!swap.lockup || verifyHtlcSpend(raw, tx.getId(), swap.lockup.hex, swap.lockup.vout, plan.contract).kind !== 'claim' ||
      tx.ins.length !== 1 || tx.outs.length !== 1 || tx.outs[0]!.value !== BigInt(plan.quote.amountSats - plan.quote.claimFeeSats) ||
      !Buffer.from(tx.outs[0]!.script).equals(address.toOutputScript(plan.claimDestination, networks.regtest))) throw unavailable();
    return tx;
  };
  const confirmedFunding = async (swap: Swap) => {
    if (!swap.lockup) throw unavailable();
    const funding = await bitcoin.confirmed(swap.lockup.txid);
    if (funding.hex !== swap.lockup.hex) throw unavailable();
    return funding;
  };
  const availableFundingOutpoint = async (swap: Swap) => {
    if (!swap.lockup) throw unavailable();
    const funding = await confirmedFunding(swap);
    if (!Number.isSafeInteger(funding.confirmations) || funding.confirmations < 1) throw unavailable();
    const tx = Transaction.fromHex(funding.hex);
    const output = tx.outs[swap.lockup.vout];
    if (tx.getId() !== swap.lockup.txid || !output || output.value !== BigInt(plan.quote.amountSats)) throw unavailable();
    const coin = z.object({ bestblock: hash, confirmations: z.number().int().positive(),
      value: z.number().finite().nonnegative(), scriptPubKey: z.object({ hex: z.string().regex(/^[a-f0-9]+$/) }) })
      .parse(await bitcoin.call('gettxout', [swap.lockup.txid, swap.lockup.vout, true]));
    const chain = chainSchema.parse(await bitcoin.call('getblockchaininfo'));
    if (coin.bestblock !== chain.bestblockhash || coin.value !== plan.quote.amountSats / 1e8 ||
      coin.scriptPubKey.hex !== Buffer.from(output.script).toString('hex')) throw unavailable();
  };
  const held = async (swap: Swap) => {
    const chain = await nodes();
    if (chain.blocks > plan.contract.timeoutHeight - 10) throw unavailable();
    const invoice = await provider.lookup(plan.contract.paymentHash);
    if (invoice.payment_request !== swap.invoice) throw unavailable();
    new HoldInvoiceManager(provider).assertAccepted(invoice, plan.contract.paymentHash, plan.quote.invoiceSats, plan.contract.timeoutHeight, 40);
  };
  const runtime = {
    ports,
    inspect: inspection,
    controls: { claimDestination: plan.claimDestination,
      startPayment: (swap: Swap) => payment.startPayment(swap), waitAccepted: (swap: Swap) => payment.waitAccepted(swap),
      signClaim: async (swap: Swap) => {
        const snapshot = JSON.stringify(swap); await held(swap); await availableFundingOutpoint(swap);
        if (JSON.stringify(runContext(true).swap) !== snapshot || swap.state !== 'LOCKUP_CONFIRMED' || swap.clientClaimIntent) throw unavailable();
        let client: ClaimWallet | undefined;
        try {
          client = await ClaimWallet.restore(deps.clientVault, plan.contract.paymentHash);
          await held(swap); await availableFundingOutpoint(swap);
          if (client.claimPublicKey !== plan.contract.claimPublicKey || JSON.stringify(runContext(true).swap) !== snapshot) throw unavailable();
          return exactClaim(client.signClaim({ contract: plan.contract, lockupTxHex: swap.lockup!.hex, vout: swap.lockup!.vout,
            destination: plan.claimDestination, feeSats: plan.quote.claimFeeSats }).toHex(), swap);
        } catch { throw unavailable(); }
        finally { client?.destroy(); }
      },
      broadcastClaim: async (raw: string) => {
        const swap = runContext(true).swap; const snapshot = JSON.stringify(swap); const tx = exactClaim(raw, swap);
        const verify = (current: Swap) => {
          if (JSON.stringify(current) !== snapshot || current.clientClaimIntent?.status !== 'INTENT' ||
            current.clientClaimIntent.txid !== tx.getId() || current.clientClaimIntent.destination !== plan.claimDestination ||
            current.clientClaimIntent.feeSats !== plan.quote.claimFeeSats) throw unavailable();
        };
        await held(swap); await availableFundingOutpoint(swap); verify(runContext(true).swap);
        const accepted = z.array(z.object({ txid: hash, allowed: z.literal(true) })).length(1)
          .parse(await bitcoin.call('testmempoolaccept', [[raw]]));
        if (accepted[0]!.txid !== tx.getId()) throw unavailable();
        await held(swap); await availableFundingOutpoint(swap);
        return once(`broadcast:${tx.getId()}`, verify, async () => {
          const result = await deps.bitcoin.call<string>('sendrawtransaction', [raw]);
          if (result !== tx.getId()) throw unavailable(); return result;
        });
      },
      findClaim: async (swap: Swap) => {
        await nodes(); const before = chainSchema.parse(await bitcoin.call('getblockchaininfo')); const funding = await confirmedFunding(swap);
        const fromHeight = before.blocks - funding.confirmations + 1;
        const result = await observer.scan(swap.lockup!.txid, swap.lockup!.vout, fromHeight, 100);
        if (result.status !== 'spent' || result.spend.txid !== swap.clientClaimIntent?.txid ||
          chainSchema.parse(await bitcoin.call('getblockchaininfo')).bestblockhash !== before.bestblockhash) throw unavailable();
        exactClaim(result.spend.hex, swap); return result.spend.txid;
      },
    },
    mineOne: async (txid: string) => {
      const chain = await nodes();
      const verify = (swap: Swap) => {
        const run = runContext(true).run; const intent = swap.miningIntents?.at(-1);
        if (!intent || intent.txid !== txid || intent.status !== 'INTENT' || intent.fromHeight !== chain.blocks ||
          (txid !== swap.lockup?.txid && txid !== swap.clientClaimIntent?.txid) || run.blocksRequested < 1 ||
          run.blocksRequested > 2 || chain.blocks > plan.contract.timeoutHeight - 10) throw unavailable();
      };
      verify(runContext(true).swap);
      z.object({ ismine: z.literal(true) }).parse(await bitcoin.call('getaddressinfo', [plan.refundDestination], true));
      await once(`mine:${txid}`, verify, async () => {
        const before = await nodes(); verify(runContext(true).swap);
        if (before.blocks !== chain.blocks || before.bestblockhash !== chain.bestblockhash) throw unavailable();
        const blocks = z.array(hash).length(1).parse(await deps.bitcoin.call('generatetoaddress', [1, plan.refundDestination, 1000000]));
        // Core's mining acknowledgment precedes LND's asynchronous block processing.
        // Observe synchronization without ever repeating the mining request.
        const deadline = performance.now() + 10000;
        for (;;) {
          runContext(true); let synced = true;
          for (const [client, identity] of [[deps.provider, plan.providerNode], [deps.payer, plan.payerNode]] as const) {
            const info = z.object({ identity_pubkey: z.literal(identity), block_height: z.number().int(),
              synced_to_chain: z.boolean(), wallet_synced: z.boolean(),
              chains: z.array(z.object({ chain: z.literal('bitcoin'), network: z.literal('regtest') })).length(1) })
              .parse(await client.call('/v1/getinfo'));
            if (info.block_height > chain.blocks + 1) throw unavailable();
            synced &&= info.block_height === chain.blocks + 1 && info.synced_to_chain && info.wallet_synced;
          }
          if (synced) break;
          if (performance.now() >= deadline) throw unavailable(); await delay(50);
        }
        const after = await nodes();
        if (after.blocks !== chain.blocks + 1 || after.bestblockhash !== blocks[0]) throw unavailable();
      });
    },
  };
  const backend = createControlledReverseBackend(store, plan, input, runtime, approval);
  const recovery = createReverseRecovery(store, ports, new LndPayerRecovery(payer, plan.payerNode, paymentHash => {
    if (paymentHash !== plan.contract.paymentHash) throw unavailable(); runContext(false);
    return { routing: plan.routing, providerNode: plan.providerNode };
  }));
  return {
    inspect: () => inspection(plan, input),
    execute: () => { executionGuard?.(); return backend.execute(approval.swapId, approval.expectedRevision); },
    stopClient: () => payment.stopObservations(),
    reconcile: (expectedRevision: number) => recovery.reconcile(approval.swapId, expectedRevision),
  };
}

/** Local single-use binding. Not registered by HTTP startup or installed by an environment flag. */
export function createJitRuntimeExecutor(store: Store, deps: Dependencies): JitExecutor {
  let invoked = false; let stopped = false; let runtime: ReturnType<typeof createControlledReverseRuntime> | undefined;
  return {
    async execute(context) {
      if (invoked || stopped || context.signal.aborted) throw unavailable(); invoked = true; context.guard();
      const guard = () => { if (stopped || context.signal.aborted) throw unavailable(); context.guard(); };
      runtime = createControlledReverseRuntime(store, context.plan, context.input, context.scope, context.approval, deps, guard);
      const stop = () => runtime!.stopClient(); context.signal.addEventListener('abort', stop, { once: true });
      try { guard(); return await runtime.execute(); }
      finally { context.signal.removeEventListener('abort', stop); runtime.stopClient(); }
    },
    stopClient() { stopped = true; runtime?.stopClient(); },
  };
}
