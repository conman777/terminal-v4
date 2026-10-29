import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { McpSettingsPanel } from './McpSettingsPanel';
import { setTokens, setUser } from '../utils/auth';
import { setEnvironmentIdentity } from '../utils/remoteEnvironments';
const apiFetch = vi.hoisted(() => vi.fn());
vi.mock('../utils/api', () => ({ apiFetch }));
const server = { id: 'synthetic-tools', name: 'Synthetic tools', enabled: true, timeoutSeconds: 5, transport: { type: 'stdio', command: '/synthetic/server', args: [] } };
const response = data => ({ ok: true, json: async () => data });
beforeEach(() => { apiFetch.mockReset(); localStorage.clear(); sessionStorage.clear(); setTokens('synthetic', 'synthetic'); setUser({ id: 'synthetic-mcp-activity' }); setEnvironmentIdentity('synthetic-mcp-activity'); });

it('cancels owned connection work when its settings section is hidden', async () => {
  let probeId;
  apiFetch.mockImplementation(async (url, options) => {
    if (options?.method === 'POST') { probeId = options.body.probeId; return response({ probeId, status: 'running', cleanupConfirmed: false }); }
    if (options?.method === 'DELETE') return response({ probeId, status: 'cancelled', cleanupConfirmed: true });
    if (url.includes('/probes/')) return new Promise(() => {});
    return response({ servers: [server] });
  });
  const view = render(<McpSettingsPanel isActive />);
  fireEvent.click(await screen.findByRole('button', { name: 'Test connection' }));
  await waitFor(() => expect(probeId).toEqual(expect.any(String)));
  view.rerender(<McpSettingsPanel isActive={false} />);
  await waitFor(() => expect(apiFetch.mock.calls.filter(([, options]) => options?.method === 'DELETE').map(([url]) => url)).toEqual([`/api/agent/mcp/${server.id}/probes/${probeId}`]));
  expect(await screen.findByText('Connection test cancelled.')).toBeInTheDocument();
});
