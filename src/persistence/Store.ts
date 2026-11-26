import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, readFile, rename, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { Database } from '../core/SwapTypes.js';
import type { StateScope } from '../environment/StateScope.js';
import {
  acquireSystemForwardPayerLease,
  acquireTestForwardPayerLease,
  FORWARD_STORE_MARKER,
  isAuthorizedForwardPayerLease,
  provisionSystemConsolidatedForwardStore,
  provisionSystemFreshForwardStore,
  provisionTestConsolidatedForwardStore,
  provisionTestFreshForwardStore,
  readPrivateFileStrict,
  syncDirectory,
  type ForwardPayerLease,
  type StoreDirectoryLock,
} from './ForwardPayerRegistry.js';
import { parseStrictJson } from './StrictJson.js';

/** All Store writers and offline maintenance must acquire this same lock. Never auto-break it. */
export async function lockStoreDirectory(directory: string): Promise<StoreDirectoryLock> {
  const path = join(directory, 'engine.lock');
  const lock = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  // Failure to initialize leaves the lock in place (fail closed).
  try {
    await lock.writeFile(String(process.pid));
    await lock.sync();
    if (process.platform !== 'win32') await syncDirectory(directory);
  } catch (error) {
    await lock.close();
    throw error;
  }
  const uid = process.getuid?.();
  const assertHeld = async () => {
    const original = await lock.stat({ bigint: true });
    const current = await lstat(path, { bigint: true }).catch(() => undefined);
    if (!current?.isFile() || original.nlink !== 1n || current.dev !== original.dev || current.ino !== original.ino ||
      (process.platform !== 'win32' && (uid === undefined || current.uid !== BigInt(uid) || (current.mode & 0o077n) !== 0n))) {
      throw new Error('Store lock lost or replaced');
    }
  };
  const closeHandle = () => lock.close().catch(() => {});
  const release = async () => {
    try { await assertHeld(); await unlink(path); } finally { await lock.close(); }
  };
  return Object.assign(release, { assertHeld, closeHandle });
}

/** Single process, serialized copy-on-write transactions; fsync before atomic rename.
 * `engine.lock` provides cooperative per-directory exclusion only; consumers must await `close()`.
 * Forward writers must open via `Store.openForForward` for per-payerNode exclusion and canonical binding. */
export class Store {
  private db: Database = { schema: 1, quotes: {}, swaps: {} };
  private queue: Promise<unknown> = Promise.resolve();
  private poisoned = false;
  private closing?: Promise<void>;
  private constructor(
    private directory: string,
    private lock: StoreDirectoryLock,
    private forwardLease?: ForwardPayerLease,
    private forwardBoundReadOnly = false,
  ) {}

  static async open(directory: string): Promise<Store> {
    directory = resolve(directory);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const dirLock = await lockStoreDirectory(directory);
    let forwardBoundReadOnly = false;
    try {
      if ((await readdir(directory)).includes('state.tmp')) {
        throw new Error('Unresolved Store temporary state');
      }
      const markerStat = await lstat(join(directory, FORWARD_STORE_MARKER)).catch(() => undefined);
      if (markerStat) forwardBoundReadOnly = true;
      const store = new Store(directory, dirLock, undefined, forwardBoundReadOnly);
      try {
        store.db = JSON.parse(await readFile(join(store.directory, 'state.json'), 'utf8')) as Database;
        if (store.db.schema !== 1 || !store.db.swaps || !store.db.quotes) throw new Error('Unsupported database');
      } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
      return store;
    } catch (e) {
      await dirLock().catch(() => dirLock.closeHandle());
      throw e;
    }
  }

