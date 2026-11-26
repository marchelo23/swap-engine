import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { address, networks } from 'bitcoinjs-lib';
import { forwardApprovalDigest, parseForwardApproval } from '../src/core/ForwardExecutor.js';
import { CoreLndForwardPorts } from '../src/core/CoreLndForwardPorts.js';
import { trackPaymentPath } from '../src/lightning/LndPaymentTransport.js';
import { prepareForwardConsolidation, ReviewOutcomeUncertainError } from '../src/persistence/PrepareForwardConsolidation.js';
import { Store } from '../src/persistence/Store.js';
import { runConsolidationCLI } from '../scripts/prepare-forward-consolidation.js';

const hash = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const payer = { node: `02${'1'.repeat(64)}`, container: 'iso_rt_lnd_provider',
  containerId: '3'.repeat(64), network: 'regtest' };
const review = 'admin-regtest-3201-review';
const names = ['admin-original.json', 'candidate.json', 'historical-a-original.json', 'historical-b-original.json', 'manifest.json'];
const adminOwner = '8eef7451-7080-4f34-89a1-238aea6f2c74';

function entries() {
  const make = (i: number) => {
    const preimage = String(i + 7).repeat(64);
    const paymentHash = hash(Buffer.from(preimage, 'hex'));
    const approval = parseForwardApproval({ network: 'regtest', payerNode: payer.node,
       payeeNode: `03${'2'.repeat(64)}`, paymentHash, invoice: `lnbcrt${String(i).repeat(25)}`,
       invoiceSats: 1005, feeLimitSats: 100, expiresAt: 1,
       deposit: { txid: String(i + 5).repeat(64), vout: 1, valueSats: 1105, scriptPubKey: `0014${String(i).repeat(40)}` } });
    const entry = { outpoint: `${approval.deposit.txid}:1`, approvalDigest: forwardApprovalDigest(approval),
      payerNode: payer.node, status: i === 1 ? 'SUCCEEDED' : 'FAILED_INSUFFICIENT_BALANCE' };
    const track = i === 1 ? { status: 'SUCCEEDED', hash: paymentHash, preimage, valueMsat: 1005000, feeMsat: 7 } :
      { status: 'FAILED', hash: paymentHash, reason: 'FAILURE_REASON_INSUFFICIENT_BALANCE', htlcs: [], feeMsat: 0 };
    const { deposit, ...terms } = approval;
    const admission = { ...terms, owner: 'owner-a', depositSats: deposit.valueSats, scriptPubKey: deposit.scriptPubKey,
      address: address.fromOutputScript(Buffer.from(deposit.scriptPubKey, 'hex'), networks.regtest),
      outpoint: { txid: deposit.txid, vout: deposit.vout }, requestKey: `fixture-${i}` };
    const id = `8eef7451-7080-4f34-89a1-238aea6f2c7${i}`;
    return { paymentHash, entry, admission, id,
      observation: { before: { ...payer }, after: { ...payer }, approval, track } };
  };
  return [make(1), make(2)] as const;
}

function openAdmission(i: number, owner = adminOwner) {
  const preimage = String(i).repeat(64);
  const paymentHash = hash(Buffer.from(preimage, 'hex'));
  const scriptPubKey = `0014${String(i).repeat(40)}`;
  return {
    id: `8eef7451-7080-4f34-89a1-238aea6f2c7${i}`,
    admission: {
      owner, network: 'regtest' as const, payerNode: payer.node, payeeNode: `03${'2'.repeat(64)}`,
      paymentHash, invoice: `lnbcrt${String(i).repeat(25)}`, invoiceSats: 1005, expiresAt: 1,
      feeLimitSats: 100 as const, scriptPubKey,
      address: address.fromOutputScript(Buffer.from(scriptPubKey, 'hex'), networks.regtest),
      depositSats: 1105, requestKey: `open-fixture-${i}`,
    },
  };
}

