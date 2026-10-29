import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useSyncExternalStore } from 'react';
import { McpSettingsPanel } from './McpSettingsPanel';
import { getActiveEnvironment, setActiveEnvironment, setEnvironmentIdentity, subscribeEnvironment } from '../utils/remoteEnvironments';
import { setAuthInitializing, setTokens, setUser } from '../utils/auth';

const home = vi.hoisted(() => ({ value: 'https://home-a.test' }));
vi.mock('../utils/apiBase', async () => {
  const { routeEnvironmentPath: route } = await import('../utils/remoteEnvironments');
  return {
    resolveApiBase: () => home.value,
    resolveHomeApiUrl: (path) => home.value + path,
    resolveApiUrl: (path) => path.startsWith('http') ? path : home.value + route(path),
  };
});
vi.mock('./McpAppView', () => ({ McpAppView: () => null }));
const server = { id: 'fixture', name: 'Synthetic server', enabled: false, timeoutSeconds: 2, transport: { type: 'http', url: 'http://127.0.0.1:9/mcp' } };
let fixture;
let identity = 0;
function ScopeHarness() {
  const environment = useSyncExternalStore(subscribeEnvironment, getActiveEnvironment);
  return <McpSettingsPanel key={environment?.id || 'home'} />;
}
function selectOwner(id) {
  setTokens(`synthetic-access-${id}`, `synthetic-refresh-${id}`);
  setUser({ id }); setEnvironmentIdentity(id, home.value); setAuthInitializing(false);
}
async function startFailedProbe() {
  await screen.findByRole('button', { name: 'Test connection' });
  fireEvent.click(screen.getByRole('button', { name: 'Test connection' }));
  await screen.findByRole('button', { name: 'Retry cancellation' });
  fireEvent.click(screen.getByRole('button', { name: 'Retry cancellation' }));
  await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Could not confirm connection cleanup'));
  if (!fixture.calls.some(call => call.method === 'POST')) throw new Error(screen.getByRole('alert').textContent);
  return fixture.calls.find(call => call.method === 'POST').body.probeId;
}
beforeEach(() => {
  home.value = 'https://home-a.test'; localStorage.clear(); sessionStorage.clear();
  selectOwner(`mcp-scope-owner-${++identity}`); setActiveEnvironment({ id: 'host-a' });
  fixture = { calls: [], receipts: new Map(), allow: false };
  vi.stubGlobal('fetch', vi.fn(async (input, options = {}) => {
    const url = new URL(input); const method = options.method || 'GET';
    const authorization = options.headers?.Authorization;
    const scope = JSON.stringify([url.origin, authorization, url.pathname.match(/environments\/([^/]+)\/proxy/)?.[1] || 'home']);
    const call = { url: url.href, path: url.pathname, method, scope, authorization, body: options.body ? JSON.parse(options.body) : undefined };
    fixture.calls.push(call);
    const respond = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
    if (url.pathname.endsWith('/api/agent/mcp')) return respond({ servers: fixture.omitServer ? [] : [server] });
    if (method === 'POST') {
      const receipt = { probeId: call.body.probeId, status: 'failed', cleanupConfirmed: false, error: 'Synthetic DELETE rejected' };
      fixture.receipts.set(scope + ':' + receipt.probeId, receipt);
      return respond({ probeId: receipt.probeId, status: 'running', cleanupConfirmed: false }, 202);
    }
    const id = url.pathname.split('/').pop(); const receipt = fixture.receipts.get(scope + ':' + id);
    if (method === 'DELETE') {
      if (!receipt) return respond({ probeId: id, status: 'cancelled', cleanupConfirmed: true });
      if (fixture.allow) Object.assign(receipt, { status: 'cancelled', cleanupConfirmed: true, error: undefined });
      return respond(receipt);
    }
    return receipt ? respond(receipt) : respond({ error: 'Unavailable' }, 404);
  }));
});

