import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assertRegtestAddress } from '../src/bitcoin/AddressPolicy.js';

test('central address policy accepts only regtest witness destinations', () => {
  assert.equal(assertRegtestAddress('bcrt1qz62y94lnjfj4sqmzwsap2fvleqxkua95znqfwj'),
    'bcrt1qz62y94lnjfj4sqmzwsap2fvleqxkua95znqfwj');
  for (const value of ['bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kygt080',
    '1BoatSLRHtKNngkdXEeobR76b53LETtpyT', 'tb1qfm9w0p5c5j5r0z8c0yw0h8z3q5y5f3j4h6f4q5',
    'bcrt1invalid']) assert.throws(() => assertRegtestAddress(value), /REGTEST_ADDRESS_REQUIRED/);
});