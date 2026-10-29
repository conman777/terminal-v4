import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WorktreeSetupCard } from './WorktreeSetupCard';

const apiFetchMock = vi.fn();
vi.mock('../utils/api', () => ({ apiFetch: (...args) => apiFetchMock(...args) }));

const snapshot = (overrides = {}) => ({
  operationId: 'op-1', status: 'running', cancelling: false, elapsedMs: 2400, error: null, cleanup: null, cleaned: null,
  tail: ['one', 'two', 'three', 'four', 'five'],
  stages: [
    { id: 'base', label: 'Checking base', status: 'done', detail: 'HEAD at abc123' },
    { id: 'checkout', label: 'Creating worktree', status: 'done', detail: null },
    { id: 'setup', label: 'Setup script', status: 'running', detail: '.v4/worktree-setup.sh' },
  ], ...overrides,
});
const reply = body => ({ ok: true, json: async () => body });

beforeEach(() => { apiFetchMock.mockReset(); });
afterEach(() => vi.useRealTimers());

describe('WorktreeSetupCard', () => {
  it('shows each stage with a text status and only the last four output lines', async () => {
    apiFetchMock.mockResolvedValue(reply(snapshot()));
    render(<WorktreeSetupCard operationId="op-1" />);
    expect(await screen.findByText('Setup script')).toBeVisible();
    const items = screen.getAllByRole('listitem').map(item => item.textContent);
    expect(items).toEqual(['Checking baseDoneHEAD at abc123', 'Creating worktreeDone', 'Setup scriptRunning.v4/worktree-setup.sh']);
    expect(screen.getByLabelText('Latest setup output')).toHaveTextContent('two three four five');
    expect(screen.getByLabelText('Latest setup output')).not.toHaveTextContent('one');
    expect(apiFetchMock.mock.calls[0][0]).toBe('/api/workspace/git/worktrees/progress?operationId=op-1');
  });

  it('cancel posts the operation id, disables itself and reports the cleanup honestly', async () => {
    apiFetchMock.mockImplementation(async url => url.endsWith('/cancel')
      ? reply(snapshot({ cancelling: true }))
      : reply(snapshot()));
    render(<WorktreeSetupCard operationId="op-1" pollMs={20} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel worktree setup' }));
    expect(await screen.findByRole('button', { name: 'Cancelling…' })).toBeDisabled();
    expect(apiFetchMock).toHaveBeenCalledWith('/api/workspace/git/worktrees/cancel', { method: 'POST', body: { operationId: 'op-1' } });
    apiFetchMock.mockImplementation(async () => reply(snapshot({ status: 'cancelled', cleaned: true, cleanup: 'The partial checkout and its branch were removed.',
      stages: [{ id: 'base', label: 'Checking base', status: 'done' }, { id: 'checkout', label: 'Creating worktree', status: 'done' }, { id: 'setup', label: 'Setup script', status: 'cancelled' }] })));
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('The partial checkout and its branch were removed.'));
    expect(screen.queryByRole('button', { name: /Cancel/ })).toBeNull();
    expect(screen.getByText('Cancelled')).toBeVisible();
  });

  it('retries a cancel that arrives before the server has registered the request', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let cancels = 0;
    apiFetchMock.mockImplementation(async url => {
      if (!url.endsWith('/cancel')) return reply(snapshot());
      cancels += 1;
      return cancels < 3 ? { ok: false, json: async () => ({ error: 'none' }) } : reply(snapshot({ cancelling: true }));
    });
    render(<WorktreeSetupCard operationId="op-1" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel worktree setup' }));
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    await waitFor(() => expect(cancels).toBe(3));
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('says so when the server cannot be reached to cancel', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    apiFetchMock.mockImplementation(async url => url.endsWith('/cancel') ? Promise.reject(new TypeError('offline')) : reply(snapshot()));
    render(<WorktreeSetupCard operationId="op-1" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel worktree setup' }));
    await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not reach the server to cancel');
    expect(screen.getByRole('button', { name: 'Cancel worktree setup' })).toBeEnabled();
  });

  it('shows a failure message from the server', async () => {
    apiFetchMock.mockResolvedValue(reply(snapshot({ status: 'failed', error: 'Git could not create the worktree: fatal: boom', stages: [{ id: 'base', label: 'Checking base', status: 'done' }, { id: 'checkout', label: 'Creating worktree', status: 'failed' }, { id: 'setup', label: 'Setup script', status: 'skipped' }] })));
    render(<WorktreeSetupCard operationId="op-1" />);
    expect(await screen.findByRole('status')).toHaveTextContent('fatal: boom');
    expect(screen.getByText('Failed')).toBeVisible();
    expect(screen.getByText('Skipped')).toBeVisible();
  });
});
