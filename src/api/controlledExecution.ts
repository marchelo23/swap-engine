import { randomBytes } from 'node:crypto';
import type { Store } from '../persistence/Store.js';
import { SwapManager } from '../core/SwapManager.js';
import { createOperatorApi as createApi } from './operatorServer.js';

export type ControlledExecution = { swapId: string; expectedRevision: number; token: string;
  execute(): Promise<{ id: string; state: string; revision: number }> };

/** Explicit operator-only installation, one invocation, one approved swap/revision. No
 * default runtime or environment flag grants this capability to the ordinary API.
 */
export async function executeControlledApi(store: Store, swapId: string, expectedRevision: number,
  execute: ControlledExecution['execute']) {
  const token = randomBytes(32).toString('hex');
  const server = createApi(new SwapManager(store), async () => { throw new Error('Balances not installed by operator execution'); }, undefined, undefined,
    { swapId, expectedRevision, token, execute });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); }); });
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Controlled API unavailable');
  const origin = `http://127.0.0.1:${address.port}`;
  try {
    const response = await fetch(`${origin}/v1/swaps/${swapId}/execute`, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(120000),
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token }, body: JSON.stringify({ expectedRevision }) });
    if (response.status !== 200) throw new Error('Controlled API uncertain; reconcile without retry');
    const result = await response.json() as { id: string; state: string; revision: number };
    const observed = await fetch(`${origin}/v1/swaps/${swapId}`, { signal: AbortSignal.timeout(10000) });
    const status = await observed.json() as { id: string; state: string };
    if (observed.status !== 200 || result.id !== swapId || status.id !== swapId || status.state !== 'COMPLETED' || result.state !== 'COMPLETED')
      throw new Error('Controlled API completion evidence changed; reconcile');
    return result;
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
}
