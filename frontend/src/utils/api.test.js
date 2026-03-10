import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./auth', () => ({
  getAccessToken: vi.fn(() => 'token-1'),
  clearTokens: vi.fn(),
  refreshTokens: vi.fn(async () => ({ accessToken: 'token-2' })),
  getAuthInitializing: vi.fn(() => false)
}));

import { apiFetch } from './api';

describe('apiFetch', () => {
  beforeEach(() => {
    global.fetch = vi.fn(async () => ({ status: 200, ok: true }));
  });

  afterEach(() => {
    vi.clearAllMocks();
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
});
