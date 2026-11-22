import { address, networks } from 'bitcoinjs-lib';

/** Central witness-destination policy for all regtest funding/claim paths. */
export function assertRegtestAddress(value: string): string {
  if (!value.startsWith('bcrt1')) throw new Error('REGTEST_ADDRESS_REQUIRED');
  try { address.toOutputScript(value, networks.regtest); } catch { throw new Error('REGTEST_ADDRESS_REQUIRED'); }
  return value;
}