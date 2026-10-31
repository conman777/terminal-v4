import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';

afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });

it('does not start a configured strict lifecycle when the marker cannot be persisted', async () => {
  vi.stubGlobal('sessionStorage', { getItem: () => null, setItem() {} });
  const fetchImpl = vi.fn();
  vi.stubGlobal('fetch', fetchImpl);
  const { AuthProvider, useAuth } = await import('../contexts/AuthContext');
  const { default: LoginPage } = await import('../components/LoginPage');
  const notifications = { subscribe: vi.fn(() => () => {}), publish: vi.fn() };
  const lifecycle = { notifications, subscribe: notifications.subscribe, read: vi.fn(async () => ({ status: 'tombstone' })),
    login: vi.fn(), refresh: vi.fn(), logout: vi.fn(), recoverLogin: vi.fn(), resumeLogout: vi.fn(),
    recoverRetirements: vi.fn(), pendingLogins: vi.fn() };
  const strictAuth = { lifecycle, subscribe: notifications.subscribe, home: new URL('/', window.location.origin).href, validateSession: vi.fn() };
  let current;
  function Probe() { current = useAuth(); return current.loading ? null : <LoginPage />; }
  render(<AuthProvider strictAuth={strictAuth}><Probe /></AuthProvider>);
  await waitFor(() => expect(current.loading).toBe(false));
  expect([current.strictReady, current.strictStatus, current.user]).toEqual([false, 'unavailable', null]);
  expect(lifecycle.read).not.toHaveBeenCalled();
  expect(notifications.subscribe).not.toHaveBeenCalled();
  expect(screen.getByRole('alert')).toHaveTextContent('Check that browser session storage is enabled');
  expect(screen.queryByRole('button', { name: /sign in|passkey/i })).toBeNull();
  expect(fetchImpl).not.toHaveBeenCalled();
});