async function fixture(t: TestContext) {
  const root = await fs.mkdtemp(join(tmpdir(), 'forward-review-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const input = { historicalADirectory: join(root, 'a'), historicalBDirectory: join(root, 'b'), adminDirectory: join(root, 'c'),
    outputDirectory: join(root, 'out'), evidenceFile: join(root, 'evidence') };
  const dirs = [input.historicalADirectory, input.historicalBDirectory, input.adminDirectory, input.outputDirectory];
  await Promise.all(dirs.map(dir => fs.mkdir(dir, { mode: 0o700 })));
  const statePaths = [join(input.historicalADirectory, 'state.json'), join(input.historicalBDirectory, 'state.json'),
    join(input.adminDirectory, 'state.json')] as const;
  const rows = entries();
  const document = ({ paymentHash, entry, id, admission }: typeof rows[number]) =>
    ({ schema: 1, quotes: {}, swaps: {}, forwardPayments: { [paymentHash]: entry }, forwardAdmissions: { [id]: admission } });
  const docs: [Record<string, any>, Record<string, any>, Record<string, any>] = [
    document(rows[0]), document(rows[1]),
    { schema: 1, quotes: { fixture: { nested: { keep: true } } }, swaps: {} },
  ];
  const evidence = { target: 'admin-regtest-3201', payer: { ...payer },
    payeeNode: rows[0].admission.payeeNode,
    sources: { admin: { owner: adminOwner, sha256: '' },
      historicalA: { owner: 'owner-a', sha256: '' }, historicalB: { owner: 'owner-a', sha256: '' } },
    lookups: Object.fromEntries(rows.map(({ paymentHash, observation }) => [paymentHash, observation])) };
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value, null, 2) + '\n');
  const saveEvidence = () => fs.writeFile(input.evidenceFile, encode(evidence), { mode: 0o600 });
  const save = async () => {
    const [a, b, c] = [encode(docs[0]), encode(docs[1]), encode(docs[2])];
    await Promise.all([fs.writeFile(statePaths[0], a, { mode: 0o600 }), fs.writeFile(statePaths[1], b, { mode: 0o600 }),
      fs.writeFile(statePaths[2], c, { mode: 0o600 })]);
    evidence.sources.historicalA.sha256 = hash(a);
    evidence.sources.historicalB.sha256 = hash(b);
    evidence.sources.admin.sha256 = hash(c);
    await saveEvidence();
  };
  await save();
  return { input, dirs, docs, rows, evidence, statePaths, save, saveEvidence };
}

