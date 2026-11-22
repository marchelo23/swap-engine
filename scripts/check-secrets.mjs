import { execFileSync } from 'node:child_process';

const git = (...args) => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 20_000_000 }).trim();
const allowedEnvExamples = new Set(['.env.example', '.env.regtest.example', '.env.signet.example', '.env.mainnet.example', '.env.ark-regtest.example', '.env.liquid-regtest.example']);
const forbidden = /(^|\/)(\.env(?:\..*)?|\.cookie|wallet\.dat|[^/]*\.(?:macaroon|pem|key|cert|db|sqlite|seed|backup)|data|node_modules|secrets)(\/|$)/i;
const rules = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})/,
  /(?:rpcpassword|macaroon|preimage|private_key)\s*[:=]\s*["']?[a-f0-9]{64,}/i,
  /https?:\/\/[^\s/@:]+:[^\s/@]+@/,
];
const paths = git('ls-files', '--cached', '-z').split('\0').filter(Boolean);
let failures = 0;
function check(path, content, source) {
  if (!allowedEnvExamples.has(path) && forbidden.test(path)) { console.error(`Forbidden tracked path (${source}): ${path}`); failures++; }
  if (path === 'scripts/check-secrets.mjs') return; // Rule literals are not credentials.
  if (rules.some(rule => rule.test(content))) { console.error(`Potential credential (${source}): ${path}`); failures++; }
}
for (const path of paths) check(path, git('show', `:${path}`), 'index');
let revisions = '';
try { revisions = git('rev-list', '--all'); } catch { /* Unborn repository. */ }
const seen = new Set();
for (const revision of revisions.split('\n').filter(Boolean)) {
  const objects = git('ls-tree', '-r', revision).split('\n').filter(Boolean);
  for (const object of objects) {
    const match = /^\d+ blob ([a-f0-9]+)\t(.+)$/.exec(object);
    if (!match) continue;
    const [, oid, path] = match;
    if (seen.has(`${oid}:${path}`)) continue;
    seen.add(`${oid}:${path}`);
    check(path, git('cat-file', '-p', oid), 'history');
  }
}
console.log(JSON.stringify({ event: 'secret_scan', indexedFiles: paths.length, historicalBlobs: seen.size, findings: failures }));
process.exitCode = failures ? 1 : 0;
