import '../test/authIndexedDB';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthProvider, useAuth } from '../contexts/AuthContext';
import { clearTokens, getAccessToken, getRefreshToken, getUser, setAuthInitializing, setTokens } from '../utils/auth';
import { authenticateWithPasskey } from '../utils/passkey';
import LoginPage from './LoginPage';

vi.mock('../utils/passkey', () => ({ authenticateWithPasskey: vi.fn() }));
const oldUser = { id: 'old-passkey-fixture', username: 'old-passkey-fixture' };
const newUser = { id: 'new-password-fixture', username: 'new-password-fixture' };
const oldResult = { user: oldUser, tokens: { accessToken: 'old-passkey-access', refreshToken: 'old-passkey-refresh' } };
const response = (status, body = {}) => ({ status, ok: status >= 200 && status < 300, json: async () => body });
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };
let auth;
function AuthScreen({ showLogin = true }) { auth = useAuth(); return <><output data-testid="passkey-auth-user">{auth.user?.id || 'signed-out'}</output>{showLogin && !auth.loading && !auth.isAuthenticated && <LoginPage />}</>; }
async function start() {
  const view = render(<AuthProvider><AuthScreen /></AuthProvider>);
  await screen.findByLabelText('Username'); fireEvent.change(screen.getByLabelText('Username'), { target: { value: 'old-passkey-fixture' } });
  fireEvent.click(screen.getByRole('button', { name: 'Authenticate with Passkey' }));
  await waitFor(() => expect(authenticateWithPasskey).toHaveBeenCalledWith('old-passkey-fixture'));
  return view;
}
beforeEach(() => {
  clearTokens(true); localStorage.clear(); setAuthInitializing(false); vi.clearAllMocks();
  global.fetch = vi.fn(async input => {
    const url = new URL(String(input), window.location.origin).pathname;
    if (url === '/api/auth/login') return response(200, { user: newUser, tokens: { accessToken: 'new-password-access', refreshToken: 'new-password-refresh' } });
    if (url === '/api/preview/session' || url === '/api/auth/logout') return response(200);
    throw new Error('Unexpected synthetic HTTP ' + url);
  });
});

describe('real LoginPage and AuthProvider passkey completion authority', () => {
  it('shows the damaged sign-in history notice when session validation cannot refresh', async () => {
    setTokens('old-passkey-access', 'old-passkey-refresh');
    const request = indexedDB.open('terminal-v4-auth-coordination', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('refresh');
    const db = await new Promise((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
    await new Promise((resolve, reject) => { const tx = db.transaction('refresh', 'readwrite'); tx.objectStore('refresh').put('damaged', 'consumed'); tx.oncomplete = resolve; tx.onerror = tx.onabort = () => reject(tx.error); });
    db.close();
    global.fetch = vi.fn(async () => response(401));
    render(<AuthProvider><AuthScreen /></AuthProvider>);
    expect(await screen.findByRole('alert')).toHaveTextContent(/sign.in history is damaged/i);
    expect(screen.getByLabelText('Username')).toBeVisible();
  });
  it('healthy current passkey completion signs in through the real callback', async () => {
    const pending = deferred(); authenticateWithPasskey.mockReturnValueOnce(pending.promise); await start();
    await act(async () => { pending.resolve(oldResult); await pending.promise; });
    expect(getAccessToken()).toBe('old-passkey-access'); expect(getRefreshToken()).toBe('old-passkey-refresh'); expect(getUser()).toEqual(oldUser); expect(screen.getByTestId('passkey-auth-user')).toHaveTextContent(oldUser.id);
  });
  it('late passkey completion after a newer password login cannot replace its account or credentials', async () => {
    const pending = deferred(); authenticateWithPasskey.mockReturnValueOnce(pending.promise); await start();
    await act(async () => { await auth.login('new-password-fixture', 'synthetic-password'); });
    await act(async () => { pending.resolve(oldResult); await pending.promise; });
    expect(getAccessToken()).toBe('new-password-access'); expect(getRefreshToken()).toBe('new-password-refresh'); expect(getUser()).toEqual(newUser); expect(screen.getByTestId('passkey-auth-user')).toHaveTextContent(newUser.id);
  });
  it('late passkey completion after explicit logout cannot restore the older account', async () => {
    const pending = deferred(); authenticateWithPasskey.mockReturnValueOnce(pending.promise); await start();
    await act(async () => { await auth.logout(); }); await act(async () => { pending.resolve(oldResult); await pending.promise; });
    expect(getAccessToken()).toBeNull(); expect(getRefreshToken()).toBeNull(); expect(getUser()).toBeNull(); expect(screen.getByLabelText('Username')).toBeVisible();
  });
  it('late passkey completion after provider unmount cannot persist an account', async () => {
    const pending = deferred(); authenticateWithPasskey.mockReturnValueOnce(pending.promise); const view = await start(); view.unmount();
    await act(async () => { pending.resolve(oldResult); await pending.promise; });
    expect(getAccessToken()).toBeNull(); expect(getRefreshToken()).toBeNull(); expect(getUser()).toBeNull();
  });
  it('late passkey completion after only LoginPage unmount cannot commit into its still-mounted provider', async () => {
    const pending = deferred(); authenticateWithPasskey.mockReturnValueOnce(pending.promise); const view = await start();
    view.rerender(<AuthProvider><AuthScreen showLogin={false} /></AuthProvider>); expect(screen.queryByLabelText('Username')).toBeNull();
    await act(async () => { pending.resolve(oldResult); await pending.promise; });
    expect(getAccessToken()).toBeNull(); expect(getRefreshToken()).toBeNull(); expect(getUser()).toBeNull(); expect(screen.getByTestId('passkey-auth-user')).toHaveTextContent('signed-out');
  });

});
