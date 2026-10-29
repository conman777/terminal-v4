import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { McpAppView } from './McpAppView';
import { setTokens, setUser } from '../utils/auth';
const apiFetch = vi.hoisted(() => vi.fn());
vi.mock('../utils/api', () => ({ apiFetch }));
const response = (body, ok = true, status = 200) => ({ ok, status, json: async () => body });
const tool = { name: 'fixture_app', inputSchema: { type: 'object' }, _meta: { ui: { resourceUri: 'ui://fixture/app' } } };
const app = { serverId: 'fixture', serverInfo: { name: 'Synthetic server' }, protocolVersion: '2025-11-25', resourceUri: 'ui://fixture/app', html: '<h1>Synthetic app</h1>', resource: { uri: 'ui://fixture/app', mimeType: 'text/html;profile=mcp-app' }, csp: { connectDomains: ['https://not-contacted.example.test'] }, permissions: { camera: {} }, tools: [tool], expiresAt: Date.now() + 600000 };
let currentId;
const configure = () => apiFetch.mockImplementation(async (path, options = {}) => {
  if (path.endsWith('/apps/open')) { currentId = options.body.sessionId; return response({ ...app, sessionId: currentId }); }
  if (options.method === 'DELETE') return response({ sessionId: currentId, status: 'closed' });
  return response({ sessionId: currentId, status: 'active', expiresAt: app.expiresAt });
});
async function setup() {
  configure();
  const onClose = vi.fn();
  const view = render(<McpAppView serverId="fixture" serverName="Synthetic server" tool={tool} onClose={onClose} />);
  await screen.findByRole('button', { name: 'Run app preview' });
  expect(screen.queryByTitle('MCP app sandbox')).not.toBeInTheDocument();
  expect(screen.getByLabelText('App HTML source')).toHaveValue(app.html);
  expect(screen.getByRole('button', { name: 'Run app preview' })).toBeDisabled();
  fireEvent.click(screen.getByLabelText('I allow this app to use browser network channels V4 cannot block.'));
  fireEvent.click(screen.getByRole('button', { name: 'Run app preview' }));
  const frame = await screen.findByTitle('MCP app sandbox');
  const post = vi.spyOn(frame.contentWindow, 'postMessage');
  const message = async (data, source = frame.contentWindow) => act(async () => window.dispatchEvent(new MessageEvent('message', { source, origin: 'null', data })));
  await message({ jsonrpc: '2.0', method: 'ui/notifications/sandbox-proxy-ready', params: {} });
  return { ...view, onClose, frame, post, message };
}
async function initialize(view) {
  await view.message({ jsonrpc: '2.0', id: 1, method: 'ui/initialize', params: { protocolVersion: '2026-01-26', appInfo: { name: 'Fixture app', version: '1.0' }, appCapabilities: {} } });
  await view.message({ jsonrpc: '2.0', method: 'ui/notifications/initialized', params: {} });
}
beforeEach(() => { apiFetch.mockReset(); currentId = undefined; setTokens('synthetic-access', 'synthetic-refresh'); setUser({ id: 'synthetic-app-owner' }); });

