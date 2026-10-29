import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { McpAppView } from './McpAppView';
import { setActiveEnvironment } from '../utils/remoteEnvironments';
import { setAuthInitializing, setTokens, setUser } from '../utils/auth';

const home = vi.hoisted(() => ({ value: 'https://app-home-a.test' }));
vi.mock('../utils/apiBase', async () => {
  const { routeEnvironmentPath } = await import('../utils/remoteEnvironments');
  return {
    resolveApiBase: () => home.value,
    resolveHomeApiUrl: (path) => home.value + path,
    resolveApiUrl: (path) => home.value + routeEnvironmentPath(path),
  };
});
const tool = { name: 'fixture_app', _meta: { ui: { resourceUri: 'ui://fixture/app' } } };
let fixture;
const reply = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const deletes = () => fixture.calls.filter(call => call.method === 'DELETE');
async function open() {
  const onClose = vi.fn();
  const view = render(<McpAppView serverId="fixture" serverName="Synthetic server" tool={tool} onClose={onClose} />);
  await screen.findByRole('button', { name: 'Run app preview' });
  return { ...view, onClose, id: fixture.calls.find(call => call.method === 'POST').body.sessionId };
}
beforeEach(() => {
  home.value = 'https://app-home-a.test';
  localStorage.clear(); setTokens('synthetic-owner-access', 'synthetic-owner-refresh'); setUser({ id: 'synthetic-app-owner' }); setAuthInitializing(false); setActiveEnvironment(null);
  fixture = { calls: [], failures: 0, wrongReceipt: false };
  vi.stubGlobal('fetch', vi.fn(async (input, options = {}) => {
    const url = new URL(input);
    const call = { url: url.href, path: url.pathname, method: options.method || 'GET', authorization: options.headers?.Authorization, body: options.body ? JSON.parse(options.body) : null, keepalive: options.keepalive };
    fixture.calls.push(call);
    if (call.path.includes('/environments/')) return reply({ error: 'This route is not delegated to paired environments' }, 403);
    if (call.path.endsWith('/apps/open')) return reply({ sessionId: call.body.sessionId, resourceUri: 'ui://fixture/app', html: '<h1>Synthetic source</h1>', resource: { mimeType: 'text/html;profile=mcp-app' } });
    if (call.method === 'DELETE' && fixture.failures-- > 0) return reply({ error: 'MCP App cleanup is still running' }, 500);
    return reply({ sessionId: fixture.wrongReceipt ? 'different-session' : call.path.split('/').pop(), status: call.method === 'DELETE' ? 'closed' : 'active' });
  }));
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); delete navigator.locks; });

