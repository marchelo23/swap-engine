export type OperatorBindingExpectation = { wallet: string; bitcoinOrigin: string; providerOrigin: string;
  payerOrigin: string; providerNode: string; payerNode: string; bitcoinCookiePath: string;
  providerCertPath: string; providerReadMacaroonPath: string; payerCertPath: string; payerReadMacaroonPath: string };
export type OperatorBindingSpec = { wallet: string; providerNode: string; payerNode: string;
  routing: { bitcoinOrigin: string; providerOrigin: string; payerOrigin: string } };
export type OperatorBindingPaths = { bitcoinCookiePath: string; providerCertPath: string;
  providerReadMacaroonPath: string; payerCertPath: string; payerReadMacaroonPath: string };

/** Binds a reviewed CLI/owned spec to the same attested runtime configuration
 * before any journal or action-capable port is opened. */
export function assertOperatorBinding(spec: OperatorBindingSpec, paths: OperatorBindingPaths,
  expected: OperatorBindingExpectation) {
  if (spec.wallet !== expected.wallet || spec.providerNode !== expected.providerNode ||
    spec.payerNode !== expected.payerNode || spec.routing.bitcoinOrigin !== expected.bitcoinOrigin ||
    spec.routing.providerOrigin !== expected.providerOrigin || spec.routing.payerOrigin !== expected.payerOrigin ||
    paths.bitcoinCookiePath !== expected.bitcoinCookiePath || paths.providerCertPath !== expected.providerCertPath ||
    paths.providerReadMacaroonPath !== expected.providerReadMacaroonPath ||
    paths.payerCertPath !== expected.payerCertPath || paths.payerReadMacaroonPath !== expected.payerReadMacaroonPath)
    throw new Error('OPERATOR_BINDING_MISMATCH');
}
