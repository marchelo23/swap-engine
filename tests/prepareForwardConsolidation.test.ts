import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { forwardApprovalDigest, parseForwardApproval } from '../src/core/ForwardExecutor.js';
import { prepareForwardConsolidation } from '../src/persistence/PrepareForwardConsolidation.js';
import { Store } from '../src/persistence/Store.js';

const hash = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const payer = { node: `02${'1'.repeat(64)}`, container: 'iso_rt_lnd_provider',
  containerId: '3'.repeat(64), network: 'regtest' };
const review = 'admin-regtest-3201-review';

function entries() {
  const make = (i: number) => {
    const preimage = String(i).repeat(64);
    const paymentHash = hash(Buffer.from(preimage, 'hex'));
    const approval = parseForwardApproval({ network: 'regtest', payerNode: payer.node,
      payeeNode: `03${'2'.repeat(64)}`, paymentHash, invoice: `lnbcrt${'a'.repeat(25)}`,
      invoiceSats: 1005, feeLimitSats: 10, expiresAt: 1,
      deposit: { txid: String(i).repeat(64), vout: 1, valueSats: 1015, scriptPubKey: `0014${'a'.repeat(40)}` } });
    const entry = { outpoint: `${approval.deposit.txid}:1`, approvalDigest: forwardApprovalDigest(approval),
      payerNode: payer.node, status: i === 1 ? 'SUCCEEDED' : 'FAILED_INSUFFICIENT_BALANCE',
      metadata: { fixture: i } };
    const track = i === 1 ? { status: 'SUCCEEDED', hash: paymentHash, preimage, valueMsat: 1005000, feeMsat: 7 } :
      { status: 'FAILED', hash: paymentHash, reason: 'FAILURE_REASON_INSUFFICIENT_BALANCE', htlcs: [], feeMsat: 0 };
    return { paymentHash, entry, observation: { before: { ...payer }, after: { ...payer }, approval, track } };
  };
  return [make(1), make(2)] as const;
}

