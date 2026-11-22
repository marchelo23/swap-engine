import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assertOperatorBinding, attestOperatorBinding, serveMutationPolicy } from '../src/environment/OperatorBinding.js';

const expected = { wallet: 'wallet-a', genesisHash: '0f9188f13cb7b2c71f2a335e3a4fc328bf5beb436012afca590b1a11466e2206', bitcoinOrigin: 'http://127.0.0.1:18443', providerOrigin: 'https://127.0.0.1:8080',
  payerOrigin: 'https://127.0.0.1:8081', providerNode: '02' + '11'.repeat(32), payerNode: '03' + '22'.repeat(32),
  bitcoinCookiePath: '/abs/cookie', providerCertPath: '/abs/provider.cert',
  providerReadMacaroonPath: '/abs/provider.read', payerCertPath: '/abs/payer.cert', payerReadMacaroonPath: '/abs/payer.read' };
const spec = { wallet: expected.wallet, providerNode: expected.providerNode, payerNode: expected.payerNode,
  routing: { bitcoinOrigin: expected.bitcoinOrigin, providerOrigin: expected.providerOrigin, payerOrigin: expected.payerOrigin } };
const paths = { bitcoinCookiePath: expected.bitcoinCookiePath, providerCertPath: expected.providerCertPath,
  providerReadMacaroonPath: expected.providerReadMacaroonPath, payerCertPath: expected.payerCertPath,
  payerReadMacaroonPath: expected.payerReadMacaroonPath };

test('operator binding rejects substituted routing, wallet, node or credential paths', () => {
  assert.doesNotThrow(() => assertOperatorBinding(spec, paths, expected));
  for (const change of [
    { spec: { ...spec, wallet: 'wallet-b' } },
    { spec: { ...spec, providerNode: '03' + '33'.repeat(32) } },
    { spec: { ...spec, routing: { ...spec.routing, bitcoinOrigin: 'http://127.0.0.1:18444' } } },
    { paths: { ...paths, bitcoinCookiePath: '/abs/other-cookie' } },
    { paths: { ...paths, payerReadMacaroonPath: '/abs/other-payer' } },
  ]) assert.throws(() => assertOperatorBinding(change.spec ?? spec, change.paths ?? paths, expected), /OPERATOR_BINDING_MISMATCH/);
});

test('unpinned native policy still attests both live LND pubkeys before custody', async () => {
  const { providerNode: _provider, payerNode: _payer, ...unpinned } = expected;
  assert.doesNotThrow(() => assertOperatorBinding(spec, paths, unpinned));
  const clients = (providerNode: string, payerNode: string) => ({
    bitcoin: { async call<T>(method: string): Promise<T> {
      const value = method === 'getblockchaininfo'
        ? { chain: 'regtest', initialblockdownload: false, bestblockhash: 'ab'.repeat(32) }
        : method === 'getblockhash' ? expected.genesisHash
        : method === 'listwallets' ? ['wallet-a'] : { walletname: 'wallet-a' };
      return value as T;
    } },
    provider: { async call<T>(): Promise<T> { return { identity_pubkey: providerNode, synced_to_chain: true,
      chains: [{ chain: 'bitcoin', network: 'regtest' }] } as T; } },
    payer: { async call<T>(): Promise<T> { return { identity_pubkey: payerNode, synced_to_chain: true,
      chains: [{ chain: 'bitcoin', network: 'regtest' }] } as T; } },
  });
  await attestOperatorBinding(clients(spec.providerNode, spec.payerNode), spec, paths, unpinned);
  await assert.rejects(attestOperatorBinding(clients(spec.payerNode, spec.payerNode), spec, paths, unpinned),
    /OPERATOR_BINDING_MISMATCH/);
  await assert.rejects(attestOperatorBinding(clients(spec.providerNode, spec.providerNode), spec, paths, unpinned),
    /OPERATOR_BINDING_MISMATCH/);
});
test('serve-status never builds a mutation policy without payer or identity', () => {
  let builds = 0; const build = () => { builds++; return spec; };
  assert.equal(serveMutationPolicy('serve-status', build), undefined);
  assert.equal(builds, 0);
  assert.equal(serveMutationPolicy('review', build), undefined);
  assert.equal(builds, 0);
  assert.equal(serveMutationPolicy('serve', build), spec);
  assert.equal(builds, 1);
});