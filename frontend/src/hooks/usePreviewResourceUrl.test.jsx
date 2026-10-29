import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiFetch } from '../utils/api';
import { clearTokens, refreshTokens, setTokens, setUser } from '../utils/auth';
import { setActiveEnvironment } from '../utils/remoteEnvironments';
import { preparePreviewResourceUrl, usePreviewResourceUrl } from './usePreviewResourceUrl';

vi.mock('../utils/api', () => ({ apiFetch: vi.fn() }));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const reply = (targetPath, previewToken = 'read-only-ticket') => ({ ok: true, json: async () => ({ targetPath, previewToken, expiresAt: 2000000000 }) });
const popup = () => ({ opener: {}, close: vi.fn(), location: { replace: vi.fn() } });
beforeEach(() => {
  localStorage.clear(); clearTokens(true); setTokens('owner-access', 'owner-refresh'); setUser({ id: 'preview-owner', username: 'fixture' }); setActiveEnvironment(null);
  apiFetch.mockReset().mockImplementation(async (_path, options) => reply(options.body.targetPath));
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('preview resource expiry retention', () => {
  const now = Date.parse('2026-10-25T12:00:00Z');
  const grant = (targetPath, previewToken, expiresAt) => ({ ok: true, json: async () => ({ targetPath, previewToken, expiresAt }) });
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    let sequence = 0;
    apiFetch.mockImplementation(async (_path, options) => grant(options.body.targetPath, `grant-${++sequence}`, Date.now() / 1000 + 900));
  });

  it('keeps the original URL through the old renewal boundary and expiry until explicit reconnect', async () => {
    const { result } = renderHook(() => usePreviewResourceUrl('/preview/4173/app'));
    await act(async () => {});
    const initial = result.current.url;
    await act(async () => vi.advanceTimersByTimeAsync(840000));
    expect(apiFetch).toHaveBeenCalledTimes(1);
    expect(result.current.url).toBe(initial);
    expect(result.current.expired).toBe(false);
    await act(async () => vi.advanceTimersByTimeAsync(60000));
    expect(result.current.url).toBe(initial);
    expect(result.current.expired).toBe(true);
    expect(result.current.error).toMatch(/expired/i);
    expect(() => result.current.assertActive()).toThrow(/expired/i);
    await act(async () => vi.advanceTimersByTimeAsync(3600000));
    expect(apiFetch).toHaveBeenCalledTimes(1);
    act(() => result.current.retry());
    await act(async () => {});
    expect(result.current.url).not.toBe(initial);
    expect(result.current.expired).toBe(false);
    expect(result.current.error).toBe('');
    expect(result.current.assertActive()).toBe(true);
  });

  it('preserves legacy responses without expiry metadata', async () => {
    apiFetch.mockResolvedValue({ ok: true, json: async () => ({ targetPath: '/preview/4173/app', previewToken: 'legacy' }) });
    const { result } = renderHook(() => usePreviewResourceUrl('/preview/4173/app'));
    await act(async () => {});
    await act(async () => vi.advanceTimersByTimeAsync(86400000));
    expect(result.current.url).toContain('previewToken=legacy');
    expect(result.current.expired).toBe(false);
    expect(result.current.assertActive()).toBe(true);
    expect(apiFetch).toHaveBeenCalledTimes(1);
  });

  it.each([now / 1000 - 1, now / 1000, now / 1000 + 1, 'invalid', NaN, null])('rejects unusable expiry %s without a reload/re-auth loop', async expiresAt => {
    apiFetch.mockResolvedValue(grant('/preview/4173/app', 'unusable', expiresAt));
    const { result } = renderHook(() => usePreviewResourceUrl('/preview/4173/app'));
    await act(async () => {});
    expect(result.current.url).toBeNull();
    expect(result.current.error).toMatch(/expir/i);
    await act(async () => vi.advanceTimersByTimeAsync(3600000));
    expect(apiFetch).toHaveBeenCalledTimes(1);
  });

  it('bounds far-future timers and marks expiry without reminting', async () => {
    const lifetime = 40 * 86400000;
    const nativeTimerLimit = 2147483647;
    apiFetch.mockImplementationOnce(async (_path, options) => grant(options.body.targetPath, 'long-lived', (now + lifetime) / 1000));
    const { result } = renderHook(() => usePreviewResourceUrl('/preview/4173/app'));
    await act(async () => {});
    await act(async () => vi.advanceTimersByTimeAsync(nativeTimerLimit));
    expect(result.current.expired).toBe(false);
    await act(async () => vi.advanceTimersByTimeAsync(lifetime - nativeTimerLimit));
    expect(result.current.expired).toBe(true);
    expect(result.current.url).toContain('previewToken=long-lived');
    expect(apiFetch).toHaveBeenCalledTimes(1);
  });

  it('checks the actual deadline on focus after suspension without replacing the URL', async () => {
    const { result } = renderHook(() => usePreviewResourceUrl('/preview/4173/app'));
    await act(async () => {});
    const initial = result.current.url;
    vi.setSystemTime(now + 901000);
    act(() => window.dispatchEvent(new Event('focus')));
    expect(result.current.expired).toBe(true);
    expect(result.current.url).toBe(initial);
    expect(apiFetch).toHaveBeenCalledTimes(1);
  });

  it('rejects an operation at the deadline even before its timer runs', async () => {
    const { result } = renderHook(() => usePreviewResourceUrl('/preview/4173/app'));
    await act(async () => {});
    vi.setSystemTime(now + 900000);
    act(() => expect(() => result.current.assertActive()).toThrow(/expired/i));
    expect(result.current.expired).toBe(true);
    expect(apiFetch).toHaveBeenCalledTimes(1);
  });

  it.each(['target', 'auth', 'environment', 'unmount'])('retires the old URL, operation guard and deadline on %s changes', async kind => {
    const fresh = deferred();
    const view = renderHook(({ target }) => usePreviewResourceUrl(target), { initialProps: { target: '/preview/4173/app' } });
    await act(async () => {});
    const retiredGuard = view.result.current.assertActive;
    await act(async () => vi.advanceTimersByTimeAsync(100000));
    apiFetch.mockImplementationOnce(() => fresh.promise);
    act(() => {
      if (kind === 'target') view.rerender({ target: '/preview/5173/next' });
      else if (kind === 'auth') setTokens('replacement-access', 'replacement-refresh');
      else if (kind === 'environment') setActiveEnvironment({ id: 'expiry-paired-fixture' });
      else view.unmount();
    });
    await act(async () => {});
    expect(() => retiredGuard()).toThrow(/changed|load/i);
    if (kind !== 'unmount') {
      expect(view.result.current.url).toBeNull();
      await act(async () => fresh.resolve(grant(kind === 'target' ? '/preview/5173/next' : '/preview/4173/app', 'current', Date.now() / 1000 + 900)));
      expect(view.result.current.expired).toBe(false);
      await act(async () => vi.advanceTimersByTimeAsync(800000));
      expect(view.result.current.expired).toBe(false);
    } else {
      await act(async () => vi.advanceTimersByTimeAsync(3600000));
      expect(apiFetch).toHaveBeenCalledTimes(1);
    }
  });

  it('allows a separate popup grant while the loaded document remains expired', async () => {
    const tab = popup();
    vi.spyOn(window, 'open').mockReturnValue(tab);
    const { result } = renderHook(() => usePreviewResourceUrl('/preview/4173/app'));
    await act(async () => {});
    const initial = result.current.url;
    await act(async () => vi.advanceTimersByTimeAsync(900000));
    act(() => result.current.openInNewTab());
    await act(async () => {});
    expect(tab.close).not.toHaveBeenCalled();
    expect(new URL(tab.location.replace.mock.lastCall[0]).searchParams.get('previewToken')).toBe('grant-2');
    expect(result.current.url).toBe(initial);
    expect(result.current.expired).toBe(true);
  });
});

