import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import RemoteTunnelsPanel from './RemoteTunnelsPanel';
const apiFetch = vi.hoisted(() => vi.fn());
vi.mock('../utils/api', () => ({ apiFetch }));
const response = data => ({ ok: true, json: async () => data });
afterEach(() => { vi.useRealTimers(); });

it('waits for a slow tunnel read before polling again and preserves the editable port draft', async () => {
  const latencyMs = 6000;
  const pollMs = 5000;
  const host = { id: 'slow-synthetic-host', label: 'Synthetic host', capabilities: { tunnels: true } };
  let tunnelReads = 0;
  const calls = [];
  apiFetch.mockImplementation(url => new Promise(resolve => {
    calls.push(url);
    const localPort = url === '/api/tunnels' && ++tunnelReads === 2 ? 45124 : 45123;
    setTimeout(() => resolve(response(url === '/api/environments'
      ? { environments: [host] }
      : { tunnels: [{ id: 'slow-synthetic-tunnel', environmentId: host.id, localPort, targetPort: 3000 }] })), latencyMs);
  }));
  vi.useFakeTimers();
  await act(async () => { render(<RemoteTunnelsPanel />); });
  fireEvent.change(screen.getByLabelText('Remote service port'), { target: { value: '3001' } });
  await act(async () => vi.advanceTimersByTime(pollMs));
  expect(calls).toEqual(['/api/environments', '/api/tunnels']);
  await act(async () => vi.advanceTimersByTime(latencyMs - pollMs));
  expect(screen.getByText('127.0.0.1:45123')).toBeVisible();
  expect(screen.getByRole('button', { name: 'Refresh service tunnels' })).toBeEnabled();
  expect(screen.getByLabelText('Remote service port')).toHaveValue(3001);
  await act(async () => vi.advanceTimersByTime(2 * pollMs - latencyMs));
  await act(async () => vi.advanceTimersByTime(latencyMs));
  expect(screen.getByText('127.0.0.1:45124')).toBeVisible();
  expect(screen.getByRole('button', { name: 'Refresh service tunnels' })).toBeEnabled();
  expect(screen.getByLabelText('Remote service port')).toHaveValue(3001);
  expect(calls).toEqual(['/api/environments', '/api/tunnels', '/api/environments', '/api/tunnels']);
});

it('does not restore a stopped tunnel when an older poll completes after the stop refresh', async () => {
  let finishOldPoll;
  let calls = 0;
  const tunnel = { id: 'synthetic-t', environmentId: 'synthetic-host', localPort: 45123, targetPort: 3000 };
  apiFetch.mockImplementation(async (url, options) => {
    if (url === '/api/environments') return response({ environments: [] });
    if (options?.method === 'DELETE') return { ok: true, status: 204 };
    calls += 1;
    if (calls === 2) return new Promise(resolve => { finishOldPoll = resolve; });
    return response({ tunnels: calls === 1 ? [tunnel] : [] });
  });
  vi.useFakeTimers();
  await act(async () => { render(<RemoteTunnelsPanel />); });
  expect(screen.getByText('127.0.0.1:45123')).toBeVisible();
  await act(async () => vi.advanceTimersByTime(5000));
  fireEvent.click(screen.getByRole('button', { name: 'Stop tunnel 45123' }));
  await act(async () => {});
  expect(screen.queryByText('127.0.0.1:45123')).not.toBeInTheDocument();
  await act(async () => finishOldPoll(response({ tunnels: [tunnel] })));
  expect(screen.queryByText('127.0.0.1:45123')).not.toBeInTheDocument();
});

it('distinguishes loading, unavailable and empty eligible devices and disables creation', async () => {
  apiFetch.mockImplementation(async () => { throw new Error('Synthetic tunnels unavailable'); });
  render(<RemoteTunnelsPanel />);
  expect(screen.getByText('Loading service tunnels…')).toBeVisible();
  expect(screen.getByRole('button', { name: 'Start service tunnel' })).toBeDisabled();
  expect(await screen.findByRole('alert')).toHaveTextContent('Synthetic tunnels unavailable');
  expect(screen.queryByText('No active service tunnels.')).not.toBeInTheDocument();
  apiFetch.mockImplementation(async url => response(url === '/api/environments' ? { environments: [] } : { tunnels: [] }));
  fireEvent.click(screen.getByRole('button', { name: 'Refresh service tunnels' }));
  expect(await screen.findByText(/No paired device has Service tunnels permission/)).toBeVisible();
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Start service tunnel' })).toBeDisabled();
});

it('marks retained tunnel rows as unconfirmed after polling fails and clears the warning on refresh', async () => {
  apiFetch.mockImplementation(async url => response(url === '/api/environments' ? { environments: [{ id: 'synthetic-host', capabilities: { tunnels: true } }] } : { tunnels: [] }));
  vi.useFakeTimers();
  await act(async () => { render(<RemoteTunnelsPanel />); });
  apiFetch.mockRejectedValue(new Error('Synthetic poll unavailable'));
  await act(async () => vi.advanceTimersByTime(5000));
  expect(screen.getByRole('alert')).toHaveTextContent(/unconfirmed.*Synthetic poll unavailable/);
  expect(screen.getByRole('button', { name: 'Start service tunnel' })).toBeDisabled();
  apiFetch.mockImplementation(async url => response(url === '/api/environments' ? { environments: [] } : { tunnels: [] }));
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Refresh service tunnels' })));
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
});
