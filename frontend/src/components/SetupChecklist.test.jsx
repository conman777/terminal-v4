import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { apiGet } from '../utils/api';
import { SetupChecklist } from './SetupChecklist';

vi.mock('../utils/api', () => ({ apiGet: vi.fn() }));

const report = ready => ({ ready, agentReady: ready, checks: [
  { id: 'git', label: 'Git', ok: true, detail: 'git version 2.50', fix: 'Install Git.', required: true },
  { id: 'claude', label: 'Claude Code', ok: ready, detail: ready ? '2.1.0' : 'Not found on this server\'s PATH', fix: 'Install Claude Code.', required: false },
] });

beforeEach(() => { vi.mocked(apiGet).mockReset(); localStorage.clear(); });

describe('SetupChecklist', () => {
  it('lists each check with how to fix what is missing, and checks again on request', async () => {
    vi.mocked(apiGet).mockResolvedValueOnce(report(false)).mockResolvedValueOnce(report(true));
    render(<SetupChecklist />);
    const missing = await screen.findByText('Install Claude Code.');
    fireEvent.click(screen.getByRole('button', { name: 'Check again' }));
    await waitFor(() => expect(screen.queryByText('Install Claude Code.')).toBeNull());
    expect([missing !== null, screen.getByText('2.1.0') !== null, vi.mocked(apiGet).mock.calls.length]).toEqual([true, true, 2]);
  });

  it('welcomes a new setup until it is ready or dismissed', async () => {
    vi.mocked(apiGet).mockResolvedValue(report(false));
    const { container, unmount } = render(<SetupChecklist welcome />);
    fireEvent.click(await screen.findByRole('button', { name: 'Dismiss' }));
    expect(container.innerHTML).toBe('');
    unmount();
    const again = render(<SetupChecklist welcome />);
    await waitFor(() => expect(vi.mocked(apiGet)).toHaveBeenCalledTimes(1));
    expect(again.container.innerHTML).toBe('');
  });
});
