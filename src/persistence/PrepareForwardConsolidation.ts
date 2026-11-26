import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, realpath, rename, rm } from 'node:fs/promises';
import { basename, dirname, join, relative } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { address, networks } from 'bitcoinjs-lib';
import { z } from 'zod';
import { forwardApprovalDigest, parseForwardApproval, verifiedForwardBalanceFailure,
  verifiedForwardPayment } from '../core/ForwardExecutor.js';
import { lockStoreDirectory } from './Store.js';

export class ReviewOutcomeUncertainError extends Error {
  constructor(message = 'Review bundle publication outcome uncertain; inspect locks and output manually') {
    super(message);
    this.name = 'ReviewOutcomeUncertainError';
  }
}

const target = 'admin-regtest-3201';
const container = 'iso_rt_lnd_provider';
const bundle = `${target}-review`;
const hex = z.string().regex(/^[a-f0-9]{64}$/);
const node = z.string().regex(/^0[23][a-f0-9]{64}$/);
const canonicalUuid = z.uuid().refine(value => value === value.toLowerCase());
const identity = z.strictObject({ network: z.literal('regtest'), container: z.literal(container),
  containerId: hex, node });
const observation = z.strictObject({ before: identity, after: identity,
  approval: z.unknown(), track: z.unknown() });
const owner = z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/);
const source = z.strictObject({ sha256: hex, owner });
const evidenceSchema = z.strictObject({ target: z.literal(target), payer: identity,
  payeeNode: node,
  sources: z.strictObject({ admin: source.extend({ owner: canonicalUuid }), historicalA: source, historicalB: source }),
  lookups: z.record(hex, observation) });
const admissionSchema = z.strictObject({
  owner, network: z.literal('regtest'), payerNode: node, payeeNode: node, paymentHash: hex,
  invoice: z.string().regex(/^lnbcrt[0-9a-z]{20,4096}$/), invoiceSats: z.number().int().min(1000).max(200_000),
  expiresAt: z.number().int().positive(), feeLimitSats: z.literal(100),
  address: z.string().regex(/^bcrt1q[a-z0-9]{38}$/), scriptPubKey: z.string().regex(/^0014[a-f0-9]{40}$/),
  depositSats: z.number().int().min(1100).max(200_100),
  outpoint: z.strictObject({ txid: hex, vout: z.number().int().min(0).max(0xffffffff) }).optional(),
  requestKey: z.string().regex(/^[a-zA-Z0-9_-]{8,128}$/).optional(),
});
const entrySchema = z.strictObject({ payerNode: node, approvalDigest: hex,
  outpoint: z.string().regex(/^[a-f0-9]{64}:(0|[1-9][0-9]{0,9})$/),
  status: z.enum(['SUCCEEDED', 'FAILED_INSUFFICIENT_BALANCE']) });
const trackSucceededSchema = z.strictObject({
  status: z.literal('SUCCEEDED'),
  hash: hex,
  preimage: hex,
  valueMsat: z.number().int().positive(),
  feeMsat: z.number().int().nonnegative(),
});
const trackFailedSchema = z.strictObject({
  status: z.literal('FAILED'),
  hash: hex,
  reason: z.literal('FAILURE_REASON_INSUFFICIENT_BALANCE'),
  htlcs: z.tuple([]),
  feeMsat: z.literal(0),
});
const allowedDocKeys = new Set(['schema', 'quotes', 'swaps', 'forwardPayments', 'forwardAdmissions']);
const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
type Dict = Record<string, unknown>;

function object(value: unknown): Dict {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected JSON object');
  return value as Dict;
}

/** JSON.parse alone silently drops duplicate keys and rounds large integers. Reject
 * ambiguous files before constructing a new state; keep original bytes in backups. */
