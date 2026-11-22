import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assertOperatorBinding } from '../src/environment/OperatorBinding.js';

const expected = { wallet: 'wallet-a', bitcoinOrigin: 'http://127.0.0.1:18443', providerOrigin: 'https://127.0.0.1:8080',
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
