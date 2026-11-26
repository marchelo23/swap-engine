import { createHash, randomUUID } from 'node:crypto';
import { constants, type BigIntStats, type Stats } from 'node:fs';
import { lstat, mkdir, open, readdir, realpath, statfs, unlink, type FileHandle } from 'node:fs/promises';
import { userInfo } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { z } from 'zod';
import { assertStateScope, type StateScope } from '../environment/StateScope.js';
import { parseStrictJson } from './StrictJson.js';

const pubkeySchema = z.string().regex(/^0[23][a-f0-9]{64}$/);
const canonicalUuidSchema = z.uuid().refine(v => v === v.toLowerCase());
const decimalBigIntSchema = z.string().regex(/^(0|[1-9][0-9]{0,20})$/);
const hex64Schema = z.string().regex(/^[a-f0-9]{64}$/);
const bindingSchema = z.strictObject({
  version: z.literal(1),
  payerNode: pubkeySchema,
  storeId: canonicalUuidSchema,
  directory: z.string().min(1),
  dev: decimalBigIntSchema,
  ino: decimalBigIntSchema,
  uid: z.number().int().nonnegative(),
});
type Binding = z.infer<typeof bindingSchema>;

export const FORWARD_STORE_MARKER = '.forward-payer.json';
const TMPFS_MAGIC = 0x01021994;
const RAMFS_MAGIC = 0x858458f6;

export type ForwardLeaseScope = 'system' | 'test';
export type ForwardPayerLease = {
  readonly scope: ForwardLeaseScope;
  readonly payerNode: string;
  readonly storeId: string;
  readonly directory: string;
  assertHeld(): Promise<void>;
  release(): Promise<void>;
  closeHandle(): Promise<void>;
};

export type StoreDirectoryLock = {
  (): Promise<void>;
  assertHeld(): Promise<void>;
  closeHandle(): Promise<void>;
};

export type ForwardLeaseAcquisitionOptions = {
  lockDirectory: (directory: string) => Promise<StoreDirectoryLock>;
  allowVolatileForTest?: boolean;
  stateScope?: StateScope;
};

function completeStateScope(scope: StateScope): StateScope {
  return {
    environment: scope.environment,
    deploymentId: scope.deploymentId,
    genesisHash: scope.genesisHash,
    wallet: scope.wallet,
    bitcoinOrigin: scope.bitcoinOrigin ?? null,
    providerOrigin: scope.providerOrigin ?? null,
    payerOrigin: scope.payerOrigin ?? null,
    providerNode: scope.providerNode ?? null,
    payerNode: scope.payerNode ?? null,
    liquidOrigin: scope.liquidOrigin ?? null,
    liquidWallet: scope.liquidWallet ?? null,
    liquidGenesisHash: scope.liquidGenesisHash ?? null,
    liquidChainName: scope.liquidChainName ?? null,
    liquidPolicyAsset: scope.liquidPolicyAsset ?? null,
    liquidParentGenesisHash: scope.liquidParentGenesisHash ?? null,
  };
}

const systemLeases = new WeakSet<ForwardPayerLease>();
const testLeases = new WeakSet<ForwardPayerLease>();
const testLeaseTokens = new WeakSet<object>();

export function isSystemForwardPayerLease(lease: ForwardPayerLease): boolean {
  return lease.scope === 'system' && systemLeases.has(lease);
}

export function isAuthorizedForwardPayerLease(lease: ForwardPayerLease, testToken?: object): boolean {
  if (isSystemForwardPayerLease(lease)) return true;
  return Boolean(testToken && testLeaseTokens.has(testToken) && lease.scope === 'test' && testLeases.has(lease));
}

export function createTestForwardLeaseToken(): object {
  const token = Object.freeze({ forwardTestLease: true });
  testLeaseTokens.add(token);
  return token;
}

export function isValidTestForwardLeaseToken(token: object | undefined): boolean {
  return Boolean(token && testLeaseTokens.has(token));
}

