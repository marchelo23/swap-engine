import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assertAddressForProfile, assertRegtestAddress } from '../src/bitcoin/AddressPolicy.js';

test('central address policy accepts only regtest witness destinations', () => {
  assert.equal(assertRegtestAddress('bcrt1qz62y94lnjfj4sqmzwsap2fvleqxkua95znqfwj'),
    'bcrt1qz62y94lnjfj4sqmzwsap2fvleqxkua95znqfwj');
  for (const value of ['bc1qndvk6ae280lqxd0ndsur2lczvgsjztyspp673g',
    '1BoatSLRHtKNngkdXEeobR76b53LETtpyT', 'tb1qfm9w0p5c5j5r0z8c0yw0h8z3q5y5f3j4h6f4q5',
    'bcrt1invalid']) assert.throws(() => assertRegtestAddress(value), /REGTEST_ADDRESS_REQUIRED/);
});
test('profile validator accepts each network and rejects cross-profile addresses', () => {
  const regtest = 'bcrt1qz62y94lnjfj4sqmzwsap2fvleqxkua95znqfwj';
  const mainnet = 'bc1qndvk6ae280lqxd0ndsur2lczvgsjztyspp673g';
  const signet = 'tb1qndvk6ae280lqxd0ndsur2lczvgsjztyst8pd2m';
  assert.equal(assertAddressForProfile(regtest, 'regtest'), regtest);
  assert.equal(assertAddressForProfile(mainnet, 'mainnet'), mainnet);
  assert.equal(assertAddressForProfile(signet, 'signet'), signet);
  assert.throws(() => assertAddressForProfile(mainnet, 'regtest'), /ADDRESS_PROFILE_MISMATCH/);
  assert.throws(() => assertAddressForProfile(regtest, 'mainnet'), /ADDRESS_PROFILE_MISMATCH/);
  assert.throws(() => assertAddressForProfile(regtest, 'signet'), /ADDRESS_PROFILE_MISMATCH/);
  assert.throws(() => assertAddressForProfile(mainnet, 'signet'), /ADDRESS_PROFILE_MISMATCH/);
  assert.throws(() => assertRegtestAddress(mainnet), /REGTEST_ADDRESS_REQUIRED/);
});