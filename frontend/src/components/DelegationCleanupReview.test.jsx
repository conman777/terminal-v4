import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearTokens, setTokens, setUser } from '../utils/auth';
import { setEnvironmentIdentity } from '../utils/remoteEnvironments';
import { apiFetch } from '../utils/api';
import DelegationCleanupReview from './DelegationCleanupReview';

vi.mock('../utils/api', () => ({ apiFetch: vi.fn() }));
const response = (status, body = {}) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
const requestId = '8a0dbd3f-571a-4e4d-b37d-f42b240495e4';
const child = { childOperationId: '84f7131a-c8da-41c8-84af-ef207c1723f0', taskId: 'task-fixture', childSessionId: 'session-fixture', workspacePath: '/fixture/workspace', provider: 'fixture-provider', model: 'fixture-model' };
const list = () => response(200, { requestId, children: [child] });

beforeEach(() => { localStorage.clear(); setTokens('fixture-access', 'fixture-refresh'); setUser({ id: 'owner-a' }); setEnvironmentIdentity('owner-a'); apiFetch.mockReset(); });
afterEach(() => { clearTokens(true); setEnvironmentIdentity(null); });

describe('delegation cleanup review', () => {
  it('requires confirmation and uses the same operation after an ambiguous review', async () => {
    apiFetch.mockResolvedValueOnce(list()).mockRejectedValueOnce(new TypeError('lost response'))
      .mockResolvedValueOnce(response(404)).mockResolvedValueOnce(list())
      .mockImplementationOnce(async (_url, options) => response(200, { status: 'reviewed', ...options.body, taskId: child.taskId, childSessionId: child.childSessionId }));
    const onReviewed = vi.fn();
    render(<DelegationCleanupReview requestId={requestId} onReviewed={onReviewed} />);
    expect(await screen.findByText(/\/fixture\/workspace/)).toBeVisible();
    expect(screen.getByText(/server cannot verify/i)).toBeVisible();
    const confirm = screen.getByRole('button', { name: /confirm delegated child review/i });
    expect(confirm).toBeDisabled();
    fireEvent.click(screen.getByRole('checkbox', { name: /personally checked and stopped all associated processes/i }));
    fireEvent.click(confirm);
    expect(await screen.findByRole('alert')).toHaveTextContent(/could not be confirmed/i);
    expect(confirm).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: /check review status/i }));
    await waitFor(() => expect(confirm).toBeEnabled());
    fireEvent.click(confirm);
    await waitFor(() => expect(onReviewed).toHaveBeenCalledTimes(1));
    const calls = apiFetch.mock.calls.filter(([url]) => url.endsWith('/delegation-review'));
    expect(calls.map(([, options]) => options.body)).toEqual([
      { requestId, operationId: expect.any(String), childOperationId: child.childOperationId, acknowledged: true },
      { requestId, operationId: expect.any(String), childOperationId: child.childOperationId, acknowledged: true },
    ]);
    expect(calls[0][1].body.operationId).toBe(calls[1][1].body.operationId);
  });

  it('ignores a delayed child list from a previous account', async () => {
    let release;
    apiFetch.mockReturnValueOnce(new Promise(resolve => { release = resolve; }));
    const view = render(<DelegationCleanupReview requestId={requestId} />);
    await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(1));
    act(() => { setUser({ id: 'owner-b' }); setEnvironmentIdentity('owner-b'); });
    await act(async () => { release(list()); });
    expect(screen.queryByText(/\/fixture\/workspace/)).not.toBeInTheDocument();
    view.unmount();
  });

  it('accepts an exact durable receipt after a lost response without resending', async () => {
    let operation;
    apiFetch.mockResolvedValueOnce(list()).mockImplementationOnce(async (_url, options) => { operation = options.body.operationId; throw new TypeError('lost response'); })
      .mockImplementationOnce(async url => response(200, { status: 'reviewed', requestId, operationId: url.split('/').pop(), childOperationId: child.childOperationId, taskId: child.taskId, childSessionId: child.childSessionId }));
    const onReviewed = vi.fn();
    render(<DelegationCleanupReview requestId={requestId} onReviewed={onReviewed} />);
    await screen.findByText(/\/fixture\/workspace/);
    fireEvent.click(screen.getByRole('checkbox', { name: /personally checked and stopped/i }));
    fireEvent.click(screen.getByRole('button', { name: /confirm delegated child review/i }));
    await screen.findByRole('alert');
    fireEvent.click(screen.getByRole('button', { name: /check review status/i }));
    await waitFor(() => expect(onReviewed).toHaveBeenCalledTimes(1));
    expect(apiFetch.mock.calls[2][0]).toBe(`/api/structured/owner-cleanup/delegation-review/${operation}`);
    expect(apiFetch.mock.calls.filter(([, options]) => options.method === 'POST')).toHaveLength(1);
  });

  it('does not retry when the cleanup request changed while the receipt is missing', async () => {
    apiFetch.mockResolvedValueOnce(list()).mockRejectedValueOnce(new TypeError('lost response')).mockResolvedValueOnce(response(404))
      .mockResolvedValueOnce(response(200, { requestId: 'e595e200-c23c-4670-896d-f2ae63b93e63', children: [child] }));
    render(<DelegationCleanupReview requestId={requestId} />);
    await screen.findByText(/\/fixture\/workspace/);
    const checkbox = screen.getByRole('checkbox', { name: /personally checked and stopped/i });
    fireEvent.click(checkbox);
    const confirm = screen.getByRole('button', { name: /confirm delegated child review/i });
    fireEvent.click(confirm);
    await screen.findByRole('alert');
    fireEvent.click(screen.getByRole('button', { name: /check review status/i }));
    await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(4));
    expect(confirm).toBeDisabled();
    fireEvent.click(checkbox); fireEvent.click(checkbox);
    expect(confirm).toBeDisabled();
  });

  const finished = { childOperationId: 'a3a6e1c0-1b3f-4a43-9c51-5a8f3d0f7e11', taskId: 'task-done', childSessionId: 'session-done', parentSessionId: 'parent-gone', workspacePath: '/fixture/done', provider: 'fixture-provider', model: 'fixture-model', outcome: 'completed', result: '<b>finished text</b>', resultTruncated: true };

  it('shows retained finished results as plain text and marks truncation', async () => {
    apiFetch.mockResolvedValueOnce(response(200, { requestId, children: [], results: [finished] }));
    render(<DelegationCleanupReview requestId={requestId} />);
    const section = await screen.findByRole('region', { name: 'Finished delegated results' });
    expect(section).toHaveTextContent('<b>finished text</b>');
    expect(section).toHaveTextContent(/Outcome: completed/);
    expect(section).toHaveTextContent(/shortened for display/i);
    expect(section.querySelector('b')).toBeNull();
  });

  it('does not invent results and reports unreadable ones without hiding children', async () => {
    apiFetch.mockResolvedValueOnce(response(200, { requestId, children: [child] }));
    const view = render(<DelegationCleanupReview requestId={requestId} />);
    await screen.findByText(/\/fixture\/workspace/);
    expect(screen.queryByRole('region', { name: 'Finished delegated results' })).not.toBeInTheDocument();
    view.unmount();
    apiFetch.mockReset().mockResolvedValueOnce(response(200, { requestId, children: [child], results: [{ ...finished, resultTruncated: 'no' }] }));
    render(<DelegationCleanupReview requestId={requestId} />);
    expect(await screen.findByText(/\/fixture\/workspace/)).toBeVisible();
    expect(await screen.findByRole('alert')).toHaveTextContent(/results could not be read/i);
    expect(screen.queryByRole('region', { name: 'Finished delegated results' })).not.toBeInTheDocument();
  });
});
