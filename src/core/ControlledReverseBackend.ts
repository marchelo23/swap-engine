import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { Store } from '../persistence/Store.js';
import type { SwapPorts } from './SwapCoordinator.js';
import { verifyReverseTestPlan, type ReverseTestPlan } from './ReverseTestPlan.js';
import { runControlledReverse, type ReverseTestControls } from './ReverseTestRunner.js';
import { verifyDecodedHoldInvoice } from '../lightning/InvoiceVerification.js';
import type { ApprovedFundingInput } from '../bitcoin/ControlledFunding.js';
import { terminal } from './SwapTypes.js';

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const height = z.number().int().nonnegative().max(499_999_999);
const approvalSchema = z.object({ id: z.uuid(), swapId: z.uuid(), planDigest: hash,
  expectedRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  isolationId: z.uuid(), expiresAt: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  maxBlocks: z.literal(2), scope: z.literal('isolated-regtest-reverse') }).strict();
export type ControlledRunApproval = z.infer<typeof approvalSchema>;
export type ControlledRunReadiness = { network: 'regtest'; isolationId: string; providerNode: string; payerNode: string;
  tipHeight: number; claimPublicKey: string; refundPublicKey: string; paymentHash: string;
  funding: ApprovedFundingInput & { confirmed: boolean; safe: boolean; spendable: boolean; valueSats: number };
  decodedInvoice: unknown };
export type ControlledRunRuntime = {
  ports: SwapPorts;
  controls: Omit<ReverseTestControls, 'mineFor'>;
  /** Trusted server-side inspection of dedicated nodes, approved UTXO and restored custody.
   * This evidence must never come from an HTTP request or an environment approval flag.
   */
  inspect(plan: ReverseTestPlan, input: ApprovedFundingInput): Promise<ControlledRunReadiness>;
  /** Concrete adapter must mine exactly one block, never retry an uncertain RPC. */
  mineOne(txid: string): Promise<void>;
};

export function controlledRunDigest(plan: ReverseTestPlan, input: ApprovedFundingInput, swapId: string, isolationId: string) {
  const verified = verifyReverseTestPlan(plan);
  z.uuid().parse(swapId); z.uuid().parse(isolationId); hash.parse(input.txid);
  if (!Number.isSafeInteger(input.vout) || input.vout < 0 || input.vout > 0xffffffff) throw new Error('Invalid approved input');
  return createHash('sha256').update(JSON.stringify({ plan: verified,
    input: { txid: input.txid, vout: input.vout }, swapId, isolationId, maxBlocks: 2 })).digest('hex');
}

/** Local operator capability only. No default runtime, environment bypass, or HTTP executor exists.
 * Authorization is installed locally and binds the full plan, input, swap, isolation and revision.
 */
