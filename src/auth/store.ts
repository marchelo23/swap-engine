import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { z } from 'zod';
import { PasswordHash, Role, Username } from './credentials.js';

const maxStoreBytes = 256 * 1024;
export const Account = z.object({
  id: z.uuid(),
  username: Username,
  role: Role,
  passwordHash: PasswordHash,
  localLabOnly: z.literal(true).optional(),
}).strict();
export type Account = z.infer<typeof Account>;

export const AccountFile = z.object({ version: z.literal(1), users: z.array(Account).max(1000) })
  .strict().refine(({ users }) =>
    new Set(users.map(user => user.id)).size === users.length &&
    new Set(users.map(user => user.username.toLowerCase())).size === users.length);

export function defaultAuthStorePath(): string {
  return process.env.AUTH_STORE_PATH ?? './data/auth/users.json';
}

export async function readAccounts(path: string): Promise<Account[]> {
  try {
    if (!(await lstat(path)).isFile()) throw new Error('Auth store must be a regular file');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const flags = constants.O_RDONLY | (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW | constants.O_NONBLOCK);
  const file = await open(path, flags);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > maxStoreBytes ||
        (process.platform !== 'win32' && (stat.mode & 0o077) !== 0)) {
      throw new Error('Auth store is unsafe');
    }
    const buffer = Buffer.alloc(maxStoreBytes + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await file.read(buffer, length, buffer.length - length, null);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length > maxStoreBytes) throw new Error('Auth store is too large');
    return AccountFile.parse(JSON.parse(buffer.toString('utf8', 0, length))).users;
  } finally {
    await file.close();
  }
}