export async function acquireForwardRegistryAdvisoryLock(payerNode: string, registryRoot: string, storeCanonical: string) {
  const node = pubkeySchema.parse(payerNode);
  const uid = currentUid();
  const regDir = await assertPrivateDirectory(registryRoot, true);
  const locksDir = await assertPrivateDirectory(join(regDir.canonicalPath, 'locks'), true);
  const bindingsDir = await assertPrivateDirectory(join(regDir.canonicalPath, 'bindings'), true);
  const { lockPath, lockHandle, assertLockHeld } = await acquireRegistryLock(
    locksDir.canonicalPath, node, storeCanonical, uid,
  );
  const assertDirUnchanged = makeAssertDirUnchanged(uid);
  const assertHeld = async () => {
    await assertDirUnchanged(regDir.canonicalPath, regDir);
    await assertDirUnchanged(locksDir.canonicalPath, locksDir);
    await assertDirUnchanged(bindingsDir.canonicalPath, bindingsDir);
    await assertLockHeld();
  };
  let closed = false;
  const closeHandle = async () => {
    if (closed) return;
    closed = true;
    await lockHandle.close().catch(() => {});
  };
  const release = async () => {
    try {
      await assertHeld();
      await unlink(lockPath);
    } finally {
      await closeHandle();
    }
  };
  return { regDir: regDir.canonicalPath, bindingsDir: bindingsDir.canonicalPath, uid, assertHeld, release, closeHandle };
}

/** Derives the single per-OS-user forward payer registry root from NSS/passwd
 * rather than HOME, XDG_*, DATA_DIR or any per-writer environment variable. */
export function systemForwardPayerRegistryRoot(): string {
  if (process.platform !== 'linux' || typeof process.getuid !== 'function') {
    throw new Error('FORWARD_CUSTODY_LINUX_ONLY');
  }
  const info = userInfo();
  if (info.uid !== process.getuid() || !isAbsolute(info.homedir)) {
    throw new Error('FORWARD_CUSTODY_IDENTITY_UNAVAILABLE');
  }
  return join(info.homedir, '.local', 'share', 'lqwd-swap-engine', 'forward-payers');
}

function currentUid(): number {
  if (process.platform !== 'linux' || typeof process.getuid !== 'function') {
    throw new Error('FORWARD_CUSTODY_LINUX_ONLY');
  }
  return process.getuid();
}

function isNested(a: string, b: string): boolean {
  const rel = relative(a, b);
  return !rel || (rel !== '..' && !rel.startsWith('../'));
}

export async function syncDirectory(path: string) {
  const handle = await open(path, 'r');
  try { await handle.sync(); } finally { await handle.close(); }
}

/** Rejects tmpfs/ramfs and volatile /tmp or /dev/shm paths before durable custody or spending. */
export async function assertPersistentStorage(directory: string): Promise<void> {
  const resolved = resolve(directory);
  if (resolved === '/tmp' || resolved.startsWith('/tmp/') ||
    resolved === '/dev/shm' || resolved.startsWith('/dev/shm/')) {
    throw new Error('FORWARD_VOLATILE_STORAGE_FORBIDDEN');
  }
  let cursor = resolved;
  for (;;) {
    try {
      const fsStat = await statfs(cursor);
      if (fsStat.type === TMPFS_MAGIC || fsStat.type === RAMFS_MAGIC) {
        throw new Error('FORWARD_VOLATILE_STORAGE_FORBIDDEN');
      }
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const parent = dirname(cursor);
      if (parent === cursor) throw new Error('FORWARD_VOLATILE_STORAGE_FORBIDDEN');
      cursor = parent;
    }
  }
}

function assertPrivateDirStat(st: Stats, uid: number) {
  if (!st.isDirectory() || st.isSymbolicLink() || st.uid !== uid || (st.mode & 0o077) !== 0) {
    throw new Error('FORWARD_CUSTODY_INVALID');
  }
}

async function assertAncestorChain(target: string, uid: number) {
  let cursor = dirname(target);
  for (;;) {
    let st: Awaited<ReturnType<typeof lstat>> | undefined;
    try { st = await lstat(cursor); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        const parent = dirname(cursor);
        if (parent === cursor) throw new Error('FORWARD_CUSTODY_INVALID');
        cursor = parent;
        continue;
      }
      throw error;
    }
    if (!st.isDirectory() || st.isSymbolicLink() || ![0, uid].includes(st.uid) ||
      ((st.mode & 0o022) !== 0 && !(st.uid === 0 && (st.mode & 0o1000) !== 0))) {
      throw new Error('FORWARD_CUSTODY_INVALID');
    }
    const parent = dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
}

async function assertNoSymlinkPrefix(target: string) {
  let cursor = target;
  const missing: string[] = [];
  for (;;) {
    try {
      const st = await lstat(cursor);
      if (st.isSymbolicLink() || !st.isDirectory()) throw new Error('FORWARD_CUSTODY_ALIASED_PATH');
      const real = await realpath(cursor);
      if (real !== cursor) throw new Error('FORWARD_CUSTODY_ALIASED_PATH');
      return { existingRoot: cursor, missingParts: missing.reverse() };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const parent = dirname(cursor);
      if (parent === cursor) throw new Error('FORWARD_CUSTODY_INVALID');
      missing.push(cursor);
      cursor = parent;
    }
  }
}

