import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiGet } from '../utils/api';
import { SetupChecklist } from './SetupChecklist';
import { setActiveEnvironment, setEnvironmentIdentity } from '../utils/remoteEnvironments';
import { setUser } from '../utils/auth';

vi.mock('../utils/api', () => ({ apiGet: vi.fn() }));

const report = ready => ({ ready, agentReady: ready, checks: [
  { id: 'git', label: 'Git', ok: true, detail: 'git version 2.50', fix: 'Install Git.', required: true },
  { id: 'claude', label: 'Claude Code', ok: ready, detail: ready ? '2.1.0' : 'Not found on this server\'s PATH', fix: 'Install Claude Code.', required: false },
] });

beforeEach(() => { vi.mocked(apiGet).mockReset(); localStorage.clear(); setEnvironmentIdentity('setup-owner'); setActiveEnvironment(null); setUser({ id: 'setup-owner' }); });
afterEach(() => { setActiveEnvironment(null); setEnvironmentIdentity(''); });

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

  it('shows a compact native-agent notice and expands the full setup details on request', async () => {
    vi.mocked(apiGet).mockResolvedValue(report(false));
    render(<SetupChecklist welcome />);
    expect(await screen.findByText(/Other configured agents may still work/)).toBeVisible();
    const details = screen.getByRole('button', { name: 'Setup details' });
    expect(details).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByText('Install Claude Code.')).not.toBeVisible();
    fireEvent.click(details);
    expect(details).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('Install Claude Code.')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Check again' })).toBeVisible();
  });

  it('keeps a missing required check discoverable without claiming that optional tools are required', async () => {
    vi.mocked(apiGet).mockResolvedValue({ ready: false, agentReady: true, checks: [
      { id: 'git', label: 'Git', ok: false, detail: 'Not found', fix: 'Install Git.', required: true },
      { id: 'gh', label: 'GitHub CLI', ok: false, detail: 'Not found', fix: 'Install GitHub CLI.', required: false },
    ] });
    render(<SetupChecklist welcome />);
    expect(await screen.findByText(/Required setup checks need attention/)).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Setup details' }));
    expect(screen.getByText('Install Git.')).toBeVisible();
    expect(screen.getByText('Install GitHub CLI.')).toBeVisible();
    expect(screen.getByText('optional')).toBeVisible();
  });

  it('isolates dismissal and ignores late setup results when changing environments', async () => {
    let resolveOld;
    vi.mocked(apiGet).mockImplementationOnce(() => new Promise(resolve => { resolveOld = resolve; })).mockResolvedValue(report(false));
    render(<SetupChecklist welcome />);
    await waitFor(() => expect(resolveOld).toBeTypeOf('function'));
    act(() => setActiveEnvironment({ id: 'setup-other-host' }));
    expect(await screen.findByText(/Other configured agents may still work/)).toBeVisible();
    await act(async () => resolveOld({ ...report(false), checks: [{ id: 'old', label: 'Old host only', ok: false, required: true }] }));
    fireEvent.click(screen.getByRole('button', { name: 'Setup details' }));
    expect(screen.queryByText('Old host only')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByRole('region', { name: 'Setup check' })).not.toBeInTheDocument();
    act(() => setActiveEnvironment(null));
    expect(await screen.findByRole('button', { name: 'Setup details' })).toBeVisible();
  });

  it('does not carry a dismissal into another account even before the environment identity updates', async () => {
    vi.mocked(apiGet).mockResolvedValue(report(false));
    render(<SetupChecklist welcome />);
    fireEvent.click(await screen.findByRole('button', { name: 'Dismiss' }));
    act(() => setUser({ id: 'other-setup-owner' }));
    expect(await screen.findByRole('button', { name: 'Setup details' })).toBeVisible();
  });

  it('shows a retryable notice when the welcome setup check fails', async () => {
    vi.mocked(apiGet).mockRejectedValueOnce(new Error('Temporary setup failure')).mockResolvedValueOnce(report(false));
    render(<SetupChecklist welcome />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Temporary setup failure');
    fireEvent.click(screen.getByRole('button', { name: 'Try setup check again' }));
    expect(await screen.findByText(/Other configured agents may still work/)).toBeVisible();
  });

  it('reports an invalid setup response instead of silently hiding the notice', async () => {
    vi.mocked(apiGet).mockResolvedValue({ ready: false });
    render(<SetupChecklist welcome />);
    expect(await screen.findByRole('alert')).toHaveTextContent('The setup check returned an invalid response.');
    expect(screen.getByRole('button', { name: 'Try setup check again' })).toBeVisible();
  });
});