test('offline review preserves three full Stores including the current quote and both admissions', async t => {
  const f = await fixture(t);
  const originals = await Promise.all([fs.readFile(f.statePaths[0]), fs.readFile(f.statePaths[1]), fs.readFile(f.statePaths[2])]);
  assert.deepEqual(await prepareForwardConsolidation(f.input), { entries: 2 });
  const bundle = join(f.input.outputDirectory, review);
  assert.deepEqual(await fs.readdir(f.input.outputDirectory), [review]);
  assert.deepEqual((await fs.stat(bundle)).mode & 0o777, 0o700);
  assert.deepEqual((await fs.readdir(bundle)).sort(), names);
  for (const name of names) assert.equal((await fs.stat(join(bundle, name))).mode & 0o777, 0o600);
  const candidate = await fs.readFile(join(bundle, 'candidate.json'));
  assert.deepEqual(JSON.parse(candidate.toString()), { ...f.docs[2],
    forwardPayments: { ...f.docs[0].forwardPayments, ...f.docs[1].forwardPayments },
    forwardAdmissions: { ...f.docs[0].forwardAdmissions, ...f.docs[1].forwardAdmissions } });
  const manifest = JSON.parse(await fs.readFile(join(bundle, 'manifest.json'), 'utf8'));
  assert.deepEqual(manifest.checksums, { 'candidate.json': hash(candidate),
    'admin-original.json': hash(originals[2]), 'historical-a-original.json': hash(originals[0]),
    'historical-b-original.json': hash(originals[1]) });
  assert.equal(manifest.admissionCount, 2);
  assert.equal(manifest.evidenceSha256, hash(await fs.readFile(f.input.evidenceFile)));
  assert.deepEqual(await fs.readFile(join(bundle, 'admin-original.json')), originals[2]);
  assert.deepEqual(await fs.readFile(join(bundle, 'historical-a-original.json')), originals[0]);
  assert.deepEqual(await fs.readFile(join(bundle, 'historical-b-original.json')), originals[1]);
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
  ['wrong historical account', f => { f.rows[1].admission.owner = 'owner-b'; }, /account/],
  ['wrong admission payee', f => { f.rows[1].admission.payeeNode = `03${'f'.repeat(64)}`; }, /node binding/],
  ['an orphan payment', f => { f.docs[1].forwardAdmissions = {}; }, /original admission/],
  ['unbound payment reservation', f => { Reflect.deleteProperty(f.rows[1].admission, 'outpoint'); }, /matching bound/],
  ['bound reservation with different outpoint', f => { f.rows[1].admission.outpoint.vout++; }, /matching bound/],
  ['changed original approval', f => { f.rows[1].admission.expiresAt++; }, /digest/],
  ['different value from reserved amount', f => { f.rows[1].admission.depositSats++; }, /economics/],
  ['address/script mismatch', f => { f.rows[1].admission.address = f.rows[0].admission.address; }, /address, script/],
  ['shared invoice string', f => { f.rows[1].admission.invoice = f.rows[0].admission.invoice; }, /reservation/],
  ['shared owner and request key', f => { f.rows[1].admission.requestKey = f.rows[0].admission.requestKey; }, /reservation/],
  ['shared script and address', f => {
    f.rows[1].admission.scriptPubKey = f.rows[0].admission.scriptPubKey;
    f.rows[1].admission.address = f.rows[0].admission.address;
  }, /reservation/],
  ['shared admission ID', f => { f.docs[1].forwardAdmissions = { [f.rows[0].id]: f.rows[1].admission }; }, /reservation/],
  ['empty historical payment journal', f => { f.docs[1].forwardPayments = {}; }, /historical journals/],
  ['ancillary conflict', f => { Object.assign(f.docs[0].quotes, { x: 1 }); Object.assign(f.docs[1].quotes, { y: 2 }); }, /non-forward/],
  ['identical populated quotes across historical stores', f => {
    Object.assign(f.docs[0].quotes, { x: 1 }); Object.assign(f.docs[1].quotes, { x: 1 }); f.docs[2].quotes = {};
  }, /non-forward/],
  ['identical populated quotes between admin and historical', f => {
    Object.assign(f.docs[0].quotes, f.docs[2].quotes);
  }, /non-forward/],
  ['populated swaps state even if identical', f => {
    Object.assign(f.docs[0].swaps, { s1: { state: 'QUOTED' } }); Object.assign(f.docs[1].swaps, { s1: { state: 'QUOTED' } });
  }, /non-forward/],
  ['unexpected non-forward key', f => { f.docs[2].extra = { keep: ['all', 1] }; }, /non-forward/],
  ['unexpected populated Database map', f => { f.docs[2].ownedReverse = { owners: {}, requests: {} }; }, /non-forward/],
  ['open admission with outpoint and no payment', f => {
    const open = openAdmission(3);
    f.docs[2].forwardAdmissions = { [open.id]: { ...open.admission, outpoint: { txid: '3'.repeat(64), vout: 0 } } };
  }, /matching bound/],
  ['open admission colliding on requestKey within same owner', f => {
    const a = openAdmission(3);
    const b = openAdmission(4);
    b.admission.requestKey = a.admission.requestKey;
    f.docs[2].forwardAdmissions = { [a.id]: a.admission, [b.id]: b.admission };
  }, /reservation/],
  ['open admission colliding on payment hash with historical', f => {
    const open = openAdmission(3);
    open.admission.paymentHash = f.rows[0].paymentHash;
    f.docs[2].forwardAdmissions = { [open.id]: open.admission };
  }, /reservation/],
  ['non-canonical uppercase admin owner UUID', f => {
    f.evidence.sources.admin.owner = adminOwner.toUpperCase();
  }, /envelope/],
  ['non-canonical uppercase admission ID', f => {
    const open = openAdmission(3);
    f.docs[2].forwardAdmissions = { [open.id.toUpperCase()]: open.admission };
  }, /Invalid forward admission/],
  ['unexpected preimage field on payment journal entry', f => {
    Object.assign(f.docs[0].forwardPayments[f.rows[0].paymentHash], { preimage: '1'.repeat(64) });
  }, /journal entry/],
  ['unexpected metadata field on payment journal entry', f => {
    Object.assign(f.docs[1].forwardPayments[f.rows[1].paymentHash], { metadata: { fixture: 2 } });
  }, /journal entry/],
  ['unexpected extra field on normalized track evidence', f => {
    Object.assign(f.rows[0].observation.track, { fee_sat: '1' });
  }, /attest/],
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
    await Promise.all(f.dirs.slice(0, 3).map(async dir => assert.deepEqual(await fs.readdir(dir), ['state.json'])));
  });
}

