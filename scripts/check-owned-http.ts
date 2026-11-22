import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';

type IO = { password(): Buffer; fetch: typeof fetch };
const stopped = (label: string): never => { throw new Error(label); };
/** Real session/owner/CSRF/Operations smoke test. Its only preparation POSTs contain
 * amount 0, so even a broken auth guard cannot reach the invoice-creation harness. */
export async function checkOwnedHttp(args: string[], io: IO = { password: () => readFileSync(0), fetch }) {
  if (args.length !== 9 || args[0] !== '--check-http-readonly' || args[1] !== '--origin' || args[3] !== '--owner-id' ||
    args[5] !== '--owner-username' || args[7] !== '--archive-id' || !z.uuid().safeParse(args[4]).success ||
    !/^[A-Za-z0-9._-]{1,64}$/.test(args[6] ?? '') || !z.uuid().safeParse(args[8]).success) stopped('HTTP_CHECK_ARGUMENTS');
  const origin = new URL(args[2]!);
  if (origin.origin !== args[2] || origin.protocol !== 'http:' || origin.hostname !== '127.0.0.1' || !origin.port || origin.username || origin.password) stopped('HTTP_CHECK_ORIGIN');
  let cookie = ''; let csrf = ''; let password: Buffer | undefined;
  const request = async (path: string, body?: unknown, headers: Record<string, string> = {}) => io.fetch(new URL(path, origin), {
    method: body === undefined ? 'GET' : 'POST', redirect: 'error', signal: AbortSignal.timeout(10000),
    headers: { origin: origin.origin, ...(cookie ? { cookie, 'x-csrf-token': csrf } : {}), ...headers,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const expect = (value: boolean, label: string) => { if (!value) stopped(label); };
  try {
    const health = await request('/v1/health'); expect(health.status === 200, 'HEALTH_UNAVAILABLE');
    const h = await health.json() as { network?: string; mode?: string; liveSwapsEnabled?: boolean };
    expect(h.network === 'regtest' && h.mode === 'regtest' && h.liveSwapsEnabled === false, 'HEALTH_GATE');
    const anonymous = await request('/v1/reverse/availability'); expect(anonymous.status === 401, 'GUEST_GATE'); await anonymous.body?.cancel();
    password = io.password(); let length = password.length; while (length && [10, 13].includes(password[length - 1]!)) length--;
    expect(length > 0 && length <= 4096, 'PASSWORD_INPUT');
    const login = await request('/v1/auth/login', { username: args[6], password: password.subarray(0, length).toString('utf8') }); password.fill(0);
    expect(login.status === 200, 'LOGIN_REJECTED');
    const setCookie = login.headers.get('set-cookie') ?? '';
    expect(/HttpOnly/i.test(setCookie) && /SameSite=Strict/i.test(setCookie), 'COOKIE_FLAGS'); cookie = setCookie.split(';')[0]!;
    const session = await login.json() as { user: { id: string; username: string; role: string }; csrfToken: string; expiresAt: number };
    expect(session.user.id === args[4] && session.user.username === args[6] && session.user.role === 'ADMIN' &&
      /^[a-f0-9]{64}$/.test(session.csrfToken) && session.expiresAt > Date.now(), 'SESSION_IDENTITY'); csrf = session.csrfToken;
    const verified = await request('/v1/auth/session'); expect(verified.status === 200, 'SESSION_RECHECK'); await verified.body?.cancel();
    const available = await request('/v1/reverse/availability'); expect(available.status === 200, 'AVAILABILITY_UNAVAILABLE');
    const a = await available.json() as { controlledReverseConfigured?: boolean; preparationAvailable?: boolean; preparedSwapIds?: string[] };
    expect(a.controlledReverseConfigured === true && a.preparationAvailable === true && !!a.preparedSwapIds?.includes(args[8]!), 'PREPARATION_GATE');
    const archive = await request('/v1/swaps/' + args[8]); expect(archive.status === 200, 'ARCHIVE_UNAVAILABLE');
    const s = await archive.json() as { id: string; state: string; payment: { status: string; valueSats: number }; funding: { txid: string }; claim: { txid: string; netSats: number } };
    expect(s.id === args[8] && s.state === 'COMPLETED' && s.payment.status === 'SUCCEEDED' && s.payment.valueSats === 50750 &&
      /^[a-f0-9]{64}$/.test(s.funding.txid) && /^[a-f0-9]{64}$/.test(s.claim.txid) && s.claim.netSats === 49500, 'ARCHIVE_EVIDENCE');
    const ops = await request('/v1/operations/balances'); expect(ops.status === 200, 'OPERATIONS_UNAVAILABLE');
    const balances = await ops.json() as { core?: { confirmedSats?: unknown }; provider?: { confirmedSats?: unknown; localSats?: unknown }; alice?: { confirmedSats?: unknown; localSats?: unknown } };
    expect([balances.core?.confirmedSats, balances.provider?.confirmedSats, balances.provider?.localSats, balances.alice?.confirmedSats, balances.alice?.localSats]
      .every(v => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0), 'FOUR_BALANCES_UNAVAILABLE');
    const negativeBody = { amountSats: 0 }; const key = 'read-only-negative-acceptance';
    for (const [headers, status] of [[{ 'idempotency-key': key, 'x-csrf-token': '0'.repeat(64) }, 403],
      [{ 'idempotency-key': key, origin: 'http://invalid.example' }, 403], [{ 'idempotency-key': key }, 400]] as const) {
      const response = await request('/v1/reverse/preparations', negativeBody, headers); expect(response.status === status, 'CSRF_OR_BODY_GATE'); await response.body?.cancel();
    }
    return { status: 'ADMIN_HTTP_VERIFIED_NO_PREPARATION_OR_PAYMENT', ownerId: args[4], ownerUsername: args[6], archiveId: s.id, fundingTxid: s.funding.txid,
      claimTxid: s.claim.txid, fourBalancesVerified: true, anonymousStatus: 401, csrfStatus: 403, invalidBodyStatus: 400 };
  } finally { password?.fill(0); cookie = csrf = ''; }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  void checkOwnedHttp(process.argv.slice(2)).then(result => process.stdout.write(JSON.stringify(result) + '\n'))
    .catch(error => { process.stderr.write(/^[A-Z_]+$/.test(String(error?.message)) ? error.message + '\n' : 'HTTP_CHECK_STOPPED\n'); process.exitCode = 1; });
