import { api, type Session } from './api.js';
import { railIds, type RailReason } from '../core/RailContract.js';
import { prepareForReview } from './preparation.js';
import { mountAuth } from './auth.js';
import { fonts } from './fonts.js';
import { playOpening } from './opening.js';
import { mountOperationsBalances } from './operations.js';
import { mountOwnedReverse } from './ownedReverse.js';
import { mountQuote } from './quote.js';
import { get, integer, text } from './ui.js';

const quotes = mountQuote(async (stillVisible, amountSats) => {
  const owner = session;
  if (!owner) throw new Error('Sign in to prepare a regtest swap.');
  const availability = await api.reverseAvailability(new AbortController().signal);
  const id = await prepareForReview(owner, availability, amountSats);
  if (session !== owner || !stillVisible()) return;
  location.hash = 'track'; await reverse.reviewPrepared(id);
});
let session: Session | null = null;
const reverse = mountOwnedReverse((configured, availability) => {
  get('prepared-swap-link').hidden = configured !== true;
  quotes.setContext(configured, session?.csrfToken, availability?.preparationAvailable === true);
});
const setBalancesActive = mountOperationsBalances();
void fonts;
const railReason: Record<RailReason, string> = {
  NOT_CONFIGURED: 'Not configured', NOT_VERIFIED: 'Not verified', WRONG_NETWORK: 'Wrong network',
  UNAVAILABLE: 'Unavailable', DISABLED: 'Disabled',
};
const chainLabel = { bitcoin: 'Bitcoin', ark: 'Ark', liquid: 'Liquid' };
const environment = api.capabilities().then(capabilities => {
  if (railIds.some(id => capabilities.rails[id].id !== id)) throw new Error('Mismatched rail identifiers.');
  const { environment, chain, rails } = capabilities;
  get('mode').dataset.mode = environment;
  const networkName = `${chainLabel[chain.kind]} ${chain.name}`;
  get('network').title = networkName;
  text('network', environment.toUpperCase());
  text('account-network', networkName);
  text('capabilities-status', `${networkName} · Read-only capabilities`);
  for (const id of railIds) {
    const rail = rails[id];
    text(`capability-${id}`, rail.available ? 'Verified' : rail.reason ? railReason[rail.reason] : 'Unavailable');
  }
  return environment;
}).catch(() => {
  get('network').title = 'Network capabilities unavailable';
  text('capabilities-status', 'Network capabilities unavailable.');
  return undefined;
});

const refresh = get<HTMLButtonElement>('refresh');
const status = (value: string) => ({ ok: 'Reachable', unavailable: 'Unavailable', invalid_response: 'Invalid response' }[value] ?? 'Unknown');
const yesNo = (value: boolean | null) => value === null ? '—' : value ? 'Yes' : 'No';
let refreshing = false;
let admin = false;
async function loadDiagnostics() {
  if (refreshing || !admin) return;
  refreshing = true;
  refresh.disabled = true;
  const blockers = get('blockers');
  blockers.hidden = true;
  for (const id of ['core', 'height', 'core-sync', 'lnd', 'sync', 'channels', 'tips']) text(id, '—');
  text('diagnostic-status', 'Checking diagnostics…');
  try {
    if (await environment !== 'regtest') {
      text('diagnostic-status', 'Node diagnostics require a verified regtest read-only backend.');
      return;
    }
    if (!admin) return;
    const report = await api.preflight();
    text('diagnostic-status', report.prerequisitesSatisfied ? 'Read-only prerequisites satisfied.' : 'Regtest setup requires attention.');
    text('core', status(report.bitcoin.rpc));
    text('height', integer(report.bitcoin.height));
    const { height, headers, initialBlockDownload } = report.bitcoin;
    text('core-sync', yesNo(height === null || headers === null || initialBlockDownload === null
      ? null : height === headers && !initialBlockDownload));
    text('lnd', status(report.lnd.rest));
    text('sync', yesNo(report.lnd.syncedToChain));
    text('channels', integer(report.lnd.activeChannels) + ' / ' + integer(report.lnd.inactiveChannels));
    text('tips', yesNo(report.tipsMatch));
    blockers.replaceChildren(...report.blockers.map(reason => {
      const row = document.createElement('li');
      row.textContent = reason.replaceAll('_', ' ').toLowerCase();
      return row;
    }));
    blockers.hidden = report.blockers.length === 0;
  } catch {
    text('diagnostic-status', 'Regtest preflight is unavailable.');
  } finally {
    refreshing = false;
    refresh.disabled = false;
  }
}

const views = [...document.querySelectorAll<HTMLElement>('[data-view]')];
function navigate(focus: boolean) {
  if (location.hash === '#main') return;
  const current = views.find(view => '#' + view.id === location.hash) ?? views[0]!;
  for (const view of views) view.hidden = current !== view;
  document.querySelector<HTMLElement>('.footer-squares')!.dataset.viewActive = current.id === 'track' ? 'account' : current.id;
  quotes.setVisible(current.id === 'swap');
  reverse.setVisible(current.id === 'track');
  setBalancesActive(current.id === 'operations' && admin);
  for (const link of document.querySelectorAll('nav a')) {
    if (link.getAttribute('href') === '#' + current.id) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }
  if (current.id === 'operations' && admin) void loadDiagnostics();
  if (focus) {
    window.scrollTo(0, 0);
    current.querySelector('h1')?.focus({ preventScroll: true });
  }
}
refresh.addEventListener('click', () => void loadDiagnostics());
window.addEventListener('hashchange', () => navigate(true));
navigate(false);
if (!get('swap').hidden) playOpening();
mountAuth(next => {
  if (session !== next) {
    session = next;
    quotes.setContext(next ? null : false, next?.csrfToken);
  } else if (!next) quotes.setContext(false);
  reverse.setSession(next);
  admin = next?.user.role === 'ADMIN';
  setBalancesActive(admin && !get('operations').hidden);
  if (admin && !get('operations').hidden) void loadDiagnostics();
});
