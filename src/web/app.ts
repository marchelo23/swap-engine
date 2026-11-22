import { api, type ArkSwapStatus, type Session } from './api.js';
import { arkProgress, arkStatusLabel } from './arkStatus.js';
import { railIds, type RailReason } from '../core/RailContract.js';
import { prepareForReview } from './preparation.js';
import { mountAuth } from './auth.js';
import { fonts } from './fonts.js';
import { playOpening } from './opening.js';
import { mountOperationsBalances } from './operations.js';
import { mountGuest } from './guest.js';
import { createGuestPresentation } from './guestUi.js';
import { mountOwnedReverse } from './ownedReverse.js';
import { mountQuote } from './quote.js';
import { details, get, integer, sats, text } from './ui.js';

const guest = mountGuest(createGuestPresentation());
const quotes = mountQuote(async (stillVisible, amountSats) => {
  const owner = session;
  if (!owner) throw new Error('Sign in to prepare a regtest swap.');
  const availability = await api.reverseAvailability(new AbortController().signal);
  const id = await prepareForReview(owner, availability, amountSats);
  if (session !== owner || !stillVisible()) return;
  location.hash = 'track'; await reverse.reviewPrepared(id);
}, guest);
let session: Session | null = null;
const reverse = mountOwnedReverse((configured, availability) => {
  get('prepared-swap-link').hidden = configured !== true;
  quotes.setContext(configured, session?.csrfToken, availability?.preparationAvailable === true);
});
const setBalancesActive = mountOperationsBalances();
void fonts;
void api.guestAvailability().then(availability => {
  guest.setAvailability(availability.configured, availability.watching);
  quotes.setGuestContext(availability.configured, availability.watching);
}).catch(() => {
  guest.setAvailability(false, false);
  quotes.setGuestContext(false, false);
});
const railReason: Record<RailReason, string> = {
  NOT_CONFIGURED: 'Not configured', NOT_VERIFIED: 'Not verified', WRONG_NETWORK: 'Wrong network',
  UNAVAILABLE: 'Unavailable', DISABLED: 'Disabled',
};
const chainLabel = { bitcoin: 'Bitcoin', ark: 'Ark', liquid: 'Liquid' };
const environment = api.capabilities().then(capabilities => {
  if (railIds.some(id => capabilities.rails[id].id !== id)) throw new Error('Mismatched rail identifiers.');
  const { environment, chain, rails } = capabilities;
  get('mode').dataset.mode = environment;
  quotes.setArkEnvironment(environment);
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
  quotes.setArkEnvironment(undefined);
  get('network').title = 'Network capabilities unavailable';
  text('capabilities-status', 'Network capabilities unavailable.');
  return undefined;
});

const refresh = get<HTMLButtonElement>('refresh');
const status = (value: string) => ({ ok: 'Reachable', unavailable: 'Unavailable', invalid_response: 'Invalid response' }[value] ?? 'Unknown');
const yesNo = (value: boolean | null) => value === null ? '—' : value ? 'Yes' : 'No';
const timestamp = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });
let refreshing = false;
let admin = false;
let adminReportController: AbortController | undefined;
let arkTelemetryController: AbortController | undefined;
let accountHistoryController: AbortController | undefined;

function renderArkSwapList(list: HTMLElement, swaps: ArkSwapStatus[]) {
  list.replaceChildren(...swaps.map(swap => {
    const item = document.createElement('li');
    item.className = 'tx-card';
    const head = document.createElement('div');
    head.className = 'tx-head';
    const route = document.createElement('span');
    route.className = 'tx-route';
    route.textContent = swap.route === 'onchain-to-ark'
      ? 'On-chain → Ark (Boarding)'
      : 'Ark → On-chain (Cooperative offboarding)';
    const badge = document.createElement('span');
    badge.className = 'tag';
    badge.textContent = arkStatusLabel(swap);
    const when = document.createElement('time');
    when.className = 'tx-time';
    when.dateTime = new Date(swap.createdAt).toISOString();
    when.textContent = timestamp.format(new Date(swap.createdAt));
    head.append(route, badge, when);
    const dl = document.createElement('dl');
    dl.className = 'details';
    details(dl, [
      ['Swap ID', swap.id],
      ['Principal', sats(swap.quote.amountSats)],
      ['Service fee', sats(swap.quote.serviceFeeSats)],
      ['Estimated network fee', sats(swap.quote.claimFeeSats)],
      ['Estimated net receipt', sats(swap.quote.netSats)],
      ['Destination', swap.destination],
      ['Commitment txid', swap.commitmentTxid ?? 'Pending batch round'],
    ]);
    item.append(head, dl);
    return item;
  }));
  list.hidden = swaps.length === 0;
}

