import type { Store } from '../persistence/Store.js';
import type { Swap } from '../core/SwapTypes.js';
import type { ReverseTestPlan } from '../core/ReverseTestPlan.js';
import type { SwapPorts } from '../core/SwapCoordinator.js';
import type { BitcoinRpcClient } from '../bitcoin/BitcoinRpcClient.js';
import type { LndClient, Invoice } from '../lightning/LndClient.js';
import type { ApprovedFundingInput } from '../bitcoin/ControlledFunding.js';
import { SwapCoordinator } from '../core/SwapCoordinator.js';
import { transition, updateSwapRevision } from '../core/SwapStateMachine.js';
import { HoldInvoiceManager } from '../lightning/HoldInvoiceManager.js';
import { controlledReversePorts } from '../core/ControlledReversePorts.js';
import { withMiningLock } from '../mining/MiningLock.js';

/** Trusted execution seam for the guest watcher. It is constructed only by an
 * explicit operator wiring; the HTTP service and environment never install it. */
export type GuestExecution = {
  fund(store: Store, swap: Swap, plan: ReverseTestPlan, input?: ApprovedFundingInput): Promise<Swap>;
  confirm(store: Store, swap: Swap, plan: ReverseTestPlan): Promise<Swap>;
  settle(store: Store, swap: Swap, plan: ReverseTestPlan, claimTxid: string): Promise<Swap>;
  markPaid(store: Store, swap: Swap, invoice: Invoice): Promise<Swap>;
  complete(store: Store, swap: Swap, plan: ReverseTestPlan): Promise<Swap>;
  expire(store: Store, swap: Swap): Promise<Swap>;
};
export type GuestPortsFactory = (store: Store, swap: Swap, plan: ReverseTestPlan, input?: ApprovedFundingInput) => SwapPorts;
type ControlledDeps = { bitcoin: Pick<BitcoinRpcClient, 'call' | 'confirmed'>;
  provider: Pick<LndClient, 'call' | 'lookup' | 'settle' | 'cancel'>; payer: Pick<LndClient, 'call'> };
const stopped = () => new Error('Guest execution state changed; reconcile without retry');

/** Production wiring seam: the caller supplies dedicated write-capable clients.
 * The HTTP service never constructs this. */
export function controlledPortsFactory(deps: ControlledDeps): GuestPortsFactory {
  return (store, swap, plan, input) => controlledReversePorts(deps.bitcoin, deps.provider, deps.payer, store, swap.id, plan,
    input && { txid: input.txid, vout: input.vout });
}

type ExecutionOptions = { lockFile?: string; lock?: <T>(work: () => Promise<T>) => Promise<T> };

/** Uses the existing controlled-run coordinator. Funding, settlement and
 * completion hold the same kernel flock as the DS-02 miner; ambiguous outcomes
 * become MANUAL_REVIEW and are never retried by this execution helper. */
export function controlledGuestExecution(portsFactory: GuestPortsFactory, options: ExecutionOptions = {}): GuestExecution {
  const coordinator = (store: Store, swap: Swap, plan: ReverseTestPlan, input?: ApprovedFundingInput) =>
    new SwapCoordinator(store, portsFactory(store, swap, plan, input));
  const lock = options.lock ?? (<T>(work: () => Promise<T>) => withMiningLock(work, { lockFile: options.lockFile }));
  return {
    async fund(store, swap, plan, input) { return lock(async () => {
      let current = swap;
      if (!current.clientPayment) current = await updateSwapRevision(store, current.id, current.revision, value => {
        if (value.state !== 'INVOICE_CREATED' || value.clientPayment) throw stopped();
        value.clientPayment = { hash: value.contract.paymentHash, status: 'IN_FLIGHT', feeLimitSats: 0 };
      });
      if (current.state !== 'INVOICE_CREATED' || current.pendingAction || current.lockup || current.fundingIntent) throw stopped();
      return coordinator(store, current, plan, input).fundAccepted(current.id, current.revision);
    }); },
    async confirm(store, swap, plan) { return coordinator(store, swap, plan).confirmLockup(swap.id); },
    async settle(store, swap, plan, claimTxid) { return lock(() =>
      coordinator(store, swap, plan).observeClaim(swap.id, claimTxid, swap.revision)); },
    async markPaid(store, swap, invoice) {
      const manager = new HoldInvoiceManager({ lookup: async () => invoice,
        settle: async () => { throw new Error('Guest watcher cannot settle directly'); },
        cancel: async () => { throw new Error('Guest watcher cannot cancel directly'); } });
      manager.assertSettled(invoice, swap.contract.paymentHash, swap.quote.invoiceSats);
      return updateSwapRevision(store, swap.id, swap.revision, value => {
        if (value.state !== 'LIGHTNING_SETTLED' || value.clientPayment?.status !== 'IN_FLIGHT') throw stopped();
        value.clientPayment.status = 'SUCCEEDED'; value.clientPayment.feeSats = 0;
      });
    },
    async complete(store, swap, plan) { return lock(() => coordinator(store, swap, plan).complete(swap.id)); },
    async expire(store, swap) {
      return updateSwapRevision(store, swap.id, swap.revision, value => {
        if (value.state !== 'INVOICE_CREATED' || value.lockup || value.fundingIntent || value.pendingAction || value.clientClaimIntent) throw stopped();
        transition(value, 'EXPIRED');
      });
    },
  };
}