describe('McpAppView', () => {
  it.each(['text/html; profile="mcp-app"; charset=utf-8', 'TEXT/HTML;profile=mcp-app', 'text/html; charset=utf-8; PROFILE = mcp-app', 'TEXT/HTML+MCP'])('opens backend-supported MIME %s for source review', async (mimeType) => {
    apiFetch.mockImplementation(async (path, options = {}) => {
      if (path.endsWith('/apps/open')) { currentId = options.body.sessionId; return response({ ...app, sessionId: currentId, resource: { ...app.resource, mimeType } }); }
      return response({ sessionId: currentId, status: options.method === 'DELETE' ? 'closed' : 'active' });
    });
    render(<McpAppView serverId="fixture" serverName="Synthetic server" tool={tool} onClose={vi.fn()} />);
    expect(await screen.findByRole('button', { name: 'Run app preview' })).toBeDisabled();
    expect(screen.getByLabelText('App HTML source')).toHaveValue(app.html);
    expect(screen.queryByTitle('MCP app sandbox')).not.toBeInTheDocument();
  });

  it('creates an explicitly opened owner session and an isolated proxy without granting requested network or camera access', async () => {
    const view = await setup();
    expect(apiFetch.mock.calls[0]).toEqual(['/api/agent/mcp/fixture/apps/open', expect.objectContaining({ method: 'POST', body: { resourceUri: 'ui://fixture/app', toolName: 'fixture_app', sessionId: expect.any(String) } })]);
    expect(view.frame).toHaveAttribute('sandbox', 'allow-scripts allow-same-origin');
    expect(view.frame.getAttribute('src')).toMatch(/^data:text\/html/);
    expect(view.frame.getAttribute('allow')).toContain("camera 'none'");
    expect(view.post).toHaveBeenCalledWith(expect.objectContaining({ method: 'ui/notifications/sandbox-resource-ready', params: expect.objectContaining({ html: expect.stringContaining("connect-src 'none'") }) }), '*');
    expect(screen.getByText(/WebRTC can bypass CSP in some runtimes/)).toBeInTheDocument();
    expect(document.querySelector('h1')).toBeNull();
  });

  it('requires source-bound initialization and does not expose API credentials in the host context', async () => {
    const view = await setup();
    const count = apiFetch.mock.calls.length;
    await view.message({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'fixture_app', arguments: {} } }, window);
    expect(apiFetch).toHaveBeenCalledTimes(count);
    await initialize(view);
    expect(view.post).toHaveBeenCalledWith(expect.objectContaining({ id: 1, result: expect.objectContaining({ protocolVersion: '2026-01-26', hostInfo: { name: 'V4', version: '0.1.0' }, hostCapabilities: expect.objectContaining({ serverTools: {}, serverResources: {} }) }) }), '*');
    expect(JSON.stringify(view.post.mock.calls)).not.toContain('terminal_access_token');
    expect(await screen.findByText('App connected.')).toBeInTheDocument();
  });

  it('shows exact app tool arguments and executes only after a separate explicit approval', async () => {
    const view = await setup(); await initialize(view);
    apiFetch.mockResolvedValueOnce(response({ requestId: 'request-fixture', status: 'pending', method: 'tools/call', params: { name: 'fixture_app', arguments: { path: 'synthetic.txt' } } }));
    await view.message({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'fixture_app', arguments: { path: 'synthetic.txt' } } });
    expect(await screen.findByText('tools/call')).toBeInTheDocument();
    expect(screen.getByText(/"path": "synthetic.txt"/)).toBeInTheDocument();
    expect(apiFetch.mock.calls.filter(([path]) => path.endsWith('/decision'))).toHaveLength(0);
    apiFetch.mockResolvedValueOnce(response({ requestId: 'request-fixture', status: 'completed', result: { content: [{ type: 'text', text: 'Synthetic approved result' }] } }));
    fireEvent.click(screen.getByRole('button', { name: 'Approve request' }));
    await waitFor(() => expect(view.post).toHaveBeenCalledWith({ jsonrpc: '2.0', id: 2, result: { content: [{ type: 'text', text: 'Synthetic approved result' }] } }, '*'));
    expect(apiFetch.mock.calls.at(-1)).toEqual([`/api/agent/mcp/apps/${currentId}/requests/request-fixture/decision`, expect.objectContaining({ method: 'POST', body: { approved: true } })]);
  });

  it('returns a denial to the app without executing the request', async () => {
    const view = await setup(); await initialize(view);
    apiFetch.mockResolvedValueOnce(response({ requestId: 'denied-fixture', status: 'pending', method: 'resources/read', params: { uri: 'fixture://readme' } }));
    await view.message({ jsonrpc: '2.0', id: 4, method: 'resources/read', params: { uri: 'fixture://readme' } });
    await screen.findByRole('button', { name: 'Deny request' });
    apiFetch.mockResolvedValueOnce(response({ requestId: 'denied-fixture', status: 'denied' }));
    fireEvent.click(screen.getByRole('button', { name: 'Deny request' }));
    await waitFor(() => expect(view.post).toHaveBeenCalledWith(expect.objectContaining({ id: 4, error: expect.objectContaining({ message: 'Request denied by user.' }) }), '*'));
    expect(apiFetch.mock.calls.at(-1)[1].body).toEqual({ approved: false });
  });

  it('rejects unadvertised host operations instead of sending conversation messages or sampling requests', async () => {
    const view = await setup(); await initialize(view);
    const count = apiFetch.mock.calls.length;
    await view.message({ jsonrpc: '2.0', id: 8, method: 'ui/message', params: { role: 'user', content: [{ type: 'text', text: 'Do not send this' }] } });
    expect(apiFetch).toHaveBeenCalledTimes(count);
    expect(view.post).toHaveBeenCalledWith(expect.objectContaining({ id: 8, error: expect.objectContaining({ code: -32601 }) }), '*');
  });

  it('shows external link requests for explicit user action and rejects privileged URLs', async () => {
    const view = await setup(); await initialize(view);
    await view.message({ jsonrpc: '2.0', id: 9, method: 'ui/open-link', params: { url: 'https://fixture.example.test/docs' } });
    const link = await screen.findByRole('link', { name: 'Open requested link' });
    expect(link).toHaveAttribute('href', 'https://fixture.example.test/docs');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    expect(link).toHaveAttribute('target', '_blank');
    await view.message({ jsonrpc: '2.0', id: 10, method: 'ui/open-link', params: { url: 'javascript:alert(1)' } });
    expect(view.post).toHaveBeenCalledWith(expect.objectContaining({ id: 10, error: expect.objectContaining({ message: 'Invalid link URL.' }) }), '*');
    expect(apiFetch.mock.calls.filter(([path]) => path.endsWith('/requests'))).toHaveLength(0);
  });

  it('checks an uncertain result without repeating a possibly executed decision', async () => {
    const view = await setup(); await initialize(view);
    apiFetch.mockResolvedValueOnce(response({ requestId: 'uncertain-fixture', status: 'pending', method: 'tools/call', params: { name: 'fixture_app', arguments: {} } }));
    await view.message({ jsonrpc: '2.0', id: 12, method: 'tools/call', params: { name: 'fixture_app', arguments: {} } });
    await screen.findByRole('button', { name: 'Approve request' });
    apiFetch.mockRejectedValueOnce(new Error('Synthetic connection lost'));
    fireEvent.click(screen.getByRole('button', { name: 'Approve request' }));
    await screen.findByRole('button', { name: 'Check request result' });
    apiFetch.mockResolvedValueOnce(response({ requestId: 'uncertain-fixture', status: 'completed', result: { content: [{ type: 'text', text: 'Already executed once' }] } }));
    fireEvent.click(screen.getByRole('button', { name: 'Check request result' }));
    await waitFor(() => expect(view.post).toHaveBeenCalledWith(expect.objectContaining({ id: 12, result: { content: [{ type: 'text', text: 'Already executed once' }] } }), '*'));
    expect(apiFetch.mock.calls.filter(([path]) => path.endsWith('/decision'))).toHaveLength(1);
    expect(apiFetch.mock.calls.at(-1)[0]).toBe(`/api/agent/mcp/apps/${currentId}/requests/uncertain-fixture`);
  });

  it('offers a decision again only after the server confirms no decision was recorded', async () => {
    const view = await setup(); await initialize(view);
    apiFetch.mockResolvedValueOnce(response({ requestId: 'pending-fixture', status: 'pending', method: 'tools/call', params: { name: 'fixture_app', arguments: {} } }));
    await view.message({ jsonrpc: '2.0', id: 13, method: 'tools/call', params: { name: 'fixture_app', arguments: {} } });
    await screen.findByRole('button', { name: 'Approve request' });
    apiFetch.mockRejectedValueOnce(new Error('Synthetic decision never reached server'));
    fireEvent.click(screen.getByRole('button', { name: 'Approve request' }));
    await screen.findByRole('button', { name: 'Check request result' });
    apiFetch.mockResolvedValueOnce(response({ requestId: 'pending-fixture', status: 'pending' }));
    fireEvent.click(screen.getByRole('button', { name: 'Check request result' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Approve request' })).toBeEnabled());
    expect(apiFetch.mock.calls.filter(([path]) => path.endsWith('/decision'))).toHaveLength(1);
  });

  it('closes the backend session when the view unmounts even while opening is pending', async () => {
    apiFetch.mockImplementationOnce((_path, options) => { currentId = options.body.sessionId; return new Promise(() => {}); });
    apiFetch.mockResolvedValueOnce(response({ status: 'closed' }));
    const view = render(<McpAppView serverId="fixture" serverName="Synthetic server" tool={tool} onClose={vi.fn()} />);
    view.unmount();
    expect(apiFetch.mock.calls[0][1].signal.aborted).toBe(true);
    expect(apiFetch.mock.calls[1]).toEqual([`/api/agent/mcp/apps/${currentId}`, expect.objectContaining({ method: 'DELETE', keepalive: true })]);
  });

  it('requests graceful teardown and waits for backend cleanup before closing the host view', async () => {
    const view = await setup(); await initialize(view);
    let acknowledge;
    apiFetch.mockImplementationOnce(() => new Promise((resolve) => { acknowledge = resolve; }));
    fireEvent.click(screen.getByRole('button', { name: 'Close app' }));
    const teardown = view.post.mock.calls.find(([message]) => message.method === 'ui/resource-teardown')[0];
    expect(teardown.params.reason).toBe('User closed the app');
    await view.message({ jsonrpc: '2.0', id: teardown.id, result: {} });
    expect(view.onClose).not.toHaveBeenCalled();
    expect(screen.queryByTitle('MCP app sandbox')).not.toBeInTheDocument();
    await act(async () => acknowledge(response({ sessionId: currentId, status: 'closed' })));
    expect(view.onClose).toHaveBeenCalledTimes(1);
  });

  it('keeps an unsuccessful cleanup visible and retryable after the iframe is removed', async () => {
    const view = await setup();
    apiFetch.mockResolvedValueOnce(response({ error: 'Synthetic cleanup failure' }, false));
    fireEvent.click(screen.getByRole('button', { name: 'Close app' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/cleanup.*Synthetic cleanup failure/);
    expect(screen.queryByTitle('MCP app sandbox')).not.toBeInTheDocument();
    expect(view.onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Close app' })).toBeEnabled();
  });

  it('hides a revoked app as soon as the owner session check reports it closed', async () => {
    const view = await setup(); await initialize(view);
    apiFetch.mockResolvedValueOnce(response({ error: 'Session closed' }, false, 404));
    await waitFor(() => expect(screen.queryByTitle('MCP app sandbox')).not.toBeInTheDocument(), { timeout: 2500 });
    expect(await screen.findByRole('alert')).toHaveTextContent(/no longer active|revoked/i);
  });
});
