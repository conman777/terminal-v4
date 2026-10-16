import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { SessionHistorySearch } from './SessionHistorySearch';

const apiFetch = vi.fn();
vi.mock('../utils/api', () => ({ apiFetch: (...args) => apiFetch(...args) }));
vi.mock('./NativeHistoryPanel', () => ({ NativeHistoryPanel: () => null }));
const path = 'C:/projects/demo';
const row = { sessionId: 'ss-one', title: 'Build review', kind: 'structured', workspacePath: path, updatedAt: '2026-10-14T10:00:00Z', snippet: 'Fixed the compiler problem.' };

describe('SessionHistorySearch', () => {
  beforeEach(() => { apiFetch.mockReset(); apiFetch.mockResolvedValue({ ok: true, json: async () => [row] }); });

  it('loads recent workspace sessions, searches saved content, and opens canonical session IDs', async () => {
    const onSelectSession = vi.fn();
    render(<SessionHistorySearch workspacePath={path} onSelectSession={onSelectSession} />);
    expect(await screen.findByText(row.snippet)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Search saved conversations'), { target: { value: 'compiler' } });
    fireEvent.click(screen.getByRole('button', { name: 'Search history' }));
    await waitFor(() => expect(apiFetch).toHaveBeenLastCalledWith('/api/workspace/history?' + new URLSearchParams({ path, q: 'compiler', limit: '20' }), { signal: expect.any(AbortSignal) }));
    fireEvent.click(screen.getByRole('button', { name: /Build review/ }));
    expect(onSelectSession).toHaveBeenCalledWith('ss-one');
  });

  it('shows load errors and retries the current query', async () => {
    apiFetch.mockResolvedValueOnce({ ok: false, json: async () => ({ error: 'History unavailable' }) });
    render(<SessionHistorySearch workspacePath={path} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('History unavailable');
    fireEvent.click(screen.getByRole('button', { name: 'Retry history' }));
    expect(await screen.findByText(row.snippet)).toBeInTheDocument();
  });

  it('does not render stale results after the workspace changes', async () => {
    const { rerender } = render(<SessionHistorySearch workspacePath={path} />);
    await screen.findByText(row.snippet);
    apiFetch.mockResolvedValue({ ok: true, json: async () => [] });
    rerender(<SessionHistorySearch workspacePath="C:/projects/other" />);
    expect(await screen.findByText('No matching conversations.')).toBeInTheDocument();
    expect(screen.queryByText(row.snippet)).not.toBeInTheDocument();
  });
});

