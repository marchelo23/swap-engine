import { Transaction } from 'bitcoinjs-lib';
import { z } from 'zod';
import type { BitcoinRpcClient } from '../bitcoin/BitcoinRpcClient.js';
import type { LndClient } from '../lightning/LndClient.js';
import type { Store } from '../persistence/Store.js';
import type { SwapPorts } from './SwapCoordinator.js';
import { verifyReverseTestPlan, type ReverseTestPlan } from './ReverseTestPlan.js';
import { prepareControlledFunding, type ApprovedFundingInput } from '../bitcoin/ControlledFunding.js';
import { verifyHtlcSpend } from '../bitcoin/SpendEvidence.js';
import { HoldInvoiceManager } from '../lightning/HoldInvoiceManager.js';

/** Explicit controlled-test capability, never constructed by the HTTP service. */
export function controlledReversePorts(bitcoin: Pick<BitcoinRpcClient, 'call' | 'confirmed'>,
  provider: Pick<LndClient, 'call' | 'lookup' | 'settle' | 'cancel'>, payer: Pick<LndClient, 'call'>,
  store: Store, id: string, approved: ReverseTestPlan, input?: ApprovedFundingInput): SwapPorts {
  const plan = verifyReverseTestPlan(approved);
  const current = () => {
    const swap = store.read().swaps[id];
    if (!swap || swap.contract.paymentHash !== plan.contract.paymentHash || swap.contract.claimPublicKey !== plan.contract.claimPublicKey ||
      swap.contract.refundPublicKey !== plan.contract.refundPublicKey || swap.contract.timeoutHeight !== plan.contract.timeoutHeight) throw new Error('Controlled swap identity changed');
    for (const key of ['amountSats', 'invoiceSats', 'serviceFeeSats', 'claimFeeSats', 'fundingReserveSats'] as const) if (swap.quote[key] !== plan.quote[key]) throw new Error('Controlled swap budget changed');
    return swap;
  };
  const core = async () => z.object({ chain: z.literal('regtest'), blocks: z.number().int().nonnegative(), initialblockdownload: z.literal(false) })
    .parse(await bitcoin.call('getblockchaininfo'));
  const nodeSchema = z.object({ chains: z.array(z.object({ chain: z.literal('bitcoin'), network: z.literal('regtest') })).length(1),
    identity_pubkey: z.string(), synced_to_chain: z.literal(true), wallet_synced: z.literal(true) });
  const assertRegtest = async () => {
    await core();
    const p = nodeSchema.parse(await provider.call('/v1/getinfo')); const a = nodeSchema.parse(await payer.call('/v1/getinfo'));
    if (p.identity_pubkey !== plan.providerNode || a.identity_pubkey !== plan.payerNode) throw new Error('Controlled node identity changed');
    current();
  };
  const assertAccepted = async () => {
    const s = current(); const tip = (await core()).blocks;
    new HoldInvoiceManager(provider).assertAccepted(await provider.lookup(s.contract.paymentHash), s.contract.paymentHash, s.quote.invoiceSats, s.contract.timeoutHeight, 40);
    if (tip > s.contract.timeoutHeight - 10) throw new Error('Controlled claim window insufficient');
    await assertRegtest();
  };
  return { assertRegtest, tip: async () => (await core()).blocks,
    invoice: hash => { if (hash !== plan.contract.paymentHash) throw new Error('Invoice hash differs from plan'); return provider.lookup(hash); },
    confirmed: txid => bitcoin.confirmed(txid),
    createInvoice: async () => { throw new Error('Controlled reverse run cannot create another invoice'); },
    prepareLockup: async swap => {
      if (!input) throw new Error('No approved funding input');
      return prepareControlledFunding(bitcoin, store, swap, input, plan.refundDestination, assertAccepted);
    },
    broadcast: async hex => {
      const s = current();
      if (s.pendingAction !== 'BROADCAST_LOCKUP' || !s.lockup || s.lockup.hex !== hex || s.fundingIntent?.signedHex !== hex ||
        s.fundingIntent.fundingTxid !== Transaction.fromHex(hex).getId()) throw new Error('Funding broadcast is not the journaled transaction');
      await assertAccepted();
      const accepted = z.array(z.object({ txid: z.string(), allowed: z.literal(true) })).length(1).parse(await bitcoin.call('testmempoolaccept', [[hex]]));
      if (accepted[0]!.txid !== s.lockup.txid) throw new Error('Funding consensus identity mismatch');
      await assertAccepted();
      return bitcoin.call<string>('sendrawtransaction', [hex]);
    },
    settle: async preimage => {
      const s = current();
      if (s.pendingAction !== 'SETTLE' || !s.claimTxid || !s.lockup || s.clientPayment?.status !== 'IN_FLIGHT') throw new Error('Settlement lacks durable claim/payment context');
      const tx = await bitcoin.confirmed(s.claimTxid);
      const evidence = verifyHtlcSpend(tx.hex, s.claimTxid, s.lockup.hex, s.lockup.vout, s.contract);
      if (tx.confirmations < 1 || evidence.kind !== 'claim' || evidence.preimage !== preimage) throw new Error('Settlement claim evidence mismatch');
      await assertRegtest();
      return provider.settle(preimage);
    },
    cancel: async hash => {
      const s = current();
      if (hash !== s.contract.paymentHash) throw new Error('Cancellation hash differs from plan');
      if (s.lockup || s.fundingIntent) {
        if (!s.refundTxid || !s.lockup) throw new Error('Cannot cancel uncertain funded swap');
        const tx = await bitcoin.confirmed(s.refundTxid);
        if (tx.confirmations < 1 || verifyHtlcSpend(tx.hex, s.refundTxid, s.lockup.hex, s.lockup.vout, s.contract).kind !== 'refund') throw new Error('Refund evidence missing');
      }
      await assertRegtest(); return provider.cancel(hash);
    },
  };
}