describe('preview resource URL authorization', () => {
  it('uses an authenticated home POST and the server-sanitized path while retaining business queries and fragments', async () => {
    apiFetch.mockResolvedValue(reply('/preview/4173/app?token=business&x=1#section'));
    const target = await preparePreviewResourceUrl('/preview/4173/app?token=old-host-access&x=1#section');
    expect(apiFetch).toHaveBeenCalledWith('/api/preview/resource-auth', expect.objectContaining({ home: true, method: 'POST', body: { targetPath: '/preview/4173/app?token=old-host-access&x=1#section' } }));
    const parsed = new URL(target);
    expect([parsed.pathname, parsed.searchParams.get('token'), parsed.searchParams.get('previewToken'), parsed.hash]).toEqual(['/preview/4173/app', 'business', 'read-only-ticket', '#section']);
  });

  it.each(['javascript:void(0)', 'data:text/html,fixture', 'file:///tmp/index.html', '/settings'])('rejects unsafe or nonpreview navigation %s', async target => {
    await expect(preparePreviewResourceUrl(target)).rejects.toThrow('Preview navigation must use an authorized preview or an external HTTP(S) address.');
    expect(apiFetch).not.toHaveBeenCalled();
    const tab = popup();
    vi.spyOn(window, 'open').mockReturnValue(tab);
    const { result } = renderHook(() => usePreviewResourceUrl(target));
    await waitFor(() => expect(result.current.error).toContain('Preview navigation must use'));
    act(() => result.current.openInNewTab());
    await waitFor(() => expect(tab.close).toHaveBeenCalled());
    expect(tab.location.replace).not.toHaveBeenCalled();
  });

  it('allows direct external HTTP(S) navigation without app credentials', async () => {
    expect(await preparePreviewResourceUrl('http://192.168.1.20:4173/app')).toBe('http://192.168.1.20:4173/app');
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it('rejects a grant response for a different target', async () => {
    apiFetch.mockResolvedValue(reply('/api/settings'));
    await expect(preparePreviewResourceUrl('/preview/4173/app')).rejects.toThrow('different target');
  });

  it('keeps the iframe URL empty after failure and remints on explicit retry', async () => {
    apiFetch.mockResolvedValueOnce({ ok: false, json: async () => ({ error: 'Preview permission denied' }) });
    const { result } = renderHook(() => usePreviewResourceUrl('/preview/4173/app'));
    expect(result.current.url).toBeNull();
    await waitFor(() => expect(result.current.error).toBe('Preview permission denied'));
    expect(result.current.url).toBeNull();
    act(() => result.current.retry());
    await waitFor(() => expect(result.current.url).toContain('previewToken=read-only-ticket'));
    expect(apiFetch).toHaveBeenCalledTimes(2);
  });

  it('does not publish an old mint across an A-to-B-to-A target transition', async () => {
    const requests = [deferred(), deferred(), deferred()];
    requests.forEach(request => apiFetch.mockImplementationOnce(() => request.promise));
    const { result, rerender } = renderHook(({ target }) => usePreviewResourceUrl(target), { initialProps: { target: '/preview/4173/a' } });
    await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(1));
    rerender({ target: '/preview/5173/b' });
    await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(2));
    rerender({ target: '/preview/4173/a' });
    await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(3));
    await act(async () => requests[0].resolve(reply('/preview/4173/a', 'stale')));
    expect(result.current.url).toBeNull();
    await act(async () => requests[2].resolve(reply('/preview/4173/a', 'current')));
    expect(new URL(result.current.url).searchParams.get('previewToken')).toBe('current');
    await act(async () => requests[1].resolve(reply('/preview/5173/b', 'wrong-app')));
    expect(new URL(result.current.url).searchParams.get('previewToken')).toBe('current');
  });

  it.each(['auth', 'environment'])('invalidates old mint authority after %s changes', async kind => {
    const previous = deferred();
    apiFetch.mockImplementationOnce(() => previous.promise);
    const { result } = renderHook(() => usePreviewResourceUrl('/preview/4173/app'));
    await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(1));
    act(() => { if (kind === 'auth') setTokens('new-owner-access', 'new-owner-refresh'); else setActiveEnvironment({ id: 'paired-fixture' }); });
    await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(result.current.url).toContain('read-only-ticket'));
    const current = result.current.url;
    await act(async () => previous.resolve(reply('/preview/4173/app', 'old-authority')));
    expect(result.current.url).toBe(current);
  });

  it('opens a placeholder synchronously and uses a fresh grant rather than the iframe grant', async () => {
    const fresh = deferred();
    const tab = popup();
    const open = vi.spyOn(window, 'open').mockReturnValue(tab);
    const { result } = renderHook(() => usePreviewResourceUrl('/preview/4173/app'));
    await waitFor(() => expect(result.current.url).toContain('read-only-ticket'));
    apiFetch.mockImplementationOnce(() => fresh.promise);
    act(() => result.current.openInNewTab());
    expect(open).toHaveBeenCalledWith('about:blank', '_blank');
    expect(tab.opener).toBeNull();
    expect(tab.location.replace).not.toHaveBeenCalled();
    await act(async () => fresh.resolve(reply('/preview/4173/app', 'fresh-tab-ticket')));
    expect(new URL(tab.location.replace.mock.lastCall[0]).searchParams.get('previewToken')).toBe('fresh-tab-ticket');
  });

  it.each(['navigate', 'auth', 'environment', 'unmount'])('closes an unprepared new tab when %s invalidates the operation', async kind => {
    const fresh = deferred();
    const tab = popup();
    vi.spyOn(window, 'open').mockReturnValue(tab);
    const { result, rerender, unmount } = renderHook(({ target }) => usePreviewResourceUrl(target), { initialProps: { target: '/preview/4173/app' } });
    await waitFor(() => expect(result.current.url).toContain('read-only-ticket'));
    apiFetch.mockImplementationOnce(() => fresh.promise);
    act(() => result.current.openInNewTab());
    act(() => {
      if (kind === 'navigate') rerender({ target: '/preview/5173/other' });
      else if (kind === 'auth') setTokens('new-access', 'new-refresh');
      else if (kind === 'environment') setActiveEnvironment({ id: 'paired-fixture' });
      else unmount();
    });
    await act(async () => fresh.resolve(reply('/preview/4173/app', 'late-ticket')));
    expect(tab.close).toHaveBeenCalled();
    expect(tab.location.replace).not.toHaveBeenCalled();
  });

  it('reports a blocked popup without starting another mint', async () => {
    vi.spyOn(window, 'open').mockReturnValue(null);
    const { result } = renderHook(() => usePreviewResourceUrl('/preview/4173/app'));
    await waitFor(() => expect(result.current.url).toContain('read-only-ticket'));
    act(() => result.current.openInNewTab());
    expect(result.current.error).toContain('blocked the new tab');
    expect(apiFetch).toHaveBeenCalledTimes(1);
  });

  it('closes a placeholder and reports failed new-tab authorization', async () => {
    const tab = popup();
    vi.spyOn(window, 'open').mockReturnValue(tab);
    const { result } = renderHook(() => usePreviewResourceUrl('/preview/4173/app'));
    await waitFor(() => expect(result.current.url).toContain('read-only-ticket'));
    apiFetch.mockResolvedValueOnce({ ok: false, json: async () => ({ error: 'Preview ticket expired' }) });
    act(() => result.current.openInNewTab());
    await waitFor(() => expect(result.current.error).toBe('Preview ticket expired'));
    expect(tab.close).toHaveBeenCalled(); expect(tab.location.replace).not.toHaveBeenCalled();
  });
  it.each([false, true])('keeps a new-tab mint alive during same-account rotation with user=%s', async withUser => {
    vi.stubGlobal('navigator', { locks: { request: async (_name, _options, run) => run() } });
    const tab = popup();
    vi.spyOn(window, 'open').mockReturnValue(tab);
    vi.stubGlobal('fetch', vi.fn(async input => ({ ok: true, status: 200, json: async () => String(input).includes('/api/auth/refresh') ? { tokens: { accessToken: 'rotated-access', refreshToken: 'rotated-refresh' }, ...(withUser ? { user: { id: 'preview-owner', username: 'fixture' } } : {}) } : {} })));
    const { result } = renderHook(() => usePreviewResourceUrl('/preview/4173/app'));
    await waitFor(() => expect(result.current.url).toContain('read-only-ticket'));
    apiFetch.mockImplementationOnce(async () => { await refreshTokens(); return reply('/preview/4173/app', 'fresh-after-rotation'); });
    act(() => result.current.openInNewTab());
    await waitFor(() => expect(new URL(tab.location.replace.mock.lastCall?.[0] || 'http://not-ready').searchParams.get('previewToken')).toBe('fresh-after-rotation'));
    expect(tab.close).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

});
