import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearTokens, setTokens, setUser } from '../utils/auth';
import { setEnvironmentIdentity } from '../utils/remoteEnvironments';
import { apiFetch } from '../utils/api';
import BackgroundCommandReview from './BackgroundCommandReview';

vi.mock('../utils/api', () => ({ apiFetch: vi.fn() }));
const response = (status, body = {}) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
const status = unknown => response(200, { unknown });
const reviewed = (options, count = 1) => response(200, { status: 'reviewed', operationId: options.body.operationId, reviewedCount: count });

beforeEach(() => { localStorage.clear(); setTokens('fixture-access', 'fixture-refresh'); setUser({ id: 'owner-a' }); setEnvironmentIdentity('owner-a'); apiFetch.mockReset(); });
afterEach(() => { clearTokens(true); setEnvironmentIdentity(null); });

describe('standalone background command review', () => {
  it('renders nothing when no command is unknown or the server has no endpoint', async () => {
    apiFetch.mockResolvedValueOnce(status(false));
    const view = render(<BackgroundCommandReview />);
    await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole('region', { name: 'Background commands' })).not.toBeInTheDocument();
    view.unmount();
    apiFetch.mockReset().mockResolvedValueOnce(response(404));
    render(<BackgroundCommandReview />);
    await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole('region', { name: 'Background commands' })).not.toBeInTheDocument();
  });

  it('needs an acknowledgment, posts a fresh operation and confirms only after the status clears', async () => {
    apiFetch.mockResolvedValueOnce(status(true)).mockImplementationOnce(async (_url, options) => reviewed(options)).mockResolvedValueOnce(status(false));
    render(<BackgroundCommandReview />);
    expect(await screen.findByText(/unknown state/i)).toBeVisible();
    const confirm = screen.getByRole('button', { name: /confirm background command review/i });
    expect(confirm).toBeDisabled();
    fireEvent.click(screen.getByRole('checkbox', { name: /personally checked/i }));
    fireEvent.click(confirm);
    expect(await screen.findByRole('status')).toHaveTextContent(/server did not verify/i);
    const post = apiFetch.mock.calls.find(([, options]) => options.method === 'POST');
    expect(post[0]).toBe('/api/structured/background-review');
    expect(post[1].body).toEqual({ operationId: expect.stringMatching(/^[0-9a-f-]{36}$/), acknowledged: true });
  });

  it('keeps the same operation after an ambiguous failure and blocks resend until status is checked', async () => {
    const sent = [];
    apiFetch.mockResolvedValueOnce(status(true))
      .mockImplementationOnce(async (_url, options) => { sent.push(options.body.operationId); throw new TypeError('lost response'); })
      .mockResolvedValueOnce(status(true))
      .mockImplementationOnce(async (_url, options) => { sent.push(options.body.operationId); return reviewed(options); })
      .mockResolvedValueOnce(status(false));
    render(<BackgroundCommandReview />);
    await screen.findByText(/unknown state/i);
    fireEvent.click(screen.getByRole('checkbox', { name: /personally checked/i }));
    const confirm = screen.getByRole('button', { name: /confirm background command review/i });
    fireEvent.click(confirm);
    expect(await screen.findByRole('alert')).toHaveTextContent(/could not be confirmed/i);
    expect(confirm).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: /check status/i }));
    await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(3));
    await waitFor(() => expect(screen.getByRole('checkbox', { name: /personally checked/i })).not.toBeDisabled());
    fireEvent.click(screen.getByRole('button', { name: /confirm background command review/i }));
    expect(await screen.findByRole('status')).toBeVisible();
    expect(sent).toHaveLength(2);
    expect(sent[0]).toBe(sent[1]);
  });

  it('does not claim success when the status still shows an unknown command', async () => {
    apiFetch.mockResolvedValueOnce(status(true)).mockImplementationOnce(async (_url, options) => reviewed(options, 0)).mockResolvedValueOnce(status(true));
    render(<BackgroundCommandReview />);
    await screen.findByText(/unknown state/i);
    fireEvent.click(screen.getByRole('checkbox', { name: /personally checked/i }));
    fireEvent.click(screen.getByRole('button', { name: /confirm background command review/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/recorded, but/i);
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('rejects a receipt for a different operation and shows a load failure honestly', async () => {
    apiFetch.mockResolvedValueOnce(status(true)).mockResolvedValueOnce(response(200, { status: 'reviewed', operationId: '00000000-0000-4000-8000-000000000000', reviewedCount: 1 }));
    render(<BackgroundCommandReview />);
    await screen.findByText(/unknown state/i);
    fireEvent.click(screen.getByRole('checkbox', { name: /personally checked/i }));
    fireEvent.click(screen.getByRole('button', { name: /confirm background command review/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/could not be confirmed/i);
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('shows an error when the status cannot be loaded and does not offer a review', async () => {
    apiFetch.mockRejectedValueOnce(new TypeError('offline'));
    render(<BackgroundCommandReview />);
    expect(await screen.findByRole('alert')).toHaveTextContent(/could not be loaded/i);
    expect(screen.queryByRole('button', { name: /confirm background command review/i })).not.toBeInTheDocument();
  });

  it('ignores a delayed status from a previous account', async () => {
    let release;
    apiFetch.mockReturnValueOnce(new Promise(resolve => { release = resolve; }));
    render(<BackgroundCommandReview />);
    await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(1));
    act(() => { setUser({ id: 'owner-b' }); setEnvironmentIdentity('owner-b'); });
    await act(async () => { release(status(true)); });
    expect(screen.queryByText(/unknown state/i)).not.toBeInTheDocument();
  });
});
