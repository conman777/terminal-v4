import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearTokens, setTokens, setUser } from '../utils/auth';
import { setActiveEnvironment, setEnvironmentIdentity } from '../utils/remoteEnvironments';
import { apiFetch } from '../utils/api';
import OwnerCleanupRecovery from './OwnerCleanupRecovery';

vi.mock('../utils/api', () => ({ apiFetch: vi.fn() }));
vi.mock('./OwnershipRecovery', () => ({ default: () => <div>Ownership review fixture</div> }));
const response = (status, body = {}) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
const state = (value, structured = 'pending') => ({ state: value, requestId: 'private-request-id', resources: { structured, delegation: 'confirmed', background: 'not_installed' } });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

beforeEach(() => { localStorage.clear(); setTokens('fixture-access', 'fixture-refresh'); setUser({ id: 'cleanup-owner-a' }); setEnvironmentIdentity('cleanup-owner-a'); setActiveEnvironment(null); apiFetch.mockReset(); });
afterEach(() => { clearTokens(true); setEnvironmentIdentity(null); });

describe('owner cleanup recovery', () => {
  it('shows pending cleanup and retries against the home server without exposing resource identifiers', async () => {
    apiFetch.mockResolvedValueOnce(response(200, state('pending'))).mockResolvedValueOnce(response(200, state('complete', 'confirmed')));
    render(<OwnerCleanupRecovery />);
    const panel = await screen.findByRole('region', { name: 'Sign-out cleanup' });
    expect(panel).toHaveTextContent(/cleanup is still pending/i);
    expect(panel).not.toHaveTextContent('private-request-id');
    fireEvent.click(screen.getByRole('button', { name: 'Retry cleanup' }));
    await waitFor(() => expect(panel).toHaveTextContent(/cleanup is complete/i));
    expect(apiFetch.mock.calls.map(([url, options]) => [url, options.home, options.method])).toEqual([
      ['/api/structured/owner-cleanup', true, undefined],
      ['/api/structured/owner-cleanup/retry', true, 'POST'],
    ]);
  });

  it('does not claim unknown resources are stopped and provides the ownership review', async () => {
    apiFetch.mockResolvedValue(response(200, state('review_required', 'unconfirmed')));
    render(<OwnerCleanupRecovery />);
    expect(await screen.findByRole('region', { name: 'Sign-out cleanup' })).toHaveTextContent(/could not be confirmed/i);
    expect(screen.getByText('Ownership review fixture')).toBeVisible();
    expect(screen.queryByText(/cleanup is complete/i)).not.toBeInTheDocument();
  });

  it('does not show a recovery panel on an older server with no endpoint', async () => {
    apiFetch.mockResolvedValue(response(404));
    render(<OwnerCleanupRecovery />);
    await waitFor(() => expect(apiFetch).toHaveBeenCalled());
    expect(screen.queryByRole('region', { name: 'Sign-out cleanup' })).not.toBeInTheDocument();
  });

  it('keeps the last known pending status when retry cannot be confirmed', async () => {
    apiFetch.mockResolvedValueOnce(response(200, state('pending'))).mockRejectedValueOnce(new TypeError('Synthetic connection failure'));
    render(<OwnerCleanupRecovery />);
    const panel = await screen.findByRole('region', { name: 'Sign-out cleanup' });
    fireEvent.click(screen.getByRole('button', { name: 'Retry cleanup' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Cleanup retry could not be confirmed');
    expect(panel).toHaveTextContent('Agent sessions: still stopping');
    expect(panel).not.toHaveTextContent('Synthetic connection failure');
  });

  it('requires explicit confirmation before reviewing unknown background processes and retains the same operation on retry', async () => {
    const requestId = '8a0dbd3f-571a-4e4d-b37d-f42b240495e4';
    const pending = { state: 'review_required', requestId, backgroundReview: 'none', resources: { structured: 'confirmed', delegation: 'confirmed', background: 'unconfirmed' } };
    const reviewed = { state: 'complete', requestId, backgroundReview: 'user_attested', resources: { structured: 'confirmed', delegation: 'confirmed', background: 'confirmed' } };
    apiFetch.mockResolvedValueOnce(response(200, pending)).mockRejectedValueOnce(new TypeError('Synthetic connection failure')).mockResolvedValueOnce(response(200, pending))
      .mockImplementationOnce(async (_url, options) => response(200, { status: 'reviewed', requestId, operationId: options.body.operationId, reviewedCount: 1 }))
      .mockResolvedValueOnce(response(200, reviewed));
    render(<OwnerCleanupRecovery />);
    const panel = await screen.findByRole('region', { name: 'Sign-out cleanup' });
    expect(panel).toHaveTextContent(/server cannot verify/i);
    const button = screen.getByRole('button', { name: 'Confirm background review' });
    expect(button).toBeDisabled();
    fireEvent.click(screen.getByRole('checkbox', { name: /all associated background processes have stopped/i }));
    fireEvent.click(button);
    expect(await screen.findByRole('alert')).toHaveTextContent(/could not be confirmed/i);
    expect(button).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Check cleanup status' }));
    await waitFor(() => expect(button).toBeEnabled());
    fireEvent.click(button);
    await waitFor(() => expect(panel).toHaveTextContent(/you confirmed/i));
    expect(panel).toHaveTextContent(/server did not verify/i);
    const calls = apiFetch.mock.calls.filter(([url]) => url.endsWith('/background-review'));
    expect(calls.map(([, options]) => options.body)).toEqual([
      { requestId, operationId: expect.any(String), acknowledged: true },
      { requestId, operationId: expect.any(String), acknowledged: true },
    ]);
    expect(calls[0][1].body.operationId).toBe(calls[1][1].body.operationId);
    expect(panel).not.toHaveTextContent(requestId);
  });

  it('does not accept a stale background review after the cleanup request changes', async () => {
    const requestId = '8a0dbd3f-571a-4e4d-b37d-f42b240495e4';
    const nextRequestId = '84f7131a-c8da-41c8-84af-ef207c1723f0';
    const resources = { structured: 'confirmed', delegation: 'confirmed', background: 'unconfirmed' };
    apiFetch.mockResolvedValueOnce(response(200, { state: 'review_required', requestId, resources })).mockResolvedValueOnce(response(409, {}))
      .mockResolvedValueOnce(response(200, { state: 'review_required', requestId: nextRequestId, resources }));
    render(<OwnerCleanupRecovery />);
    await screen.findByRole('region', { name: 'Sign-out cleanup' });
    fireEvent.click(screen.getByRole('checkbox', { name: /all associated background processes have stopped/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm background review' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/could not be confirmed/i);
    expect(screen.getByRole('button', { name: 'Confirm background review' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Check cleanup status' }));
    await waitFor(() => expect(screen.getByRole('checkbox', { name: /all associated background processes have stopped/i })).not.toBeChecked());
    expect(screen.getByRole('button', { name: 'Confirm background review' })).toBeDisabled();
  });

  it('refreshes sessions after a status check finds a previously unconfirmed review completed', async () => {
    const requestId = '8a0dbd3f-571a-4e4d-b37d-f42b240495e4';
    const resources = { structured: 'confirmed', delegation: 'confirmed', background: 'unconfirmed' };
    const onResolved = vi.fn();
    apiFetch.mockResolvedValueOnce(response(200, { state: 'review_required', requestId, resources }))
      .mockRejectedValueOnce(new TypeError('Lost response'))
      .mockResolvedValueOnce(response(200, { state: 'complete', requestId: null, backgroundReview: 'user_attested', resources: { ...resources, background: 'confirmed' } }));
    render(<OwnerCleanupRecovery onResolved={onResolved} />);
    await screen.findByRole('region', { name: 'Sign-out cleanup' });
    fireEvent.click(screen.getByRole('checkbox', { name: /all associated background processes have stopped/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm background review' }));
    await screen.findByRole('alert');
    fireEvent.click(screen.getByRole('button', { name: 'Check cleanup status' }));
    await waitFor(() => expect(onResolved).toHaveBeenCalledTimes(1));
  });

  it('displays historical delegated-child attestation without claiming server verification', async () => {
    apiFetch.mockResolvedValueOnce(response(200, { state: 'complete', requestId: null, delegationReview: 'user_attested', resources: { structured: 'confirmed', delegation: 'confirmed', background: 'not_installed' } }));
    render(<OwnerCleanupRecovery />);
    const panel = await screen.findByRole('region', { name: 'Sign-out cleanup' });
    expect(panel).toHaveTextContent(/previous cleanup review/i);
    expect(panel).toHaveTextContent(/server did not verify/i);
  });

  it('does not expose or apply a delayed background review to a different account', async () => {
    const requestId = '8a0dbd3f-571a-4e4d-b37d-f42b240495e4', review = deferred();
    apiFetch.mockResolvedValueOnce(response(200, { state: 'review_required', requestId, resources: { structured: 'confirmed', delegation: 'confirmed', background: 'unconfirmed' } }))
      .mockReturnValueOnce(review.promise).mockResolvedValueOnce(response(200, state('complete', 'confirmed')));
    const view = render(<OwnerCleanupRecovery key="owner-a" />);
    await screen.findByRole('region', { name: 'Sign-out cleanup' });
    fireEvent.click(screen.getByRole('checkbox', { name: /all associated background processes have stopped/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm background review' }));
    await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(2));
    const operationId = apiFetch.mock.calls[1][1].body.operationId;
    act(() => { setUser({ id: 'cleanup-owner-b' }); setEnvironmentIdentity('cleanup-owner-b'); });
    view.rerender(<OwnerCleanupRecovery key="owner-b" />);
    await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(3));
    await act(async () => { review.resolve(response(200, { status: 'reviewed', requestId, operationId, reviewedCount: 1 })); await review.promise; });
    expect(screen.queryByRole('region', { name: 'Sign-out cleanup' })).not.toBeInTheDocument();
    expect(apiFetch).toHaveBeenCalledTimes(3);
  });

  it('discards a delayed response from the previous account', async () => {
    const old = deferred();
    apiFetch.mockReturnValueOnce(old.promise).mockResolvedValueOnce(response(200, state('complete', 'confirmed')));
    const view = render(<OwnerCleanupRecovery key="owner-a" />);
    await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(1));
    act(() => { setUser({ id: 'cleanup-owner-b' }); setEnvironmentIdentity('cleanup-owner-b'); });
    view.rerender(<OwnerCleanupRecovery key="owner-b" />);
    await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(2));
    await act(async () => { old.resolve(response(200, state('pending'))); await old.promise; });
    expect(screen.queryByRole('region', { name: 'Sign-out cleanup' })).not.toBeInTheDocument();
  });

  it('offers the standalone background command review only when a completed cleanup reports unknown commands', async () => {
    apiFetch.mockImplementation(async url => url === '/api/structured/background-review' ? response(200, { unknown: true }) : response(200, { ...state('complete', 'confirmed'), backgroundUnknown: true }));
    render(<OwnerCleanupRecovery />);
    expect(await screen.findByRole('button', { name: /confirm background command review/i })).toBeVisible();
    expect(screen.queryByText(/cleanup is complete/i)).not.toBeInTheDocument();
  });

  it('shows nothing for a completed cleanup without unknown commands', async () => {
    apiFetch.mockResolvedValue(response(200, state('complete', 'confirmed')));
    render(<OwnerCleanupRecovery />);
    await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole('region')).not.toBeInTheDocument();
  });
});