function parse(bytes: Buffer): unknown {
  const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  const parsed: unknown = JSON.parse(text);
  const stack: Array<Set<string> | null> = [];
  const tokens = /"(?:\\[\s\S]|[^"\\])*"|[{}[\]:]|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/g;
  for (const token of text.matchAll(tokens)) {
    const value = token[0];
    if (value === '{') stack.push(new Set());
    else if (value === '[') stack.push(null);
    else if (value === '}' || value === ']') stack.pop();
    else if (value.startsWith('"') && /^\s*:/.test(text.slice(token.index + value.length))) {
      const keys = stack.at(-1);
      const key = JSON.parse(value) as string;
      if (!keys || keys.has(key)) throw new Error('Duplicate JSON key');
      keys.add(key);
    } else if (/^[-0-9]/.test(value) && String(Number(value)) !== value) {
      // Only accept number tokens that JSON.stringify can reproduce exactly.
      throw new Error('Noncanonical JSON number');
    }
  }
  return parsed;
}

async function snapshot(path: string) {
  const f = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const s = await f.stat();
    if (!s.isFile() || s.nlink !== 1 || s.uid !== process.getuid?.() || (s.mode & 0o077))
      throw new Error('Expected private, unaliased regular input');
    return await f.readFile();
  } finally { await f.close(); }
}

const roles = ['admin', 'historicalA', 'historicalB'] as const;
type Role = typeof roles[number];