async function fixture(t: TestContext) {
  const root = await fs.mkdtemp(join(tmpdir(), 'forward-review-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const input = { adminDirectory: join(root, 'a'), otherDirectory: join(root, 'b'),
    outputDirectory: join(root, 'out'), evidenceFile: join(root, 'evidence') };
  const dirs = [input.adminDirectory, input.otherDirectory, input.outputDirectory];
  await Promise.all(dirs.map(dir => fs.mkdir(dir, { mode: 0o700 })));
  const statePaths = [join(input.adminDirectory, 'state.json'), join(input.otherDirectory, 'state.json')] as const;
  const rows = entries();
  const document = ({ paymentHash, entry }: typeof rows[number]) =>
    ({ schema: 1, quotes: {}, swaps: {}, forwardPayments: { [paymentHash]: entry } });
  const docs = [document(rows[0]), document(rows[1])] as const;
  const evidence = { target: 'admin-regtest-3201', payer: { ...payer },
    lookups: Object.fromEntries(rows.map(({ paymentHash, observation }) => [paymentHash, observation])) };
  const write = (path: string, value: unknown) => fs.writeFile(path, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  const save = () => Promise.all([
    write(statePaths[0], docs[0]), write(statePaths[1], docs[1]), write(input.evidenceFile, evidence)]);
  await save();
  return { input, dirs, docs, rows, evidence, statePaths, save };
}

test('offline review preserves both full journals and publishes no Store state', async t => {
  const f = await fixture(t);
  Object.assign(f.docs[0].quotes, { fixture: { nested: { keep: true } } });
  await f.save();
  const originals = await Promise.all([fs.readFile(f.statePaths[0]), fs.readFile(f.statePaths[1])]);
  assert.deepEqual(await prepareForwardConsolidation(f.input), { entries: 2 });
  const bundle = join(f.input.outputDirectory, review);
  assert.deepEqual(await fs.readdir(f.input.outputDirectory), [review]);
  assert.deepEqual((await fs.stat(bundle)).mode & 0o777, 0o700);
  const names = ['admin-original.json', 'other-original.json', 'candidate.json', 'manifest.json'];
  assert.deepEqual((await fs.readdir(bundle)).sort(), names.sort());
  for (const name of names) assert.equal((await fs.stat(join(bundle, name))).mode & 0o777, 0o600);
  const candidate = await fs.readFile(join(bundle, 'candidate.json'));
  assert.deepEqual(JSON.parse(candidate.toString()), { ...f.docs[0],
    forwardPayments: { ...f.docs[0].forwardPayments, ...f.docs[1].forwardPayments } });
  const manifest = JSON.parse(await fs.readFile(join(bundle, 'manifest.json'), 'utf8'));
  assert.deepEqual(manifest.checksums, { 'candidate.json': hash(candidate),
    'admin-original.json': hash(originals[0]), 'other-original.json': hash(originals[1]) });
  assert.equal(manifest.evidenceSha256, hash(await fs.readFile(f.input.evidenceFile)));
  assert.deepEqual(await fs.readFile(join(bundle, 'admin-original.json')), originals[0]);
  assert.deepEqual(await fs.readFile(join(bundle, 'other-original.json')), originals[1]);
  assert.deepEqual(await Promise.all(f.statePaths.map(path => fs.readFile(path))), originals);
  await assert.rejects(prepareForwardConsolidation(f.input), /empty/);
});

type Fixture = Awaited<ReturnType<typeof fixture>>;
const refusals: Array<[string, (f: Fixture) => void, RegExp]> = [
  ['hash conflict even if identical', f => { f.docs[1].forwardPayments = f.docs[0].forwardPayments; }, /payment hash/],
  ['outpoint conflict', f => { f.rows[1].entry.outpoint = f.rows[0].entry.outpoint; }, /outpoint/],
  ['different LND instance', f => { f.rows[1].observation.after.containerId = '4'.repeat(64); }, /identity/],
  ['different LND node', f => { f.rows[1].observation.before.node = `02${'4'.repeat(64)}`; }, /identity/],
  ['wrong network', f => { f.evidence.payer.network = 'mainnet'; }, /envelope/],
  ['wrong target', f => { f.evidence.target = 'admin-regtest-3200'; }, /envelope/],
  ['foreign stack', f => { f.evidence.payer.container = 'ark_lab_lnd'; }, /envelope/],
  ['missing evidence', f => { delete f.evidence.lookups[f.rows[0].paymentHash]; }, /coverage/],
  ['mismatched approval', f => { f.rows[0].observation.approval.expiresAt++; }, /attest/],
  ['mismatched amount', f => { f.rows[0].observation.track.valueMsat = 1; }, /attest/],
  ['mismatched preimage', f => { f.rows[0].observation.track.preimage = '3'.repeat(64); }, /attest/],
  ['failure with fee', f => { f.rows[1].observation.track.feeMsat = 1; }, /attest/],
  ['failure with HTLC', f => { Object.assign(f.rows[1].observation.track, { htlcs: [{}] }); }, /attest/],
  ['unresolved intent', f => { f.rows[1].entry.status = 'UNKNOWN'; }, /unresolved/],
  ['ancillary conflict', f => { Object.assign(f.docs[0].quotes, { x: 1 }); Object.assign(f.docs[1].quotes, { y: 2 }); }, /non-forward/],
];
for (const [name, change, message] of refusals) {
  test(`offline review refuses ${name}`, async t => {
    const f = await fixture(t);
    change(f);
    await f.save();
    const originals = await Promise.all(f.statePaths.map(path => fs.readFile(path)));
    await assert.rejects(prepareForwardConsolidation(f.input), message);
    assert.deepEqual(await fs.readdir(f.input.outputDirectory), []);
    assert.deepEqual(await Promise.all(f.statePaths.map(path => fs.readFile(path))), originals);
    await Promise.all(f.dirs.slice(0, 2).map(async dir => assert.deepEqual(await fs.readdir(dir), ['state.json'])));
  });
}

test('offline review refuses live Store, refuses late writes after close and never breaks a lock', async t => {
  const f = await fixture(t);
  const writer = await Store.open(f.input.otherDirectory);
  try {
    await assert.rejects(prepareForwardConsolidation(f.input), { code: 'EEXIST' });
    assert.deepEqual(await fs.readdir(f.input.adminDirectory), ['state.json']);
    assert.deepEqual(await fs.readdir(f.input.otherDirectory), ['engine.lock', 'state.json']);
    const closing = writer.close();
    await assert.rejects(writer.transaction(db => { db.quotes = {}; }), /closing/);
    await closing;
  } finally { await writer.close(); }
  await prepareForwardConsolidation(f.input);
});

test('offline review refuses symlinks, duplicate JSON and unresolved temporary state', async t => {
  const f = await fixture(t);
  const original = await fs.readFile(f.statePaths[0]);
  await fs.writeFile(f.statePaths[0], '{"schema":1,"schem\\u0061":1}');
  await assert.rejects(prepareForwardConsolidation(f.input), /Duplicate JSON key/);
  await fs.writeFile(f.statePaths[0], original);
  const temp = join(f.input.adminDirectory, 'state.tmp');
  await fs.writeFile(temp, original, { mode: 0o600 });
  await assert.rejects(prepareForwardConsolidation(f.input), /temporary state/);
  await fs.unlink(temp);
  await fs.unlink(f.statePaths[0]);
  await fs.symlink(f.statePaths[1], f.statePaths[0]);
  await assert.rejects(prepareForwardConsolidation(f.input), { code: 'ELOOP' });
  assert.deepEqual(await fs.readdir(f.input.outputDirectory), []);
});

test('publication failure cleans staging and excludes Store writers until completion', async t => {
  const f = await fixture(t);
  const realRename = fs.rename;
  let attempts = 0;
  const mocking = t.mock.method(fs, 'rename', async (...[source, destination]: Parameters<typeof fs.rename>) => {
    if (destination !== join(f.input.outputDirectory, review)) return realRename(source, destination);
    attempts++;
    for (const dir of f.dirs) await assert.rejects(Store.open(dir), { code: 'EEXIST' });
    assert.deepEqual((await fs.readdir(source)).sort(),
      ['admin-original.json', 'candidate.json', 'manifest.json', 'other-original.json']);
    throw new Error('fixture: rename failed');
  });
  syncBuiltinESMExports();
  try { await assert.rejects(prepareForwardConsolidation(f.input), /fixture: rename failed/); }
  finally { mocking.mock.restore(); syncBuiltinESMExports(); }
  assert.equal(attempts, 1);
  assert.deepEqual(await fs.readdir(f.input.outputDirectory), []);
  for (const dir of f.dirs.slice(0, 2)) assert.deepEqual(await fs.readdir(dir), ['state.json']);
});

test('parent fsync failure does not report success or remove the visible review bundle', async t => {
  const f = await fixture(t);
  const actualOpen = fs.open;
  const mocking = t.mock.method(fs, 'open', async (...args: Parameters<typeof fs.open>) => {
    const handle = await actualOpen(...args);
    if (args[0] === f.input.outputDirectory && args[1] === 'r')
      handle.sync = async () => { throw new Error('fixture: directory fsync failed'); };
    return handle;
  });
  syncBuiltinESMExports();
  try { await assert.rejects(prepareForwardConsolidation(f.input), /durability uncertain/); }
  finally { mocking.mock.restore(); syncBuiltinESMExports(); }
  assert.deepEqual(await fs.readdir(f.input.outputDirectory), [review]);
  assert.deepEqual((await fs.readdir(join(f.input.outputDirectory, review))).sort(),
    ['admin-original.json', 'candidate.json', 'manifest.json', 'other-original.json']);
  for (const dir of f.dirs.slice(0, 2)) assert.deepEqual(await fs.readdir(dir), ['state.json']);
});