describe('McpSettingsPanel originating probe scope', () => {
  it('keeps the exact failed UUID on its originating host across unmount and restores cleanup on return', async () => {
    render(<ScopeHarness />);
    const id = await startFailedProbe();
    await act(async () => setActiveEnvironment({ id: 'host-b' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Test connection' })).toBeEnabled());
    expect(fixture.calls.filter(call => call.method === 'DELETE').map(call => call.path)).toEqual([
      `/api/environments/host-a/proxy/api/agent/mcp/fixture/probes/${id}`,
      `/api/environments/host-a/proxy/api/agent/mcp/fixture/probes/${id}`,
    ]);
    await act(async () => setActiveEnvironment({ id: 'host-a' }));
    expect(await screen.findByRole('button', { name: 'Retry cancellation' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Test connection' })).toBeDisabled();
    const persisted = JSON.stringify(Object.entries(sessionStorage));
    expect(persisted).toContain(id);
    expect(persisted).not.toMatch(/synthetic-access|synthetic-refresh|bearerToken|transport/);
    fixture.allow = true;
    fireEvent.click(screen.getByRole('button', { name: 'Retry cancellation' }));
    expect(await screen.findByRole('status')).toHaveTextContent('Connection test cancelled.');
    expect(screen.getByRole('button', { name: 'Test connection' })).toBeEnabled();
    expect(fixture.calls.filter(call => call.method === 'POST')).toHaveLength(1);
    expect(fixture.calls.filter(call => call.method === 'DELETE').every(call => call.path === `/api/environments/host-a/proxy/api/agent/mcp/fixture/probes/${id}`)).toBe(true);
    expect(JSON.stringify(Object.entries(sessionStorage))).not.toContain(id);
  });

  it('rebinds same-environment account changes without a parent remount and retains the previous owner job', async () => {
    const original = JSON.parse(localStorage.getItem('terminal_user')).id;
    render(<McpSettingsPanel />);
    const id = await startFailedProbe();
    const deletesBefore = fixture.calls.filter(call => call.method === 'DELETE').length;
    await act(async () => { setTokens('synthetic-other-access', 'synthetic-other-refresh'); setUser({ id: 'different-owner-same-host' }); });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Test connection' })).toBeEnabled());
    expect(fixture.calls.filter(call => call.method === 'DELETE')).toHaveLength(deletesBefore);
    await act(async () => { setTokens(`synthetic-access-${original}`, `synthetic-refresh-${original}`); setUser({ id: original }); });
    expect(await screen.findByRole('button', { name: 'Retry cancellation' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Test connection' })).toBeDisabled();
    fixture.allow = true;
    fireEvent.click(screen.getByRole('button', { name: 'Retry cancellation' }));
    expect(await screen.findByRole('status')).toHaveTextContent('Connection test cancelled.');
    expect(fixture.calls.filter(call => call.method === 'DELETE').at(-1).path).toBe(`/api/environments/host-a/proxy/api/agent/mcp/fixture/probes/${id}`);
  });

  it('keeps exact cleanup reachable after returning to a scope whose server was removed', async () => {
    render(<ScopeHarness />);
    const id = await startFailedProbe();
    await act(async () => setActiveEnvironment({ id: 'host-b' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Test connection' })).toBeEnabled());
    fixture.omitServer = true;
    await act(async () => setActiveEnvironment({ id: 'host-a' }));
    await screen.findByText('No MCP servers configured.');
    expect(screen.getByRole('button', { name: 'Retry cancellation' })).toBeEnabled();
    fixture.allow = true;
    fireEvent.click(screen.getByRole('button', { name: 'Retry cancellation' }));
    expect(await screen.findByRole('status')).toHaveTextContent('Connection test cancelled.');
    expect(fixture.calls.filter(call => call.method === 'DELETE').at(-1).path).toBe(`/api/environments/host-a/proxy/api/agent/mcp/fixture/probes/${id}`);
  });

  it('blocks a new connection for a damaged stored cleanup identity until settings cleanup succeeds', async () => {
    const owner = JSON.parse(localStorage.getItem('terminal_user')).id;
    const key = 'terminal:mcp-probe:v1:' + encodeURIComponent(JSON.stringify([home.value + '/', owner, 'host-a']));
    sessionStorage.setItem(key, '{damaged');
    render(<McpSettingsPanel />);
    await screen.findByRole('button', { name: 'Test connection' });
    expect(screen.getByRole('button', { name: 'Test connection' })).toBeDisabled();
    expect(screen.getByRole('alert')).toHaveTextContent('Stored MCP cleanup identity is invalid');
    expect(fixture.calls.some(call => call.method === 'POST' || call.method === 'DELETE')).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Retry MCP cleanup' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Test connection' })).toBeEnabled());
    expect(fixture.calls.filter(call => call.method === 'PUT')).toHaveLength(1);
    expect(sessionStorage.getItem(key)).toBeNull();
  });

  it.each(['owner', 'home'])('never sends old cleanup under a different %s and restores it only in the originating scope', async (change) => {
    const originalOwner = JSON.parse(localStorage.getItem('terminal_user')).id;
    const originalHome = home.value;
    const view = render(<ScopeHarness />);
    const id = await startFailedProbe();
    const deletesBefore = fixture.calls.filter(call => call.method === 'DELETE').length;
    await act(async () => {
      if (change === 'home') home.value = 'https://home-b.test';
      selectOwner(change === 'owner' ? 'different-synthetic-owner' : originalOwner);
      setActiveEnvironment({ id: 'host-a' });
      view.rerender(<ScopeHarness key="changed" />);
    });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Test connection' })).toBeEnabled());
    expect(fixture.calls.filter(call => call.method === 'DELETE')).toHaveLength(deletesBefore);
    expect(screen.queryByRole('button', { name: 'Retry cancellation' })).not.toBeInTheDocument();
    await act(async () => {
      home.value = originalHome; selectOwner(originalOwner); setActiveEnvironment({ id: 'host-a' });
      view.rerender(<ScopeHarness key="returned" />);
    });
    expect(await screen.findByRole('button', { name: 'Retry cancellation' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Test connection' })).toBeDisabled();
    fixture.allow = true;
    fireEvent.click(screen.getByRole('button', { name: 'Retry cancellation' }));
    expect(await screen.findByRole('status')).toHaveTextContent('Connection test cancelled.');
    expect(fixture.calls.filter(call => call.method === 'DELETE').at(-1)).toMatchObject({ url: originalHome + `/api/environments/host-a/proxy/api/agent/mcp/fixture/probes/${id}`, authorization: `Bearer synthetic-access-${originalOwner}` });
  });
});
