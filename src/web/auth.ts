import { api, type Session } from './api.js';
import { get, text } from './ui.js';

export function mountAuth(onSessionChange: (session: Session | null) => void) {
  const form = get<HTMLFormElement>('login-form');
  const username = get<HTMLInputElement>('username');
  const password = get<HTMLInputElement>('password');
  const submit = form.querySelector('button')!;
  const logout = get<HTMLButtonElement>('logout');
  let session: Session | null = null;
  let expiry: number | undefined;
  let busy = false;

  function setBusy(value: boolean) {
    busy = value;
    submit.disabled = value;
    logout.disabled = value;
    form.setAttribute('aria-busy', String(value));
  }

  function render(next: Session | null) {
    window.clearTimeout(expiry);
    session = next;
    const admin = next?.user.role === 'ADMIN';
    const account = get('account-dashboard');
    const adminPanel = get('admin-dashboard');
    const recoverFocus = (account.contains(document.activeElement) && !next)
      || (adminPanel.contains(document.activeElement) && !admin);
    get('signin').hidden = !!next;
    account.hidden = !next;
    get('admin-gate').hidden = admin;
    adminPanel.hidden = !admin;
    text('account-username', next?.user.username ?? '');
    text('account-role', next ? (admin ? 'Administrator' : 'User') : '');
    text('admin-status', next ? 'Administrator role required.' : 'Sign in with an administrator account.');
    if (recoverFocus) document.querySelector<HTMLElement>('[data-view]:not([hidden]) h1')?.focus();
    onSessionChange(next);
    if (next) {
      expiry = window.setTimeout(() => {
        if (session !== next) return;
        if (Date.now() < next.expiresAt) { render(next); return; }
        render(null);
        text('login-status', 'Session expired. Sign in again.');
      }, Math.min(next.expiresAt - Date.now(), 2_147_483_647));
    }
  }

  async function verify() {
    const verified = await api.session();
    render(verified);
    return verified;
  }

  setBusy(true);
  void verify().then(verified => {
    if (!verified) text('login-status', 'Enter your account credentials.');
  }).catch(() => {
    render(null);
    text('login-status', 'The session service is unavailable. You can try signing in.');
    text('admin-status', 'The session service is unavailable.');
  }).finally(() => setBusy(false));

  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (busy || session || !form.reportValidity()) return;
    const enteredPassword = password.value;
    const enteredUsername = username.value;
    password.value = '';
    setBusy(true);
    text('login-status', 'Signing in…');
    try {
      try {
        if (!await api.login(enteredUsername, enteredPassword)) {
          text('login-status', 'Sign-in failed. Check your credentials.');
          return;
        }
      } catch {
        text('login-status', 'Sign-in service unavailable. Try again.');
        return;
      }
      if (!await verify()) {
        text('login-status', 'Sign-in could not be verified.');
        return;
      }
      username.value = '';
      password.value = '';
      text('account-status', 'Signed in.');
      if (!get('account').hidden) get('account-overview').focus();
    } catch {
      text('login-status', 'Sign-in could not be verified. Try again.');
    } finally {
      setBusy(false);
      if (!session && !get('account').hidden) password.focus();
    }
  });

  logout.addEventListener('click', async () => {
    if (busy || !session) return;
    const csrf = session.csrfToken;
    setBusy(true);
    render(null);
    text('login-status', 'Signing out…');
    try {
      await api.logout(csrf);
      text('login-status', 'Signed out.');
    } catch {
      text('login-status', 'Sign-out could not be confirmed.');
      try {
        if (await verify()) text('account-status', 'Sign-out could not be confirmed. Try again.');
      } catch {
        text('admin-status', 'The session service is unavailable.');
      }
    } finally {
      setBusy(false);
      if (!get('account').hidden) (session ? logout : username).focus();
    }
  });
}
