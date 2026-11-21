import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Transaction, Psbt, address, networks } from 'bitcoinjs-lib';
import { setup } from './helpers.js';
import { prepareControlledFunding, verifyControlledFunding } from '../src/bitcoin/ControlledFunding.js';
import { readFile } from 'node:fs/promises';

test('actual Core 32 PSBT format defaults require explicit v0 without changing transaction version', async () => {
  const sample = JSON.parse(await readFile(new URL('./fixtures/core32-createpsbt.json', import.meta.url), 'utf8'));
  // Pure createpsbt with a nonexistent dummy input: this fixture never locked, signed or broadcast funds.
  assert.throws(() => Psbt.fromBase64(sample.defaultV2));
  const parsed = Psbt.fromBase64(sample.explicitV0);
  assert.equal(parsed.version, 2); assert.equal(parsed.txInputs.length, 1);
  assert.equal(Buffer.from(parsed.txInputs[0]!.hash).toString('hex'), '11'.repeat(32));
  assert.equal(parsed.txOutputs[0]!.value, 50000n);
});

async function fundingFixture() {
  const f = await setup(); const change = address.toOutputScript(f.destination, networks.regtest);
  const previous = Transaction.fromHex(f.tx.toHex()); previous.outs[0]!.script = change; previous.outs[0]!.value = 100000n;
  const input = { txid: previous.getId(), vout: 0 };
  const psbt = new Psbt({ network: networks.regtest }).addInput({ hash: input.txid, index: 0, witnessUtxo: { script: change, value: 100000n } })
    .addOutput({ script: f.htlc.output, value: 50000n }).addOutput({ script: change, value: 49700n });
  const raw = () => Buffer.from(psbt.data.globalMap.unsignedTx.toBuffer()).toString('hex');
  await f.store.transaction(db => { db.swaps[f.swap.id]!.pendingAction = 'PREPARE_LOCKUP'; });
  let prepared = 0; let signed = 0; let lost = false;
  const blockHash = 'ab'.repeat(32); const tipHash = 'cd'.repeat(32);
  const rpc = { async call<T>(method: string, params: unknown[] = [], wallet = false): Promise<T> {
    if (method === 'getblockchaininfo') return { chain: 'regtest', blocks: 100, bestblockhash: tipHash } as T;
    if (method === 'getrawtransaction') return { txid: input.txid, hex: previous.toHex(), blockhash: blockHash, in_active_chain: true, confirmations: 11 } as T;
    if (method === 'getblockheader') return { hash: blockHash, height: 90, confirmations: 11 } as T;
    if (method === 'getblockhash') return blockHash as T;
    if (method === 'gettxout') return { scriptPubKey: { hex: Buffer.from(change).toString('hex') } } as T;
    if (method === 'listunspent') return [{ ...input, safe: true, spendable: true }] as T;
    if (method === 'listlockunspent') return [] as T;
    if (method === 'getaddressinfo') return { ismine: true } as T;
    if (method === 'walletcreatefundedpsbt') {
      prepared++;
      const intent = f.store.read().swaps[f.swap.id]!.fundingIntent!;
      assert.equal(intent.txid, input.txid); assert.equal(intent.valueSats, 100000); assert.equal(intent.maxFeeSats, 1000);
      assert.equal(wallet, true); assert.deepEqual(params[0], [input]);
      assert.deepEqual(params[3], { add_inputs: false, lockUnspents: true, changeAddress: f.destination, fee_rate: 2, replaceable: false });
      assert.deepEqual(params.slice(4), [true, 2, 0]); // Core 32 defaults to PSBT v2; bitcoinjs requires explicit v0.
      if (lost) throw new Error('Locking outcome unknown');
      return { psbt: psbt.toBase64() } as T;
    }
    if (method === 'walletprocesspsbt') {
      signed++; assert.equal(f.store.read().swaps[f.swap.id]!.fundingIntent!.unsignedHex, raw());
      return { psbt: psbt.toBase64() } as T;
    }
    if (method === 'finalizepsbt') return { complete: true, hex: raw() } as T;
    throw new Error(`Unexpected funding test RPC ${method}`);
  } };
  return { f, previous, input, psbt, raw, rpc, prepared: () => prepared, signed: () => signed, loseLockingReply: () => { lost = true; } };
}

test('controlled funding journals selected inputs before locking and exact signed transaction before return', async () => {
  const x = await fundingFixture(); try {
    const result = await prepareControlledFunding(x.rpc, x.f.store, x.f.swap, x.input, x.f.destination, async () => {});
    const intent = x.f.store.read().swaps[x.f.swap.id]!.fundingIntent!;
    assert.equal(intent.fundingTxid, result.txid); assert.equal(intent.signedHex, result.hex); assert.equal(intent.fundingVout, result.vout);
    assert.equal(intent.feeSats, 300); assert.equal(x.prepared(), 1); assert.equal(x.signed(), 1);
    await assert.rejects(prepareControlledFunding(x.rpc, x.f.store, x.f.swap, x.input, x.f.destination, async () => {}), /reconciliation/);
    assert.equal(x.prepared(), 1);
  } finally { await x.f.cleanup(); }
});

test('lost wallet locking outcome retains an exact durable intent and blocks repeated preparation', async () => {
  const x = await fundingFixture(); try {
    x.loseLockingReply();
    await assert.rejects(prepareControlledFunding(x.rpc, x.f.store, x.f.swap, x.input, x.f.destination, async () => {}), /unknown/);
    assert.equal(x.f.store.read().swaps[x.f.swap.id]!.fundingIntent!.txid, x.input.txid);
    await assert.rejects(prepareControlledFunding(x.rpc, x.f.store, x.f.swap, x.input, x.f.destination, async () => {}), /reconciliation/);
    assert.equal(x.prepared(), 1); assert.equal(x.signed(), 0);
  } finally { await x.f.cleanup(); }
});

test('unapproved unsigned funding output is rejected before signing; input selection is not repeated', async () => {
  const x = await fundingFixture(); try {
    x.psbt.addOutput({ script: Buffer.from([0x51]), value: 1n });
    await assert.rejects(prepareControlledFunding(x.rpc, x.f.store, x.f.swap, x.input, x.f.destination, async () => {}));
    assert.equal(x.signed(), 0); assert.equal(x.prepared(), 1);
    assert.ok(x.f.store.read().swaps[x.f.swap.id]!.fundingIntent);
  } finally { await x.f.cleanup(); }
});

test('funding verifier enforces exact HTLC and change scripts, fee reserve and unique outpoint', async () => {
  const x = await fundingFixture(); try {
    assert.equal(verifyControlledFunding(x.raw(), x.previous.toHex(), x.f.swap, x.input, x.f.destination).feeSats, 300);
    for (const change of [
      (tx: Transaction) => { tx.outs[0]!.value = 49999n; },
      (tx: Transaction) => { tx.outs[1]!.script = Buffer.from([0x51]); },
      (tx: Transaction) => { tx.outs[1]!.value = 48000n; },
      (tx: Transaction) => { tx.addInput(x.previous.getHash(), 0); },
    ]) {
      const tx = Transaction.fromHex(x.raw()); change(tx);
      assert.throws(() => verifyControlledFunding(tx.toHex(), x.previous.toHex(), x.f.swap, x.input, x.f.destination));
    }
  } finally { await x.f.cleanup(); }
});
