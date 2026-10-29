import { act, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { AuthProvider, useAuth } from './AuthContext';
import { apiFetch } from '../utils/api';
import { clearTokens, getAccessToken, getRefreshToken, getUser, getAuthInitializing, setAuthInitializing, setTokens, setUser } from '../utils/auth';
import { setEnvironmentIdentity, setActiveEnvironment } from '../utils/remoteEnvironments';
import { getComposerDraftStore } from '../utils/composerDraftStore';
import { getCompactionIntentStore } from '../utils/compactionIntentStore';

const oldUser = { id: 'auth-old-fixture', username: 'old-fixture' };
const newUser = { id: 'auth-new-fixture', username: 'new-fixture' };
const requestBody = { requestId: '5a99f505-f6b8-4d4a-921a-609515981950', instructions: 'Frozen pending fixture instructions', expectedRevision: 'a'.repeat(64) };
const response = (status, body = {}) => ({ status, ok: status >= 200 && status < 300, json: async () => body });
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
let auth, handler;
const calls = [];
function Probe() {
  auth = useAuth();
  return <><output data-testid="auth-user">{auth.user?.id || 'signed-out'}</output><output data-testid="auth-loading">{String(auth.loading)}</output><output data-testid="cleanup-notice">{auth.cleanupNotice || ''}</output>{!auth.isAuthenticated && <label>Username<input /></label>}</>;
}
function standard(url) {
  if (url === '/api/auth/me') return response(200, oldUser);
  if (url === '/api/auth/login') return response(200, { user: newUser, tokens: { accessToken: 'new-access', refreshToken: 'new-refresh' } });
  if (url === '/api/auth/logout' || url === '/api/preview/session') return response(200);
  throw new Error('Unexpected fixture HTTP ' + url);
}
async function mount() {
  const view = render(<AuthProvider><Probe /></AuthProvider>);
  await waitFor(() => expect(screen.getByTestId('auth-loading')).toHaveTextContent('false'));
  expect(screen.getByTestId('auth-user')).toHaveTextContent(oldUser.id);
  return view;
}
async function settle(request) { let outcome; await act(async () => { outcome = await request; }); return outcome; }
function send() { return apiFetch('/api/structured/sessions/auth-fixture/compact', { method: 'POST', body: requestBody }).then(value => ({ value }), error => ({ error })); }
function posts() { return calls.filter(call => call.url.endsWith('/compact')); }
function expectNewAuth() { expect(getAccessToken()).toBe('new-access'); expect(getRefreshToken()).toBe('new-refresh'); expect(getUser()).toEqual(newUser); expect(screen.getByTestId('auth-user')).toHaveTextContent(newUser.id); }
function savedWork() {
  setEnvironmentIdentity(oldUser.id, window.location.origin); setActiveEnvironment({ id: 'auth-env-fixture' });
  const composer = getComposerDraftStore('ss-auth-fixture'); composer.setText('Keep ordinary draft'); const ordinary = composer.prepareIntent('Keep ordinary draft\n');
  const compact = getCompactionIntentStore('ss-auth-fixture'); compact.setInstructions('Keep separate compact draft'); const intent = compact.prepareIntent('a'.repeat(64));
  const keys = Object.keys(localStorage).filter(key => key.includes('composerDraft:') || key.includes('compactionIntent:'));
  expect(keys).toHaveLength(2);
  return { ordinary, intent, bytes: Object.fromEntries(keys.map(key => [key, localStorage.getItem(key)])) };
}

beforeEach(() => {
  vi.stubGlobal('navigator', { locks: { request: async (_name, _options, run) => run() } });
  clearTokens(true); localStorage.clear(); setAuthInitializing(false); setEnvironmentIdentity(null); setActiveEnvironment(null);
  setTokens('old-access', 'old-refresh'); setUser(oldUser); calls.length = 0; handler = standard;
  global.fetch = vi.fn(async (input, options = {}) => {
    const url = new URL(String(input), window.location.origin).pathname;
    // Capture immutable transport values, since production reuses its options object on inline retry.
    calls.push({ url, method: options.method || 'GET', body: options.body, authorization: options.headers?.Authorization });
    return handler(url, options);
  });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('real AuthProvider and apiFetch lifecycle', () => {
  it.each(['password', 'local-testing'])('unreachable %s sign-in reports the actual app address', async mode => {
    await mount();
    handler = () => { throw new TypeError('Failed to fetch'); };
    let failure;
    await act(async () => {
      try { await auth.login('tester', undefined, mode); } catch (error) { failure = error; }
    });
    expect(failure?.message).toBe(`Cannot connect to the app at ${window.location.origin}. Restart the local app and try again.`);
    expect(auth.error).toBe(failure.message);
  });
  it('commits username-only testing tokens through the same account lifecycle without sending a password', async () => {
    await mount();
    handler = (url, options) => url === '/api/auth/local-testing' ? response(200, {user:newUser,tokens:{accessToken:'new-access',refreshToken:'new-refresh'}}) : standard(url, options);
    await act(async () => { await auth.login('tester',undefined,'local-testing'); });
    expectNewAuth();
    expect(calls.find(call=>call.url==='/api/auth/local-testing').body).toBe(JSON.stringify({username:'tester'}));
  });
  it('valid initial access credentials without a cached user still save and render the verified me result', async () => {
    localStorage.removeItem('terminal_user');
    await mount(); expect(getUser()).toEqual(oldUser); expect(getAccessToken()).toBe('old-access'); expect(calls.filter(call => call.url === '/api/auth/refresh')).toHaveLength(0);
  });

  it('same-account refresh without a user payload retains the verified user and retries the exact serialized command', async () => {
    await mount(); let sent = 0; handler = url => {
      if (url.endsWith('/compact')) return response(++sent === 1 ? 401 : 202);
      if (url === '/api/auth/refresh') return response(200, { tokens: { accessToken: 'rotated-access', refreshToken: 'rotated-refresh' } });
      return standard(url);
    };
    const outcome = await settle(send()); expect(outcome.value.status).toBe(202); expect(getUser()).toEqual(oldUser); expect(screen.getByTestId('auth-user')).toHaveTextContent(oldUser.id);
    expect(posts().map(call => call.body)).toEqual([JSON.stringify(requestBody), JSON.stringify(requestBody)]);
  });

  it('a401 while initial validation is pending still reports Auth initializing without refresh or command replay', async () => {
    const delayed = deferred(); handler = url => url === '/api/auth/me' ? delayed.promise : url.endsWith('/compact') ? response(401) : standard(url);
    render(<AuthProvider><Probe /></AuthProvider>); expect(screen.getByTestId('auth-loading')).toHaveTextContent('true');
    const outcome = await settle(send()); expect(outcome.error?.message).toBe('Auth initializing'); expect(posts()).toHaveLength(1); expect(calls.filter(call => call.url === '/api/auth/refresh')).toHaveLength(0);
    await act(async () => { delayed.resolve(response(200, oldUser)); await delayed.promise; }); expect(screen.getByTestId('auth-user')).toHaveTextContent(oldUser.id); expect(screen.getByTestId('auth-loading')).toHaveTextContent('false');
  });

  it.each([401, 403])('failed refresh%s clears credentials and promptly displays sign-in while retaining exact scoped draft and compact intents', async status => {
    await mount(); const saved = savedWork();
    handler = url => url.endsWith('/compact') ? response(401) : url === '/api/auth/refresh' ? response(status) : standard(url);
    const outcome = await settle(send()); expect(outcome.error?.message).toBe('Session expired');
    expect(getAccessToken()).toBeNull(); expect(getRefreshToken()).toBeNull(); expect(getUser()).toBeNull();
    expect(screen.getByLabelText('Username')).toBeVisible(); expect(screen.getByTestId('auth-user')).toHaveTextContent('signed-out');
    for (const [key, value] of Object.entries(saved.bytes)) expect(localStorage.getItem(key)).toBe(value);
    expect(posts()).toHaveLength(1);
  });

  it.each(['network', 'server503', 'rate429'])('transient refresh %s preserves mounted auth and stored credentials without retrying the command', async kind => {
    await mount(); handler = url => {
      if (url.endsWith('/compact')) return response(401);
      if (url === '/api/auth/refresh') { if (kind === 'network') throw new TypeError('Synthetic temporary network loss'); return response(kind === 'rate429' ? 429 : 503); }
      return standard(url);
    };
    const outcome = await settle(send()); expect(outcome.error).toBeTruthy(); expect(getAccessToken()).toBe('old-access'); expect(getRefreshToken()).toBe('old-refresh');
    expect(screen.getByTestId('auth-user')).toHaveTextContent(oldUser.id); expect(screen.queryByLabelText('Username')).toBeNull(); expect(posts()).toHaveLength(1);
  });

  it('successful inline refresh resends the exact serialized UUID/body once under the refreshed credentials', async () => {
    await mount(); let sent = 0; handler = url => {
      if (url.endsWith('/compact')) return response(++sent === 1 ? 401 : 202, { requestId: requestBody.requestId });
      if (url === '/api/auth/refresh') return response(200, { user: oldUser, tokens: { accessToken: 'refreshed-access', refreshToken: 'refreshed-refresh' } });
      return standard(url);
    };
    const outcome = await settle(send()); expect(outcome.value.status).toBe(202); expect(posts()).toHaveLength(2);
    expect(posts().map(call => call.body)).toEqual([JSON.stringify(requestBody), JSON.stringify(requestBody)]);
    expect(posts().map(call => call.authorization)).toEqual(['Bearer old-access', 'Bearer refreshed-access']); expect(screen.getByTestId('auth-user')).toHaveTextContent(oldUser.id);
  });

  it('late unauthorized command response after a new login never refreshes new credentials or replays the old body', async () => {
    await mount(); const delayed = deferred(); handler = url => url.endsWith('/compact') ? delayed.promise : standard(url);
    const request = send(); await waitFor(() => expect(posts()).toHaveLength(1));
    await act(async () => { await auth.login('new-fixture', 'synthetic-password'); }); expectNewAuth();
    delayed.resolve(response(401)); const outcome = await settle(request);
    expect(outcome.error).toBeTruthy(); expectNewAuth(); expect(posts()).toHaveLength(1); expect(calls.filter(call => call.url === '/api/auth/refresh')).toHaveLength(0);
  });

  it('parallel same-account401 requests share token rotation and both preserve their distinct serialized bodies', async () => {
    await mount(); const delayed = deferred(); const firstBody = { ...requestBody, instructions: 'First parallel command' }, secondBody = { ...requestBody, requestId: '9d6422b1-4613-4a40-afb3-7d3ca5f64121', instructions: 'Second parallel command' };
    handler = (url, options) => {
      if (url.endsWith('/compact')) return response(options.headers.Authorization === 'Bearer old-access' ? 401 : 202);
      if (url === '/api/auth/refresh') return delayed.promise;
      return standard(url);
    };
    const first = apiFetch('/api/structured/sessions/auth-fixture/compact', { method: 'POST', body: firstBody }).then(value => ({ value }), error => ({ error }));
    const second = apiFetch('/api/structured/sessions/auth-fixture/compact', { method: 'POST', body: secondBody }).then(value => ({ value }), error => ({ error }));
    await waitFor(() => expect(calls.filter(call => call.url === '/api/auth/refresh')).toHaveLength(1));
    delayed.resolve(response(200, { user: oldUser, tokens: { accessToken: 'rotated-access', refreshToken: 'rotated-refresh' } }));
    const outcomes = await settle(Promise.all([first, second])); expect(outcomes.map(value => value.value?.status)).toEqual([202, 202]); expect(posts()).toHaveLength(4);
    expect(posts().filter(call => call.body === JSON.stringify(firstBody))).toHaveLength(2); expect(posts().filter(call => call.body === JSON.stringify(secondBody))).toHaveLength(2); expect(getAccessToken()).toBe('rotated-access'); expect(screen.getByTestId('auth-user')).toHaveTextContent(oldUser.id);
  });

  it.each([401, 200])('late old refresh%s after a new login cannot clear or overwrite the new account or resend the old command', async status => {
    await mount(); const delayed = deferred(); handler = url => {
      if (url.endsWith('/compact')) return response(401);
      if (url === '/api/auth/refresh') return delayed.promise;
      return standard(url);
    };
    const request = send(); await waitFor(() => expect(calls.some(call => call.url === '/api/auth/refresh')).toBe(true));
    await act(async () => { await auth.login('new-fixture', 'synthetic-password'); }); expectNewAuth();
    delayed.resolve(response(status, { user: oldUser, tokens: { accessToken: 'late-old-access', refreshToken: 'late-old-refresh' } }));
    const outcome = await settle(request); expect(outcome.error).toBeTruthy(); expectNewAuth(); expect(posts()).toHaveLength(1);
  });

  it.each([401, 200])('late old refresh%s after explicit logout cannot restore the old account or resend its command', async status => {
    await mount(); const delayed = deferred(); handler = url => {
      if (url.endsWith('/compact')) return response(401);
      if (url === '/api/auth/refresh') return delayed.promise;
      return standard(url);
    };
    const request = send(); await waitFor(() => expect(calls.some(call => call.url === '/api/auth/refresh')).toBe(true));
    await act(async () => { await auth.logout(); }); expect(screen.getByLabelText('Username')).toBeVisible();
    delayed.resolve(response(status, { user: oldUser, tokens: { accessToken: 'late-old-access', refreshToken: 'late-old-refresh' } }));
    const outcome = await settle(request); expect(outcome.error).toBeTruthy(); expect(getAccessToken()).toBeNull(); expect(getUser()).toBeNull(); expect(screen.getByLabelText('Username')).toBeVisible(); expect(posts()).toHaveLength(1);
  });

  it('a delayed initial me response after explicit auth clear cannot restore the old user', async () => {
    const delayed = deferred(); handler = url => url === '/api/auth/me' ? delayed.promise : standard(url);
    render(<AuthProvider><Probe /></AuthProvider>); expect(screen.getByTestId('auth-loading')).toHaveTextContent('true');
    await act(async () => { clearTokens(true); }); expect(screen.getByLabelText('Username')).toBeVisible();
    await act(async () => { delayed.resolve(response(200, oldUser)); await delayed.promise; });
    expect(screen.getByTestId('auth-user')).toHaveTextContent('signed-out'); expect(getUser()).toBeNull(); expect(getAccessToken()).toBeNull();
  });

  it('a delayed initial me response after a new login cannot replace the later account', async () => {
    const delayed = deferred(); handler = url => url === '/api/auth/me' ? delayed.promise : standard(url);
    render(<AuthProvider><Probe /></AuthProvider>); await act(async () => { await auth.login('new-fixture', 'synthetic-password'); }); expectNewAuth();
    await act(async () => { delayed.resolve(response(200, oldUser)); await delayed.promise; }); expectNewAuth();
  });

  it('unmounted initial validation cannot write an old user into storage', async () => {
    const delayed = deferred(); handler = url => url === '/api/auth/me' ? delayed.promise : standard(url);
    const view = render(<AuthProvider><Probe /></AuthProvider>); view.unmount(); clearTokens(true);
    await act(async () => { delayed.resolve(response(200, oldUser)); await delayed.promise; }); expect(getUser()).toBeNull(); expect(getAccessToken()).toBeNull();
  });

  it('native cross-tab auth storage clearing updates React auth without deleting scoped drafts or resending work', async () => {
    await mount(); const saved = savedWork();
    await act(async () => { localStorage.removeItem('terminal_access_token'); localStorage.removeItem('terminal_refresh_token'); localStorage.removeItem('terminal_user'); window.dispatchEvent(new StorageEvent('storage', { key: 'terminal_user', oldValue: JSON.stringify(oldUser), newValue: null, storageArea: localStorage })); });
    expect(screen.getByLabelText('Username')).toBeVisible(); expect(screen.getByTestId('auth-user')).toHaveTextContent('signed-out');
    for (const [key, value] of Object.entries(saved.bytes)) expect(localStorage.getItem(key)).toBe(value);
    expect(posts()).toHaveLength(0);
  });
  it.each(['response', 'network failure'])('explicit logout still clears its current persistent credentials after provider unmount and delayed %s', async mode => {
    const view = await mount(); const delayed = deferred(); handler = url => url === '/api/auth/logout' ? delayed.promise : standard(url);
    let pending; act(() => { pending = auth.logout(); }); await waitFor(() => expect(calls.some(call => call.url === '/api/auth/logout')).toBe(true));
    view.unmount();
    await act(async () => { if (mode === 'response') delayed.resolve(response(200)); else delayed.reject(new TypeError('Synthetic logout network failure')); await pending; });
    expect(getAccessToken()).toBeNull(); expect(getRefreshToken()).toBeNull(); expect(getUser()).toBeNull();
  });

  it('signs out while reporting that server cleanup is pending without exposing account details', async () => {
    await mount(); handler = url => url === '/api/auth/logout' ? response(202, { success: true, cleanup: { state: 'pending' } }) : standard(url);
    await act(async () => { await auth.logout(); });
    expect(screen.getByTestId('auth-user')).toHaveTextContent('signed-out');
    expect(screen.getByTestId('cleanup-notice')).toHaveTextContent(/cleanup.*pending/i);
    expect(screen.getByTestId('cleanup-notice')).not.toHaveTextContent(oldUser.username);
    expect(getAccessToken()).toBeNull();
    handler = standard;
    await act(async () => { await auth.login(newUser.username, 'synthetic-password'); });
    expect(screen.getByTestId('cleanup-notice')).toBeEmptyDOMElement();
    expect(screen.getByTestId('auth-user')).toHaveTextContent(newUser.id);
  });

  it('reports unconfirmed cleanup if sign-out cannot reach the server', async () => {
    await mount(); handler = url => url === '/api/auth/logout' ? Promise.reject(new TypeError('Synthetic network failure')) : standard(url);
    await act(async () => { await auth.logout(); });
    expect(screen.getByTestId('auth-user')).toHaveTextContent('signed-out');
    expect(screen.getByTestId('cleanup-notice')).toHaveTextContent(/could not be confirmed/i);
  });

  it('does not carry a prior sign-out notice into a different cross-tab account', async () => {
    await mount(); handler = url => url === '/api/auth/logout' ? response(202, { success: true, cleanup: { state: 'pending' } }) : standard(url);
    await act(async () => { await auth.logout(); });
    expect(screen.getByTestId('cleanup-notice')).toHaveTextContent(/pending/i);
    act(() => { setTokens('new-access', 'new-refresh'); setUser(newUser); });
    await waitFor(() => expect(screen.getByTestId('auth-user')).toHaveTextContent(newUser.id));
    expect(screen.getByTestId('cleanup-notice')).toBeEmptyDOMElement();
  });

  it('a delayed old logout cannot clear a newer successful login', async () => {
    await mount(); const delayed = deferred(); handler = url => url === '/api/auth/logout' ? delayed.promise : standard(url);
    let pending; act(() => { pending = auth.logout(); }); await waitFor(() => expect(calls.some(call => call.url === '/api/auth/logout')).toBe(true));
    await act(async () => { await auth.login('new-fixture', 'synthetic-password'); }); expectNewAuth();
    await act(async () => { delayed.resolve(response(200)); await pending; }); expectNewAuth();
  });

  it('initial refresh-only credentials with no cached user keep initialization pending until the fallback me identity is verified', async () => {
    localStorage.removeItem('terminal_access_token'); localStorage.removeItem('terminal_user');
    const delayed = deferred(); handler = url => url === '/api/auth/refresh' ? response(200, { tokens: { accessToken: 'initial-rotated-access', refreshToken: 'initial-rotated-refresh' } }) : url === '/api/auth/me' ? delayed.promise : standard(url);
    render(<AuthProvider><Probe /></AuthProvider>); await waitFor(() => expect(calls.some(call => call.url === '/api/auth/me')).toBe(true));
    const loadingBeforeIdentity = screen.getByTestId('auth-loading').textContent, initializingBeforeIdentity = getAuthInitializing();
    await act(async () => { delayed.resolve(response(200, oldUser)); await delayed.promise; });
    expect(loadingBeforeIdentity).toBe('true'); expect(initializingBeforeIdentity).toBe(true); expect(screen.getByTestId('auth-loading')).toHaveTextContent('false'); expect(getAuthInitializing()).toBe(false); expect(screen.getByTestId('auth-user')).toHaveTextContent(oldUser.id); expect(getUser()).toEqual(oldUser);
  });

  it.each([401, 403])('initial refresh-only token success followed by definitive me%s clears credentials and finishes sign-out', async status => {
    localStorage.removeItem('terminal_access_token'); localStorage.removeItem('terminal_user');
    handler = url => url === '/api/auth/refresh' ? response(200, { tokens: { accessToken: 'unverified-initial-access', refreshToken: 'unverified-initial-refresh' } }) : url === '/api/auth/me' ? response(status) : standard(url);
    render(<AuthProvider><Probe /></AuthProvider>); await waitFor(() => expect(calls.some(call => call.url === '/api/auth/me')).toBe(true));
    await waitFor(() => expect(getAccessToken()).toBeNull()); expect(getRefreshToken()).toBeNull(); expect(getUser()).toBeNull(); expect(screen.getByLabelText('Username')).toBeVisible(); expect(getAuthInitializing()).toBe(false);
  });

});