test('source roles are pinned to fingerprints; aliases and swapped inputs are refused', async t => {
  const f = await fixture(t);
  await assert.rejects(prepareForwardConsolidation({ ...f.input,
    historicalADirectory: f.input.historicalBDirectory, historicalBDirectory: f.input.historicalADirectory }), /fingerprint/);
  await assert.rejects(prepareForwardConsolidation({ ...f.input,
    historicalADirectory: f.input.adminDirectory }), /separate/);
  assert.deepEqual(await fs.readdir(f.input.outputDirectory), []);
});

test('offline review refuses live Store, refuses late writes after close and never breaks a lock', async t => {
  const f = await fixture(t);
  const writer = await Store.open(f.input.adminDirectory);
  try {
    await assert.rejects(prepareForwardConsolidation(f.input), { code: 'EEXIST' });
    assert.deepEqual(await fs.readdir(f.input.historicalADirectory), ['state.json']);
    assert.deepEqual(await fs.readdir(f.input.historicalBDirectory), ['state.json']);
    assert.deepEqual(await fs.readdir(f.input.adminDirectory), ['engine.lock', 'state.json']);
    const closing = writer.close();
    await assert.rejects(writer.transaction(db => { db.quotes = {}; }), /closing/);
    await closing;
  } finally { await writer.close(); }
  await prepareForwardConsolidation(f.input);
});

test('offline review refuses symlinks, duplicate JSON and unresolved temporary state', async t => {
  const f = await fixture(t);
  const original = await fs.readFile(f.statePaths[0]);
  const invalid = Buffer.from('{"schema":1,"schem\\u0061":1}');
  await fs.writeFile(f.statePaths[0], invalid);
  f.evidence.sources.historicalA.sha256 = hash(invalid);
  await f.saveEvidence();
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
    assert.deepEqual((await fs.readdir(source)).sort(), names);
    throw new Error('fixture: rename failed');
  });
  syncBuiltinESMExports();
  try { await assert.rejects(prepareForwardConsolidation(f.input), /fixture: rename failed/); }
  finally { mocking.mock.restore(); syncBuiltinESMExports(); }
  assert.equal(attempts, 1);
  assert.deepEqual(await fs.readdir(f.input.outputDirectory), []);
  for (const dir of f.dirs.slice(0, 3)) assert.deepEqual(await fs.readdir(dir), ['state.json']);
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
  assert.deepEqual((await fs.readdir(join(f.input.outputDirectory, review))).sort(), names);
  for (const dir of f.dirs.slice(0, 3)) assert.deepEqual(await fs.readdir(dir), ['state.json']);
});

test('losing a source lock before publication aborts without deleting a replacement writer lock', async t => {
  const f = await fixture(t);
  const actualOpen = fs.open;
  const lock = join(f.input.historicalBDirectory, 'engine.lock');
  let writer: Store | undefined;
  const mocking = t.mock.method(fs, 'open', async (...args: Parameters<typeof fs.open>) => {
    const handle = await actualOpen(...args);
    if (args[0] === join(f.input.outputDirectory, '.incomplete') && args[1] === 'r') {
      const sync = handle.sync.bind(handle);
      handle.sync = async () => {
        await sync();
        await fs.unlink(lock);
        writer = await Store.open(f.input.historicalBDirectory);
      };
    }
    return handle;
  });
  syncBuiltinESMExports();
  try { await assert.rejects(prepareForwardConsolidation(f.input), /lock lost/); }
  finally { mocking.mock.restore(); syncBuiltinESMExports(); }
  assert.ok(writer);
  try {
    assert.deepEqual(await fs.readdir(f.input.outputDirectory), []);
    await assert.rejects(Store.open(f.input.historicalBDirectory), { code: 'EEXIST' });
  } finally { await writer.close(); }
});

