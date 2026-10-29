import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { McpSettingsPanel } from './McpSettingsPanel';
import { setTokens, setUser } from '../utils/auth';
import { setEnvironmentIdentity } from '../utils/remoteEnvironments';

const apiFetch = vi.hoisted(() => vi.fn());
vi.mock('../utils/api', () => ({ apiFetch }));
vi.mock('./McpAppView', () => ({ McpAppView: ({ tool, onClose }) => <div>Opened app {tool.name}<button onClick={onClose}>Close synthetic app</button></div> }));
const response = (body, ok = true) => ({ ok, json: async () => body });
const stdio = {
  id: 'local-tools', name: 'Local tools', enabled: true, timeoutSeconds: 30,
  transport: { type: 'stdio', command: '/opt/fixture/server', args: ['--stdio'], envKeys: ['FIXTURE_TOKEN'] },
};
const http = {
  id: 'remote-tools', name: 'Remote tools', enabled: false, timeoutSeconds: 15,
  transport: { type: 'http', url: 'https://fixture.example.test/mcp', bearerTokenSet: true },
};
const setup = async (servers = []) => {
  apiFetch.mockResolvedValueOnce(response({ servers }));
  render(<McpSettingsPanel />);
  await screen.findByRole('button', { name: 'Add MCP server' });
};
const serverCard = (name) => screen.getByRole('article', { name });
const edit = (name) => fireEvent.click(within(serverCard(name)).getByRole('button', { name: 'Edit' }));
const save = () => fireEvent.click(screen.getByRole('button', { name: 'Save server' }));
const queueProbe = (result) => {
  let probeId;
  apiFetch.mockImplementationOnce(async (_url, options) => { probeId = options.body.probeId; return response({ probeId, status: 'running', cleanupConfirmed: false }); });
  apiFetch.mockImplementationOnce(async () => response({ probeId, status: 'completed', cleanupConfirmed: true, result }));
};

let testOwner = 0;
beforeEach(() => {
  apiFetch.mockReset(); localStorage.clear(); sessionStorage.clear();
  const id = `mcp-component-fixture-${++testOwner}`;
  setTokens('synthetic-access', 'synthetic-refresh'); setUser({ id }); setEnvironmentIdentity(id);
});