function consolidate(snapshots: Record<Role, Buffer>, evidence: Buffer) {
  const attest = evidenceSchema.safeParse(parse(evidence));
  if (!attest.success) throw new Error('Invalid offline evidence envelope');
  const { payer, payeeNode, sources, lookups } = attest.data;
  if (payer.node === payeeNode || new Set(roles.map(role => sources[role].sha256)).size !== roles.length)
    throw new Error('Ambiguous source or node identity');
  for (const role of roles) {
    if (sources[role].sha256 !== digest(snapshots[role])) throw new Error('Source fingerprint mismatch');
  }
  const forward = Object.create(null) as Dict;
  const admissions = Object.create(null) as Dict;
  const reservations = new Set<string>();
  const outpoints = new Set<string>();
  const approvalDigests = new Map<string, string>();
  const candidate = Object.create(null) as Dict;
  candidate.schema = 1;
  candidate.swaps = {};
  for (const role of roles) {
    const doc = object(parse(snapshots[role]));
    for (const key of Object.keys(doc)) {
      if (!allowedDocKeys.has(key)) throw new Error('Unexpected non-forward state; review separately');
    }
    if (doc.schema !== 1) throw new Error('Unsupported database schema');
    const quotes = object(doc.quotes);
    const swaps = object(doc.swaps);
    if (Object.keys(swaps).length) throw new Error('Unexpected populated non-forward swaps state; review separately');
    if (role !== 'admin' && Object.keys(quotes).length)
      throw new Error('Unexpected or conflicting non-forward state; review separately');
    if (role === 'admin') candidate.quotes = quotes;
    const journal = Object.hasOwn(doc, 'forwardPayments') ? object(doc.forwardPayments) : {};
    const entries = Object.entries(journal);
    if (role !== 'admin' && !entries.length) throw new Error('Both historical journals must be nonempty');
    for (const [hash, raw] of entries) {
      const entry = entrySchema.safeParse(raw);
      if (!hex.safeParse(hash).success || !entry.success || entry.data.payerNode !== payer.node)
        throw new Error('Invalid, unresolved or foreign journal entry');
      if (Object.hasOwn(forward, hash)) throw new Error('Conflicting payment hash');
      if (outpoints.has(entry.data.outpoint)) throw new Error('Conflicting deposit outpoint');
      forward[hash] = entry.data;
      outpoints.add(entry.data.outpoint);
    }
    const records = Object.hasOwn(doc, 'forwardAdmissions') ? object(doc.forwardAdmissions) : {};
    const matched = new Set<string>();
    for (const [id, raw] of Object.entries(records)) {
      const parsed = admissionSchema.safeParse(raw);
      if (!canonicalUuid.safeParse(id).success || !parsed.success)
        throw new Error('Invalid forward admission');
      const a = parsed.data;
      if (a.owner !== sources[role].owner || a.payerNode !== payer.node || a.payeeNode !== payeeNode)
        throw new Error('Unexpected admission account or node binding');
      let script: string | undefined;
      try { script = Buffer.from(address.toOutputScript(a.address, networks.regtest)).toString('hex'); }
      catch { /* Reject invalid addresses without surfacing private data. */ }
      if (script !== a.scriptPubKey || a.depositSats !== a.invoiceSats + a.feeLimitSats)
        throw new Error('Invalid admission address, script or deposit economics');
      const keys = [`id:${id}`, `hash:${a.paymentHash}`, `invoice:${a.invoice}`,
        `address:${a.address}`, `script:${a.scriptPubKey}`];
      if (a.requestKey) keys.push(`request:${a.owner}:${a.requestKey}`);
      if (a.outpoint) keys.push(`outpoint:${a.outpoint.txid}:${a.outpoint.vout}`);
      if (keys.some(key => reservations.has(key))) throw new Error('Conflicting admission reservation');
      for (const key of keys) reservations.add(key);
      if (a.outpoint || Object.hasOwn(journal, a.paymentHash)) {
        const entry = entrySchema.safeParse(journal[a.paymentHash]);
        if (!a.outpoint || !entry.success || entry.data.outpoint !== `${a.outpoint.txid}:${a.outpoint.vout}`)
          throw new Error('Admission or payment lacks a matching bound reservation in its source');
        const approval = parseForwardApproval({ ...a,
          deposit: { ...a.outpoint, scriptPubKey: a.scriptPubKey, valueSats: a.depositSats } });
        const derived = forwardApprovalDigest(approval);
        if (derived !== entry.data.approvalDigest) throw new Error('Admission approval digest mismatch');
        approvalDigests.set(a.paymentHash, derived);
        matched.add(a.paymentHash);
      }
      admissions[id] = parsed.data;
    }
    if (matched.size !== entries.length) throw new Error('Payment lacks its original admission');
  }
  if (Object.keys(lookups).length !== Object.keys(forward).length) throw new Error('Evidence coverage mismatch');
  for (const [hash, raw] of Object.entries(forward)) {
    const entry = entrySchema.parse(raw);
    const seen = lookups[hash];
    if (!seen || !isDeepStrictEqual(seen.before, payer) || !isDeepStrictEqual(seen.after, payer))
      throw new Error('Missing lookup or different payer identity');
    let valid = false;
    try {
      const a = parseForwardApproval(seen.approval);
      valid = a.payerNode === payer.node && a.paymentHash === hash &&
        `${a.deposit.txid}:${a.deposit.vout}` === entry.outpoint && forwardApprovalDigest(a) === approvalDigests.get(hash) &&
        (entry.status === 'SUCCEEDED'
          ? trackSucceededSchema.safeParse(seen.track).success && verifiedForwardPayment(a, seen.track)
          : trackFailedSchema.safeParse(seen.track).success && verifiedForwardBalanceFailure(a, seen.track));
    } catch { /* Never surface evidence or approval contents in errors. */ }
    if (!valid) throw new Error('Lookup or approval does not attest journal entry');
  }
  candidate.forwardPayments = forward;
  candidate.forwardAdmissions = admissions;
  return { candidate: Buffer.from(JSON.stringify(candidate)), entries: Object.keys(forward).length,
    admissionCount: Object.keys(admissions).length };
}

async function syncDirectory(path: string) {
  const f = await open(path, 'r');
  try { await f.sync(); } finally { await f.close(); }
}

function nested(a: string, b: string) {
  const rel = relative(a, b);
  return !rel || (rel !== '..' && !rel.startsWith('../'));
}

/** Offline only. Evidence is a trusted operator capture, not authenticated by this
 * function. Publish a private review bundle, never an executable Store state. */