test('offline review preserves open admission without outpoint', async t => {
  const f = await fixture(t);
  const open = openAdmission(3);
  f.docs[2].forwardAdmissions = { [open.id]: open.admission };
  await f.save();
  assert.deepEqual(await prepareForwardConsolidation(f.input), { entries: 2 });
  const bundle = join(f.input.outputDirectory, review);
  const candidate = JSON.parse(await fs.readFile(join(bundle, 'candidate.json'), 'utf8'));
  const manifest = JSON.parse(await fs.readFile(join(bundle, 'manifest.json'), 'utf8'));
  assert.equal(manifest.admissionCount, 3);
  assert.deepEqual(candidate.forwardAdmissions[open.id], open.admission);
  assert.equal(candidate.forwardPayments[open.admission.paymentHash], undefined);
});

test('TrackPayment normalization from raw LND captures matches consolidation and rejects discrepancies', async t => {
  const f = await fixture(t);
  const rawSuccess = {
    status: 'SUCCEEDED', failure_reason: 'FAILURE_REASON_NONE',
    payment_hash: f.rows[0].paymentHash, payment_preimage: '8'.repeat(64),
    value_sat: '1005', value_msat: '1005000', fee_sat: '0', fee_msat: '7',
    payment_index: '10', creation_time_ns: '1700000000000000000', htlcs: [{ status: 'SUCCEEDED' }],
  };
  const rawFailed = {
    status: 'FAILED', failure_reason: 'FAILURE_REASON_INSUFFICIENT_BALANCE',
    payment_hash: f.rows[1].paymentHash, payment_preimage: '0'.repeat(64),
    value_sat: '0', value_msat: '0', fee: '0', fee_sat: '0', fee_msat: '0',
    payment_index: '11', creation_time_ns: '1700000001000000000', htlcs: [],
  };
  const trackWith = (payload: unknown) => {
    const origin = 'https://127.0.0.1:48080';
    return new CoreLndForwardPorts(
      { call: async () => { throw new Error('unused'); } },
      { origin, call: async () => { throw new Error('unused'); } },
      { origin, async stream(path, body, observe) {
        assert.equal(body, undefined);
        assert.match(path, /^\/v2\/router\/track\//);
        assert.equal(observe(payload), true);
      } },
      payer.node, f.rows[0].admission.payeeNode, '123',
    );
  };
  Object.assign(f.rows[0].observation, { track: await trackWith(rawSuccess).track(f.rows[0].paymentHash) });
  Object.assign(f.rows[1].observation, { track: await trackWith(rawFailed).track(f.rows[1].paymentHash) });
  await f.save();
  assert.deepEqual(await prepareForwardConsolidation(f.input), { entries: 2 });
  const candidate = await fs.readFile(join(f.input.outputDirectory, review, 'candidate.json'), 'utf8');
  assert.equal(candidate.includes('8'.repeat(64)), false);
  await assert.rejects(trackWith({ ...rawSuccess, failure_reason: 'FAILURE_REASON_ERROR' }).track(f.rows[0].paymentHash));
  await assert.rejects(trackWith({ ...rawFailed, fee_sat: '1' }).track(f.rows[1].paymentHash));
  await assert.rejects(trackWith({ ...rawFailed, htlcs: [{}] }).track(f.rows[1].paymentHash));
});

test('losing a source lock post-rename emits static uncertain diagnostic without paths and preserves replacement lock and non-executable bundle', async t => {
  const f = await fixture(t);
  const actualOpen = fs.open;
  const lock = join(f.input.historicalBDirectory, 'engine.lock');
  let writer: Store | undefined;
  const mocking = t.mock.method(fs, 'open', async (...args: Parameters<typeof fs.open>) => {
    const handle = await actualOpen(...args);
    if (args[0] === f.input.outputDirectory && args[1] === 'r') {
      const sync = handle.sync.bind(handle);
      handle.sync = async () => {
        await sync();
        await fs.unlink(lock);
        writer = await Store.open(f.input.historicalBDirectory);
      };
    }
    return handle;
  });
  syncBuiltinESMExports();
  let caught: unknown;
  try { await prepareForwardConsolidation(f.input); assert.fail('expected post-rename uncertain failure'); }
  catch (error) { caught = error; }
  finally { mocking.mock.restore(); syncBuiltinESMExports(); }
  assert.ok(caught instanceof ReviewOutcomeUncertainError);
  assert.match(caught.message, /outcome uncertain/);
  for (const sensitive of [...f.dirs, f.input.evidenceFile]) assert.equal(caught.message.includes(sensitive), false);
  assert.ok(writer);
  try {
    assert.deepEqual(await fs.readdir(f.input.outputDirectory), [review]);
    assert.deepEqual((await fs.readdir(join(f.input.outputDirectory, review))).sort(), names);
    await assert.rejects(Store.open(f.input.historicalBDirectory), { code: 'EEXIST' });
  } finally { await writer.close(); }
});

test('CLI distinguishes pre-rename and post-rename failures with static diagnostics without leaking paths', async t => {
  const f = await fixture(t);
  const errors: string[] = [];
  const logs: string[] = [];
  const io = { log: (m: string) => logs.push(m), error: (m: string) => errors.push(m) };
  const argv = [f.input.adminDirectory, f.input.historicalADirectory, f.input.historicalBDirectory,
    f.input.outputDirectory, f.input.evidenceFile];
  f.docs[2].extra = { unexpected: true };
  await f.save();
  assert.equal(await runConsolidationCLI(argv, io), 1);
  assert.match(errors[0]!, /Offline preparation failed; no activation attempted/);
  for (const sensitive of [...f.dirs, f.input.evidenceFile]) assert.equal(errors[0]!.includes(sensitive), false);
  delete f.docs[2].extra;
  await f.save();
  const actualOpen = fs.open;
  const mocking = t.mock.method(fs, 'open', async (...args: Parameters<typeof fs.open>) => {
    const handle = await actualOpen(...args);
    if (args[0] === f.input.outputDirectory && args[1] === 'r') {
      handle.sync = async () => { throw new Error(`post-rename fsync failed on ${f.input.outputDirectory}`); };
    }
    return handle;
  });
  syncBuiltinESMExports();
  try { assert.equal(await runConsolidationCLI(argv, io), 1); }
  finally { mocking.mock.restore(); syncBuiltinESMExports(); }
  assert.match(errors[1]!, /outcome uncertain after bundle publication/);
  for (const sensitive of [...f.dirs, f.input.evidenceFile]) assert.equal(errors[1]!.includes(sensitive), false);
  assert.deepEqual(logs, []);
});

test('Store.close enforces cooperative exclusion, drains queued writes, preserves replacement locks and completes sibling cleanup', async t => {
  const root = await fs.mkdtemp(join(tmpdir(), 'store-close-coop-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const dir = join(root, 'store');
  const store = await Store.open(dir);
  let committed = false;
  const tx = store.transaction(db => { db.quotes = { q: { id: 'q', amountSats: 10_000, serviceFeeSats: 100, invoiceSats: 10_000, fundingReserveSats: 1000, claimFeeSats: 500, expiresAt: 1 } }; committed = true; });
  const closing = store.close();
  assert.equal(store.close(), closing);
  await assert.rejects(store.transaction(() => {}), /closing/);
  await Promise.all([tx, closing]);
  assert.equal(committed, true);
  assert.deepEqual(await fs.readdir(dir), ['state.json']);

  const lost = await Store.open(dir);
  await fs.unlink(join(dir, 'engine.lock'));
  const replacement = await Store.open(dir);
  try {
    await assert.rejects(lost.transaction(db => { db.swaps = {}; }), /lock lost/);
    await assert.rejects(lost.close(), /lock lost/);
    await assert.rejects(Store.open(dir), { code: 'EEXIST' });
  } finally { await replacement.close(); }
});
