import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { WorkspaceToolsButton } from './WorkspaceToolsButton';

const apiFetch = vi.fn();
vi.mock('../utils/api', () => ({ apiFetch: (...args) => apiFetch(...args) }));
vi.mock('./WorkspaceBoardPanel', () => ({ WorkspaceBoardPanel: ({ workspacePath }) => <p>Board for {workspacePath}</p> }));
vi.mock('./WorkspaceGitPanel', () => ({ WorkspaceGitPanel: () => null }));
vi.mock('./SessionHistorySearch', () => ({ SessionHistorySearch: () => null }));
vi.mock('./WorkspaceRewindPanel', () => ({ WorkspaceRewindPanel: () => null }));
vi.mock('./WorkspaceTasksPanel', () => ({ WorkspaceTasksPanel: () => null }));
vi.mock('./WorkspaceProposalsPanel', () => ({ WorkspaceProposalsPanel: () => null }));
vi.mock('./WorkspaceSkillsPanel', () => ({ WorkspaceSkillsPanel: () => null }));
vi.mock('./FileTransferPanel', () => ({ FileTransferPanel: () => null }));
vi.mock('./CollaborationPanel', () => ({ CollaborationPanel: () => null }));
vi.mock('./SessionReplayPanel', () => ({ SessionReplayPanel: () => null }));

const open = () => fireEvent.click(screen.getByRole('button', { name: 'Workspace tools' }));

describe('Task board capability probe', () => {
  beforeEach(() => apiFetch.mockReset());

  it('hides the board entry when the server answers 404', async () => {
    apiFetch.mockResolvedValue({ ok: false, status: 404 });
    render(<WorkspaceToolsButton workspacePath="/project" />);
    open();
    await waitFor(() => expect(apiFetch).toHaveBeenCalled());
    await Promise.resolve();
    expect(screen.queryByRole('tab', { name: 'Task board' })).not.toBeInTheDocument();
  });

  it('hides the board entry when the probe fails or the server errors', async () => {
    apiFetch.mockRejectedValueOnce(new Error('offline'));
    const { unmount } = render(<WorkspaceToolsButton workspacePath="/project" />);
    open();
    await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(1));
    await Promise.resolve();
    expect(screen.queryByRole('tab', { name: 'Task board' })).not.toBeInTheDocument();
    unmount();
    apiFetch.mockResolvedValueOnce({ ok: false, status: 500 });
    render(<WorkspaceToolsButton workspacePath="/project" />);
    open();
    await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(2));
    await Promise.resolve();
    expect(screen.queryByRole('tab', { name: 'Task board' })).not.toBeInTheDocument();
  });

  it('probes the board route for the workspace and mounts the panel when available', async () => {
    apiFetch.mockResolvedValue({ ok: true, status: 200 });
    render(<WorkspaceToolsButton workspacePath="/project" />);
    open();
    const tab = await screen.findByRole('tab', { name: 'Task board' });
    expect(apiFetch.mock.calls[0][0]).toBe('/api/workspace/board?path=%2Fproject');
    expect(screen.queryByText('Board for /project')).not.toBeInTheDocument();
    fireEvent.click(tab);
    expect(screen.getByText('Board for /project')).toBeInTheDocument();
  });

  it('does not probe until the tools are opened', () => {
    render(<WorkspaceToolsButton workspacePath="/project" />);
    expect(apiFetch).not.toHaveBeenCalled();
  });
});
