import type { Store } from '../persistence/Store.js';
import { SwapCoordinator, type SwapPorts } from '../core/SwapCoordinator.js';
import type { ReverseReconcileControls } from '../core/ReverseTestRunner.js';
import { ReconcileResponse } from './schemas.js';
import { LndRecoveryClient, LndPayerRecovery, assertRecoveryNode } from '../lightning/LndPayerRecovery.js';
import { ReadOnlyBitcoinClient } from '../diagnostics/ReadOnlyClients.js';
import type { config } from '../config.js';
import { reverseRoutingSchema } from '../core/ReverseTestPlan.js';

export class RecoveryConflict extends Error {}
export class RecoveryNotFound extends Error {}

type EvidencePorts = Pick<SwapPorts, 'assertRegtest' | 'invoice' | 'tip' | 'confirmed'>;
const disabled = async (): Promise<never> => { throw new Error('Recovery cannot execute external actions'); };
const noActions = { createInvoice: disabled, prepareLockup: disabled, broadcast: disabled, settle: disabled, cancel: disabled };

/** Crash fallback requires no RPC capability or credentials and retains reservations. */
export function recoverInterruptedReverseRuns(store: Store): Promise<void> {
  return new SwapCoordinator(store, { ...noActions, assertRegtest: disabled, invoice: disabled,
    tip: disabled, confirmed: disabled }).recover();
}

/** Opt-in evidence reconciliation only. This capability cannot resume the runner or send funds.
 * The HTTP caller supplies a revision, never payment or chain evidence.
 */
export function createReverseRecovery(store: Store, evidence: EvidencePorts, payer: ReverseReconcileControls) {
  const ports: SwapPorts = { ...noActions,
    assertRegtest: () => evidence.assertRegtest(), invoice: hash => evidence.invoice(hash),
    tip: () => evidence.tip(), confirmed: txid => evidence.confirmed(txid) };
  const coordinator = new SwapCoordinator(store, ports);
  return {
    async reconcile(id: string, expectedRevision: number) {
      if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) throw new RecoveryConflict('Invalid revision');
      const swap = store.read().swaps[id];
      if (!swap) throw new RecoveryNotFound('Swap missing');
      if (swap.revision !== expectedRevision) throw new RecoveryConflict('Stale revision');
      try {
        const report = await coordinator.reconcileReverse(id, expectedRevision, hash => payer.lookupPayment(hash));
        // Explicit projection: neither raw swap journals nor adapter-owned data reaches HTTP.
        return ReconcileResponse.parse({ id: report.swap.id, revision: report.swap.revision,
          state: report.swap.state, next: report.next });
      } catch (error) {
        if (store.read().swaps[id]?.revision !== expectedRevision) throw new RecoveryConflict('Swap changed during reconciliation');
        throw error;
      }
    },
  };
}

export type ReverseRecovery = ReturnType<typeof createReverseRecovery>;

/** Constructs read capabilities only; disabled configuration does not instantiate transports. */
export function configuredReverseRecovery(store: Store, settings: ReturnType<typeof config>): ReverseRecovery | undefined {
  const recovery = settings.recovery;
  if (!recovery) return undefined;
  const bitcoin = new ReadOnlyBitcoinClient(settings.bitcoinUrl, settings.cookie, settings.wallet);
  const provider = new LndRecoveryClient(settings.lndUrl, settings.cert, settings.macaroon);
  const payer = new LndRecoveryClient(recovery.payerUrl, recovery.payerCert, recovery.payerMacaroon);
  return createReverseRecovery(store, {
    assertRegtest: async () => {
      await bitcoin.assertRegtest();
      await assertRecoveryNode(provider, recovery.providerNode);
      await assertRecoveryNode(payer, recovery.payerNode);
    },
    invoice: async hash => {
      await assertRecoveryNode(provider, recovery.providerNode);
      const invoice = await provider.lookup(hash);
      await assertRecoveryNode(provider, recovery.providerNode);
      return invoice;
    },
    tip: async () => {
      const info = await bitcoin.call<{ chain: string; blocks: number; initialblockdownload: boolean }>('getblockchaininfo');
      if (info.chain !== 'regtest' || info.initialblockdownload !== false || !Number.isSafeInteger(info.blocks) || info.blocks < 0) throw new Error('Recovery tip unavailable');
      return info.blocks;
    },
    confirmed: txid => bitcoin.confirmed(txid),
  }, new LndPayerRecovery(payer, recovery.payerNode, hash => {
    const db = store.read(); const matches = Object.values(db.swaps).filter(s => s.contract.paymentHash === hash);
    if (matches.length !== 1) throw new Error('Recovery payment identity ambiguous');
    const swap = matches[0]!;
    const runs = Object.values(db.controlledExecutions ?? {}).filter(run => run.swapId === swap?.id);
    if (!runs.length) return undefined;
    if (runs.length !== 1 || runs[0]!.providerNode !== recovery.providerNode || runs[0]!.payerNode !== recovery.payerNode) throw new Error('Controlled recovery identity changed');
    const routing = reverseRoutingSchema.parse(runs[0]!.routing);
    if (routing.payerOrigin !== payer.origin || routing.providerOrigin !== provider.origin || routing.bitcoinOrigin !== bitcoin.origin) throw new Error('Controlled recovery endpoint changed');
    return { routing, providerNode: recovery.providerNode };
  }));
}
