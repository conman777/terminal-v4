import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RemoteEnvironmentsPanel, RemoteEnvironmentSwitcher } from './RemoteEnvironmentsPanel';
import { apiFetch } from '../utils/api';
import { getActiveEnvironment, setActiveEnvironment } from '../utils/remoteEnvironments';
vi.mock('../utils/api', () => ({ apiFetch: vi.fn() }));
const remote = { id: 'host-a', label: 'Build host', url: 'https://build.example.test', expiresAt: '2030-01-01T00:00:00Z' };
const reply = data => ({ ok: true, json: async () => data });
beforeEach(() => {
  apiFetch.mockReset();
  setActiveEnvironment(null);
  apiFetch.mockImplementation(async url => reply(url.endsWith('/status') ? { connected: true } : url.endsWith('/pairing-code') ? { code: 'one-time-code', expiresAt: Math.floor(Date.now() / 1000) + 120 } : { environments: [remote], grants: [{ id: 'grant-a', label: 'Laptop' }] }));
});
describe('compact server selector', () => {
  it('opens the same chooser inside a header without a separate server bar', async () => {
    render(<RemoteEnvironmentSwitcher compact />);
    expect(screen.queryByRole('region', { name: 'Active environment' })).not.toBeInTheDocument();
    const trigger = screen.getByRole('button', { name: 'Switch server, This server' });
    fireEvent.click(trigger);
    expect(await screen.findByRole('dialog', { name: 'Switch server' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Close server chooser' }));
    await waitFor(() => expect(trigger).toHaveFocus());
  });
});
describe('RemoteEnvironmentsPanel', () => {
  it('announces a pending device directory without showing a false empty state', async () => {
    let resolveDirectory;
    apiFetch.mockReturnValueOnce(new Promise(resolve => { resolveDirectory = resolve; }));
    render(<RemoteEnvironmentsPanel />);
    expect(screen.getByRole('status')).toHaveTextContent('Checking devices…');
    expect(screen.queryByText('No paired devices yet.')).not.toBeInTheDocument();
    resolveDirectory(reply({ environments: [], grants: [] }));
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('No paired devices yet.'));
  });

  it('reports a directory failure without presenting an unverified empty list', async () => {
    apiFetch.mockRejectedValueOnce(new Error('Synthetic directory unavailable'));
    render(<RemoteEnvironmentsPanel />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Synthetic directory unavailable');
    expect(screen.queryByText('No paired devices yet.')).not.toBeInTheDocument();
  });

  it('switches the actual active environment and returns to the home server', async () => {
    render(<RemoteEnvironmentsPanel />);
    fireEvent.click(await screen.findByRole('button', { name: 'Use Build host' }));
    expect(getActiveEnvironment()).toEqual(remote);
    fireEvent.click(screen.getByRole('button', { name: 'Use this server' }));
    expect(getActiveEnvironment()).toBeNull();
  });
  it('creates an expiring pairing code and revokes incoming access', async () => {
    render(<RemoteEnvironmentsPanel />);
    fireEvent.click(screen.getByRole('button', { name: 'Create pairing code' }));
    expect(await screen.findByText('one-time-code')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Revoke Laptop' }));
    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith('/api/environments/grants/grant-a', { method: 'DELETE' }));
  });
  it('requires explicit consent for insecure HTTP and never puts the pairing code in a URL', async () => {
    render(<RemoteEnvironmentsPanel />);
    fireEvent.change(screen.getByLabelText('Remote server URL'), { target: { value: 'http://192.168.1.15:3020' } });
    fireEvent.change(screen.getByLabelText('Pairing code'), { target: { value: 'secret-code' } });
    fireEvent.click(screen.getByRole('button', { name: 'Pair server' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Allow unencrypted HTTP');
    fireEvent.click(screen.getByLabelText(/Allow unencrypted HTTP/));
    fireEvent.click(screen.getByRole('button', { name: 'Pair server' }));
    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith('/api/environments/connect', { method: 'POST', body: { url: 'http://192.168.1.15:3020', code: 'secret-code', label: '192.168.1.15', allowInsecureHttp: true } }));
  });
});


describe('device address book', () => {
  it('searches aliases, hosts and tags and shows persisted recent workspace', async () => {
    apiFetch.mockImplementation(async url => reply(url.endsWith('/status') ? { connected: true } : { environments: [
      { ...remote, favorite: true, tags: ['build', 'linux'], lastWorkspace: '/projects/service' },
      { id: 'host-b', label: 'Travel laptop', url: 'https://travel.example.test', tags: ['personal'] },
    ], grants: [] }));
    render(<RemoteEnvironmentsPanel />);
    expect(await screen.findByText('Recent workspace: /projects/service')).toBeInTheDocument();
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search devices' }), { target: { value: 'linux' } });
    expect(screen.getByRole('button', { name: 'Use Build host' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Use Travel laptop' })).not.toBeInTheDocument();
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search devices' }), { target: { value: 'no-match' } });
    expect(screen.getByText('No devices match your search.')).toBeInTheDocument();
  });
  it('persists aliases, favorites and tags through the owner API', async () => {
    render(<RemoteEnvironmentsPanel />);
    fireEvent.click(await screen.findByRole('button', { name: 'Edit Build host' }));
    fireEvent.change(screen.getByLabelText('Device alias'), { target: { value: 'Linux builder' } });
    fireEvent.change(screen.getByLabelText('Tags (comma separated)'), { target: { value: 'work, linux, work' } });
    fireEvent.click(screen.getByLabelText('Favorite device'));
    fireEvent.click(screen.getByRole('button', { name: 'Save device' }));
    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith('/api/environments/host-a', expect.objectContaining({ method: 'PATCH', body: { label: 'Linux builder', favorite: true, tags: ['work', 'linux'] } })));
  });
  it('checks live connectivity without treating a failed host as signed out', async () => {
    apiFetch.mockImplementation(async url => reply(url.endsWith('/status') ? { connected: false, error: 'Connection refused' } : { environments: [{ ...remote, lastSeenAt: 1700000000 }], grants: [] }));
    render(<RemoteEnvironmentsPanel />);
    expect(await screen.findByText('Offline')).toBeInTheDocument();
    expect(screen.getByText(/Last seen/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Use Build host' })).toBeEnabled();
  });
  it('creates explicitly scoped custom pairing codes', async () => {
    render(<RemoteEnvironmentsPanel />);
    fireEvent.change(screen.getByLabelText('Access profile'), { target: { value: 'custom' } });
    fireEvent.click(screen.getByLabelText('Terminal input'));
    fireEvent.click(screen.getByLabelText('File changes'));
    fireEvent.click(screen.getByRole('button', { name: 'Create pairing code' }));
    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith('/api/environments/pairing-code', expect.objectContaining({ method: 'POST', body: { label: 'Paired client', profile: 'custom', capabilities: { terminalInput: true, fileWrite: true, agentExecute: false, tunnels: false, desktopView: false, desktopControl: false, transfer: false, recordings: false } } })));
    expect(await screen.findByText('one-time-code')).toBeInTheDocument();
  });
  it('filters favorites and explains the granted access profile', async () => {
    apiFetch.mockImplementation(async url => reply(url.endsWith('/status') ? { connected: true } : { environments: [
      { ...remote, favorite: true, profile: 'observer', capabilities: {} },
      { id: 'host-b', label: 'Travel laptop', url: 'https://travel.example.test' },
    ], grants: [{ id: 'grant-a', label: 'Laptop', profile: 'custom', capabilities: { transfer: true } }] }));
    render(<RemoteEnvironmentsPanel />);
    await screen.findByRole('button', { name: 'Use Travel laptop' });
    fireEvent.click(screen.getByLabelText('Favorites only'));
    expect(screen.getByRole('button', { name: 'Use Build host' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Use Travel laptop' })).not.toBeInTheDocument();
    expect(screen.getByText('Observer: View existing sessions and browse files')).toBeInTheDocument();
    expect(screen.getByText('Custom access: File transfers')).toBeInTheDocument();
  });
  it('keeps the permission selection fixed while creating a code', async () => {
    let resolveCode;
    apiFetch.mockImplementation(async url => url.endsWith('/pairing-code') ? new Promise(resolve => { resolveCode = resolve; }) : reply(url.endsWith('/status') ? { connected: true } : { environments: [], grants: [] }));
    render(<RemoteEnvironmentsPanel />);
    fireEvent.change(screen.getByLabelText('Access profile'), { target: { value: 'custom' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create pairing code' }));
    expect(screen.getByLabelText('Access profile')).toBeDisabled();
    expect(screen.getByLabelText('Terminal input')).toBeDisabled();
    resolveCode(reply({ code: 'fixed-profile-code', expiresAt: Math.floor(Date.now() / 1000) + 120 }));
    expect(await screen.findByText('fixed-profile-code')).toBeInTheDocument();
    expect(screen.getByLabelText('Access profile')).toBeEnabled();
  });
  it('does not publish an initial directory response after a newer refresh', async () => {
    let resolveFirst;
    apiFetch.mockImplementationOnce(() => new Promise(resolve => { resolveFirst = resolve; }));
    render(<RemoteEnvironmentsPanel />);
    fireEvent.click(screen.getByRole('button', { name: 'Refresh devices' }));
    await screen.findByRole('button', { name: 'Use Build host' });
    resolveFirst(reply({ environments: [{ id: 'stale', label: 'Stale host', url: 'https://stale.test' }], grants: [] }));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Use Stale host' })).not.toBeInTheDocument());
  });
});


describe('environment extension accessibility', () => {
  it('includes an extension details summary in its dialog focus trap', async () => {
    render(<RemoteEnvironmentSwitcher><details><summary>Host startup commands</summary><p>Command details</p></details></RemoteEnvironmentSwitcher>);
    fireEvent.click(screen.getByRole('button', { name: 'Switch server, This server' }));
    fireEvent.click(screen.getByRole('button', { name: 'Manage servers' }));
    fireEvent.click(screen.getByRole('button', { name: 'Additional remote tools' }));
    const summary = await screen.findByText('Host startup commands');
    summary.focus();
    fireEvent.keyDown(summary, { key: 'Tab' });
    expect(screen.getByRole('button', { name: 'Back to servers' })).toHaveFocus();
    fireEvent.keyDown(screen.getByRole('button', { name: 'Back to servers' }), { key: 'Tab', shiftKey: true });
    expect(summary).toHaveFocus();
  });
});


describe('server chooser', () => {
  it('opens a focused chooser without pairing, permissions or advanced tools', async () => {
    render(<RemoteEnvironmentSwitcher><p>Advanced fixture tools</p></RemoteEnvironmentSwitcher>);
    fireEvent.click(screen.getByRole('button', { name: 'Switch server, This server' }));
    expect(screen.getByRole('heading', { name: 'Switch server' })).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: 'Use Build host' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Use this server' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.queryByRole('button', { name: 'Create pairing code' })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Remote server URL')).not.toBeInTheDocument();
    expect(screen.queryByText('Advanced fixture tools')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Use Build host' }));
    expect(getActiveEnvironment()).toEqual(remote);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Switch server, Build host' })).toHaveFocus();
  });

  it('keeps management separate and returns to the chooser with Escape', async () => {
    render(<RemoteEnvironmentSwitcher><p>Advanced fixture tools</p></RemoteEnvironmentSwitcher>);
    const trigger = screen.getByRole('button', { name: 'Switch server, This server' });
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole('button', { name: 'Manage servers' }));
    expect(screen.getByRole('heading', { name: 'Manage servers' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create pairing code' })).toBeInTheDocument();
    expect(screen.queryByText('Advanced fixture tools')).not.toBeInTheDocument();
    fireEvent.click(screen.getByText('Additional remote tools'));
    expect(screen.getByText('Advanced fixture tools')).toBeInTheDocument();
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(screen.getByRole('heading', { name: 'Switch server' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Manage servers' })).toHaveFocus();
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
    expect(getActiveEnvironment()).toBeNull();
    expect(apiFetch.mock.calls.every(([, options]) => !options?.method || options.method === 'GET')).toBe(true);
  });

  it('keeps this server usable when the directory fails and allows a read-only retry', async () => {
    apiFetch.mockRejectedValueOnce(new Error('Directory unavailable'));
    render(<RemoteEnvironmentSwitcher />);
    fireEvent.click(screen.getByRole('button', { name: 'Switch server, This server' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Directory unavailable');
    expect(screen.queryByText('No other servers connected.')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Use this server' })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: 'Retry server list' }));
    expect(await screen.findByRole('button', { name: 'Use Build host' })).toBeInTheDocument();
  });
});