  private static async openFromAcquisition(
    acquisition: Promise<{ lease: ForwardPayerLease; dirLock: StoreDirectoryLock; stateBytes: Buffer }>,
  ): Promise<Store> {
    const { lease, dirLock, stateBytes } = await acquisition;
    try {
      const parsed = parseStrictJson(stateBytes) as Database;
      if (parsed.schema !== 1 || !parsed.swaps || !parsed.quotes) throw new Error('Unsupported database');
      const store = new Store(lease.directory, dirLock, lease, false);
      store.db = parsed;
      await store.assertAllHeld();
      return store;
    } catch (error) {
      await dirLock().catch(() => dirLock.closeHandle());
      await lease.release().catch(() => lease.closeHandle());
      throw error;
    }
  }

  /** Opens an already-provisioned canonical forward Store for `payerNode` under both per-payer
   * exclusion and per-directory `engine.lock`, using the fixed OS-user system registry. */
  static openForForward(directory: string, payerNode: string): Promise<Store> {
    return Store.openFromAcquisition(acquireSystemForwardPayerLease(directory, payerNode, {
      lockDirectory: lockStoreDirectory,
    }));
  }

  /** Explicit offline provisioning for a brand-new fresh payer Store (system registry, durable non-tmpfs storage). */
  static provisionFreshForward(directory: string, payerNode: string, stateScope?: StateScope) {
    return provisionSystemFreshForwardStore(directory, payerNode, {
      lockDirectory: lockStoreDirectory,
      stateScope,
    });
  }

  /** Explicit offline provisioning/cutover from an authenticated consolidated review bundle (system registry). */
  static provisionConsolidatedForward(
    directory: string,
    payerNode: string,
    bundleDirectory: string,
    manifestSha256: string,
    stateScope?: StateScope,
  ) {
    return provisionSystemConsolidatedForwardStore(directory, payerNode, bundleDirectory, manifestSha256, {
      lockDirectory: lockStoreDirectory,
      stateScope,
    });
  }

  /** Test-only isolated variant; requires explicit authorized test token and never produces system-scoped leases. */
  static openForForwardWithTestToken(
    testToken: object,
    directory: string,
    payerNode: string,
    registryRoot: string,
  ): Promise<Store> {
    return Store.openFromAcquisition(acquireTestForwardPayerLease(testToken, directory, payerNode, registryRoot, {
      lockDirectory: lockStoreDirectory,
    }));
  }

  static provisionFreshForwardWithTestToken(
    testToken: object,
    directory: string,
    payerNode: string,
    registryRoot: string,
    allowVolatileForTest = true,
    stateScope?: StateScope,
  ) {
    return provisionTestFreshForwardStore(testToken, directory, payerNode, registryRoot, {
      lockDirectory: lockStoreDirectory,
      allowVolatileForTest,
      stateScope,
    });
  }

  static provisionConsolidatedForwardWithTestToken(
    testToken: object,
    directory: string,
    payerNode: string,
    bundleDirectory: string,
    manifestSha256: string,
    registryRoot: string,
    allowVolatileForTest = true,
    stateScope?: StateScope,
  ) {
    return provisionTestConsolidatedForwardStore(
      testToken, directory, payerNode, bundleDirectory, manifestSha256, registryRoot,
      { lockDirectory: lockStoreDirectory, allowVolatileForTest, stateScope },
    );
  }

  forwardPayerNode(): string | undefined {
    return this.forwardLease?.payerNode;
  }

  assertForwardStore(testToken?: object): void {
    if (this.poisoned) throw new Error('Persistence outcome uncertain; restart and reconcile');
    if (this.closing) throw new Error('Store is closing or closed');
    if (!this.forwardLease) throw new Error('FORWARD_PAYER_LEASE_REQUIRED');
    if (!isAuthorizedForwardPayerLease(this.forwardLease, testToken)) {
      throw new Error('FORWARD_SYSTEM_LEASE_REQUIRED');
    }
  }

  assertForwardPayerBoundSync(payerNode: string, testToken?: object): void {
    this.assertForwardStore(testToken);
    if (this.forwardLease!.payerNode !== payerNode) throw new Error('FORWARD_PAYER_MISMATCH');
  }