export async function prepareForwardConsolidation(input: {
  adminDirectory: string; historicalADirectory: string; historicalBDirectory: string;
  outputDirectory: string; evidenceFile: string;
}) {
  if (process.platform !== 'linux') throw new Error('Linux local filesystem required');
  const [admin, historicalA, historicalB, output] = await Promise.all([realpath(input.adminDirectory),
    realpath(input.historicalADirectory), realpath(input.historicalBDirectory), realpath(input.outputDirectory)]);
  const sources = { admin, historicalA, historicalB };
  const dirs = [...roles.map(role => sources[role]), output];
  const identities = new Set<string>();
  for (const a of dirs) {
    if (dirs.some(b => b !== a && nested(a, b))) throw new Error('Directories must be separate');
    const s = await lstat(a);
    if (!s.isDirectory() || s.uid !== process.getuid?.() || (s.mode & 0o077))
      throw new Error('Expected private directory owned by this user');
    if (identities.has(`${s.dev}:${s.ino}`)) throw new Error('Directories must be separate');
    identities.add(`${s.dev}:${s.ino}`);
  }
  const evidenceDir = await realpath(dirname(input.evidenceFile));
  if (dirs.some(dir => nested(dir, evidenceDir))) throw new Error('Evidence must be outside journal and output directories');
  const unlocks: Array<Awaited<ReturnType<typeof lockStoreDirectory>>> = [];
  const assertHeld = async () => { for (const lock of unlocks) await lock.assertHeld(); };
  const assertNoTemps = async () => {
    for (const role of roles) if ((await readdir(sources[role])).includes('state.tmp'))
      throw new Error('Unresolved Store temporary state');
  };
  let stage: string | undefined;
  let published = false;
  let uncertain: ReviewOutcomeUncertainError | undefined;
  try {
    for (const dir of dirs.sort()) unlocks.unshift(await lockStoreDirectory(dir));
    await assertHeld();
    if ((await readdir(output)).some(name => name !== 'engine.lock')) throw new Error('Output directory must be empty');
    await assertNoTemps();
    const snapshots = { admin: await snapshot(join(admin, 'state.json')),
      historicalA: await snapshot(join(historicalA, 'state.json')),
      historicalB: await snapshot(join(historicalB, 'state.json')) };
    const evidence = await snapshot(join(evidenceDir, basename(input.evidenceFile)));
    const { candidate, entries, admissionCount } = consolidate(snapshots, evidence);
    const staging = join(output, '.incomplete');
    await mkdir(staging, { mode: 0o700 });
    stage = staging;
    const artifacts = { 'admin-original.json': snapshots.admin, 'historical-a-original.json': snapshots.historicalA,
      'historical-b-original.json': snapshots.historicalB, 'candidate.json': candidate };
    const checksums = Object.fromEntries(Object.entries(artifacts).map(([name, bytes]) => [name, digest(bytes)]));
    for (const [name, bytes] of Object.entries({ ...artifacts, 'manifest.json': Buffer.from(JSON.stringify({
      target, network: 'regtest', entries, admissionCount, checksums, evidenceSha256: digest(evidence),
    })) })) {
      const f = await open(join(staging, name), 'wx', 0o600);
      try { await f.writeFile(bytes); await f.sync(); } finally { await f.close(); }
    }
    await syncDirectory(staging);
    await assertNoTemps();
    for (const role of roles) {
      if (!(await snapshot(join(sources[role], 'state.json'))).equals(snapshots[role]))
        throw new Error('Source changed during preparation');
    }
    await assertHeld();
    await rename(staging, join(output, bundle));
    published = true;
    stage = undefined;
    try { await syncDirectory(output); }
    catch { uncertain = new ReviewOutcomeUncertainError('Review bundle publication durability uncertain; inspect manually'); throw uncertain; }
    try { await assertHeld(); }
    catch { uncertain = new ReviewOutcomeUncertainError('Review bundle publication outcome uncertain; lock lost after rename; inspect manually'); throw uncertain; }
    return { entries };
  } finally {
    // Release all acquired locks even if staging cleanup or one unlock fails.
    try { if (stage) await rm(stage, { recursive: true }); }
    finally {
      const results = await Promise.allSettled(unlocks.map(unlock => unlock()));
      if (results.some(r => r.status === 'rejected')) {
        if (published) throw uncertain ?? new ReviewOutcomeUncertainError('Review bundle publication outcome uncertain; lock lost after rename; inspect manually');
        throw new Error('Review lock lost or cleanup failed; inspect manually');
      }
    }
  }
}
