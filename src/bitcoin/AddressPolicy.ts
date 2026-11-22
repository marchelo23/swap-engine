import { address, networks } from 'bitcoinjs-lib';

export type BitcoinAddressProfile = 'regtest' | 'signet' | 'mainnet';

/** Central profile validator. Signet uses the testnet address encoding. */
export function assertAddressForProfile(value: string, profile: BitcoinAddressProfile): string {
  const network = profile === 'mainnet' ? networks.bitcoin : profile === 'signet' ? networks.testnet : networks.regtest;
  try { address.toOutputScript(value, network); } catch { throw new Error('ADDRESS_PROFILE_MISMATCH'); }
  return value;
}

/** Live regtest paths remain witness-only: no base58 or other networks. */
export function assertRegtestAddress(value: string): string {
  if (!value.startsWith('bcrt1')) throw new Error('REGTEST_ADDRESS_REQUIRED');
  try { assertAddressForProfile(value, 'regtest'); } catch { throw new Error('REGTEST_ADDRESS_REQUIRED'); }
  return value;
}