  async assertForwardPayerHeld(payerNode: string, testToken?: object): Promise<void> {
    this.assertForwardPayerBoundSync(payerNode, testToken);
    try { await this.assertAllHeld(); }
    catch (error) { this.poisoned = true; throw error; }
  }

  private async assertAllHeld() {
    await this.lock.assertHeld();
    if (this.forwardLease) await this.forwardLease.assertHeld();
  }

  read(): Database {
    if (this.poisoned) throw new Error('Persistence outcome uncertain; restart and reconcile');
    return structuredClone(this.db);
  }

  transaction<T>(fn: (draft: Database) => T): Promise<T> {
    if (this.closing) return Promise.reject(new Error('Store is closing or closed'));
    if (this.forwardBoundReadOnly && !this.forwardLease) {
      return Promise.reject(new Error('FORWARD_PAYER_LEASE_REQUIRED'));
    }
    const action = this.queue.then(async () => {
      if (this.poisoned) throw new Error('Persistence outcome uncertain; restart and reconcile');
      try { await this.assertAllHeld(); }
      catch (error) { this.poisoned = true; throw error; }
      const draft = structuredClone(this.db);
      const result = structuredClone(fn(draft));
      // Detach caller-owned objects before the first await so memory and disk
      // commit the same immutable snapshot, even if an adapter retains a reference.
      const committed = structuredClone(draft);
      const temp = join(this.directory, 'state.tmp');
      try {
        const file = process.platform !== 'win32'
          ? await open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
          : await open(temp, 'wx', 0o600);
        try {
          if (process.platform !== 'win32') {
            const st = await file.stat({ bigint: true });
            const uid = process.getuid?.();
            if (!st.isFile() || st.nlink !== 1n || uid === undefined || st.uid !== BigInt(uid) || (st.mode & 0o077n) !== 0n)
              throw new Error('FORWARD_CUSTODY_INVALID');
          }
          await file.writeFile(JSON.stringify(committed));
          await file.sync();
        } finally { await file.close(); }
        await this.assertAllHeld();
        await rename(temp, join(this.directory, 'state.json'));
        // Persist the directory entry on POSIX; Windows does not support directory fsync.
        if (process.platform !== 'win32') {
          const directory = await open(this.directory, 'r');
          try { await directory.sync(); } finally { await directory.close(); }
        }
        if (this.forwardLease) await this.assertAllHeld();
      } catch (error) { this.poisoned = true; throw error; }
      this.db = committed;
      return result;
    });
    this.queue = action.catch(() => {});
    return action;
  }

  /** Drains queued writes, verifies lock ownership, and unlinks locks. Rejects if poisoned or any lock was lost/replaced. */
  close() {
    return this.closing ??= this.queue.then(async () => {
      if (!this.forwardLease) {
        let lockHeld = false;
        try {
          await this.lock.assertHeld();
          lockHeld = true;
        } catch (error) {
          this.poisoned = true;
          throw error;
        } finally {
          if (!lockHeld || this.poisoned) await this.lock.closeHandle();
        }
        if (this.poisoned) {
          await this.lock.closeHandle();
          throw new Error('Persistence outcome uncertain; locks retained for reconciliation');
        }
        await this.lock();
        return;
      }
      let bothHeld = false;
      try {
        await this.lock.assertHeld();
        await this.forwardLease.assertHeld();
        bothHeld = true;
      } catch (error) {
        this.poisoned = true;
        throw error;
      } finally {
        if (!bothHeld || this.poisoned) {
          await Promise.allSettled([this.lock.closeHandle(), this.forwardLease.closeHandle()]);
        }
      }
      if (this.poisoned) {
        throw new Error('Persistence outcome uncertain; locks retained for reconciliation');
      }
      const results = await Promise.allSettled([this.lock(), this.forwardLease.release()]);
      const failed = results.find((r): r is PromiseRejectedResult => r.status === 'rejected');
      if (failed) { this.poisoned = true; throw failed.reason; }
    });
  }
}

export { readPrivateFileStrict };
