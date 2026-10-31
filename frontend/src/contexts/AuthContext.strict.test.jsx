import { act, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { AuthProvider, useAuth } from './AuthContext';
import { createBrowserAuthAuthority } from '../utils/standaloneIndexedDbAuthAuthority';
import { createBrowserAuthLifecycle } from '../utils/browserAuthLifecycle';

const home = new URL('/', window.location.origin).href;
const user = { id: 'strict-owner', username: 'synthetic-user' };
const issued = { kind: 'issued', user, session: 'strict-session', accessToken: 'strict-access', refreshToken: 'strict-refresh', logoutCapability: 'a'.repeat(64) };
let auth;
function Probe() {
  auth = useAuth();
  return <><output data-testid="user">{auth.user?.id || 'signed-out'}</output><output data-testid="loading">{String(auth.loading)}</output><output data-testid="ready">{String(auth.strictReady)}</output>{auth.isAuthenticated && <textarea aria-label="Retained draft" defaultValue="Unsent draft" />}</>;
}
async function fixture() {
  const indexedDB = new IDBFactory();
  const authority = createBrowserAuthAuthority({ indexedDB, verifyLogoutReceipt: async ({ receipt }) => receipt === 'confirmed', verifyLoginFailureReceipt: async ({ receipt }) => receipt === 'no-session' });
  await authority.provision();
  const transport = { login: vi.fn(async () => issued), refresh: vi.fn(async () => ({ accessToken: 'rotated-access', refreshToken: 'rotated-refresh' })), logout: vi.fn(async () => 'confirmed'), recoverLogin: vi.fn(async () => ({ kind: 'no-session', receipt: 'no-session' })) };
  const listeners = new Set();
  const notifications = { subscribe: fn => { listeners.add(fn); return () => listeners.delete(fn); }, publish: () => { listeners.forEach(fn => fn({ status: 'changed' })); return true; } };
  const lifecycle = createBrowserAuthLifecycle({ authority, transport, notifications });
  const strictAuth = { lifecycle, home, validateSession: vi.fn(async () => ({ status: 'valid' })), subscribe: notifications.subscribe };
  const notify = () => notifications.publish();
  const failNotifications = () => listeners.forEach(fn => fn({ status: 'unavailable' }));
  return { authority, lifecycle, transport, strictAuth, notify, failNotifications };
}
afterEach(() => { localStorage.clear(); vi.restoreAllMocks(); });

describe('opt-in strict AuthProvider', () => {
  it('initializes a validated strict session without touching legacy credentials or drafts', async () => {
    const { lifecycle, strictAuth } = await fixture();
    await lifecycle.login(home, {});
    localStorage.setItem('terminal_access_token', 'legacy-unrelated');
    localStorage.setItem('identity:strict:composerDraft:v1:thread', 'legacy-draft');
    render(<AuthProvider strictAuth={strictAuth}><Probe /></AuthProvider>);
    await waitFor(() => expect(screen.getByTestId('ready')).toHaveTextContent('true'));
    expect([auth.user, auth.authLifecycle, localStorage.getItem('terminal_access_token'), localStorage.getItem('identity:strict:composerDraft:v1:thread')]).toEqual([user, lifecycle, 'legacy-unrelated', 'legacy-draft']);
    expect(strictAuth.validateSession).toHaveBeenCalledWith(expect.objectContaining({ home, owner: user.id, session: issued.session, accessToken: issued.accessToken }));
  });

  it('refreshes a server-confirmed expired session during initialization', async () => {
    const { lifecycle, strictAuth, transport } = await fixture();
    await lifecycle.login(home, {});
    strictAuth.validateSession.mockResolvedValueOnce({ status: 'expired' }).mockResolvedValue({ status: 'valid' });
    render(<AuthProvider strictAuth={strictAuth}><Probe /></AuthProvider>);
    await waitFor(() => expect(screen.getByTestId('ready')).toHaveTextContent('true'));
    expect([auth.user, transport.refresh.mock.calls.length, (await lifecycle.read()).pair.accessToken]).toEqual([user, 1, 'rotated-access']);
  });

  it('fails closed if strict invalidation cannot be subscribed', async () => {
    const { strictAuth, lifecycle } = await fixture();
    await lifecycle.login(home, {});
    strictAuth.subscribe = strictAuth.lifecycle.notifications.subscribe = () => { throw new Error('synthetic subscription failure'); };
    render(<AuthProvider strictAuth={strictAuth}><Probe /></AuthProvider>);
    await waitFor(() => expect(screen.getByTestId('loading')).toHaveTextContent('false'));
    expect([auth.isAuthenticated, auth.strictReady]).toEqual([false, false]);
    expect(auth.authNotice).toMatch(/unavailable/i);
  });

  it('holds an already mounted workspace when invalidation becomes unavailable', async () => {
    const { lifecycle, strictAuth, failNotifications } = await fixture();
    await lifecycle.login(home, {});
    render(<AuthProvider strictAuth={strictAuth}><Probe /></AuthProvider>);
    await waitFor(() => expect(screen.getByTestId('ready')).toHaveTextContent('true'));
    const draft = screen.getByLabelText('Retained draft');
    await act(async () => { failNotifications(); });
    await waitFor(() => expect(auth.authNotice).toMatch(/unavailable/i));
    expect([auth.strictReady, auth.isAuthenticated, screen.getByLabelText('Retained draft')]).toEqual([false, true, draft]);
  });

  it('fails closed on unavailable authority rather than reading legacy credentials', async () => {
    const { strictAuth } = await fixture();
    strictAuth.lifecycle = { ...strictAuth.lifecycle, read: vi.fn(async () => ({ status: 'unavailable' })) };
    localStorage.setItem('terminal_access_token', 'legacy-access');
    localStorage.setItem('terminal_user', JSON.stringify(user));
    render(<AuthProvider strictAuth={strictAuth}><Probe /></AuthProvider>);
    await waitFor(() => expect(screen.getByTestId('loading')).toHaveTextContent('false'));
    expect([auth.isAuthenticated, auth.strictReady, localStorage.getItem('terminal_access_token')]).toEqual([false, false, 'legacy-access']);
    expect(auth.authNotice).toMatch(/unavailable/i);
  });

  it('does not fall back to legacy auth when strict configuration is missing', async () => {
    localStorage.setItem('terminal_access_token', 'legacy-access');
    localStorage.setItem('terminal_user', JSON.stringify(user));
    render(<AuthProvider strictAuth={null}><Probe /></AuthProvider>);
    await waitFor(() => expect(screen.getByTestId('loading')).toHaveTextContent('false'));
    expect([auth.isAuthenticated, auth.strictReady, localStorage.getItem('terminal_access_token')]).toEqual([false, false, 'legacy-access']);
  });

  it('dispatches a claimed login through the injected lifecycle and publishes its validated user', async () => {
    const { strictAuth, transport } = await fixture();
    render(<AuthProvider strictAuth={strictAuth}><Probe /></AuthProvider>);
    await waitFor(() => expect(screen.getByTestId('loading')).toHaveTextContent('false'));
    await act(async () => { expect(await auth.login('synthetic-user', 'synthetic-password')).toEqual(user); });
    expect(screen.getByTestId('ready')).toHaveTextContent('true');
    expect(transport.login).toHaveBeenCalledWith(expect.objectContaining({ home, credentials: { kind: 'password', username: 'synthetic-user', password: 'synthetic-password' } }));
    expect(localStorage.getItem('terminal_access_token')).toBeNull();
  });

  it('does not publish a different session when another tab replaces a just-completed login', async () => {
    const { strictAuth, lifecycle, transport } = await fixture();
    strictAuth.lifecycle = { ...lifecycle, login: async (...args) => {
      const original = await lifecycle.login(...args);
      transport.login.mockResolvedValueOnce({ ...issued, user: { id: 'other-owner', username: 'other' }, session: 'other-session', accessToken: 'other-access', refreshToken: 'other-refresh' });
      await lifecycle.login(home, {}); await lifecycle.recoverRetirements();
      return original;
    } };
    render(<AuthProvider strictAuth={strictAuth}><Probe /></AuthProvider>);
    await waitFor(() => expect(screen.getByTestId('loading')).toHaveTextContent('false'));
    await act(async () => { await expect(auth.login('synthetic-user', 'synthetic-password')).rejects.toThrow(/could not be confirmed/i); });
    expect([auth.isAuthenticated, auth.strictReady, auth.strictStatus]).toEqual([false, false, 'account-changed']);
  });

  it('retains a mounted draft and disables strict actions after uncertain refresh', async () => {
    const { strictAuth, lifecycle, transport } = await fixture();
    await lifecycle.login(home, {});
    render(<AuthProvider strictAuth={strictAuth}><Probe /></AuthProvider>);
    await waitFor(() => expect(screen.getByTestId('ready')).toHaveTextContent('true'));
    const draft = screen.getByLabelText('Retained draft');
    draft.value = 'Unsaved in-memory draft';
    transport.refresh.mockRejectedValueOnce(new Error('lost response'));
    await act(async () => { expect((await auth.refreshAuth()).status).toBe('refresh-unconfirmed'); });
    expect([auth.isAuthenticated, auth.strictReady, screen.getByLabelText('Retained draft'), draft.value]).toEqual([true, false, draft, 'Unsaved in-memory draft']);
    expect(auth.authNotice).toMatch(/confirm/i);
  });

  it('retains the draft while logout is uncertain, then signs out only after verified recovery', async () => {
    const { strictAuth, lifecycle, transport } = await fixture();
    await lifecycle.login(home, {});
    transport.logout.mockRejectedValueOnce(new Error('lost response')).mockResolvedValueOnce('confirmed');
    render(<AuthProvider strictAuth={strictAuth}><Probe /></AuthProvider>);
    await waitFor(() => expect(screen.getByTestId('ready')).toHaveTextContent('true'));
    const draft = screen.getByLabelText('Retained draft');
    let result;
    await act(async () => { result = await auth.logout(); });
    expect(result.status).toBe('logout-unconfirmed');
    expect([auth.isAuthenticated, auth.strictReady, screen.getByLabelText('Retained draft')]).toEqual([true, false, draft]);
    await act(async () => { expect((await auth.resumeLogout(result.incarnation)).status).toBe('tombstone'); });
    expect([auth.isAuthenticated, screen.queryByLabelText('Retained draft')]).toEqual([false, null]);
  });

  it('keeps an in-memory draft mounted when another tab signs out', async () => {
    const { strictAuth, lifecycle, notify } = await fixture();
    await lifecycle.login(home, {});
    render(<AuthProvider strictAuth={strictAuth}><Probe /></AuthProvider>);
    await waitFor(() => expect(screen.getByTestId('ready')).toHaveTextContent('true'));
    const draft = screen.getByLabelText('Retained draft');
    draft.value = 'Unsaved in-memory draft';
    await lifecycle.logout();
    await act(async () => { notify(); });
    await waitFor(() => expect(auth.authNotice).toMatch(/signed out/i));
    expect([auth.isAuthenticated, screen.getByLabelText('Retained draft'), draft.value]).toEqual([true, draft, 'Unsaved in-memory draft']);
    expect(auth.strictReady).toBe(false);
  });

  it('holds the old workspace when another tab changes accounts', async () => {
    const { strictAuth, lifecycle, transport, notify } = await fixture();
    await lifecycle.login(home, {});
    render(<AuthProvider strictAuth={strictAuth}><Probe /></AuthProvider>);
    await waitFor(() => expect(screen.getByTestId('ready')).toHaveTextContent('true'));
    const draft = screen.getByLabelText('Retained draft');
    draft.value = 'Old account unsaved draft';
    transport.login.mockResolvedValueOnce({ ...issued, user: { id: 'other-owner', username: 'other' }, session: 'other-session', accessToken: 'other-access', refreshToken: 'other-refresh' });
    expect((await lifecycle.login(home, {})).status).toBe('retirement-pending');
    expect((await lifecycle.recoverRetirements()).status).toBe('active');
    await act(async () => { notify(); });
    await waitFor(() => expect(auth.authNotice).toMatch(/account changed/i));
    expect([auth.user.id, screen.getByLabelText('Retained draft'), draft.value]).toEqual([user.id, draft, 'Old account unsaved draft']);
    expect(auth.strictReady).toBe(false);
  });

  it('does not adopt stale validation after a newer session wins', async () => {
    const { strictAuth, lifecycle } = await fixture();
    await lifecycle.login(home, {});
    let release, entered;
    const started = new Promise(resolve => { entered = resolve; });
    strictAuth.validateSession.mockImplementationOnce(() => { entered(); return new Promise(resolve => { release = resolve; }); });
    render(<AuthProvider strictAuth={strictAuth}><Probe /></AuthProvider>);
    await started;
    await lifecycle.logout();
    release({ status: 'valid' });
    await waitFor(() => expect(screen.getByTestId('loading')).toHaveTextContent('false'));
    expect([auth.isAuthenticated, auth.strictReady]).toEqual([false, false]);
  });

  it('refuses passkey results dispatched through the legacy login flow', async () => {
    const { strictAuth } = await fixture();
    render(<AuthProvider strictAuth={strictAuth}><Probe /></AuthProvider>);
    await waitFor(() => expect(screen.getByTestId('loading')).toHaveTextContent('false'));
    expect(auth.loginWithPasskeyResult({ user, tokens: { accessToken: 'unsafe', refreshToken: 'unsafe' } }, {})).toBe(false);
    expect(localStorage.getItem('terminal_access_token')).toBeNull();
  });
});
