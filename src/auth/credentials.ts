import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';

export const Username = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/);
export const Role = z.enum(['USER', 'ADMIN']);
export type Role = z.infer<typeof Role>;
export const Password = z.string().min(1).refine(value => Buffer.byteLength(value) <= 1024);

// The format version fixes the work factors. The file cannot supply scrypt options.
const options = { N: 32_768, r: 8, p: 3, maxmem: 48 * 1024 * 1024 };
export const PasswordHash = z.string().regex(/^scrypt-v1\$[0-9a-f]{32}\$[0-9a-f]{64}$/);
const dummyHash = `scrypt-v1$${randomBytes(16).toString('hex')}$${randomBytes(32).toString('hex')}`;

function derive(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, 32, options, (error, key) => error ? reject(error) : resolve(key));
  });
}

export async function hashPassword(password: string, minimumLength: 4 | 12 = 12): Promise<string> {
  if (!Password.safeParse(password).success || [...password].length < minimumLength) {
    throw new Error(`Password must contain at least ${minimumLength} characters and at most 1024 bytes`);
  }
  const salt = randomBytes(16);
  const key = await derive(password, salt);
  return `scrypt-v1$${salt.toString('hex')}$${key.toString('hex')}`;
}

export async function verifyPassword(password: string, passwordHash?: string): Promise<boolean> {
  if (!Password.safeParse(password).success) return false;
  const parsed = PasswordHash.safeParse(passwordHash);
  const [, salt, expected] = (parsed.success ? parsed.data : dummyHash).split('$');
  const key = await derive(password, Buffer.from(salt!, 'hex'));
  const matches = timingSafeEqual(key, Buffer.from(expected!, 'hex'));
  return parsed.success && matches;
}