describe('McpAppView originating session scope', () => {
  it('deletes the exact home session after selection changes before unmount', async () => {
    const view = await open();
    act(() => setActiveEnvironment({ id: 'synthetic-host-b' }));
    view.unmount();
    await waitFor(() => expect(deletes()).toEqual([expect.objectContaining({ url: `${home.value}/api/agent/mcp/apps/${view.id}`, keepalive: true, authorization: 'Bearer synthetic-owner-access' })]));
  });

  it('retires a mounted view on scope change instead of polling or approving in the new scope', async () => {
    const view = await open();
    act(() => setActiveEnvironment({ id: 'synthetic-host-b' }));
    expect(screen.queryByRole('button', { name: 'Run app preview' })).not.toBeInTheDocument();
    expect(await screen.findByRole('alert')).toHaveTextContent(/scope|environment|account/i);
    await waitFor(() => expect(deletes().map(call => call.path)).toEqual([`/api/agent/mcp/apps/${view.id}`]));
    expect(fixture.calls.every(call => !call.path.includes('/environments/'))).toBe(true);
  });

  it('uses rotated credentials in the same session for origin-bound cleanup', async () => {
    const view = await open();
    localStorage.setItem('terminal_access_token', 'synthetic-rotated-access');
    act(() => setActiveEnvironment({ id: 'synthetic-host-b' })); view.unmount();
    await waitFor(() => expect(deletes().map(call => [call.url, call.authorization])).toEqual([[`${home.value}/api/agent/mcp/apps/${view.id}`, 'Bearer synthetic-rotated-access']]));
  });

  it('refreshes a 401 cleanup at home while a paired environment is selected', async () => {
    const view = await open();
    const originalFetch = fetch;
    Object.defineProperty(navigator, 'locks', { configurable: true, value: { request: async (_name, _options, callback) => callback() } });
    let expired = true;
    vi.stubGlobal('fetch', vi.fn(async (input, options = {}) => {
      const url = new URL(input);
      if (url.pathname === '/api/auth/refresh') return reply({ accessToken: 'synthetic-refreshed-access', refreshToken: 'synthetic-refreshed-refresh' });
      if (url.pathname === '/api/preview/session') return reply({});
      if (options.method === 'DELETE' && expired) { expired = false; return reply({ error: 'Expired synthetic token' }, 401); }
      return originalFetch(input, options);
    }));
    act(() => setActiveEnvironment({ id: 'synthetic-host-b' })); view.unmount();
    await waitFor(() => expect(deletes().map(call => [call.url, call.authorization])).toEqual([[`${home.value}/api/agent/mcp/apps/${view.id}`, 'Bearer synthetic-refreshed-access']]));
  });

  it('cancels a pending open on its original scope and ignores a late success', async () => {
    const originalFetch = fetch;
    let resolveOpen;
    vi.stubGlobal('fetch', vi.fn((input, options = {}) => options.method === 'POST'
      ? new Promise(resolve => { resolveOpen = () => resolve(originalFetch(input, options)); })
      : originalFetch(input, options)));
    const onClose = vi.fn();
    const view = render(<McpAppView serverId="fixture" serverName="Synthetic server" tool={tool} onClose={onClose} />);
    act(() => setActiveEnvironment({ id: 'synthetic-host-b' })); view.unmount();
    await act(async () => resolveOpen());
    const id = fixture.calls.find(call => call.method === 'POST').body.sessionId;
    expect(deletes().map(call => call.url)).toEqual([`${home.value}/api/agent/mcp/apps/${id}`]);
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'Run app preview' })).not.toBeInTheDocument();
  });

  it.each(['account', 'home'])('never sends the old UUID or credentials after %s changes', async (change) => {
    const view = await open();
    if (change === 'account') act(() => { setTokens('synthetic-other-access', 'synthetic-other-refresh'); setUser({ id: 'synthetic-other-owner' }); });
    else home.value = 'https://app-home-b.test';
    view.unmount();
    await act(async () => {});
    expect(deletes()).toEqual([]);
  });

  it('retains and retries a failed cleanup after unmount on its original home', async () => {
    const view = await open(); vi.useFakeTimers(); fixture.failures = 1;
    act(() => setActiveEnvironment({ id: 'synthetic-host-b' })); view.unmount();
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    expect(deletes().map(call => call.url)).toEqual(Array(2).fill(`${home.value}/api/agent/mcp/apps/${view.id}`));
    await act(async () => { await vi.advanceTimersByTimeAsync(30000); });
    expect(deletes()).toHaveLength(2);
  });

  it('stops a detached retry before it can use another home or account', async () => {
    const view = await open(); vi.useFakeTimers(); fixture.failures = 1;
    view.unmount();
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    home.value = 'https://app-home-b.test';
    setTokens('synthetic-other-access', 'synthetic-other-refresh'); setUser({ id: 'synthetic-other-owner' });
    await act(async () => { await vi.advanceTimersByTimeAsync(30000); });
    expect(deletes().map(call => [call.url, call.authorization])).toEqual([[`https://app-home-a.test/api/agent/mcp/apps/${view.id}`, 'Bearer synthetic-owner-access']]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not release a detached retry on a mismatched closed receipt', async () => {
    const view = await open(); vi.useFakeTimers(); fixture.wrongReceipt = true;
    view.unmount();
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(deletes()).toHaveLength(2);
    fixture.wrongReceipt = false;
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    expect(deletes().map(call => call.url)).toEqual(Array(3).fill(`${home.value}/api/agent/mcp/apps/${view.id}`));
    await act(async () => { await vi.advanceTimersByTimeAsync(30000); });
    expect(deletes()).toHaveLength(3);
  });

  it('does not accept a closed receipt for another UUID and allows a correct retry', async () => {
    const view = await open(); fixture.wrongReceipt = true;
    fireEvent.click(screen.getByRole('button', { name: 'Close app' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/cleanup/);
    expect(view.onClose).not.toHaveBeenCalled();
    fixture.wrongReceipt = false;
    fireEvent.click(screen.getByRole('button', { name: 'Close app' }));
    await waitFor(() => expect(view.onClose).toHaveBeenCalledTimes(1));
    expect(deletes().map(call => call.path)).toEqual(Array(2).fill(`/api/agent/mcp/apps/${view.id}`));
  });
});