export function createControlledReverseBackend(store: Store, suppliedPlan: ReverseTestPlan, suppliedInput: ApprovedFundingInput,
  runtime: ControlledRunRuntime, suppliedApproval?: ControlledRunApproval) {
  const plan = verifyReverseTestPlan(structuredClone(suppliedPlan));
  const input = { txid: suppliedInput.txid, vout: suppliedInput.vout };
  const approval = suppliedApproval ? approvalSchema.parse(structuredClone(suppliedApproval)) : undefined;
  const requireApproval = (id: string, expectedRevision: number) => {
    if (!approval || approval.swapId !== id || approval.expectedRevision !== expectedRevision || approval.expiresAt <= Date.now() ||
      approval.expiresAt > plan.quote.expiresAt || approval.planDigest !== controlledRunDigest(plan, input, id, approval.isolationId)) {
      throw new Error('Controlled execution disabled: exact current local authorization required');
    }
    return approval;
  };
  const current = (id: string, expectedRevision: number) => {
    const db = store.read(); const swap = db.swaps[id];
    if (!swap || swap.revision !== expectedRevision || swap.state !== 'INVOICE_CREATED' || !swap.invoice ||
      swap.pendingAction || swap.clientPayment || swap.lockup || swap.fundingIntent || swap.clientClaimIntent ||
      swap.claimTxid || swap.refundTxid || swap.miningIntents?.length ||
      Object.values(db.controlledExecutions ?? {}).some(run => run.swapId === id)) throw new Error('Existing or uncertain execution requires reconciliation');
    if (Object.values(db.swaps).some(other => other.id !== id && !terminal.has(other.state))) throw new Error('Execution store is not isolated to one active swap');
    if (JSON.stringify(swap.contract) !== JSON.stringify(plan.contract) || JSON.stringify(swap.quote) !== JSON.stringify(plan.quote) ||
      runtime.controls.claimDestination !== plan.claimDestination || Date.now() >= plan.quote.expiresAt || plan.createdAt > Date.now()) throw new Error('Execution differs from current approved plan');
    return swap;
  };
  return {
    async execute(id: string, expectedRevision: number) {
      const authorized = requireApproval(id, expectedRevision);
      const initial = current(id, expectedRevision);
      await runtime.ports.assertRegtest();
      const observed = await runtime.inspect(structuredClone(plan), { ...input });
      if (observed.network !== 'regtest' || observed.isolationId !== authorized.isolationId ||
        observed.providerNode !== plan.providerNode || observed.payerNode !== plan.payerNode ||
        observed.claimPublicKey !== plan.contract.claimPublicKey || observed.refundPublicKey !== plan.contract.refundPublicKey ||
        observed.paymentHash !== plan.contract.paymentHash || !Number.isSafeInteger(observed.tipHeight) ||
        observed.tipHeight < plan.tipHeight || observed.tipHeight > plan.contract.timeoutHeight - 10 ||
        observed.funding.txid !== input.txid || observed.funding.vout !== input.vout ||
        observed.funding.confirmed !== true || observed.funding.safe !== true || observed.funding.spendable !== true ||
        !Number.isSafeInteger(observed.funding.valueSats) || observed.funding.valueSats <= plan.quote.amountSats ||
        (await runtime.ports.tip()) !== observed.tipHeight) throw new Error('Isolated execution readiness unverified');
      verifyDecodedHoldInvoice(initial.invoice!, observed.decodedInvoice, { paymentHash: plan.contract.paymentHash,
        payeePublicKey: plan.providerNode, invoiceSats: plan.quote.invoiceSats, minFinalCltv: plan.invoiceCltvDelta });
      requireApproval(id, expectedRevision);
      if (JSON.stringify(current(id, expectedRevision)) !== JSON.stringify(initial)) throw new Error('Swap changed during readiness verification');
      await store.transaction(db => {
        requireApproval(id, expectedRevision);
        if (JSON.stringify(db.swaps[id]) !== JSON.stringify(initial) ||
          db.controlledExecutions?.[authorized.id] || Object.values(db.controlledExecutions ?? {}).some(run => run.swapId === id) ||
          Object.values(db.swaps).some(other => other.id !== id && !terminal.has(other.state))) throw new Error('Execution reservation conflict');
        (db.controlledExecutions ??= {})[authorized.id] = { swapId: id, planDigest: authorized.planDigest,
          isolationId: authorized.isolationId, routing: structuredClone(plan.routing), providerNode: plan.providerNode, payerNode: plan.payerNode,
          status: 'INTENT', blocksRequested: 0 };
      });
      try {
        const activeApproval = () => {
          if (authorized.expiresAt <= Date.now()) throw new Error('Controlled execution authorization expired');
          const db = store.read(); const swap = db.swaps[id]; const run = db.controlledExecutions?.[authorized.id];
          if (!swap || JSON.stringify(swap.contract) !== JSON.stringify(plan.contract) || JSON.stringify(swap.quote) !== JSON.stringify(plan.quote) ||
            runtime.controls.claimDestination !== plan.claimDestination || run?.status !== 'INTENT' || run.planDigest !== authorized.planDigest ||
            JSON.stringify(run.routing) !== JSON.stringify(plan.routing) || run.providerNode !== plan.providerNode || run.payerNode !== plan.payerNode) {
            throw new Error('Controlled execution context changed');
          }
        };
        const ports: SwapPorts = { assertRegtest: async () => { activeApproval(); await runtime.ports.assertRegtest(); },
          invoice: hash => runtime.ports.invoice(hash), tip: () => runtime.ports.tip(), confirmed: txid => runtime.ports.confirmed(txid),
          createInvoice: async () => { throw new Error('Execution cannot recreate an invoice'); },
          prepareLockup: swap => { activeApproval(); return runtime.ports.prepareLockup(swap); },
          broadcast: hex => { activeApproval(); return runtime.ports.broadcast(hex); },
          settle: preimage => { activeApproval(); return runtime.ports.settle(preimage); },
          cancel: async () => { throw new Error('Execution cannot cancel or refund automatically'); } };
        const result = await runControlledReverse(store, ports, {
          claimDestination: plan.claimDestination,
          routingFeeLimitSats: plan.routingFeeLimitSats,
          startPayment: swap => { activeApproval(); return runtime.controls.startPayment(swap); },
          waitAccepted: swap => runtime.controls.waitAccepted(swap),
          signClaim: swap => { activeApproval(); return runtime.controls.signClaim(swap); },
          broadcastClaim: hex => { activeApproval(); return runtime.controls.broadcastClaim(hex); },
          findClaim: swap => runtime.controls.findClaim(swap),
          mineFor: async txid => {
            await ports.assertRegtest();
            const before = height.parse(await runtime.ports.tip());
            if (before >= plan.contract.timeoutHeight - 10) throw new Error('Mining exceeds safe claim window');
            await store.transaction(db => {
              const swap = db.swaps[id]!; const run = db.controlledExecutions![authorized.id]!;
              const mining = swap.miningIntents?.at(-1);
              if (run.status !== 'INTENT' || run.blocksRequested >= authorized.maxBlocks ||
                (txid !== swap.lockup?.txid && txid !== swap.clientClaimIntent?.txid) ||
                mining?.txid !== txid || mining.status !== 'INTENT' || mining.fromHeight !== before) throw new Error('Mining request lacks bounded durable intent');
              run.blocksRequested++; // Consume budget before the call, including unknown outcomes.
            });
            activeApproval();
            await runtime.mineOne(txid);
            if (height.parse(await runtime.ports.tip()) !== before + 1) throw new Error('Mining did not produce exactly one observed block');
          },
        }, id);
        await store.transaction(db => { db.controlledExecutions![authorized.id]!.status = 'COMPLETED'; });
        return { id: result.id, state: result.state, revision: result.revision };
      } catch {
        await store.transaction(db => { db.controlledExecutions![authorized.id]!.status = 'UNKNOWN'; });
        throw new Error('Controlled execution uncertain; reconcile existing evidence without retry');
      }
    },
  };
}
