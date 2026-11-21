import { constants } from 'node:fs';
import { lstat, realpath, open } from 'node:fs/promises';
import { dirname, resolve, isAbsolute, join } from 'node:path';
import { createHash } from 'node:crypto';

export const operatorStopped = () => new Error('OPERATOR_STOPPED: retain custody and intents; reconcile without retry');
export const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
export async function operatorDirectory(path: string) {
  const stat = await lstat(path);
  if (!isAbsolute(path) || !stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid!() ||
    stat.mode & 0o077 || await realpath(path) !== resolve(path)) throw operatorStopped();
}
/** Never prints contents. Existing system credentials may be 644 only inside an owned 700 ancestor. */
export async function protectedBytes(path: string, privateFile = true, publicFile = false): Promise<Buffer> {
  if (process.platform === 'win32' || !process.getuid || !isAbsolute(path) || await realpath(path) !== resolve(path)) throw operatorStopped();
  let directory = dirname(path); let protectedAncestor = false;
  for (;;) {
    const stat = await lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || ![0, process.getuid()].includes(stat.uid) ||
      (stat.mode & 0o022 && !(stat.uid === 0 && stat.mode & 0o1000))) throw operatorStopped();
    if (stat.uid === process.getuid() && !(stat.mode & 0o077)) protectedAncestor = true;
    const parent = dirname(directory); if (parent === directory) break; directory = parent;
  }
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.uid !== process.getuid() || stat.nlink !== 1 || stat.size > 65536 ||
      stat.mode & 0o022 || (privateFile && stat.mode & 0o077) || (!privateFile && !publicFile && stat.mode & 0o077 && !protectedAncestor)) throw operatorStopped();
    return await file.readFile();
  } finally { await file.close(); }
}
export async function checkedJSON(path: string, checksum: string) {
  const bytes = await protectedBytes(path);
  if (sha256(bytes) !== checksum) throw operatorStopped(); return JSON.parse(bytes.toString('utf8')) as unknown;
}
export async function operatorArtifact(directory: string, name: string, result: unknown) {
  if (!/^[a-z0-9-]+\.json$/.test(name)) throw operatorStopped();
  const bytes = Buffer.from(JSON.stringify(result, null, 2) + '\n'); const path = join(directory, name);
  let file;
  try { file = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || !(await protectedBytes(path)).equals(bytes)) throw operatorStopped(); return; }
  try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
  const dir = await open(directory, 'r'); try { await dir.sync(); } finally { await dir.close(); }
}
