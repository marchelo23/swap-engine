import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, realpath, rename, rm } from 'node:fs/promises';
import { basename, dirname, join, relative } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { forwardApprovalDigest, parseForwardApproval, verifiedForwardBalanceFailure,
  verifiedForwardPayment } from '../core/ForwardExecutor.js';
import { lockStoreDirectory } from './Store.js';

const target = 'admin-regtest-3201';
const container = 'iso_rt_lnd_provider';
const bundle = `${target}-review`;
const hex = z.string().regex(/^[a-f0-9]{64}$/);
const node = z.string().regex(/^0[23][a-f0-9]{64}$/);
const identity = z.strictObject({ network: z.literal('regtest'), container: z.literal(container),
  containerId: hex, node });
const observation = z.strictObject({ before: identity, after: identity,
  approval: z.unknown(), track: z.unknown() });
const evidenceSchema = z.strictObject({ target: z.literal(target), payer: identity,
  lookups: z.record(hex, observation) });
const entrySchema = z.object({ payerNode: node, approvalDigest: hex,
  outpoint: z.string().regex(/^[a-f0-9]{64}:(0|[1-9][0-9]{0,9})$/),
  status: z.enum(['SUCCEEDED', 'FAILED_INSUFFICIENT_BALANCE']) });
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

function consolidate(first: Buffer, second: Buffer, evidence: Buffer) {
  const documents = [object(parse(first)), object(parse(second))];
  const attest = evidenceSchema.safeParse(parse(evidence));
  if (!attest.success) throw new Error('Invalid offline evidence envelope');
  const { payer, lookups } = attest.data;
  const forward = Object.create(null) as Dict;
  const outpoints = new Set<string>();
  const candidate = Object.create(null) as Dict;
  for (const doc of documents) {
    if (doc.schema !== 1) throw new Error('Unsupported database schema');
    object(doc.quotes);
    object(doc.swaps);
    const entries = Object.entries(object(doc.forwardPayments));
    if (!entries.length) throw new Error('Both journals must be nonempty');
    for (const [hash, raw] of entries) {
      const entry = entrySchema.safeParse(raw);
      if (!hex.safeParse(hash).success || !entry.success || entry.data.payerNode !== payer.node)
        throw new Error('Invalid, unresolved or foreign journal entry');
      if (Object.hasOwn(forward, hash)) throw new Error('Conflicting payment hash');
      if (outpoints.has(entry.data.outpoint)) throw new Error('Conflicting deposit outpoint');
      forward[hash] = raw;
      outpoints.add(entry.data.outpoint);
    }
    for (const [key, value] of Object.entries(doc)) {
      if (key === 'forwardPayments') continue;
      const prior = candidate[key];
      if (!Object.hasOwn(candidate, key)) candidate[key] = value;
      else if (!isDeepStrictEqual(prior, value)) {
        const empty = (v: unknown) => v !== null && typeof v === 'object' &&
          !Array.isArray(v) && !Object.keys(v).length;
        if (empty(prior) && value !== null && typeof value === 'object' && !Array.isArray(value)) candidate[key] = value;
        else if (!(empty(value) && prior !== null && typeof prior === 'object' && !Array.isArray(prior)))
          throw new Error('Conflicting non-forward state; review separately');
      }
    }
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
        `${a.deposit.txid}:${a.deposit.vout}` === entry.outpoint && forwardApprovalDigest(a) === entry.approvalDigest &&
        (entry.status === 'SUCCEEDED' ? verifiedForwardPayment(a, seen.track) : verifiedForwardBalanceFailure(a, seen.track));
    } catch { /* Never surface evidence or approval contents in errors. */ }
    if (!valid) throw new Error('Lookup or approval does not attest journal entry');
  }
  candidate.forwardPayments = forward;
  return { candidate: Buffer.from(JSON.stringify(candidate)), entries: Object.keys(forward).length };
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
  adminDirectory: string; otherDirectory: string; outputDirectory: string; evidenceFile: string;
}) {
  if (process.platform !== 'linux') throw new Error('Linux local filesystem required');
  const [admin, other, output] = await Promise.all(
    [realpath(input.adminDirectory), realpath(input.otherDirectory), realpath(input.outputDirectory)]);
  const dirs = [admin, other, output];
  for (const a of dirs) {
    if (dirs.some(b => b !== a && nested(a, b))) throw new Error('Directories must be separate');
    const s = await lstat(a);
    if (!s.isDirectory() || s.uid !== process.getuid?.() || (s.mode & 0o077))
      throw new Error('Expected private directory owned by this user');
  }
  if (new Set(dirs).size !== 3) throw new Error('Directories must be separate');
  const evidenceDir = await realpath(dirname(input.evidenceFile));
  if (dirs.some(dir => nested(dir, evidenceDir))) throw new Error('Evidence must be outside journal and output directories');
  const unlocks: Array<() => Promise<void>> = [];
  let stage: string | undefined;
  try {
    for (const dir of dirs.sort()) unlocks.unshift(await lockStoreDirectory(dir));
    if ((await readdir(output)).some(name => name !== 'engine.lock')) throw new Error('Output directory must be empty');
    if ((await Promise.all([readdir(admin), readdir(other)])).some(names => names.includes('state.tmp')))
      throw new Error('Unresolved Store temporary state');
    const inputs = await Promise.allSettled([
      snapshot(join(admin, 'state.json')), snapshot(join(other, 'state.json')),
      snapshot(join(evidenceDir, basename(input.evidenceFile)))]);
    const [first, second, evidence] = inputs.map(input => {
      if (input.status === 'rejected') throw input.reason;
      return input.value;
    });
    if (!first || !second || !evidence) throw new Error('Missing snapshot');
    const { candidate, entries } = consolidate(first, second, evidence);
    const staging = join(output, '.incomplete');
    await mkdir(staging, { mode: 0o700 });
    stage = staging;
    const artifacts = { 'admin-original.json': first, 'other-original.json': second, 'candidate.json': candidate };
    const checksums = Object.fromEntries(Object.entries(artifacts).map(([name, bytes]) => [name, digest(bytes)]));
    for (const [name, bytes] of Object.entries({ ...artifacts, 'manifest.json': Buffer.from(JSON.stringify({
      target, network: 'regtest', entries, checksums, evidenceSha256: digest(evidence),
    })) })) {
      const f = await open(join(staging, name), 'wx', 0o600);
      try { await f.writeFile(bytes); await f.sync(); } finally { await f.close(); }
    }
    await syncDirectory(staging);
    await rename(staging, join(output, bundle));
    stage = undefined;
    try { await syncDirectory(output); }
    catch { throw new Error('Review bundle publication durability uncertain; inspect manually'); }
    return { entries };
  } finally {
    // Release all acquired locks even if staging cleanup or one unlock fails.
    try { if (stage) await rm(stage, { recursive: true }); }
    finally {
      const results = await Promise.allSettled(unlocks.map(unlock => unlock()));
      if (results.some(r => r.status === 'rejected')) throw new Error('Review lock cleanup failed; inspect manually');
    }
  }
}
