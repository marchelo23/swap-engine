import type { Store } from '../persistence/Store.js';
import type { ReadOnlyBitcoinClient, ReadOnlyLndClient } from '../diagnostics/ReadOnlyClients.js';
import type { HttpsLndInvoiceTransport } from '../lightning/LndInvoiceTransport.js';
import { assertRecoveryNode } from '../lightning/LndPayerRecovery.js';
import { createControlledReadiness, type ReadinessCustody } from './ControlledReadiness.js';
import { createReversePreparation, preparationSpecSchema, type PreparationSpec, type PreparationApproval } from './ReversePreparation.js';
import type { JitReaders } from './JustInTimeReverse.js';

type Clients = {
  bitcoin: Pick<ReadOnlyBitcoinClient, 'origin' | 'call' | 'confirmed'>;
  provider: Pick<ReadOnlyLndClient, 'origin' | 'assertRegtest' | 'call'>;
  payer: Pick<ReadOnlyLndClient, 'origin' | 'assertRegtest' | 'call'>;
  invoices: Pick<HttpsLndInvoiceTransport, 'origin' | 'create' | 'lookup'>;
  custody: ReadinessCustody;
};

/** Retained-invoice review/readiness needs lookup only; no invoice writer is accepted. */
export function createLndJitReaders(store: Store, value: PreparationSpec,
  clients: Omit<Clients, 'invoices'> & { invoices: Pick<Clients['invoices'], 'origin' | 'lookup'> }): JitReaders {
  const spec = preparationSpecSchema.parse(structuredClone(value));
  const endpoints = () => {
    if (clients.bitcoin.origin !== spec.routing.bitcoinOrigin || clients.provider.origin !== spec.routing.providerOrigin ||
      clients.payer.origin !== spec.routing.payerOrigin || clients.invoices.origin !== spec.routing.providerOrigin)
      throw new Error('Retained invoice endpoint changed; no execution');
  };
  endpoints();
  const provider = { get origin() { return clients.provider.origin; }, call: clients.provider.call.bind(clients.provider),
    async lookup(hash: string) {
      endpoints(); if (hash !== spec.client.paymentHash) throw new Error('Retained invoice hash differs');
      await assertRecoveryNode(clients.provider, spec.providerNode); const found = await clients.invoices.lookup(hash);
      await assertRecoveryNode(clients.provider, spec.providerNode); endpoints();
      if (found.status !== 'PRESENT') throw new Error('Retained invoice unavailable or uncertain'); return found.invoice;
    } };
  return { bitcoin: clients.bitcoin, provider, payer: clients.payer, custody: clients.custody,
    inspect: (id, plan) => createControlledReadiness(store, id, { ...spec.routing, isolationId: spec.isolationId },
      clients.bitcoin, provider, clients.payer, clients.custody)(plan, { txid: spec.input.txid, vout: spec.input.vout }) };
}

/** Concrete operator wiring: creation is a separate capability; recovery has no POST path. */
export function createLndReversePreparation(store: Store, value: PreparationSpec, clients: Clients,
  approval?: PreparationApproval, mode: 'prepare' | 'recover' = 'recover') {
  const spec = preparationSpecSchema.parse(structuredClone(value));
  const fail = () => new Error('Controlled LND preparation evidence unavailable; reconcile without retry');
  const endpoints = () => {
    if (clients.bitcoin.origin !== spec.routing.bitcoinOrigin || clients.provider.origin !== spec.routing.providerOrigin ||
      clients.payer.origin !== spec.routing.payerOrigin || clients.invoices.origin !== spec.routing.providerOrigin) throw fail();
  };
  endpoints();
  const lookup = async (hash: string) => {
    if (hash !== spec.client.paymentHash) throw fail();
    endpoints(); await assertRecoveryNode(clients.provider, spec.providerNode);
    const found = await clients.invoices.lookup(hash);
    await assertRecoveryNode(clients.provider, spec.providerNode); endpoints(); return found;
  };
  const provider = { get origin() { return clients.provider.origin; },
    call: clients.provider.call.bind(clients.provider), assertRegtest: clients.provider.assertRegtest.bind(clients.provider),
    lookup: async (hash: string) => { const found = await lookup(hash); if (found.status !== 'PRESENT') throw fail(); return found.invoice; } };
  const harness = createReversePreparation(store, spec, {
    bitcoin: clients.bitcoin, provider, payer: clients.payer, custody: clients.custody,
    invoiceStatus: async hash => (await lookup(hash)).status,
    inspect: (id, plan) => createControlledReadiness(store, id, { ...spec.routing, isolationId: spec.isolationId },
      clients.bitcoin, provider, clients.payer, clients.custody)(plan, { txid: spec.input.txid, vout: spec.input.vout }),
    createInvoice: async (request, beforeRequest) => {
      if (mode !== 'prepare') throw fail(); endpoints();
      return clients.invoices.create(request, async () => { endpoints(); await beforeRequest(); endpoints(); });
    },
  }, mode === 'prepare' ? approval : undefined);
  return mode === 'prepare' ? harness : { recover: harness.recover };
}