function resetArkTelemetry() {
  arkTelemetryController?.abort();
  arkTelemetryController = undefined;
  text('ark-tag', 'UNAVAILABLE');
  text('ark-status', 'Ark regtest telemetry is unavailable.');
}

function resetArkAdminReport() {
  adminReportController?.abort();
  adminReportController = undefined;
  text('activity-tag', 'REPORTING UNAVAILABLE');
  text('fee-tag', 'ACCOUNTING UNAVAILABLE');
  text('tx-tag', 'REPORTING UNAVAILABLE');
  text('tx-status', 'The backend does not provide an administrator transaction list.');
  for (const id of [
    'activity-total', 'activity-completed', 'activity-pending', 'activity-failed',
    'activity-onchain-sent', 'activity-onchain-received', 'activity-ark-sent', 'activity-ark-received',
    'activity-lightning-sent', 'activity-lightning-received',
    'fee-collected', 'fee-network', 'fee-net-revenue',
  ]) text(id, '—');
  const list = get('tx-list');
  list.replaceChildren();
  list.hidden = true;
}

async function loadArkAdminReport() {
  if (!admin) { resetArkAdminReport(); return; }
  adminReportController?.abort();
  const controller = new AbortController();
  adminReportController = controller;
  try {
    const report = await api.arkAdminReport(controller.signal);
    if (adminReportController !== controller || !admin) return;
    const s = report.summary;
    text('activity-tag', 'REGTEST · ARK');
    text('activity-total', integer(s.totalSwaps));
    text('activity-completed', integer(s.completedSwaps));
    text('activity-pending', integer(s.pendingSwaps));
    text('activity-failed', integer(s.failedSwaps));
    text('activity-onchain-sent', sats(s.onchainSentSats));
    text('activity-onchain-received', sats(s.onchainReceivedSats));
    text('activity-ark-sent', sats(s.arkSentSats));
    text('activity-ark-received', sats(s.arkReceivedSats));
    text('activity-lightning-sent', '—');
    text('activity-lightning-received', '—');
    text('fee-tag', 'REGTEST · ARK');
    text('fee-collected', sats(s.collectedServiceFeesSats));
    text('fee-network', sats(s.estimatedNetworkFeesSats));
    text('fee-net-revenue', sats(s.netOperationalRevenueSats));
    text('tx-tag', 'REGTEST · ARK');
    text('tx-status', report.swaps.length > 0
      ? `${integer(report.swaps.length)} Ark ↔ On-chain ${report.swaps.length === 1 ? 'swap' : 'swaps'} recorded on regtest.`
      : 'No Ark ↔ On-chain swaps recorded yet.');
    renderArkSwapList(get('tx-list'), report.swaps);
  } catch {
    if (adminReportController === controller) resetArkAdminReport();
  } finally {
    if (adminReportController === controller) adminReportController = undefined;
  }
}

function resetAccountHistory() {
  accountHistoryController?.abort();
  accountHistoryController = undefined;
  text('account-history-tag', 'UNAVAILABLE');
  text('account-history-status', 'Private history requires swaps with verified owner IDs.');
  for (const id of ['account-active-swaps', 'account-completed-swaps', 'account-failed-swaps']) text(id, '—');
  const list = get('account-history-list');
  list.replaceChildren();
  list.hidden = true;
}

