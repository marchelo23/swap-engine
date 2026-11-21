import type { IncomingMessage, ServerResponse } from 'node:http';
import { sessionOwnerAuthenticator, type OwnerSessions, type OwnedReverseApi } from './ownedReverse.js';
import type { serveOwnedReverse } from './serveOwnedReverse.js';
import type { OwnedPreparationService } from './ownedPreparation.js';

/** Mount this handler in the EXISTING authenticated app before legacy swap routes. The
 * operator loader runs in-process, keeping its store/custody lifetime open until close().
 * It neither creates a login nor trusts a cookie, bearer token or forwarded owner itself. */
export function createOwnedReverseGateway<S extends { account: { id: string; role: string } }>(sessions: OwnerSessions<S>,
  options: { enabled?: boolean; delegateWhenInactive?: boolean } = {}) {
  const authenticate = sessionOwnerAuthenticator(sessions);
  let current: OwnedReverseApi | undefined; let stopClient: (() => void) | undefined; let finish: (() => void) | undefined;
  let closing: Promise<void> | undefined;
  let preparation: OwnedPreparationService | undefined;
  const serve: typeof serveOwnedReverse = async (_store, owned, _port, stop) => {
    if (options.enabled === false || current || preparation || closing) throw new Error('Controlled runtime disabled, already mounted or closed');
    current = owned; stopClient = stop;
    await new Promise<void>(resolve => { finish = resolve; });
    return { status: 'OWNED_REGTEST_API_STOPPED' };
  };
  return {
    installPreparation(service: OwnedPreparationService) {
      if (options.enabled !== true || current || preparation || closing) throw new Error('PREPARATION_DISABLED');
      preparation = service;
    },
    operatorIO: { sessions, serve },
    async handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
      if (preparation) return preparation.handle(req, res);
      if (current) return current.handle(req, res);
      const path = new URL(req.url ?? '/', 'http://localhost').pathname;
      if (options.delegateWhenInactive && path !== '/v1/reverse/availability') return false;
      if (path !== '/v1/reverse/availability' && path !== '/v1/swaps' && !path.startsWith('/v1/swaps/')) return false;
      const send = (status: number, value: unknown) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(value)); };
      try {
        const principal = await authenticate(req);
        if (!principal) { send(401, { error: 'AUTHENTICATION_REQUIRED' }); return true; }
        if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method ?? '') && !principal.csrfVerified) {
          send(403, { error: 'CSRF_REJECTED' }); return true;
        }
        if (req.method === 'GET' && path === '/v1/reverse/availability') send(200, { network: 'regtest', liveSwapsEnabled: false,
          controlledReverseConfigured: false, executionAvailable: false, recoveryAvailable: false, preparedSwapIds: [] });
        else send(503, { error: 'CONTROLLED_REVERSE_NOT_CONFIGURED' });
      } catch { send(503, { error: 'SERVICE_UNAVAILABLE' }); }
      return true;
    },
    close(): Promise<void> {
      return closing ??= (async () => {
        const mounted = current; current = undefined;
        try { stopClient?.(); await mounted?.drain(); await preparation?.close(); } finally { finish?.(); }
      })();
    },
  };
}
