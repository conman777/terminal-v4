import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

let scope;
let authListener;
let environmentListener;
let environment;
let envController;
vi.mock('../utils/api', () => ({ apiFetch: vi.fn() }));
vi.mock('../utils/auth', () => ({
  captureAuthScope: () => ({ ...scope }),
  isAuthScopeCurrent: value => value.generation === scope.generation && value.userId === scope.userId && value.home === scope.home,
  subscribeAuth: listener => { authListener = listener; return () => { authListener = null; }; },
}));
vi.mock('../utils/remoteEnvironments', () => ({
  getActiveEnvironment: () => environment,
  getEnvironmentSignal: () => envController.signal,
  subscribeEnvironment: listener => { environmentListener = listener; return () => { environmentListener = null; }; },
}));
import { apiFetch } from '../utils/api';
import OwnershipRecovery from './OwnershipRecovery';

const epoch = '2397ef31-85de-4bf1-b68e-07f3298b4701';
const response = (value, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => value });
beforeEach(() => {
  scope = { generation: 1, userId: 'owner', home: 'https://home.test/', session: 'auth-epoch' };
  environment = null;
  envController = new AbortController();
  apiFetch.mockReset();
});
afterEach(() => cleanup());

describe('structured ownership recovery', () => {
  it('does not offer recovery when the server has not enabled the ownership guard', async () => {
    apiFetch.mockResolvedValue(response(null, 404));
    const onResolved = vi.fn();
    const { container } = render(<OwnershipRecovery onResolved={onResolved} />);
    await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(container).toBeEmptyDOMElement());
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
    expect(onResolved).not.toHaveBeenCalled();
    expect(apiFetch.mock.calls.every(([, options]) => !options?.method || options.method === 'GET')).toBe(true);
  });

  it('explains a live competing server without offering a bypass', async () => {
    apiFetch.mockResolvedValue(response({ state: 'busy' }));
    render(<OwnershipRecovery onResolved={vi.fn()} />);
    expect(await screen.findByText(/another server is using your sessions/i)).toBeVisible();
    expect(screen.queryByRole('button', { name: /continue after review/i })).not.toBeInTheDocument();
  });

  it('does not mistake this server’s own lease for a competing server', async () => {
    apiFetch.mockResolvedValue(response({ state: 'owned' }));
    render(<OwnershipRecovery onResolved={vi.fn()} />);
    await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(1));
    expect(screen.queryByText(/another server is using your sessions/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
  });

  it('requires acknowledgment, preserves the operation across a lost response, and retries only the same epoch', async () => {
    apiFetch.mockResolvedValueOnce(response({ state: 'unconfirmed', epoch }))
      .mockRejectedValueOnce(new TypeError('Connection lost'))
      .mockResolvedValueOnce(response(null, 204));
    const onResolved = vi.fn();
    render(<OwnershipRecovery onResolved={onResolved} />);
    expect(await screen.findByText(/cleanup remains unverified/i)).toBeVisible();
    const proceed = screen.getByRole('button', { name: /continue after review/i });
    expect(proceed).toBeDisabled();
    fireEvent.click(screen.getByRole('checkbox', { name: /checked that the previous processes have stopped/i }));
    fireEvent.click(proceed);
    expect(await screen.findByText(/could not confirm the review/i)).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: /retry the same review/i }));
    await waitFor(() => expect(onResolved).toHaveBeenCalledTimes(1));
    const posts = apiFetch.mock.calls.filter(([, options]) => options?.method === 'POST');
    expect(posts).toHaveLength(2);
    expect(posts[0][1].body).toEqual(posts[1][1].body);
    expect(posts[0][1].body).toMatchObject({ epoch, acknowledged: true });
    expect(posts[0][1].body.operationId).toMatch(/^[0-9a-f-]{36}$/i);
  });

  it('discards a delayed inspection after an account switch', async () => {
    let finish;
    apiFetch.mockReturnValue(new Promise(resolve => { finish = resolve; }));
    const onResolved = vi.fn();
    render(<OwnershipRecovery onResolved={onResolved} />);
    scope = { ...scope, generation: 2, userId: 'other' };
    authListener('identity');
    finish(response({ state: 'unconfirmed', epoch }));
    await waitFor(() => expect(screen.queryByRole('checkbox')).not.toBeInTheDocument());
    expect(apiFetch).toHaveBeenCalledTimes(1);
    expect(onResolved).not.toHaveBeenCalled();
  });

  it('does not leave an old account review visible when an auth update changes the user', async () => {
    apiFetch.mockResolvedValue(response({ state: 'unconfirmed', epoch }));
    render(<OwnershipRecovery onResolved={vi.fn()} />);
    expect(await screen.findByRole('checkbox')).toBeVisible();
    scope = { ...scope, userId: 'other' };
    authListener('rotation');
    await waitFor(() => expect(screen.queryByRole('checkbox')).not.toBeInTheDocument());
  });

  it('never applies a delayed approval after an environment change', async () => {
    let finish;
    apiFetch.mockResolvedValueOnce(response({ state: 'unconfirmed', epoch }))
      .mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
    const onResolved = vi.fn();
    render(<OwnershipRecovery onResolved={onResolved} />);
    fireEvent.click(await screen.findByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: /continue after review/i }));
    await waitFor(() => expect(finish).toBeTypeOf('function'));
    envController.abort();
    environment = { id: 'other' };
    environmentListener();
    finish(response(null, 204));
    await waitFor(() => expect(screen.queryByRole('checkbox')).not.toBeInTheDocument());
    expect(onResolved).not.toHaveBeenCalled();
  });

  it('requires a fresh inspection and acknowledgment when ownership changes', async () => {
    const nextEpoch = '727178b6-a998-4f62-834b-fda16cc4c2c1';
    apiFetch.mockResolvedValueOnce(response({ state: 'unconfirmed', epoch }))
      .mockResolvedValueOnce(response({}, 409))
      .mockResolvedValueOnce(response({ state: 'unconfirmed', epoch: nextEpoch }));
    render(<OwnershipRecovery onResolved={vi.fn()} />);
    fireEvent.click(await screen.findByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: /continue after review/i }));
    expect(await screen.findByText(/ownership state changed/i)).toBeVisible();
    expect(screen.getByRole('button', { name: /continue after review/i })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: /check ownership again/i }));
    await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(3));
    await waitFor(() => expect(screen.getByRole('checkbox')).not.toBeChecked());
  });

  it('reuses the same review identity after a reload with an uncertain response', async () => {
    apiFetch.mockResolvedValueOnce(response({ state: 'unconfirmed', epoch }))
      .mockRejectedValueOnce(new TypeError('Connection lost'))
      .mockResolvedValueOnce(response({ state: 'unconfirmed', epoch }))
      .mockResolvedValueOnce(response(null, 204));
    const first = render(<OwnershipRecovery onResolved={vi.fn()} />);
    fireEvent.click(await screen.findByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: /continue after review/i }));
    expect(await screen.findByText(/could not confirm the review/i)).toBeVisible();
    first.unmount();
    const onResolved = vi.fn();
    render(<OwnershipRecovery onResolved={onResolved} />);
    fireEvent.click(await screen.findByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: /continue after review/i }));
    await waitFor(() => expect(onResolved).toHaveBeenCalledTimes(1));
    const posts = apiFetch.mock.calls.filter(([, options]) => options?.method === 'POST');
    expect(posts.map(([, options]) => options.body)).toEqual([posts[0][1].body, posts[0][1].body]);
  });

  it('does not inspect or change ownership through a remote environment', async () => {
    environment = { id: 'remote' };
    render(<OwnershipRecovery onResolved={vi.fn()} />);
    expect(await screen.findByText(/open the affected server directly/i)).toBeVisible();
    expect(apiFetch).not.toHaveBeenCalled();
  });
});