async function loadAccountHistory() {
  const owner = session;
  if (!owner) { resetAccountHistory(); return; }
  accountHistoryController?.abort();
  const controller = new AbortController();
  accountHistoryController = controller;
  try {
    const { swaps } = await api.arkSwaps(controller.signal);
    if (accountHistoryController !== controller || session !== owner) return;
    const completed = swaps.filter(s => arkProgress(s) === 'confirmed').length;
    const failed = swaps.filter(s => arkProgress(s) === 'rejected').length;
    const active = swaps.length - completed - failed;
    text('account-history-tag', 'REGTEST · ARK');
    text('account-history-status', swaps.length > 0
      ? `${integer(swaps.length)} Ark ↔ On-chain ${swaps.length === 1 ? 'swap' : 'swaps'} owned by ${owner.user.username}.`
      : 'No Ark ↔ On-chain swaps recorded for this account yet.');
    text('account-active-swaps', integer(active));
    text('account-completed-swaps', integer(completed));
    text('account-failed-swaps', integer(failed));
    renderArkSwapList(get('account-history-list'), swaps);
  } catch {
    if (accountHistoryController === controller) resetAccountHistory();
  } finally {
    if (accountHistoryController === controller) accountHistoryController = undefined;
  }
}

async function loadArkTelemetry() {
  if (!admin) return;
  arkTelemetryController?.abort();
  const controller = new AbortController();
  arkTelemetryController = controller;
  try {
    if (!['regtest', 'ark-regtest'].includes((await environment) ?? '')) {
      if (arkTelemetryController !== controller || !admin) return;
      text('ark-tag', 'UNAVAILABLE');
      text('ark-status', 'Ark regtest telemetry is unavailable.');
      return;
    }
    const ark = await api.arkTelemetry(controller.signal);
    if (arkTelemetryController !== controller || !admin) return;
    if (ark.operatorStatus === 'ok' && ark.operator) {
      text('ark-tag', 'REGTEST · ' + ark.operator.version);
      const aliceTotal = ark.wallets?.alice?.totalSats;
      const bobTotal = ark.wallets?.bob?.totalSats;
      const walletSummary = aliceTotal != null || bobTotal != null
        ? ` Alice: ${integer(aliceTotal ?? null)} sats · Bob: ${integer(bobTotal ?? null)} sats.`
        : '';
      text('ark-status', `Connected to Ark regtest adapter (${ark.operator.version}, dust ${ark.operator.dustSats} sats).${walletSummary}`);
    } else {
      text('ark-tag', 'UNAVAILABLE');
      text('ark-status', 'Ark regtest operator telemetry is unavailable.');
    }
  } catch {
    if (arkTelemetryController === controller) {
      text('ark-tag', 'UNAVAILABLE');
      text('ark-status', 'Ark regtest telemetry is unavailable.');
    }
  } finally {
    if (arkTelemetryController === controller) arkTelemetryController = undefined;
  }
}

async function loadDiagnostics() {
  if (refreshing || !admin) return;
  refreshing = true;
  refresh.disabled = true;
  void loadArkAdminReport();
  void loadArkTelemetry();
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
  if (current.id === 'account' && session) void loadAccountHistory();
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
    quotes.setArkExecutionAllowed(next ? null : false);
    if (next) void api.arkAvailability().then(result => {
      if (session === next) quotes.setArkExecutionAllowed(result.executionAvailable);
    }).catch(() => { if (session === next) quotes.setArkExecutionAllowed('unavailable'); });
    quotes.setContext(next ? null : false, next?.csrfToken);
  } else if (!next) quotes.setContext(false);
  reverse.setSession(next);
  admin = next?.user.role === 'ADMIN';
  setBalancesActive(admin && !get('operations').hidden);
  if (!admin) {
    resetArkAdminReport();
    resetArkTelemetry();
  }
  if (admin && !get('operations').hidden) void loadDiagnostics();
  if (!next) resetAccountHistory();
  else if (!get('account').hidden) void loadAccountHistory();
});
