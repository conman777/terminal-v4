import { act, fireEvent, render, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { apiFetch } from '../utils/api';
import { clearTokens, setTokens, setUser } from '../utils/auth';
import { setActiveEnvironment } from '../utils/remoteEnvironments';
import { usePreviewTelemetryBroker } from './usePreviewTelemetryBroker';

vi.mock('../utils/api', () => ({ apiFetch: vi.fn() }));
const authorized = 'http://localhost:3000/preview/4173/app?previewToken=current-grant';
const metrics = [{ type: 'runtimeMetrics', timestamp: 123, data: { fps: 60, memory: null, longTasks: [] } }];
const entries = [{ id: 'log-one', type: 'console', level: 'log', message: 'fixture', timestamp: 123 }];
let iframeRef;
function send(overrides = {}, source = iframeRef.current.contentWindow) {
  fireEvent(window, new MessageEvent('message', { source, data: { type: 'preview-performance', port: 4173, documentUrl: authorized, documentGrant: 'current-grant', metrics, ...overrides } }));
}
beforeEach(() => {
  localStorage.clear(); clearTokens(true); setTokens('owner-access', 'owner-refresh'); setUser({ id: 'preview-owner', username: 'fixture' }); setActiveEnvironment(null);
  apiFetch.mockReset().mockResolvedValue({ ok: true });
  const { container } = render(<iframe title="Telemetry fixture" />);
  iframeRef = { current: container.querySelector('iframe') };
});

describe('preview telemetry broker', () => {
  it('posts validated metrics and log batches only to fixed current-port endpoints', () => {
    renderHook(() => usePreviewTelemetryBroker(iframeRef, authorized));
    send({ path: '/api/settings', method: 'DELETE' });
    send({ type: 'preview-log-batch', entries });
    expect(apiFetch.mock.calls.map(([path, options]) => [path, options.home, options.method, options.body])).toEqual([
      ['/api/preview/4173/performance', true, 'POST', { metrics }],
      ['/api/preview/4173/logs', true, 'POST', entries],
    ]);
  });

  it('accepts legitimate inner navigation while retaining grant identity', () => {
    renderHook(() => usePreviewTelemetryBroker(iframeRef, authorized));
    send({ documentUrl: 'http://localhost:3000/preview/4173/next#section' });
    expect(apiFetch).toHaveBeenCalledOnce();
  });

  it.each([
    { port: 5173 }, { port: '4173' }, { documentUrl: '/preview/4173/' },
    { documentUrl: 'http://localhost:3000/preview/4173/app?previewToken=old-grant', documentGrant: 'old-grant' },
    { documentUrl: 'http://localhost:3000/preview/5173/app?previewToken=current-grant' },
    { documentUrl: 'https://foreign.example.com/preview/4173/app?previewToken=current-grant' },
    { documentUrl: 'http://localhost:3000/api/settings?previewToken=current-grant' },
    { documentUrl: 'http://localhost:3000/api/environments/other/proxy/preview/4173/app?previewToken=current-grant' },
    { type: 'arbitrary-api-command' },
  ])('rejects an unrelated document, port or message: %j', overrides => {
    renderHook(() => usePreviewTelemetryBroker(iframeRef, authorized)); send(overrides); expect(apiFetch).not.toHaveBeenCalled();
  });

  it('rejects a former document after same-port navigation issues a fresh unique grant', () => {
    const { rerender } = renderHook(({ url }) => usePreviewTelemetryBroker(iframeRef, url), { initialProps: { url: authorized } });
    const next = authorized.replace('/app?', '/new-app?').replace('current-grant', 'next-grant');
    rerender({ url: next });
    send();
    expect(apiFetch).not.toHaveBeenCalled();
    send({ documentUrl: next, documentGrant: 'next-grant' });
    expect(apiFetch).toHaveBeenCalledOnce();
  });

  it('rejects messages from another frame and while authorization is pending', () => {
    const { rerender } = renderHook(({ url }) => usePreviewTelemetryBroker(iframeRef, url), { initialProps: { url: authorized } });
    send({}, window); expect(apiFetch).not.toHaveBeenCalled();
    rerender({ url: null }); send(); expect(apiFetch).not.toHaveBeenCalled();
  });

  it.each([
    [], Array.from({ length: 501 }, () => metrics[0]),
    [{ ...metrics[0], type: 'arbitrary' }], [{ ...metrics[0], timestamp: Infinity }],
    [{ ...metrics[0], timestamp: 1.5 }], [{ ...metrics[0], data: null }], [{ ...metrics[0], data: [] }],
    [{ ...metrics[0], data: { large: 'x'.repeat(1000001) } }],
  ])('rejects invalid or oversized metric batches', batch => {
    renderHook(() => usePreviewTelemetryBroker(iframeRef, authorized)); send({ metrics: batch }); expect(apiFetch).not.toHaveBeenCalled();
  });

  it('rejects cycles without throwing in the listener', () => {
    const data = {}; data.cycle = data;
    renderHook(() => usePreviewTelemetryBroker(iframeRef, authorized));
    expect(() => send({ metrics: [{ ...metrics[0], data }] })).not.toThrow(); expect(apiFetch).not.toHaveBeenCalled();
  });

  it.each([[], Array.from({ length: 201 }, () => entries[0]), [{ ...entries[0], level: 'admin' }], [{ ...entries[0], message: {} }]])('rejects invalid or oversized log batches', batch => {
    renderHook(() => usePreviewTelemetryBroker(iframeRef, authorized)); send({ type: 'preview-log-batch', entries: batch }); expect(apiFetch).not.toHaveBeenCalled();
  });

  it('routes paired telemetry to the exact captured paired endpoint and rejects a former grant', () => {
    setActiveEnvironment({ id: 'paired-host' });
    const url = 'http://localhost:3000/api/environments/paired-host/proxy/preview/4173/app?previewToken=paired-grant';
    renderHook(() => usePreviewTelemetryBroker(iframeRef, url));
    send(); expect(apiFetch).not.toHaveBeenCalled();
    send({ documentUrl: url, documentGrant: 'paired-grant' });
    expect(apiFetch).toHaveBeenCalledWith('/api/environments/paired-host/proxy/api/preview/4173/performance', expect.objectContaining({ home: true, method: 'POST', body: { metrics } }));
  });

  it.each(['url', 'auth', 'environment', 'unmount'])('aborts pending posts and rejects further old-document batches after %s changes', kind => {
    const { rerender, unmount } = renderHook(({ url }) => usePreviewTelemetryBroker(iframeRef, url), { initialProps: { url: authorized } });
    send(); const signal = apiFetch.mock.lastCall[1].signal;
    act(() => {
      if (kind === 'url') rerender({ url: authorized.replace('current-grant', 'next-grant') });
      else if (kind === 'auth') setTokens('new-access', 'new-refresh');
      else if (kind === 'environment') setActiveEnvironment({ id: 'other-host' });
      else unmount();
    });
    expect(signal.aborted).toBe(true);
    send(); expect(apiFetch).toHaveBeenCalledOnce();
  });
});
