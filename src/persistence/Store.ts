import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { Database } from '../core/SwapTypes.js';

/** All Store writers and offline maintenance must acquire this same lock. Never auto-break it. */
export async function lockStoreDirectory(directory: string): Promise<() => Promise<void>> {
  const path = join(directory, 'engine.lock');
  const lock = await open(path, 'wx', 0o600);
  // Failure to initialize leaves the lock in place (fail closed).
  try { await lock.writeFile(String(process.pid)); await lock.sync(); } finally { await lock.close(); }
  return () => unlink(path);
}

/** Single process, serialized copy-on-write transactions; fsync before atomic rename. */
export class Store {
  private db: Database = { schema: 1, quotes: {}, swaps: {} };
  private queue: Promise<unknown> = Promise.resolve();
  private poisoned = false;
  private closing?: Promise<void>;
  private constructor(private directory: string, private unlock: () => Promise<void>) {}
  static async open(directory: string): Promise<Store> {
    directory = resolve(directory);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const store = new Store(directory, await lockStoreDirectory(directory));
    try {
      try {
        store.db = JSON.parse(await readFile(join(store.directory, 'state.json'), 'utf8')) as Database;
        if (store.db.schema !== 1 || !store.db.swaps || !store.db.quotes) throw new Error('Unsupported database');
      } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
      return store;
    } catch (e) { await store.unlock(); throw e; }
  }
  read(): Database {
    if (this.poisoned) throw new Error('Persistence outcome uncertain; restart and reconcile');
    return structuredClone(this.db);
  }
  transaction<T>(fn: (draft: Database) => T): Promise<T> {
    if (this.closing) return Promise.reject(new Error('Store is closing or closed'));
    const action = this.queue.then(async () => {
      if (this.poisoned) throw new Error('Persistence outcome uncertain; restart and reconcile');
      const draft = structuredClone(this.db);
      const result = structuredClone(fn(draft));
      // Detach caller-owned objects before the first await so memory and disk
      // commit the same immutable snapshot, even if an adapter retains a reference.
      const committed = structuredClone(draft);
      const temp = join(this.directory, 'state.tmp');
      const file = await open(temp, 'w', 0o600);
      try { await file.writeFile(JSON.stringify(committed)); await file.sync(); } finally { await file.close(); }
      try {
        await rename(temp, join(this.directory, 'state.json'));
      // Persist the directory entry on POSIX; Windows does not support directory fsync.
        if (process.platform !== 'win32') {
          const directory = await open(this.directory, 'r');
          try { await directory.sync(); } finally { await directory.close(); }
        }
      } catch (error) { this.poisoned = true; throw error; }
      this.db = committed;
      return result;
    });
    this.queue = action.catch(() => {});
    return action;
  }
  close() { return this.closing ??= this.queue.then(this.unlock); }
}
