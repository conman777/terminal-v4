import { setActiveEnvironment, getEnvironmentSignal } from './remoteEnvironments';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./auth', () => ({
  getAccessToken: vi.fn(() => 'token-1'),
  clearTokens: vi.fn(),
  refreshTokens: vi.fn(async () => ({ accessToken: 'token-2' })),
  getAuthInitializing: vi.fn(() => false),
  captureAuthScope: vi.fn(() => 'fixture-auth-scope'),
  isAuthScopeCurrent: vi.fn(() => true)
}));

import { apiFetch } from './api';
import { clearTokens, refreshTokens } from './auth';

describe('apiFetch', () => {
  beforeEach(() => {
    global.fetch = vi.fn(async () => ({ status: 200, ok: true }));
  });

  afterEach(() => {
    vi.clearAllMocks();
    setActiveEnvironment(null);
  });

  it('does not mutate the caller body when serializing json requests', async () => {
    const body = { hello: 'world' };
    const options = { method: 'POST', body };

    await apiFetch('/api/test', options);

    expect(options.body).toBe(body);
    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining('/api/test'),
      expect.objectContaining({
        body: JSON.stringify(body),
        headers: expect.objectContaining({
          Authorization: 'Bearer token-1',
          'Content-Type': 'application/json'
        })
      })
    );
  });

  it('reuses the serialized request body on retry without changing the original options', async () => {
    const body = { retry: true };
    const options = { method: 'POST', body };
    global.fetch = vi
      .fn()
      .mockResolvedValueOnce({ status: 401, ok: false })
      .mockResolvedValueOnce({ status: 200, ok: true });

    await apiFetch('/api/test', options);

    expect(options.body).toBe(body);
    expect(global.fetch).toHaveBeenNthCalledWith(
      2,
      expect.any(String),
      expect.objectContaining({ body: JSON.stringify(body) })
    );
  });

  it('force-clears local auth when refresh fails after a 401', async () => {
    global.fetch = vi.fn().mockResolvedValueOnce({ status: 401, ok: false });
    refreshTokens.mockRejectedValueOnce(new Error('Token refresh failed'));

    await expect(apiFetch('/api/test')).rejects.toThrow('Session expired');

    expect(clearTokens).toHaveBeenCalledWith(true);
  });
  it('sends home credentials only to the home proxy and aborts requests from the previous environment', async () => {
    setActiveEnvironment({ id: 'remote-a' });
    const oldSignal = getEnvironmentSignal();
    await apiFetch('/api/terminal');
    expect(global.fetch).toHaveBeenCalledWith('/api/environments/remote-a/proxy/api/terminal', expect.objectContaining({ headers: { Authorization: 'Bearer token-1' } }));
    const requestSignal = global.fetch.mock.calls[0][1].signal;
    setActiveEnvironment(null);
    expect(oldSignal.aborted).toBe(true);
    expect(requestSignal.aborted).toBe(true);
    await expect(apiFetch('https://untrusted.example.test/api/terminal')).rejects.toThrow('API requests must use the home server');
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });
  it('does not retry an old-host request after token refresh completes during an environment switch', async () => {
    setActiveEnvironment({ id: 'remote-a' });
    global.fetch.mockResolvedValueOnce({ status: 401, ok: false });
    refreshTokens.mockImplementationOnce(async () => {
      setActiveEnvironment({ id: 'remote-b' });
      return { accessToken: 'token-2' };
    });
    await expect(apiFetch('/api/terminal')).rejects.toThrow();
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(clearTokens).not.toHaveBeenCalled();
  });

  it('keeps explicit home account settings on the home server while working remotely', async () => {
    setActiveEnvironment({ id: 'remote-a' });
    await apiFetch('/api/settings', { home: true });
    expect(global.fetch).toHaveBeenCalledWith('/api/settings', expect.not.objectContaining({ home: true }));
  });

});
