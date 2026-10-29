// SCRATCH ADJACENT REGRESSION PREVIEW. These may already pass: they are not RED
// evidence for attachment upload/draft implementation. Real apiFetch/auth; fake HTTP.
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { apiFetch } from './api';
import { clearTokens, setAuthInitializing, setTokens, setUser, getAccessToken } from './auth';
import { setActiveEnvironment, setEnvironmentIdentity } from './remoteEnvironments';

const image = { attachmentId: '11111111-1111-4111-8111-111111111111', artifactId: 'a'.repeat(64), mimeType: 'image/png', bytes: 67, name: 'first.png' };
const input = { requestId: '22222222-2222-4222-8222-222222222222', text: '', attachments: [image] };
const response = (status, body = {}) => ({ status, ok: status >= 200 && status < 300, json: async () => body });
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };

describe('user image body auth regression sentinels', () => {
  beforeEach(() => {
    vi.stubGlobal('navigator', { locks: { request: async (_name, _options, run) => run() } });
    clearTokens(true); localStorage.clear(); setAuthInitializing(false);
    setEnvironmentIdentity('image-auth-old', window.location.origin); setActiveEnvironment(null);
    setTokens('old-access', 'old-refresh'); setUser({ id: 'image-auth-old' });
  });
  afterEach(() => { vi.unstubAllGlobals(); setEnvironmentIdentity(null); clearTokens(true); localStorage.clear(); });

  it('retries a successful same-account401 with the exact image body bytes once', async () => {
    const sent = []; let count = 0;
    vi.stubGlobal('fetch', vi.fn(async (url, options) => {
      if (String(url).endsWith('/api/auth/refresh')) return response(200, { tokens: { accessToken: 'rotated-access', refreshToken: 'rotated-refresh' } });
      if (String(url).endsWith('/api/preview/session')) return response(200);
      sent.push({ body: options.body, authorization: options.headers.Authorization });
      return response(++count === 1 ? 401 : 202);
    }));
    expect((await apiFetch('/api/structured/sessions/ss-image-auth/attachments/send', { method: 'POST', body: input })).status).toBe(202);
    expect(sent.map(item => item.body)).toEqual([JSON.stringify(input), JSON.stringify(input)]);
    expect(sent.map(item => item.authorization)).toEqual(['Bearer old-access', 'Bearer rotated-access']);
  });

  it.each([200, 401])('late old refresh%s cannot replay an old image request or overwrite another login', async status => {
    const delayed = deferred(); const sent = [];
    vi.stubGlobal('fetch', vi.fn(async (url, options) => {
      if (String(url).endsWith('/api/auth/refresh')) return delayed.promise;
      sent.push(options.body); return response(401);
    }));
    const outcome = apiFetch('/api/structured/sessions/ss-image-auth/attachments/send', { method: 'POST', body: input }).catch(error => error);
    await vi.waitFor(() => expect(fetch.mock.calls.some(([url]) => String(url).endsWith('/api/auth/refresh'))).toBe(true));
    setTokens('new-access', 'new-refresh'); setUser({ id: 'image-auth-new' });
    delayed.resolve(response(status, { user: { id: 'image-auth-old' }, tokens: { accessToken: 'late-access', refreshToken: 'late-refresh' } }));
    expect(await outcome).toBeInstanceOf(Error);
    expect(getAccessToken()).toBe('new-access'); expect(sent).toEqual([JSON.stringify(input)]);
  });
});