describe('McpSettingsPanel', () => {
  it.each(['pending', 'failed'])('preserves unread settings during cleanup recovery while the initial GET is %s', async (initialMode) => {
    const owner = JSON.parse(localStorage.getItem('terminal_user')).id;
    const key = 'terminal:mcp-probe:v1:' + encodeURIComponent(JSON.stringify([window.location.origin + '/', owner, null]));
    sessionStorage.setItem(key, '{damaged');
    const original = [stdio, http];
    let stored = original;
    let mode = initialMode;
    let finishLoad;
    apiFetch.mockImplementation(async (_url, options) => {
      if (options?.method === 'PUT') {
        if (options.body.servers.length === 0) stored = [];
        return response({ servers: stored });
      }
      if (mode === 'pending') return new Promise(resolve => { finishLoad = () => resolve(response({ servers: stored })); });
      if (mode === 'failed') return response({ error: 'Synthetic settings read failed' }, false);
      return response({ servers: stored });
    });
    render(<McpSettingsPanel />);
    const cleanup = await screen.findByRole('button', { name: 'Retry MCP cleanup' });
    if (initialMode === 'failed') await screen.findByRole('button', { name: 'Retry loading MCP settings' });
    await act(async () => fireEvent.click(cleanup));
    expect(stored).toEqual(original);
    expect(apiFetch.mock.calls.filter(([, options]) => options?.method === 'PUT')).toEqual([]);
    expect(cleanup).toBeDisabled();
    expect(screen.queryByText('MCP settings saved.')).not.toBeInTheDocument();
    if (initialMode === 'pending') await act(async () => finishLoad());
    else {
      fireEvent.click(screen.getByRole('button', { name: 'Retry loading MCP settings' }));
      await screen.findByRole('button', { name: 'Retry loading MCP settings' });
      expect(cleanup).toBeDisabled();
      expect(apiFetch.mock.calls.filter(([, options]) => options?.method === 'PUT')).toEqual([]);
      mode = 'ok';
      fireEvent.click(screen.getByRole('button', { name: 'Retry loading MCP settings' }));
    }
    await screen.findByRole('article', { name: 'Local tools' });
    expect(cleanup).toBeEnabled();
    fireEvent.click(cleanup);
    await screen.findByText('MCP settings saved.');
    expect(apiFetch.mock.calls.filter(([, options]) => options?.method === 'PUT').map(([, options]) => options.body)).toEqual([{ servers: [
      { id: stdio.id, name: stdio.name, enabled: stdio.enabled, timeoutSeconds: stdio.timeoutSeconds,
        transport: { type: 'stdio', command: stdio.transport.command, args: stdio.transport.args } },
      { id: http.id, name: http.name, enabled: http.enabled, timeoutSeconds: http.timeoutSeconds,
        transport: { type: 'http', url: http.transport.url } },
    ] }]);
    expect(stored).toEqual(original);
    expect(sessionStorage.getItem(key)).toBeNull();
  });

  it.each(['pending', 'failed'])('cancels an exact held probe independently while the configuration GET is %s', async (mode) => {
    const owner = JSON.parse(localStorage.getItem('terminal_user')).id;
    const probeId = crypto.randomUUID();
    const key = 'terminal:mcp-probe:v1:' + encodeURIComponent(JSON.stringify([window.location.origin + '/', owner, null]));
    sessionStorage.setItem(key, JSON.stringify({ version: 1, probeId, serverId: http.id, timeoutSeconds: http.timeoutSeconds }));
    apiFetch.mockImplementation(async (_url, options) => {
      if (options?.method === 'DELETE') return response({ probeId, status: 'cancelled', cleanupConfirmed: true });
      return mode === 'pending' ? new Promise(() => {}) : response({ error: 'Synthetic settings read failed' }, false);
    });
    render(<McpSettingsPanel />);
    const retry = await screen.findByRole('button', { name: 'Retry cancellation' });
    expect(retry).toBeEnabled();
    fireEvent.click(retry);
    expect(await screen.findByText('Connection test cancelled.')).toBeInTheDocument();
    expect(apiFetch.mock.calls.filter(([, options]) => options?.method === 'DELETE').map(([path]) => path)).toEqual([`/api/agent/mcp/${http.id}/probes/${probeId}`]);
    expect(apiFetch.mock.calls.some(([, options]) => options?.method === 'PUT')).toBe(false);
    expect(sessionStorage.getItem(key)).toBeNull();
  });

  it('only loads configuration until the user explicitly tests a connection', async () => {
    await setup([stdio, http]);
    expect(screen.getByText('FIXTURE_TOKEN')).toBeInTheDocument();
    expect(screen.getByText(/executing a tool still requires approval/i)).toBeInTheDocument();
    expect(apiFetch).toHaveBeenCalledTimes(1);
    expect(apiFetch.mock.calls[0][0]).toBe('/api/agent/mcp');
  });

  it('preserves redacted secrets on both edited and untouched servers', async () => {
    await setup([stdio, http]);
    edit('Local tools');
    fireEvent.change(screen.getByLabelText('Server name'), { target: { value: 'Renamed tools' } });
    apiFetch.mockResolvedValueOnce(response({ servers: [{ ...stdio, name: 'Renamed tools' }, http] }));
    save();
    await screen.findByRole('article', { name: 'Renamed tools' });
    const request = apiFetch.mock.calls[1][1];
    expect(request).toMatchObject({ method: 'PUT', body: { servers: [
      { id: 'local-tools', name: 'Renamed tools', enabled: true, timeoutSeconds: 30,
        transport: { type: 'stdio', command: '/opt/fixture/server', args: ['--stdio'] } },
      { id: 'remote-tools', name: 'Remote tools', enabled: false, timeoutSeconds: 15,
        transport: { type: 'http', url: 'https://fixture.example.test/mcp' } },
    ] } });
    expect(request.body.servers[0].transport).not.toHaveProperty('env');
    expect(request.body.servers[1].transport).not.toHaveProperty('bearerToken');
    expect(request.body.servers[1].transport).not.toHaveProperty('clearBearerToken');
  });

  it('adds an explicitly configured stdio server and environment without invoking it', async () => {
    await setup();
    fireEvent.click(screen.getByRole('button', { name: 'Add MCP server' }));
    fireEvent.change(screen.getByLabelText('Server ID'), { target: { value: 'fixture' } });
    fireEvent.change(screen.getByLabelText('Server name'), { target: { value: 'Fixture server' } });
    fireEvent.change(screen.getByLabelText('Executable path'), { target: { value: '/opt/fixture/server' } });
    fireEvent.change(screen.getByLabelText('Arguments (JSON array)'), { target: { value: '["--stdio", "argument with spaces"]' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add environment variable' }));
    fireEvent.change(screen.getByLabelText('Variable name 1'), { target: { value: 'FIXTURE_TOKEN' } });
    fireEvent.change(screen.getByLabelText('Variable value 1'), { target: { value: 'synthetic-secret' } });
    apiFetch.mockResolvedValueOnce(response({ servers: [{ ...stdio, id: 'fixture', name: 'Fixture server', enabled: false }] }));
    save();
    await screen.findByRole('article', { name: 'Fixture server' });
    expect(apiFetch.mock.calls[1][1].body.servers).toEqual([{
      id: 'fixture', name: 'Fixture server', enabled: false, timeoutSeconds: 30,
      transport: { type: 'stdio', command: '/opt/fixture/server', args: ['--stdio', 'argument with spaces'], env: { FIXTURE_TOKEN: 'synthetic-secret' } },
    }]);
    expect(apiFetch.mock.calls.some(([, options]) => options?.method === 'POST')).toBe(false);
    expect(screen.queryByDisplayValue('synthetic-secret')).not.toBeInTheDocument();
  });

  it('requires an explicit choice for stored environment variables when a target changes', async () => {
    await setup([stdio]);
    edit('Local tools');
    fireEvent.change(screen.getByLabelText('Executable path'), { target: { value: '/opt/fixture/another-server' } });
    save();
    expect(await screen.findByRole('alert')).toHaveTextContent(/choose.*environment/i);
    expect(apiFetch).toHaveBeenCalledTimes(1);
    fireEvent.change(screen.getByLabelText('Environment variables'), { target: { value: 'clear' } });
    apiFetch.mockResolvedValueOnce(response({ servers: [{ ...stdio, transport: { ...stdio.transport, command: '/opt/fixture/another-server', envKeys: [] } }] }));
    save();
    await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(2));
    expect(apiFetch.mock.calls[1][1].body.servers[0].transport.env).toEqual({});
  });

  it('preserves stored HTTP tokens until explicitly replaced or removed', async () => {
    await setup([http]);
    edit('Remote tools');
    expect(screen.getByLabelText('Bearer token')).toHaveValue('');
    fireEvent.click(screen.getByLabelText('Remove stored bearer token'));
    apiFetch.mockResolvedValueOnce(response({ servers: [{ ...http, transport: { ...http.transport, bearerTokenSet: false } }] }));
    save();
    await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(2));
    expect(apiFetch.mock.calls[1][1].body.servers[0].transport).toEqual({
      type: 'http', url: 'https://fixture.example.test/mcp', clearBearerToken: true,
    });
  });

  it.each(['http://public.example.test/mcp', 'http://localhost:3000/mcp', 'https://fixture.example.test/mcp?token=secret', 'https://user:secret@fixture.example.test/mcp'])('rejects an unsafe HTTP endpoint %s before saving', async (url) => {
    await setup([http]);
    edit('Remote tools');
    fireEvent.change(screen.getByLabelText('MCP URL'), { target: { value: url } });
    save();
    expect(await screen.findByRole('alert')).toHaveTextContent(/https|loopback|query|credentials/i);
    expect(apiFetch).toHaveBeenCalledTimes(1);
  });

  it('enables and removes a server only after explicit user actions', async () => {
    await setup([http]);
    apiFetch.mockResolvedValueOnce(response({ servers: [{ ...http, enabled: true }] }));
    fireEvent.click(within(serverCard('Remote tools')).getByRole('checkbox', { name: 'Enable Remote tools' }));
    await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(2));
    expect(apiFetch.mock.calls[1][1].body.servers[0]).toMatchObject({ id: 'remote-tools', enabled: true });
    fireEvent.click(within(serverCard('Remote tools')).getByRole('button', { name: 'Remove' }));
    expect(screen.getByRole('button', { name: 'Confirm removal' })).toBeInTheDocument();
    apiFetch.mockResolvedValueOnce(response({ servers: [] }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm removal' }));
    await screen.findByText('No MCP servers configured.');
    expect(apiFetch.mock.calls[2][1].body).toEqual({ servers: [] });
  });

  it('displays a negotiated connection result and tools after an explicit probe', async () => {
    await setup([http]);
    queueProbe({ server: { id: http.id, name: http.name }, protocolVersion: '2025-06-18', serverInfo: { name: 'Synthetic MCP', version: '1.0' }, tools: [{ name: 'fixture_read', description: 'Reads a synthetic fixture', inputSchema: { type: 'object' } }] });
    fireEvent.click(within(serverCard('Remote tools')).getByRole('button', { name: 'Test connection' }));
    await screen.findByText('fixture_read');
    expect(screen.getByText(/Synthetic MCP/)).toBeInTheDocument();
    expect(apiFetch.mock.calls[1]).toEqual(['/api/agent/mcp/remote-tools/probe', expect.objectContaining({ method: 'POST', body: { background: true, probeId: expect.any(String) }, signal: expect.any(AbortSignal) })]);
  });

  it('shows resource, template, and prompt metadata without reading resources or calling tools', async () => {
    await setup([http]);
    queueProbe({ serverInfo: { name: 'Synthetic MCP' }, tools: [],
      resources: [{ uri: 'fixture://readme', name: 'Fixture README', description: 'Synthetic resource' }],
      resourceTemplates: [{ uriTemplate: 'fixture://files/{path}', name: 'Fixture file template' }],
      prompts: [{ name: 'fixture_review', description: 'Synthetic prompt', arguments: [{ name: 'path', required: true }] }],
    });
    fireEvent.click(within(serverCard('Remote tools')).getByRole('button', { name: 'Test connection' }));
    expect(await screen.findByText('Fixture README')).toBeInTheDocument();
    expect(screen.getByText('fixture://readme')).toBeInTheDocument();
    expect(screen.getByText('Fixture file template')).toBeInTheDocument();
    expect(screen.getByText('fixture://files/{path}')).toBeInTheDocument();
    expect(screen.getByText('fixture_review')).toBeInTheDocument();
    expect(screen.getByText('path (required)')).toBeInTheDocument();
    expect(apiFetch).toHaveBeenCalledTimes(3);
    expect(screen.queryByRole('link', { name: 'Fixture README' })).not.toBeInTheDocument();
  });

  it('cancels a pending probe and ignores its late result', async () => {
    await setup([stdio]);
    let finish;
    apiFetch.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    fireEvent.click(within(serverCard('Local tools')).getByRole('button', { name: 'Test connection' }));
    const signal = apiFetch.mock.calls[1][1].signal;
    apiFetch.mockImplementationOnce(async () => response({ probeId: apiFetch.mock.calls[1][1].body.probeId, status: 'cancelled', cleanupConfirmed: true }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel connection test' }));
    expect(signal.aborted).toBe(true);
    expect(apiFetch.mock.calls[2]).toEqual([expect.stringMatching(/\/api\/agent\/mcp\/local-tools\/probes\/[a-f0-9-]+$/), expect.objectContaining({ method: 'DELETE' })]);
    await act(async () => finish(response({ serverInfo: { name: 'Late result' }, tools: [] })));
    expect(screen.queryByText(/Late result/)).not.toBeInTheDocument();
    expect(await screen.findByRole('status')).toHaveTextContent(/cancelled/i);
  });

  it('waits for the server cleanup acknowledgement before reporting a cancelled test', async () => {
    await setup([stdio]);
    apiFetch.mockImplementationOnce(() => new Promise(() => {}));
    fireEvent.click(within(serverCard('Local tools')).getByRole('button', { name: 'Test connection' }));
    let acknowledge;
    apiFetch.mockImplementationOnce(() => new Promise((resolve) => { acknowledge = resolve; }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel connection test' }));
    expect(screen.getByRole('button', { name: 'Cancelling…' })).toBeDisabled();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    await act(async () => acknowledge(response({ probeId: apiFetch.mock.calls[1][1].body.probeId, status: 'cancelled', cleanupConfirmed: true })));
    expect(await screen.findByRole('status')).toHaveTextContent('Connection test cancelled.');
  });

  it.each(['poll', 'cancel'])('repair t4 retains exact probe identity after a 200 failed cleanup receipt via %s', async (mode) => {
    await setup([stdio]);
    let probeId;
    apiFetch.mockImplementationOnce(async (_url, options) => {
      probeId = options.body.probeId;
      return mode === 'poll' ? response({ probeId, status: 'running', cleanupConfirmed: false }) : new Promise(() => {});
    });
    if (mode === 'poll') apiFetch.mockImplementationOnce(async () => response({ probeId, status: 'failed', cleanupConfirmed: false, error: 'Synthetic DELETE rejected' }));
    fireEvent.click(within(serverCard('Local tools')).getByRole('button', { name: 'Test connection' }));
    if (mode === 'cancel') {
      apiFetch.mockImplementationOnce(async () => response({ probeId, status: 'failed', cleanupConfirmed: false, error: 'Synthetic DELETE rejected' }));
      fireEvent.click(screen.getByRole('button', { name: 'Cancel connection test' }));
    }
    expect(await screen.findByRole('button', { name: 'Retry cancellation' })).toBeEnabled();
    expect(within(serverCard('Local tools')).getByRole('button', { name: 'Test connection' })).toBeDisabled();
    expect(screen.getByRole('alert')).toHaveTextContent(/cleanup/i);
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    apiFetch.mockImplementationOnce(async () => response({ probeId, status: 'failed', cleanupConfirmed: false, error: 'Still rejected' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Retry cancellation' }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Still rejected'));
    expect(apiFetch.mock.lastCall[0]).toBe(`/api/agent/mcp/local-tools/probes/${probeId}`);
    expect(within(serverCard('Local tools')).getByRole('button', { name: 'Test connection' })).toBeDisabled();
    apiFetch.mockImplementationOnce(async () => response({ probeId, status: 'cancelled', cleanupConfirmed: true }));
    fireEvent.click(screen.getByRole('button', { name: 'Retry cancellation' }));
    expect(await screen.findByRole('status')).toHaveTextContent('Connection test cancelled.');
    expect(apiFetch.mock.lastCall[0]).toBe(`/api/agent/mcp/local-tools/probes/${probeId}`);
    expect(within(serverCard('Local tools')).getByRole('button', { name: 'Test connection' })).toBeEnabled();
  });

  it.each(['different identifier', 'missing cleanup state', 'invalid status'])('repair t4 keeps cancellation retryable after a receipt with %s', async (kind) => {
    await setup([stdio]);
    apiFetch.mockImplementationOnce(() => new Promise(() => {}));
    fireEvent.click(within(serverCard('Local tools')).getByRole('button', { name: 'Test connection' }));
    const probeId = apiFetch.mock.calls[1][1].body.probeId;
    const receipt = { probeId, status: 'cancelled', cleanupConfirmed: true };
    if (kind === 'different identifier') receipt.probeId = 'synthetic-foreign-id';
    if (kind === 'missing cleanup state') delete receipt.cleanupConfirmed;
    if (kind === 'invalid status') receipt.status = 'unknown';
    apiFetch.mockResolvedValueOnce(response(receipt));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel connection test' }));
    expect(await screen.findByRole('button', { name: 'Retry cancellation' })).toBeEnabled();
    expect(within(serverCard('Local tools')).getByRole('button', { name: 'Test connection' })).toBeDisabled();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    apiFetch.mockResolvedValueOnce(response({ probeId, status: 'cancelled', cleanupConfirmed: true }));
    fireEvent.click(screen.getByRole('button', { name: 'Retry cancellation' }));
    expect(await screen.findByRole('status')).toHaveTextContent('Connection test cancelled.');
    expect(apiFetch.mock.lastCall[0]).toBe(`/api/agent/mcp/local-tools/probes/${probeId}`);
  });

  it('repair t4 releases an ordinary probe failure only after confirmed cleanup', async () => {
    await setup([http]);
    let probeId;
    apiFetch.mockImplementationOnce(async (_url, options) => { probeId = options.body.probeId; return response({ probeId, status: 'running', cleanupConfirmed: false }); });
    apiFetch.mockImplementationOnce(async () => response({ probeId, status: 'failed', cleanupConfirmed: true, error: 'Synthetic discovery failure' }));
    fireEvent.click(within(serverCard('Remote tools')).getByRole('button', { name: 'Test connection' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Synthetic discovery failure');
    expect(within(serverCard('Remote tools')).getByRole('button', { name: 'Test connection' })).toBeEnabled();
    expect(apiFetch).toHaveBeenCalledTimes(3);
  });

  it('keeps a failed cleanup actionable until cancellation is acknowledged', async () => {
    await setup([stdio]);
    apiFetch.mockImplementationOnce(() => new Promise(() => {}));
    fireEvent.click(within(serverCard('Local tools')).getByRole('button', { name: 'Test connection' }));
    apiFetch.mockResolvedValueOnce(response({ error: 'Synthetic cancel failure' }, false));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel connection test' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/cleanup.*Synthetic cancel failure/i);
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(within(serverCard('Local tools')).getByRole('button', { name: 'Test connection' })).toBeDisabled();
    apiFetch.mockImplementationOnce(async () => response({ probeId: apiFetch.mock.calls[1][1].body.probeId, status: 'cancelled', cleanupConfirmed: true }));
    fireEvent.click(screen.getByRole('button', { name: 'Retry cancellation' }));
    expect(await screen.findByRole('status')).toHaveTextContent(/cancelled/i);
    expect(within(serverCard('Local tools')).getByRole('button', { name: 'Test connection' })).toBeEnabled();
  });

  it('requests server-side cleanup if the panel closes during a probe', async () => {
    apiFetch.mockResolvedValueOnce(response({ servers: [stdio] }));
    const view = render(<McpSettingsPanel />);
    await screen.findByRole('article', { name: 'Local tools' });
    apiFetch.mockImplementationOnce(() => new Promise(() => {}));
    fireEvent.click(within(serverCard('Local tools')).getByRole('button', { name: 'Test connection' }));
    apiFetch.mockImplementationOnce(async () => response({ probeId: apiFetch.mock.calls[1][1].body.probeId, status: 'cancelled', cleanupConfirmed: true }));
    view.unmount();
    expect(apiFetch.mock.calls[1][1].signal.aborted).toBe(true);
    expect(apiFetch.mock.calls[2]).toEqual([expect.stringMatching(/\/probes\/[a-f0-9-]+$/), expect.objectContaining({ method: 'DELETE', keepalive: true })]);
  });

  it('polls an active background job until its negotiated result is complete', async () => {
    await setup([http]);
    let probeId;
    apiFetch.mockImplementationOnce(async (_url, options) => { probeId = options.body.probeId; return response({ probeId, status: 'running', cleanupConfirmed: false }); });
    apiFetch.mockImplementationOnce(async () => response({ probeId, status: 'running', cleanupConfirmed: false }));
    apiFetch.mockImplementationOnce(async () => response({ probeId, status: 'completed', cleanupConfirmed: true, result: { serverInfo: { name: 'Polled fixture' }, tools: [] } }));
    fireEvent.click(within(serverCard('Remote tools')).getByRole('button', { name: 'Test connection' }));
    await screen.findByText('Connected: Polled fixture');
    expect(apiFetch).toHaveBeenCalledTimes(4);
    expect(apiFetch.mock.calls[2][0]).toBe(`/api/agent/mcp/remote-tools/probes/${probeId}`);
    expect(apiFetch.mock.calls[3][0]).toBe(`/api/agent/mcp/remote-tools/probes/${probeId}`);
  });

  it('keeps an edited draft available after a failed save', async () => {
    await setup([http]);
    edit('Remote tools');
    fireEvent.change(screen.getByLabelText('Server name'), { target: { value: 'Draft tools' } });
    apiFetch.mockResolvedValueOnce(response({ error: 'Synthetic save failure' }, false));
    save();
    expect(await screen.findByRole('alert')).toHaveTextContent('Synthetic save failure');
    expect(screen.getByLabelText('Server name')).toHaveValue('Draft tools');
    expect(screen.getByRole('button', { name: 'Save server' })).toBeEnabled();
  });

  it('does not let a failed initial load overwrite an unknown configuration', async () => {
    apiFetch.mockResolvedValueOnce(response({ error: 'Synthetic load failure' }, false));
    render(<McpSettingsPanel />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Synthetic load failure');
    expect(screen.queryByRole('button', { name: 'Add MCP server' })).not.toBeInTheDocument();
    apiFetch.mockResolvedValueOnce(response({ servers: [http] }));
    fireEvent.click(screen.getByRole('button', { name: 'Retry loading MCP settings' }));
    await screen.findByRole('article', { name: 'Remote tools' });
    expect(apiFetch.mock.calls.every(([, options]) => !options.method)).toBe(true);
  });

  it('blocks forwarding a stored HTTP token to a changed URL without an explicit token choice', async () => {
    await setup([http]);
    edit('Remote tools');
    fireEvent.change(screen.getByLabelText('MCP URL'), { target: { value: 'http://127.0.0.1:3456/mcp' } });
    save();
    expect(await screen.findByRole('alert')).toHaveTextContent(/replacement bearer token|remove stored bearer token/i);
    expect(apiFetch).toHaveBeenCalledTimes(1);
    fireEvent.change(screen.getByLabelText('Bearer token'), { target: { value: 'replacement-fixture-token' } });
    apiFetch.mockResolvedValueOnce(response({ servers: [{ ...http, transport: { ...http.transport, url: 'http://127.0.0.1:3456/mcp' } }] }));
    save();
    await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(2));
    expect(apiFetch.mock.calls[1][1].body.servers[0].transport).toEqual({ type: 'http', url: 'http://127.0.0.1:3456/mcp', bearerToken: 'replacement-fixture-token' });
  });

  it('keeps an actionable connection error and allows retry', async () => {
    await setup([stdio]);
    apiFetch.mockResolvedValueOnce(response({ error: 'Synthetic handshake rejected' }, false));
    apiFetch.mockImplementationOnce(async () => response({ probeId: apiFetch.mock.calls[1][1].body.probeId, status: 'cancelled', cleanupConfirmed: true }));
    fireEvent.click(within(serverCard('Local tools')).getByRole('button', { name: 'Test connection' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Connection to Local tools failed: Synthetic handshake rejected');
    expect(within(serverCard('Local tools')).getByRole('button', { name: 'Test connection' })).toBeEnabled();
  });

  it.each([
    ['Server ID', 'contains spaces', /server ID/i],
    ['Server name', '', /server name/i],
    ['Executable path', 'relative/server', /absolute path/i],
    ['Arguments (JSON array)', '[1]', /arguments.*string/i],
    ['Arguments (JSON array)', '{"arg":"value"}', /arguments/i],
    ['Connection timeout (seconds)', '0', /between 1 and 120/i],
  ])('validates %s before changing saved configuration', async (label, value, expected) => {
    await setup();
    fireEvent.click(screen.getByRole('button', { name: 'Add MCP server' }));
    fireEvent.change(screen.getByLabelText('Server ID'), { target: { value: 'fixture' } });
    fireEvent.change(screen.getByLabelText('Server name'), { target: { value: 'Fixture' } });
    fireEvent.change(screen.getByLabelText('Executable path'), { target: { value: '/opt/fixture/server' } });
    fireEvent.change(screen.getByLabelText(label), { target: { value } });
    save();
    expect(await screen.findByRole('alert')).toHaveTextContent(expected);
    expect(apiFetch).toHaveBeenCalledTimes(1);
  });

  it('bounds each server configuration before sending any credentials', async () => {
    await setup();
    fireEvent.click(screen.getByRole('button', { name: 'Add MCP server' }));
    fireEvent.change(screen.getByLabelText('Server ID'), { target: { value: 'fixture' } });
    fireEvent.change(screen.getByLabelText('Server name'), { target: { value: 'Fixture' } });
    fireEvent.change(screen.getByLabelText('Executable path'), { target: { value: '/opt/fixture/server' } });
    for (let index = 1; index <= 4; index += 1) {
      fireEvent.click(screen.getByRole('button', { name: 'Add environment variable' }));
      fireEvent.change(screen.getByLabelText(`Variable name ${index}`), { target: { value: `FIXTURE_${index}` } });
      fireEvent.change(screen.getByLabelText(`Variable value ${index}`), { target: { value: 'x'.repeat(16384) } });
    }
    save();
    expect(await screen.findByRole('alert')).toHaveTextContent('Each MCP server configuration must be at most 64 KiB.');
    expect(apiFetch).toHaveBeenCalledTimes(1);
  });

  it('opens a declared MCP app only after the user clicks its enabled server tool', async () => {
    await setup([stdio]);
    queueProbe({ serverInfo: { name: 'Synthetic MCP' }, tools: [{ name: 'fixture_app', inputSchema: { type: 'object' }, _meta: { ui: { resourceUri: 'ui://fixture/app' } } }] });
    fireEvent.click(within(serverCard('Local tools')).getByRole('button', { name: 'Test connection' }));
    const open = await screen.findByRole('button', { name: 'Open app for fixture_app' });
    expect(screen.queryByText('Opened app fixture_app')).not.toBeInTheDocument();
    fireEvent.click(open);
    expect(screen.getByText('Opened app fixture_app')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Close synthetic app' }));
    expect(screen.queryByText('Opened app fixture_app')).not.toBeInTheDocument();
  });

  it('aborts requests when the settings panel closes', async () => {
    apiFetch.mockImplementation(() => new Promise(() => {}));
    const view = render(<McpSettingsPanel />);
    const signal = apiFetch.mock.calls[0][1].signal;
    view.unmount();
    expect(signal.aborted).toBe(true);
  });
  it('adopts a saved new server after cleanup503 and retries only its redacted committed config', async () => {
    await setup();
    fireEvent.click(screen.getByRole('button', { name: 'Add MCP server' }));
    fireEvent.change(screen.getByLabelText('Server ID'), { target: { value: 'fixture' } });
    fireEvent.change(screen.getByLabelText('Server name'), { target: { value: 'Fixture saved' } });
    fireEvent.change(screen.getByLabelText('Executable path'), { target: { value: '/opt/fixture/server' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add environment variable' }));
    fireEvent.change(screen.getByLabelText('Variable name 1'), { target: { value: 'FIXTURE_TOKEN' } });
    fireEvent.change(screen.getByLabelText('Variable value 1'), { target: { value: 'synthetic-new-secret' } });
    const committed = { ...stdio, id: 'fixture', name: 'Fixture saved', enabled: false, transport: { ...stdio.transport, args: [] } };
    apiFetch.mockResolvedValueOnce({ status: 503, ...response({ error: 'Synthetic process cleanup failed', settingsSaved: true, cleanupConfirmed: false, config: { servers: [committed] } }, false) });
    save();
    expect(await screen.findByRole('article', { name: 'Fixture saved' })).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent(/settings.*saved.*cleanup.*unconfirmed/i);
    expect(screen.queryByRole('form', { name: 'Add MCP server' })).not.toBeInTheDocument();
    expect(screen.queryByDisplayValue('synthetic-new-secret')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add MCP server' })).toBeDisabled();
    expect(within(serverCard('Fixture saved')).getByRole('button', { name: 'Test connection' })).toBeDisabled();
    apiFetch.mockResolvedValueOnce(response({ servers: [committed] }));
    fireEvent.click(screen.getByRole('button', { name: 'Retry MCP cleanup' }));
    await screen.findByText('MCP settings saved.');
    expect(apiFetch.mock.calls[2][1].body).toEqual({ servers: [{
      id: 'fixture', name: 'Fixture saved', enabled: false, timeoutSeconds: 30,
      transport: { type: 'stdio', command: '/opt/fixture/server', args: [] },
    }] });
    expect(screen.getAllByRole('article')).toHaveLength(1);
    expect(screen.queryByRole('button', { name: 'Retry MCP cleanup' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add MCP server' })).toBeEnabled();
  });

  it('keeps a committed removal visible through repeated cleanup failures without restoring the server', async () => {
    await setup([http]);
    fireEvent.click(within(serverCard('Remote tools')).getByRole('button', { name: 'Remove' }));
    const partial = () => ({ status: 503, ...response({ error: 'Synthetic cleanup pending', settingsSaved: true, cleanupConfirmed: false, config: { servers: [] } }, false) });
    apiFetch.mockResolvedValueOnce(partial());
    fireEvent.click(screen.getByRole('button', { name: 'Confirm removal' }));
    await screen.findByText('No MCP servers configured.');
    expect(screen.queryByRole('article')).not.toBeInTheDocument();
    apiFetch.mockResolvedValueOnce(partial());
    fireEvent.click(screen.getByRole('button', { name: 'Retry MCP cleanup' }));
    await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(3));
    expect(screen.getByRole('alert')).toHaveTextContent(/cleanup.*unconfirmed/i);
    expect(apiFetch.mock.calls[2][1].body).toEqual({ servers: [] });
    apiFetch.mockResolvedValueOnce(response({ servers: [] }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Retry MCP cleanup' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Retry MCP cleanup' }));
    await screen.findByText('MCP settings saved.');
    expect(apiFetch.mock.calls[3][1].body).toEqual({ servers: [] });
  });

  it('shows committed enablement state after cleanup503 and preserves the stored HTTP token on retry', async () => {
    await setup([{ ...http, enabled: true }]);
    const committed = { ...http, enabled: false };
    apiFetch.mockResolvedValueOnce({ status: 503, ...response({ error: 'Synthetic integration cleanup failed', settingsSaved: true, cleanupConfirmed: false, config: { servers: [committed] } }, false) });
    fireEvent.click(within(serverCard('Remote tools')).getByRole('checkbox', { name: 'Enable Remote tools' }));
    await screen.findByRole('button', { name: 'Retry MCP cleanup' });
    expect(screen.getByRole('checkbox', { name: 'Enable Remote tools' })).not.toBeChecked();
    expect(screen.getByText('Bearer token: stored; value hidden.')).toBeInTheDocument();
    apiFetch.mockResolvedValueOnce(response({ servers: [committed] }));
    fireEvent.click(screen.getByRole('button', { name: 'Retry MCP cleanup' }));
    await screen.findByText('MCP settings saved.');
    expect(apiFetch.mock.calls[2][1].body.servers[0].transport).toEqual({ type: 'http', url: http.transport.url });
  });
  it('retains the saved-state explanation if a cleanup retry loses its response', async () => {
    await setup([http]);
    const committed = { ...http, enabled: true };
    apiFetch.mockResolvedValueOnce({ status: 503, ...response({ error: 'Synthetic cleanup pending', settingsSaved: true, cleanupConfirmed: false, config: { servers: [committed] } }, false) });
    fireEvent.click(within(serverCard('Remote tools')).getByRole('checkbox', { name: 'Enable Remote tools' }));
    await screen.findByRole('button', { name: 'Retry MCP cleanup' });
    apiFetch.mockRejectedValueOnce(new Error('Synthetic connection lost'));
    fireEvent.click(screen.getByRole('button', { name: 'Retry MCP cleanup' }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/settings.*saved.*cleanup.*unconfirmed.*Synthetic connection lost/i));
    expect(screen.getByRole('checkbox', { name: 'Enable Remote tools' })).toBeChecked();
    expect(screen.getByRole('button', { name: 'Retry MCP cleanup' })).toBeEnabled();
    expect(within(serverCard('Remote tools')).getByRole('button', { name: 'Test connection' })).toBeDisabled();
  });
});
