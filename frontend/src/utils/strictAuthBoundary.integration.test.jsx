import { render } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { AuthProvider } from '../contexts/AuthContext';
import { apiFetch } from './api';
import { beginAuthChange, captureAuthScope, clearTokens, getAccessToken, getRefreshToken, getUser, isAuthScopeCurrent, refreshTokens, setTokens, setUser } from './auth';

afterEach(() => { vi.unstubAllGlobals(); localStorage.clear(); sessionStorage.clear(); });

it('fences legacy credentials and requests immediately on strict selection, even after unmount', async () => {
  localStorage.setItem('terminal_access_token', 'synthetic-old-access');
  localStorage.setItem('terminal_refresh_token', 'synthetic-old-refresh');
  localStorage.setItem('terminal_user', JSON.stringify({ id: 'synthetic-old-owner' }));
  localStorage.setItem('terminal_auth_session', 'synthetic-old-session');
  const originalStorage = Object.fromEntries(Object.keys(localStorage).map(key => [key, localStorage.getItem(key)]));
  const priorScope = captureAuthScope();
  let resolveResponse;
  const fetchImpl = vi.fn()
    .mockResolvedValueOnce(new Response('{"synthetic":"old-result"}', { status: 200 }))
    .mockImplementationOnce(() => new Promise(resolve => { resolveResponse = resolve; }));
  vi.stubGlobal('fetch', fetchImpl);
  const completed = await apiFetch('/api/already-returned');
  const decoding = completed.json();
  const pending = apiFetch('/api/synthetic', { method: 'POST', body: { draft: 'synthetic' } });
  expect(fetchImpl).toHaveBeenCalledTimes(2);
  expect(fetchImpl.mock.calls[1][1].headers.Authorization).toBe('Bearer synthetic-old-access');
  const seenInRender = [];
  function Child() { seenInRender.push([getAccessToken(), getRefreshToken(), getUser()]); return null; }
  const view = render(<AuthProvider strictAuth={null}><Child /></AuthProvider>);
  expect(seenInRender).toEqual([[null, null, null]]);
  expect(isAuthScopeCurrent(priorScope)).toBe(false);
  expect(fetchImpl.mock.calls[1][1].signal.aborted).toBe(true);
  await expect(decoding).rejects.toThrow('Legacy authentication is unavailable');
  expect(() => completed.status).toThrow('Legacy authentication is unavailable');
  resolveResponse(new Response('{"synthetic":true}', { status: 200 }));
  await expect(pending).rejects.toMatchObject({ message: 'Legacy authentication is unavailable', outcomeUncertain: true });
  expect(() => setTokens('synthetic-new-access', 'synthetic-new-refresh')).toThrow('Legacy authentication is unavailable');
  expect(() => setUser({ id: 'synthetic-new-owner' })).toThrow('Legacy authentication is unavailable');
  expect(() => beginAuthChange()).toThrow('Legacy authentication is unavailable');
  expect(() => clearTokens(true)).toThrow('Legacy authentication is unavailable');
  await expect(refreshTokens()).rejects.toThrow('Legacy authentication is unavailable');
  await expect(apiFetch('/api/synthetic')).rejects.toThrow('Legacy authentication is unavailable');
  await expect(apiFetch('/api/synthetic', { authLifecycle: null })).rejects.toThrow('Authentication is unavailable');
  view.unmount();
  expect([getAccessToken(), getRefreshToken(), getUser()]).toEqual([null, null, null]);
  await expect(apiFetch('/api/synthetic')).rejects.toThrow('Legacy authentication is unavailable');
  expect(fetchImpl).toHaveBeenCalledTimes(2);
  expect(Object.fromEntries(Object.keys(localStorage).map(key => [key, localStorage.getItem(key)]))).toEqual(originalStorage);
});
