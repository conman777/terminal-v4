import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { RemoteEnvironmentSwitcher, RemoteEnvironmentsPanel } from './RemoteEnvironmentsPanel';
import { setActiveEnvironment } from '../utils/remoteEnvironments';
const apiFetch = vi.hoisted(() => vi.fn());
vi.mock('../utils/api', () => ({ apiFetch }));
const host = { id: 'synthetic-a', label: 'Synthetic host', url: 'https://synthetic.test', tags: [], capabilities: {} };
const response = data => ({ ok: true, json: async () => data });
beforeEach(() => { apiFetch.mockReset(); });
afterEach(() => { setActiveEnvironment(null); });

it('refreshes the server chooser after disconnecting a device in management', async () => {
  let hosts = [host];
  apiFetch.mockImplementation(async (url, options) => {
    if (options?.method === 'DELETE') { hosts = []; return { ok: true, status: 204 }; }
    return response(url.endsWith('/status') ? { connected: true } : { environments: hosts, grants: [] });
  });
  render(<RemoteEnvironmentSwitcher />);
  fireEvent.click(screen.getByRole('button', { name: /Switch server/ }));
  await screen.findByRole('button', { name: 'Use Synthetic host' });
  fireEvent.click(screen.getByRole('button', { name: 'Manage servers' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Disconnect Synthetic host' }));
  await waitFor(() => expect(screen.queryByRole('button', { name: 'Disconnect Synthetic host' })).not.toBeInTheDocument());
  fireEvent.click(screen.getByRole('button', { name: 'Back to servers' }));
  expect(await screen.findByText('No other servers connected.')).toBeVisible();
  expect(screen.queryByRole('button', { name: 'Use Synthetic host' })).not.toBeInTheDocument();
});

it('locks device metadata while its submitted draft is being saved', async () => {
  let finish;
  apiFetch.mockImplementation(async (url, options) => {
    if (options?.method === 'PATCH') return new Promise(resolve => { finish = resolve; });
    return response(url.endsWith('/status') ? { connected: true } : { environments: [host], grants: [] });
  });
  render(<RemoteEnvironmentsPanel />);
  fireEvent.click(await screen.findByRole('button', { name: 'Edit Synthetic host' }));
  fireEvent.change(screen.getByLabelText('Device alias'), { target: { value: 'Submitted alias' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save device' }));
  expect(screen.getByLabelText('Device alias')).toBeDisabled();
  expect(screen.getByLabelText('Tags (comma separated)')).toBeDisabled();
  await act(async () => finish(response({})));
});

it('distinguishes chooser empty copy from the management address book copy', async () => {
  apiFetch.mockResolvedValue(response({ environments: [], grants: [] }));
  render(<RemoteEnvironmentSwitcher />);
  fireEvent.click(screen.getByRole('button', { name: /Switch server/ }));
  expect(await screen.findByText('No other servers connected.')).toBeVisible();
  expect(screen.queryByText('No paired devices yet.')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Manage servers' }));
  expect(await screen.findByText('No paired devices yet.')).toBeVisible();
});

it('distinguishes a failed device status check from a confirmed offline result and refreshes it', async () => {
  let attempts = 0;
  apiFetch.mockImplementation(async url => {
    if (url.endsWith('/status')) {
      if (++attempts === 1) throw new Error('Synthetic status unavailable');
      return response({ connected: false });
    }
    return response({ environments: [host], grants: [] });
  });
  render(<RemoteEnvironmentsPanel />);
  expect(await screen.findByText(/Could not check connection/)).toBeVisible();
  expect(screen.queryByText('Offline', { exact: true })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Refresh devices' }));
  expect(await screen.findByText('Offline', { exact: true })).toBeVisible();
});
