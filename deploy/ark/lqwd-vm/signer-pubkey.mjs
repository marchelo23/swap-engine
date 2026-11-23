#!/usr/bin/env node
import { createECDH } from 'node:crypto';

const value = process.argv[2] ?? process.env.ARK_LQWD_SIGNER_KEY;
if (!/^[0-9a-f]{64}$/.test(value ?? '')) {
  console.error('signer key must be 64 lowercase hex characters');
  process.exit(1);
}

const ecdh = createECDH('secp256k1');
ecdh.setPrivateKey(Buffer.from(value, 'hex'));
console.log(ecdh.getPublicKey('hex', 'compressed'));
