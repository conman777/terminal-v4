import { afterEach, describe, expect, it, vi } from 'vitest';
import { StrictMode } from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { startRegistration } from '@simplewebauthn/browser';
import { apiFetch } from '../utils/api';
import PasskeyManager from './PasskeyManager';

vi.mock('../utils/api', () => ({ apiFetch: vi.fn() }));
vi.mock('@simplewebauthn/browser', () => ({ startRegistration: vi.fn(), startAuthentication: vi.fn() }));

const key = { id: 'fixture-known-key', name: 'Synthetic known laptop', createdAt: '2026-10-01T00:00:00Z' };
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const list = keys => Response.json({ credentials: keys });

afterEach(() => { vi.resetAllMocks(); vi.unstubAllGlobals(); });

describe('PasskeyManager', () => {
  it('names the optional passkey field and announces registration cancellation', async () => {
    apiFetch.mockResolvedValueOnce(list([])).mockResolvedValueOnce(Response.json({ publicKey: {} }));
    startRegistration.mockRejectedValueOnce(new DOMException('Synthetic cancellation', 'NotAllowedError'));
    render(<PasskeyManager />);
    await screen.findByText('No passkeys registered yet.');
    expect(screen.getByRole('textbox', { name: 'Passkey name (optional)' })).toHaveAccessibleDescription('Choose a name to recognize this device later.');
    fireEvent.click(screen.getByRole('button', { name: '+ Add Passkey' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Registration was cancelled or timed out');
  });

  it('distinguishes a pending initial read from a verified empty list', async () => {
    const pending = deferred(); apiFetch.mockReturnValueOnce(pending.promise);
    render(<PasskeyManager />);
    expect(screen.getByText('Loading...')).toBeInTheDocument();
    expect(screen.queryByText('No passkeys registered yet.')).not.toBeInTheDocument();
    await act(async () => pending.resolve(list([])));
    expect(screen.getByText('No passkeys registered yet.')).toBeInTheDocument();
  });

  it.each(['server', 'network'])('reports an initial %s failure and retries the list without reopening or registering', async kind => {
    if (kind === 'server') apiFetch.mockResolvedValueOnce(Response.json({ error: 'Synthetic list unavailable' }, { status: 503 }));
    else apiFetch.mockRejectedValueOnce(new TypeError('Synthetic list unavailable'));
    const pending = deferred(); apiFetch.mockReturnValueOnce(pending.promise);
    render(<PasskeyManager />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Synthetic list unavailable');
    expect(screen.queryByText('No passkeys registered yet.')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(screen.getByText('Loading...')).toBeInTheDocument();
    expect(screen.queryByText('No passkeys registered yet.')).not.toBeInTheDocument();
    await act(async () => pending.resolve(list([key])));
    expect(screen.getByText(key.name)).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();
    expect(apiFetch.mock.calls).toEqual([['/api/auth/passkey/credentials'], ['/api/auth/passkey/credentials']]);
    expect(startRegistration).not.toHaveBeenCalled();
  });

  it('shows verified empty state after retry and preserves retry on repeated failure', async () => {
    apiFetch.mockRejectedValueOnce(new Error('First synthetic failure')).mockRejectedValueOnce(new Error('Second synthetic failure')).mockResolvedValueOnce(list([]));
    render(<PasskeyManager />);
    expect(await screen.findByRole('alert')).toHaveTextContent('First synthetic failure');
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Second synthetic failure'));
    expect(screen.queryByText('No passkeys registered yet.')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('No passkeys registered yet.')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('preserves known rows during a refresh and exposes its failure separately from deletion success', async () => {
    const pending = deferred();
    apiFetch.mockResolvedValueOnce(list([key])).mockResolvedValueOnce(new Response(null, { status: 204 })).mockReturnValueOnce(pending.promise).mockResolvedValueOnce(list([]));
    vi.stubGlobal('confirm', vi.fn(() => true));
    render(<PasskeyManager />);
    expect(await screen.findByText(key.name)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(3));
    expect(screen.getByText(key.name)).toBeInTheDocument();
    expect(screen.getByText('Loading...')).toBeInTheDocument();
    await act(async () => pending.reject(new Error('Synthetic refresh unavailable')));
    expect(screen.getByRole('alert')).toHaveTextContent('Synthetic refresh unavailable');
    expect(screen.getByText(key.name)).toBeInTheDocument();
    expect(screen.getByText('Passkey removed')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('No passkeys registered yet.')).toBeInTheDocument();
  });

  it('keeps registration errors when a list-only retry succeeds', async () => {
    apiFetch.mockRejectedValueOnce(new Error('Synthetic list unavailable')).mockResolvedValueOnce(Response.json({ error: 'Synthetic registration denied' }, { status: 403 })).mockResolvedValueOnce(list([key]));
    render(<PasskeyManager />);
    await screen.findByRole('alert');
    fireEvent.click(screen.getByRole('button', { name: '+ Add Passkey' }));
    expect(await screen.findByText('Synthetic registration denied')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText(key.name)).toBeInTheDocument();
    expect(screen.getByText('Synthetic registration denied')).toBeInTheDocument();
    expect(screen.queryByText('Synthetic list unavailable')).not.toBeInTheDocument();
  });

  it.each(['success', 'failure'])('ignores the obsolete Strict Mode initial list %s after the current load completes', async outcome => {
    const stale = deferred(); apiFetch.mockReturnValueOnce(stale.promise).mockResolvedValueOnce(list([key]));
    render(<StrictMode><PasskeyManager /></StrictMode>);
    expect(await screen.findByText(key.name)).toBeInTheDocument();
    await act(async () => { if (outcome === 'success') stale.resolve(list([])); else stale.reject(new Error('Obsolete synthetic failure')); });
    expect(screen.getByText(key.name)).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.queryByText('No passkeys registered yet.')).not.toBeInTheDocument();
  });

  it('does not start a follow-up list read after a delete completes on an unmounted manager', async () => {
    const pending = deferred(); apiFetch.mockResolvedValueOnce(list([key])).mockReturnValueOnce(pending.promise);
    vi.stubGlobal('confirm', vi.fn(() => true));
    const view = render(<PasskeyManager />);
    await screen.findByText(key.name);
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    view.unmount();
    await act(async () => pending.resolve(new Response(null, { status: 204 })));
    expect(apiFetch).toHaveBeenCalledTimes(2);
  });

  it('preserves a deletion error and its known row without starting a reload', async () => {
    apiFetch.mockResolvedValueOnce(list([key])).mockResolvedValueOnce(Response.json({ error: 'Synthetic delete denied' }, { status: 403 }));
    vi.stubGlobal('confirm', vi.fn(() => true));
    render(<PasskeyManager />);
    await screen.findByText(key.name);
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    expect(await screen.findByText('Synthetic delete denied')).toBeInTheDocument();
    expect(screen.getByText(key.name)).toBeInTheDocument();
    expect(apiFetch).toHaveBeenCalledTimes(2);
  });

  it('preserves registration cancellation feedback', async () => {
    apiFetch.mockResolvedValueOnce(list([])).mockResolvedValueOnce(Response.json({ publicKey: {} }));
    startRegistration.mockRejectedValueOnce(new DOMException('Synthetic device cancellation', 'NotAllowedError'));
    render(<PasskeyManager />);
    await screen.findByText('No passkeys registered yet.');
    fireEvent.click(screen.getByRole('button', { name: '+ Add Passkey' }));
    expect(await screen.findByText('Registration was cancelled or timed out')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '+ Add Passkey' })).toBeEnabled();
    expect(apiFetch).toHaveBeenCalledTimes(2);
  });

  it('keeps registration success and known rows when the follow-up read fails', async () => {
    apiFetch.mockResolvedValueOnce(list([key])).mockResolvedValueOnce(Response.json({ publicKey: {} })).mockResolvedValueOnce(Response.json({})).mockRejectedValueOnce(new Error('Synthetic post-registration list unavailable'));
    startRegistration.mockResolvedValueOnce({ id: 'synthetic-registration' });
    render(<PasskeyManager />);
    await screen.findByText(key.name);
    fireEvent.click(screen.getByRole('button', { name: '+ Add Passkey' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Synthetic post-registration list unavailable');
    expect(screen.getByText('Passkey registered successfully')).toBeInTheDocument();
    expect(screen.getByText(key.name)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeEnabled();
  });

  it('ignores a delayed older mutation reload after a newer reload succeeds', async () => {
    const stale = deferred();
    const newer = { ...key, id: 'fixture-new-key', name: 'Synthetic newly registered key' };
    apiFetch.mockResolvedValueOnce(list([key])).mockResolvedValueOnce(new Response(null, { status: 204 })).mockReturnValueOnce(stale.promise)
      .mockResolvedValueOnce(Response.json({ publicKey: {} })).mockResolvedValueOnce(Response.json({})).mockResolvedValueOnce(list([newer]));
    startRegistration.mockResolvedValueOnce({ id: 'synthetic-registration' });
    vi.stubGlobal('confirm', vi.fn(() => true));
    render(<PasskeyManager />);
    await screen.findByText(key.name);
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(3));
    fireEvent.click(screen.getByRole('button', { name: '+ Add Passkey' }));
    expect(await screen.findByText(newer.name)).toBeInTheDocument();
    await act(async () => stale.resolve(list([])));
    expect(screen.getByText(newer.name)).toBeInTheDocument();
    expect(screen.queryByText('No passkeys registered yet.')).not.toBeInTheDocument();
  });

  it('does not start a follow-up read after registration completes on an unmounted manager', async () => {
    const pending = deferred();
    apiFetch.mockResolvedValueOnce(list([])).mockResolvedValueOnce(Response.json({ publicKey: {} })).mockReturnValueOnce(pending.promise);
    startRegistration.mockResolvedValueOnce({ id: 'synthetic-registration' });
    const view = render(<PasskeyManager />);
    await screen.findByText('No passkeys registered yet.');
    fireEvent.click(screen.getByRole('button', { name: '+ Add Passkey' }));
    await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(3));
    view.unmount();
    await act(async () => pending.resolve(Response.json({})));
    expect(apiFetch).toHaveBeenCalledTimes(3);
  });

  it('refreshes the credential list after an empty successful DELETE response', async () => {
    const key = { id: 'fixture-key', name: 'Fixture laptop', createdAt: '2026-10-01T00:00:00Z' };
    apiFetch.mockResolvedValueOnce(Response.json({ credentials: [key] }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(Response.json({ credentials: [] }));
    vi.stubGlobal('confirm', vi.fn(() => true));
    render(<PasskeyManager />);
    expect(await screen.findByText(key.name)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(screen.queryByText(key.name)).not.toBeInTheDocument());
    expect(screen.getByText('Passkey removed')).toBeInTheDocument();
    expect(screen.getByText('No passkeys registered yet.')).toBeInTheDocument();
    expect(apiFetch).toHaveBeenNthCalledWith(2, '/api/auth/passkey/credentials/fixture-key', { method: 'DELETE' });
  });
});