export async function assertPrivateDirectory(rawPath: string, create: boolean) {
  const uid = currentUid();
  const resolved = resolve(rawPath);
  if (!isAbsolute(resolved)) throw new Error('FORWARD_CUSTODY_INVALID');
  await assertAncestorChain(resolved, uid);
  const { missingParts } = await assertNoSymlinkPrefix(resolved);
  if (create && missingParts.length > 0) {
    for (const part of missingParts) {
      const parent = dirname(part);
      const parentStat = await lstat(parent);
      if (!parentStat.isDirectory() || parentStat.isSymbolicLink() || ![0, uid].includes(parentStat.uid) ||
        ((parentStat.mode & 0o022) !== 0 && !(parentStat.uid === 0 && (parentStat.mode & 0o1000) !== 0))) {
        throw new Error('FORWARD_CUSTODY_INVALID');
      }
      try {
        await mkdir(part, { mode: 0o700 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
      assertPrivateDirStat(await lstat(part), uid);
      await syncDirectory(part);
      await syncDirectory(parent);
    }
  }
  const canonical = await realpath(resolved);
  if (canonical !== resolved) throw new Error('FORWARD_CUSTODY_ALIASED_PATH');
  await assertAncestorChain(canonical, uid);
  const st = await lstat(canonical, { bigint: true });
  if (!st.isDirectory() || st.isSymbolicLink() || st.uid !== BigInt(uid) || (st.mode & 0o077n) !== 0n) {
    throw new Error('FORWARD_CUSTODY_INVALID');
  }
  return { canonicalPath: canonical, dev: String(st.dev), ino: String(st.ino), uid };
}

function assertPrivateFileStat(st: BigIntStats, uid: number) {
  if (!st.isFile() || st.nlink !== 1n || st.uid !== BigInt(uid) || (st.mode & 0o077n) !== 0n) {
    throw new Error('FORWARD_CUSTODY_INVALID');
  }
}

export async function readPrivateFileStrict(filePath: string): Promise<{ bytes: Buffer; stat: BigIntStats } | undefined> {
  const uid = currentUid();
  let handle: FileHandle;
  try {
    handle = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  try {
    const stat = await handle.stat({ bigint: true });
    assertPrivateFileStat(stat, uid);
    return { bytes: await handle.readFile(), stat };
  } finally {
    await handle.close();
  }
}

async function writeExclusivePrivateFile(dirPath: string, filePath: string, content: string): Promise<BigIntStats> {
  const uid = currentUid();
  const handle = await open(filePath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  let stat: BigIntStats;
  try {
    stat = await handle.stat({ bigint: true });
    assertPrivateFileStat(stat, uid);
    await handle.writeFile(content);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await syncDirectory(dirPath);
  return stat;
}

export function validateStateForwardOwnership(bytes: Buffer, payerNode: string): { hasForwardRecords: boolean } {
  let raw: unknown;
  try { raw = parseStrictJson(bytes); } catch { throw new Error('FORWARD_STATE_INVALID'); }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('FORWARD_STATE_INVALID');
  const db = raw as Record<string, unknown>;
  if (db.schema !== 1 || !db.quotes || typeof db.quotes !== 'object' || Array.isArray(db.quotes) ||
    !db.swaps || typeof db.swaps !== 'object' || Array.isArray(db.swaps)) {
    throw new Error('FORWARD_STATE_INVALID');
  }
  let hasForwardRecords = false;
  for (const field of ['forwardPayments', 'forwardAdmissions'] as const) {
    if (!Object.hasOwn(db, field)) continue;
    const map = db[field];
    if (!map || typeof map !== 'object' || Array.isArray(map)) throw new Error('FORWARD_STATE_INVALID');
    const entries = Object.values(map as Record<string, unknown>);
    if (entries.length > 0) hasForwardRecords = true;
    for (const entry of entries) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry) ||
        (entry as Record<string, unknown>).payerNode !== payerNode) {
        throw new Error('FORWARD_STATE_PAYER_MISMATCH');
      }
    }
  }
  return { hasForwardRecords };
}

export function parseForwardBinding(bytes: Buffer, expectedPayerNode: string): Binding {
  let parsed: unknown;
  try { parsed = parseStrictJson(bytes); } catch { throw new Error('FORWARD_BINDING_INVALID'); }
  const result = bindingSchema.safeParse(parsed);
  if (!result.success) throw new Error('FORWARD_BINDING_INVALID');
  if (result.data.payerNode !== expectedPayerNode) throw new Error('FORWARD_PAYER_MISMATCH');
  return result.data;
}

export function assertBindingMatchesDirectory(
  binding: Binding,
  dir: { canonicalPath: string; dev: string; ino: string; uid: number },
) {
  if (binding.directory !== dir.canonicalPath || binding.dev !== dir.dev ||
    binding.ino !== dir.ino || binding.uid !== dir.uid) {
    throw new Error('FORWARD_CANONICAL_STORE_MISMATCH');
  }
}

async function assertFileUnchanged(path: string, expectedStat: BigIntStats, expectedBytes: Buffer, uid: number) {
  const current = await readPrivateFileStrict(path).catch(error => {
    if ((error as NodeJS.ErrnoException).code === 'ELOOP') throw new Error('FORWARD_CUSTODY_ALIASED_PATH');
    throw error;
  });
  if (!current) throw new Error('FORWARD_CUSTODY_LOST');
  assertPrivateFileStat(current.stat, uid);
  if (current.stat.dev !== expectedStat.dev || current.stat.ino !== expectedStat.ino) {
    throw new Error('FORWARD_CUSTODY_REPLACED');
  }
  if (!current.bytes.equals(expectedBytes)) {
    throw new Error('FORWARD_CUSTODY_MUTATED');
  }
}

async function acquireRegistryLock(
  locksCanonical: string,
  node: string,
  storeCanonical: string,
  uid: number,
) {
  const lockPath = join(locksCanonical, `${node}.lock`);
  const lockHandle = await open(lockPath, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
  let lockStat: BigIntStats;
  try {
    lockStat = await lockHandle.stat({ bigint: true });
    assertPrivateFileStat(lockStat, uid);
    await lockHandle.writeFile(JSON.stringify({
      version: 1, payerNode: node, directory: storeCanonical, pid: process.pid, uid,
    }) + '\n');
    await lockHandle.sync();
    await syncDirectory(locksCanonical);
    lockStat = await lockHandle.stat({ bigint: true });
  } catch (error) {
    await lockHandle.close().catch(() => {});
    throw error;
  }
  const assertLockHeld = async () => {
    const original = await lockHandle.stat({ bigint: true });
    const current = await lstat(lockPath, { bigint: true }).catch(() => undefined);
    if (!current || !current.isFile() || original.nlink !== 1n || current.nlink !== 1n ||
      current.dev !== original.dev || current.ino !== original.ino ||
      current.dev !== lockStat.dev || current.ino !== lockStat.ino ||
      current.uid !== BigInt(uid) || (current.mode & 0o077n) !== 0n) {
      throw new Error('Forward payer lock lost or replaced');
    }
  };
  return { lockPath, lockHandle, assertLockHeld };
}

function makeAssertDirUnchanged(uid: number) {
  return async (dirPath: string, expected: { dev: string; ino: string }) => {
    const canonicalNow = await realpath(dirPath).catch(() => undefined);
    if (canonicalNow !== dirPath) throw new Error('FORWARD_CUSTODY_ALIASED_PATH');
    await assertAncestorChain(dirPath, uid);
    const st = await lstat(dirPath, { bigint: true }).catch(() => undefined);
    if (!st || !st.isDirectory() || st.isSymbolicLink() || st.uid !== BigInt(uid) ||
      (st.mode & 0o077n) !== 0n || String(st.dev) !== expected.dev || String(st.ino) !== expected.ino) {
      throw new Error('FORWARD_CUSTODY_REPLACED');
    }
  };
}

/** Acquires exclusive per-payerNode lock AND engine.lock on an ALREADY-PROVISIONED canonical forward Store.
 * Never auto-creates a missing binding and never initializes an empty DB when state.json is missing. */
async function acquireExistingForwardPayerLeaseInternal(
  storeDirectory: string,
  payerNode: string,
  registryRoot: string,
  scope: ForwardLeaseScope,
  options: ForwardLeaseAcquisitionOptions,
): Promise<{ lease: ForwardPayerLease; dirLock: StoreDirectoryLock; stateBytes: Buffer }> {
  const node = pubkeySchema.parse(payerNode);
  const uid = currentUid();
  if (scope === 'system') {
    await assertPersistentStorage(registryRoot);
    await assertPersistentStorage(storeDirectory);
  }
  const regDir = await assertPrivateDirectory(registryRoot, true);
  const locksDir = await assertPrivateDirectory(join(regDir.canonicalPath, 'locks'), true);
  const bindingsDir = await assertPrivateDirectory(join(regDir.canonicalPath, 'bindings'), true);
  const storeDir = await assertPrivateDirectory(storeDirectory, false);
  if (isNested(regDir.canonicalPath, storeDir.canonicalPath) || isNested(storeDir.canonicalPath, regDir.canonicalPath)) {
    throw new Error('FORWARD_CUSTODY_NESTED_PATHS');
  }

  const { lockPath, lockHandle, assertLockHeld } = await acquireRegistryLock(
    locksDir.canonicalPath, node, storeDir.canonicalPath, uid,
  );
  let dirLock: StoreDirectoryLock | undefined;
  let uncertain = false;
  try {
    dirLock = await options.lockDirectory(storeDir.canonicalPath);
    if ((await readdir(storeDir.canonicalPath)).includes('state.tmp')) {
      throw new Error('FORWARD_UNRESOLVED_TEMP_STATE');
    }
    const bindingPath = join(bindingsDir.canonicalPath, `${node}.json`);
    const markerPath = join(storeDir.canonicalPath, FORWARD_STORE_MARKER);
    const statePath = join(storeDir.canonicalPath, 'state.json');
    const [bindingFile, markerFile, stateFile] = await Promise.all([
      readPrivateFileStrict(bindingPath),
      readPrivateFileStrict(markerPath),
      readPrivateFileStrict(statePath),
    ]);
    if (!bindingFile && !markerFile) throw new Error('FORWARD_CUSTODY_BINDING_REQUIRED');
    if (!bindingFile || !markerFile) throw new Error('FORWARD_BINDING_INCOMPLETE');
    const regBinding = parseForwardBinding(bindingFile.bytes, node);
    const storeMarker = parseForwardBinding(markerFile.bytes, node);
    if (regBinding.storeId !== storeMarker.storeId) throw new Error('FORWARD_BINDING_CONFLICT');
    assertBindingMatchesDirectory(regBinding, storeDir);
    assertBindingMatchesDirectory(storeMarker, storeDir);
    if (!stateFile) throw new Error('FORWARD_STATE_MISSING');
    validateStateForwardOwnership(stateFile.bytes, node);

    const assertDirUnchanged = makeAssertDirUnchanged(uid);
    const assertHeld = async () => {
      await assertDirUnchanged(regDir.canonicalPath, regDir);
      await assertDirUnchanged(locksDir.canonicalPath, locksDir);
      await assertDirUnchanged(bindingsDir.canonicalPath, bindingsDir);
      await assertLockHeld();
      await assertDirUnchanged(storeDir.canonicalPath, storeDir);
      await assertFileUnchanged(bindingPath, bindingFile.stat, bindingFile.bytes, uid);
      await assertFileUnchanged(markerPath, markerFile.stat, markerFile.bytes, uid);
    };

    await assertHeld();
    let closed = false;
    const closeHandle = async () => {
      if (closed) return;
      closed = true;
      await lockHandle.close().catch(() => {});
    };
    const release = async () => {
      try {
        await assertHeld();
        await unlink(lockPath);
      } finally {
        await closeHandle();
      }
    };
    const lease: ForwardPayerLease = {
      scope, payerNode: node, storeId: regBinding.storeId, directory: storeDir.canonicalPath,
      assertHeld, release, closeHandle,
    };
    if (scope === 'system') systemLeases.add(lease);
    else testLeases.add(lease);
    return { lease, dirLock, stateBytes: stateFile.bytes };
  } catch (error) {
    if (!uncertain) {
      if (dirLock) await dirLock().catch(() => dirLock!.closeHandle());
      try {
        await assertLockHeld();
        await unlink(lockPath);
      } catch { /* Never break a lost/replaced lock on failed open. */ }
    } else {
      await dirLock?.closeHandle();
    }
    await lockHandle.close().catch(() => {});
    throw error;
  }
}

/** Explicit offline provisioning for a brand-new fresh payer Store (empty state.json, durable storage).
 * Acquires both locks BEFORE creating binding -> marker -> initial state.json. */
async function provisionFreshForwardInternal(
  storeDirectory: string,
  payerNode: string,
  registryRoot: string,
  options: ForwardLeaseAcquisitionOptions,
): Promise<{ storeId: string; directory: string }> {
  const node = pubkeySchema.parse(payerNode);
  const uid = currentUid();
  if (!options.allowVolatileForTest) {
    await assertPersistentStorage(registryRoot);
    await assertPersistentStorage(storeDirectory);
  }
  const regDir = await assertPrivateDirectory(registryRoot, true);
  const locksDir = await assertPrivateDirectory(join(regDir.canonicalPath, 'locks'), true);
  const bindingsDir = await assertPrivateDirectory(join(regDir.canonicalPath, 'bindings'), true);
  const storeDir = await assertPrivateDirectory(storeDirectory, true);
  if (isNested(regDir.canonicalPath, storeDir.canonicalPath) || isNested(storeDir.canonicalPath, regDir.canonicalPath)) {
    throw new Error('FORWARD_CUSTODY_NESTED_PATHS');
  }
  const { lockPath, lockHandle, assertLockHeld } = await acquireRegistryLock(
    locksDir.canonicalPath, node, storeDir.canonicalPath, uid,
  );
  let dirLock: StoreDirectoryLock | undefined;
  let uncertain = false;
  try {
    dirLock = await options.lockDirectory(storeDir.canonicalPath);
    if ((await readdir(storeDir.canonicalPath)).includes('state.tmp')) {
      throw new Error('FORWARD_UNRESOLVED_TEMP_STATE');
    }
    const bindingPath = join(bindingsDir.canonicalPath, `${node}.json`);
    const markerPath = join(storeDir.canonicalPath, FORWARD_STORE_MARKER);
    const statePath = join(storeDir.canonicalPath, 'state.json');
    const envScopePath = join(storeDir.canonicalPath, '.environment.json');
    const [bindingFile, markerFile, stateFile, envScopeFile] = await Promise.all([
      readPrivateFileStrict(bindingPath),
      readPrivateFileStrict(markerPath),
      readPrivateFileStrict(statePath),
      readPrivateFileStrict(envScopePath),
    ]);
    if (bindingFile || markerFile) throw new Error('FORWARD_BINDING_ALREADY_EXISTS');
    if (stateFile) throw new Error('FORWARD_STATE_ALREADY_EXISTS');
    if (envScopeFile) throw new Error('FORWARD_STATE_SCOPE_ALREADY_EXISTS');

    const storeId = randomUUID();
    const content = JSON.stringify({
      version: 1, payerNode: node, storeId, directory: storeDir.canonicalPath,
      dev: storeDir.dev, ino: storeDir.ino, uid,
    }) + '\n';
    const expectedBindingBytes = Buffer.from(content);
    const initialState = '{"schema":1,"quotes":{},"swaps":{}}\n';

    uncertain = true;
    if (options.stateScope) {
      await assertStateScope(storeDir.canonicalPath, completeStateScope(options.stateScope), { allowLegacyOfflineMigration: false });
    }
    const bindingStat = await writeExclusivePrivateFile(bindingsDir.canonicalPath, bindingPath, content);
    const markerStat = await writeExclusivePrivateFile(storeDir.canonicalPath, markerPath, content);
    await writeExclusivePrivateFile(storeDir.canonicalPath, statePath, initialState);
    const [verifiedBinding, verifiedMarker, verifiedState] = await Promise.all([
      readPrivateFileStrict(bindingPath),
      readPrivateFileStrict(markerPath),
      readPrivateFileStrict(statePath),
    ]);
    if (!verifiedBinding || !verifiedMarker || !verifiedState ||
      verifiedBinding.stat.dev !== bindingStat.dev || verifiedBinding.stat.ino !== bindingStat.ino ||
      verifiedMarker.stat.dev !== markerStat.dev || verifiedMarker.stat.ino !== markerStat.ino ||
      !verifiedBinding.bytes.equals(expectedBindingBytes) ||
      !verifiedMarker.bytes.equals(expectedBindingBytes) ||
      !verifiedState.bytes.equals(Buffer.from(initialState))) {
      throw new Error('FORWARD_CUSTODY_INIT_MISMATCH');
    }
    uncertain = false;

    await dirLock();
    dirLock = undefined;
    await assertLockHeld();
    await unlink(lockPath);
    await lockHandle.close().catch(() => {});
    return { storeId, directory: storeDir.canonicalPath };
  } catch (error) {
    if (!uncertain) {
      if (dirLock) await dirLock().catch(() => dirLock!.closeHandle());
      try {
        await assertLockHeld();
        await unlink(lockPath);
      } catch { /* Never break a lost/replaced lock on failed provision. */ }
    } else {
      await dirLock?.closeHandle();
    }
    await lockHandle.close().catch(() => {});
    throw error;
  }
}

const manifestSchema = z.strictObject({
  target: z.literal('admin-regtest-3201'),
  network: z.literal('regtest'),
  entries: z.number().int().positive(),
  admissionCount: z.number().int().positive(),
  checksums: z.strictObject({
    'admin-original.json': hex64Schema,
    'historical-a-original.json': hex64Schema,
    'historical-b-original.json': hex64Schema,
    'candidate.json': hex64Schema,
  }),
  evidenceSha256: hex64Schema,
  boundAdmin: z.strictObject({
    storeId: canonicalUuidSchema,
    bindingSha256: hex64Schema,
    markerSha256: hex64Schema,
  }).nullable(),
});

const digestHex = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

/** Explicit offline provisioning / cutover from an authenticated consolidated review bundle. */
async function provisionConsolidatedForwardInternal(
  storeDirectory: string,
  payerNode: string,
  bundleDirectory: string,
  manifestSha256: string,
  registryRoot: string,
  options: ForwardLeaseAcquisitionOptions,
): Promise<{ storeId: string; directory: string }> {
  const node = pubkeySchema.parse(payerNode);
  hex64Schema.parse(manifestSha256);
  const uid = currentUid();
  if (!options.allowVolatileForTest) {
    await assertPersistentStorage(registryRoot);
    await assertPersistentStorage(storeDirectory);
  }
  const regDir = await assertPrivateDirectory(registryRoot, true);
  const locksDir = await assertPrivateDirectory(join(regDir.canonicalPath, 'locks'), true);
  const bindingsDir = await assertPrivateDirectory(join(regDir.canonicalPath, 'bindings'), true);
  const storeDir = await assertPrivateDirectory(storeDirectory, true);
  const bundleDir = await assertPrivateDirectory(bundleDirectory, false);
  if (isNested(regDir.canonicalPath, storeDir.canonicalPath) || isNested(storeDir.canonicalPath, regDir.canonicalPath) ||
    isNested(bundleDir.canonicalPath, storeDir.canonicalPath) || isNested(storeDir.canonicalPath, bundleDir.canonicalPath)) {
    throw new Error('FORWARD_CUSTODY_NESTED_PATHS');
  }

  const manifestFile = await readPrivateFileStrict(join(bundleDir.canonicalPath, 'manifest.json'));
  const candidateFile = await readPrivateFileStrict(join(bundleDir.canonicalPath, 'candidate.json'));
  if (!manifestFile || !candidateFile) throw new Error('FORWARD_CONSOLIDATED_BUNDLE_MISSING');
  if (digestHex(manifestFile.bytes) !== manifestSha256) throw new Error('FORWARD_CONSOLIDATED_MANIFEST_MISMATCH');
  const manifest = manifestSchema.parse(parseStrictJson(manifestFile.bytes));
  if (digestHex(candidateFile.bytes) !== manifest.checksums['candidate.json']) {
    throw new Error('FORWARD_CONSOLIDATED_CANDIDATE_MISMATCH');
  }
  const check = validateStateForwardOwnership(candidateFile.bytes, node);
  if (!check.hasForwardRecords) throw new Error('FORWARD_CONSOLIDATED_EMPTY');

  const { lockPath, lockHandle, assertLockHeld } = await acquireRegistryLock(
    locksDir.canonicalPath, node, storeDir.canonicalPath, uid,
  );
  let dirLock: StoreDirectoryLock | undefined;
  let uncertain = false;
  try {
    dirLock = await options.lockDirectory(storeDir.canonicalPath);
    if ((await readdir(storeDir.canonicalPath)).includes('state.tmp')) {
      throw new Error('FORWARD_UNRESOLVED_TEMP_STATE');
    }
    const bindingPath = join(bindingsDir.canonicalPath, `${node}.json`);
    const markerPath = join(storeDir.canonicalPath, FORWARD_STORE_MARKER);
    const statePath = join(storeDir.canonicalPath, 'state.json');
    const [bindingFile, markerFile, stateFile] = await Promise.all([
      readPrivateFileStrict(bindingPath),
      readPrivateFileStrict(markerPath),
      readPrivateFileStrict(statePath),
    ]);

    let storeId: string;
    if (bindingFile || markerFile) {
      if (!bindingFile || !markerFile) throw new Error('FORWARD_BINDING_INCOMPLETE');
      const regBinding = parseForwardBinding(bindingFile.bytes, node);
      const storeMarker = parseForwardBinding(markerFile.bytes, node);
      if (regBinding.storeId !== storeMarker.storeId) throw new Error('FORWARD_BINDING_CONFLICT');
      assertBindingMatchesDirectory(regBinding, storeDir);
      assertBindingMatchesDirectory(storeMarker, storeDir);
      if (!manifest.boundAdmin || manifest.boundAdmin.storeId !== regBinding.storeId ||
        manifest.boundAdmin.bindingSha256 !== digestHex(bindingFile.bytes) ||
        manifest.boundAdmin.markerSha256 !== digestHex(markerFile.bytes)) {
        throw new Error('FORWARD_BINDING_CONFLICT');
      }
      if (!stateFile || digestHex(stateFile.bytes) !== manifest.checksums['admin-original.json']) {
        throw new Error('FORWARD_CONSOLIDATED_SOURCE_CHANGED');
      }
      if (options.stateScope) {
        await assertStateScope(storeDir.canonicalPath, completeStateScope(options.stateScope), { allowLegacyOfflineMigration: false });
      }
      storeId = regBinding.storeId;
    } else {
      if (manifest.boundAdmin !== null) throw new Error('FORWARD_BINDING_CONFLICT');
      if (stateFile && digestHex(stateFile.bytes) !== manifest.checksums['admin-original.json']) {
        throw new Error('FORWARD_CONSOLIDATED_SOURCE_CHANGED');
      }
      if (options.stateScope) {
        await assertStateScope(storeDir.canonicalPath, completeStateScope(options.stateScope), { allowLegacyOfflineMigration: false });
      }
      storeId = randomUUID();
      const content = JSON.stringify({
        version: 1, payerNode: node, storeId, directory: storeDir.canonicalPath,
        dev: storeDir.dev, ino: storeDir.ino, uid,
      }) + '\n';
      uncertain = true;
      await writeExclusivePrivateFile(bindingsDir.canonicalPath, bindingPath, content);
      await writeExclusivePrivateFile(storeDir.canonicalPath, markerPath, content);
    }

    uncertain = true;
    const tempPath = join(storeDir.canonicalPath, 'state.tmp');
    const temp = await open(tempPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try {
      const tempStat = await temp.stat({ bigint: true });
      assertPrivateFileStat(tempStat, uid);
      await temp.writeFile(candidateFile.bytes);
      await temp.sync();
    } finally {
      await temp.close();
    }
    const { rename } = await import('node:fs/promises');
    await rename(tempPath, statePath);
    await syncDirectory(storeDir.canonicalPath);
    uncertain = false;

    await dirLock();
    dirLock = undefined;
    await assertLockHeld();
    await unlink(lockPath);
    await lockHandle.close().catch(() => {});
    return { storeId, directory: storeDir.canonicalPath };
  } catch (error) {
    if (!uncertain) {
      if (dirLock) await dirLock().catch(() => dirLock!.closeHandle());
      try {
        await assertLockHeld();
        await unlink(lockPath);
      } catch { /* Never break a lost/replaced lock on failed provision. */ }
    } else {
      await dirLock?.closeHandle();
    }
    await lockHandle.close().catch(() => {});
    throw error;
  }
}

export function acquireSystemForwardPayerLease(
  storeDirectory: string,
  payerNode: string,
  options: ForwardLeaseAcquisitionOptions,
) {
  return acquireExistingForwardPayerLeaseInternal(
    storeDirectory, payerNode, systemForwardPayerRegistryRoot(), 'system', options,
  );
}

export function provisionSystemFreshForwardStore(
  storeDirectory: string,
  payerNode: string,
  options: ForwardLeaseAcquisitionOptions,
) {
  return provisionFreshForwardInternal(storeDirectory, payerNode, systemForwardPayerRegistryRoot(), options);
}

export function provisionSystemConsolidatedForwardStore(
  storeDirectory: string,
  payerNode: string,
  bundleDirectory: string,
  manifestSha256: string,
  options: ForwardLeaseAcquisitionOptions,
) {
  return provisionConsolidatedForwardInternal(
    storeDirectory, payerNode, bundleDirectory, manifestSha256, systemForwardPayerRegistryRoot(), options,
  );
}

/** Test-only entry points requiring an authorized test token; production routes reject 'test'-scoped leases. */
export function acquireTestForwardPayerLease(
  testToken: object,
  storeDirectory: string,
  payerNode: string,
  registryRoot: string,
  options: ForwardLeaseAcquisitionOptions,
) {
  if (!testLeaseTokens.has(testToken)) throw new Error('FORWARD_TEST_TOKEN_INVALID');
  return acquireExistingForwardPayerLeaseInternal(storeDirectory, payerNode, registryRoot, 'test', options);
}

export function provisionTestFreshForwardStore(
  testToken: object,
  storeDirectory: string,
  payerNode: string,
  registryRoot: string,
  options: ForwardLeaseAcquisitionOptions,
) {
  if (!testLeaseTokens.has(testToken)) throw new Error('FORWARD_TEST_TOKEN_INVALID');
  return provisionFreshForwardInternal(storeDirectory, payerNode, registryRoot, options);
}

export function provisionTestConsolidatedForwardStore(
  testToken: object,
  storeDirectory: string,
  payerNode: string,
  bundleDirectory: string,
  manifestSha256: string,
  registryRoot: string,
  options: ForwardLeaseAcquisitionOptions,
) {
  if (!testLeaseTokens.has(testToken)) throw new Error('FORWARD_TEST_TOKEN_INVALID');
  return provisionConsolidatedForwardInternal(
    storeDirectory, payerNode, bundleDirectory, manifestSha256, registryRoot, options,
  );
}
