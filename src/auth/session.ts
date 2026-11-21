import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { verifyPassword, type Role } from './credentials.js';
import { defaultAuthStorePath, readAccounts, type Account } from './store.js';
import type { ApplicationMode } from '../config.js';

const cookieName = 'swap_session';
const tokenPattern = /^[a-f0-9]{64}$/;
const loginWindowMs = 60_000;
const maxSessions = 1024;
const loopbackAddresses = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

function loopbackOrigin(req: IncomingMessage): string | undefined {
  const host = req.headers.host;
  if (!host || req.headersDistinct.host?.length !== 1) return;
  const port = req.socket.localPort;
  const authority = ['localhost', '127.0.0.1', '[::1]']
    .map(name => port === 80 ? name : `${name}:${port}`).find(candidate => candidate === host);
  if (authority) return `http://${authority}`;
}

interface Session {
  id: string;
  account: Account;
  csrfToken: string;
  expiresAt: number;
}

export interface AuthOptions {
  storePath?: string;
  origin?: string;
  sessionTtlMs?: number;
  now?: () => number;
}

export class Sessions {
  private readonly sessions = new Map<string, Session>();
  private readonly attemptsByAddress = new Map<string, number>();
  private attempts = 0;
  private windowEndsAt = 0;
  private pendingLogins = 0;
  private readonly storePath: string;
  private readonly origin?: string;
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(options: AuthOptions, private readonly mode: ApplicationMode) {
    this.storePath = options.storePath ?? defaultAuthStorePath();
    this.origin = options.origin ?? process.env.AUTH_ORIGIN;
    if (this.origin !== undefined) {
      const url = new URL(this.origin);
      if (!['http:', 'https:'].includes(url.protocol) || url.origin !== this.origin) {
        throw new Error('AUTH_ORIGIN must be an HTTP(S) origin');
      }
    }
    this.ttlMs = options.sessionTtlMs ?? 3_600_000;
    if (!Number.isSafeInteger(this.ttlMs) || this.ttlMs < 1000 || this.ttlMs > 86_400_000) {
      throw new Error('Invalid session lifetime');
    }
    this.now = options.now ?? Date.now;
  }

  sameOrigin(req: IncomingMessage): boolean {
    const origin = req.headers.origin;
    if (!origin || req.headersDistinct.origin?.length !== 1) return false;
    return origin === (this.origin ?? loopbackOrigin(req));
  }

  private isLocalLabRequest(req: IncomingMessage): boolean {
    if (this.mode !== 'simulation' && this.mode !== 'regtest') return false;
    if (!loopbackAddresses.has(req.socket.remoteAddress ?? '') || !loopbackAddresses.has(req.socket.localAddress ?? '')) return false;
    if (Object.keys(req.headers).some(name => /^(forwarded$|x-forwarded-|x-real-ip$|via$)/.test(name))) return false;
    const directOrigin = loopbackOrigin(req);
    return directOrigin !== undefined && (this.origin === undefined || this.origin === directOrigin) &&
      (req.headers.origin === undefined || this.sameOrigin(req));
  }

  allowLoginAttempt(req: IncomingMessage): boolean {
    const now = this.now();
    if (now >= this.windowEndsAt) {
      this.windowEndsAt = now + loginWindowMs;
      this.attempts = 0;
      this.attemptsByAddress.clear();
    }
    const address = req.socket.remoteAddress ?? '';
    const attempts = this.attemptsByAddress.get(address) ?? 0;
    if (this.attempts >= 30 || attempts >= 5) return false;
    this.attempts++;
    this.attemptsByAddress.set(address, attempts + 1);
    return true;
  }

  async login(req: IncomingMessage, username: string, password: string): Promise<Session | undefined> {
    if (this.pendingLogins >= 4) return;
    this.pendingLogins++;
    try {
      const accounts = await this.accounts();
      const normalizedUsername = username.toLowerCase();
      const account = accounts.find(user => user.username.toLowerCase() === normalizedUsername &&
        (!user.localLabOnly || this.isLocalLabRequest(req)));
      if (!await verifyPassword(password, account?.passwordHash) || !account) return;
      const now = this.now();
      for (const [id, session] of this.sessions) {
        if (session.expiresAt <= now) this.sessions.delete(id);
      }
      if (this.sessions.size >= maxSessions) return;
      const session = {
        id: randomBytes(32).toString('hex'),
        account,
        csrfToken: randomBytes(32).toString('hex'),
        expiresAt: now + this.ttlMs,
      };
      this.sessions.set(session.id, session);
      return session;
    } finally {
      this.pendingLogins--;
    }
  }

  async get(req: IncomingMessage): Promise<Session | undefined> {
    const cookies = (req.headers.cookie ?? '').split(';').map(part => part.trim());
    const matches = cookies.filter(part => part.startsWith(`${cookieName}=`));
    const id = matches[0]?.slice(cookieName.length + 1);
    if (matches.length !== 1 || !id || !tokenPattern.test(id)) return;
    const session = this.sessions.get(id);
    if (!session) return;
    if (session.account.localLabOnly && !this.isLocalLabRequest(req)) return;
    if (session.expiresAt <= this.now()) {
      this.sessions.delete(id);
      return;
    }
    const accounts = await this.accounts();
    const account = accounts.find(user => user.id === session.account.id);
    if (this.sessions.get(id) !== session || session.expiresAt <= this.now() || !account ||
        account.role !== session.account.role || account.username !== session.account.username ||
        account.localLabOnly !== session.account.localLabOnly ||
        account.passwordHash !== session.account.passwordHash) {
      this.sessions.delete(id);
      return;
    }
    return session;
  }

  verifyCsrf(req: IncomingMessage, session: Session): boolean {
    const token = req.headers['x-csrf-token'];
    return this.sameOrigin(req) && typeof token === 'string' && tokenPattern.test(token) &&
      timingSafeEqual(Buffer.from(token, 'hex'), Buffer.from(session.csrfToken, 'hex'));
  }

  revoke(session: Session): void {
    this.sessions.delete(session.id);
  }

  cookie(session?: Session): string {
    const age = session ? Math.ceil(this.ttlMs / 1000) : 0;
    const secure = this.origin?.startsWith('https:') ? '; Secure' : '';
    return `${cookieName}=${session?.id ?? ''}; Path=/; Max-Age=${age}; HttpOnly; SameSite=Strict${secure}`;
  }

  private async accounts(): Promise<Account[]> {
    try { return await readAccounts(this.storePath); }
    catch { return []; }
  }
}

export function sessionResponse(session: Session) {
  const { id, username, role } = session.account;
  return { user: { id, username, role }, csrfToken: session.csrfToken, expiresAt: session.expiresAt };
}

export function roleDenial(session: Session | undefined, required: Role): 401 | 403 | undefined {
  if (!session) return 401;
  if (required === 'ADMIN' && session.account.role !== 'ADMIN') return 403;
}
