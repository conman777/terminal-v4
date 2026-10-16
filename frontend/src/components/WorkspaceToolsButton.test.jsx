import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { WorkspaceToolsButton } from './WorkspaceToolsButton';

vi.mock('./WorkspaceGitPanel', () => ({ WorkspaceGitPanel: ({ onStartTask }) => <button onClick={() => onStartTask('/worktree')}>Open managed task</button> }));
vi.mock('./SessionHistorySearch', () => ({ SessionHistorySearch: ({ onSelectSession }) => <button onClick={() => onSelectSession('saved-session')}>Open saved conversation</button> }));
vi.mock('./WorkspaceTasksPanel', () => ({ WorkspaceTasksPanel: ({ currentSessionId }) => <p>Task parent: {currentSessionId}</p> }));
vi.mock('./WorkspaceProposalsPanel', () => ({ WorkspaceProposalsPanel: ({ latestAssistantText, onRequestSuggestions }) => <button onClick={() => onRequestSuggestions('reviewable prompt')}>{latestAssistantText || 'No assistant response'}</button> }));
vi.mock('./WorkspaceSkillsPanel', () => ({ WorkspaceSkillsPanel: () => <p>Installed skills</p> }));

vi.mock('./FileTransferPanel',()=>({FileTransferPanel:({workspacePath})=><p>Transfer workspace: {workspacePath}</p>}));
vi.mock('./CollaborationPanel',()=>({CollaborationPanel:({sessionId})=><p>Share session: {sessionId}</p>}));
vi.mock('./SessionReplayPanel',()=>({SessionReplayPanel:({sessionId})=><p>Replay session: {sessionId}</p>}));
describe('WorkspaceToolsButton', () => {
  it('routes Git, history, task and learning actions with current workspace context', () => {
    const onStartTask = vi.fn();
    const onSelectSession = vi.fn();
    const onInsertPrompt = vi.fn();
    render(<WorkspaceToolsButton workspacePath="/project" currentSessionId="parent-session" latestAssistantText="Actual response"
      onStartTask={onStartTask} onSelectSession={onSelectSession} onInsertPrompt={onInsertPrompt} />);
    fireEvent.click(screen.getByRole('button', { name: 'Workspace tools' }));
    fireEvent.click(screen.getByText('Open managed task'));
    expect(onStartTask).toHaveBeenCalledWith('/worktree');
    fireEvent.click(screen.getByRole('button', { name: 'Workspace tools' }));
    fireEvent.click(screen.getByRole('tab', { name: 'History' }));
    fireEvent.click(screen.getByText('Open saved conversation'));
    expect(onSelectSession).toHaveBeenCalledWith('saved-session');
    fireEvent.click(screen.getByRole('button', { name: 'Workspace tools' }));
    fireEvent.click(screen.getByRole('tab', { name: 'Tasks & schedules' }));
    expect(screen.getByText('Task parent: parent-session')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('tab', { name: 'Learning' }));
    fireEvent.click(screen.getByText('Actual response'));
    expect(onInsertPrompt).toHaveBeenCalledWith('reviewable prompt');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('disables unavailable workspaces and restores trigger focus after Escape', () => {
    const { rerender } = render(<WorkspaceToolsButton />);
    expect(screen.getByRole('button', { name: 'Workspace tools' })).toBeDisabled();
    rerender(<WorkspaceToolsButton workspacePath="/project" />);
    const trigger = screen.getByRole('button', { name: 'Workspace tools' });
    fireEvent.click(trigger);
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });
});


it('keeps workspace tools open when restoring a saved conversation fails', async () => {
  render(<WorkspaceToolsButton workspacePath="/project" onSelectSession={() => Promise.reject(new Error('Restore failed'))} />);
  fireEvent.click(screen.getByRole('button', { name: 'Workspace tools' }));
  fireEvent.click(screen.getByRole('tab', { name: 'History' }));
  fireEvent.click(screen.getByText('Open saved conversation'));
  expect(await screen.findByRole('alert')).toHaveTextContent('Restore failed');
  expect(screen.getByRole('dialog')).toBeInTheDocument();
});

it('opens transfers, invitations and replay with the current workspace and session',()=>{
 render(<WorkspaceToolsButton workspacePath="/project" currentSessionId="current-session" />);
 fireEvent.click(screen.getByRole('button',{name:'Workspace tools'}));
 fireEvent.click(screen.getByRole('tab',{name:'File transfers'}));expect(screen.getByText('Transfer workspace: /project')).toBeInTheDocument();
 fireEvent.click(screen.getByRole('tab',{name:'Share workspace'}));expect(screen.getByText('Share session: current-session')).toBeInTheDocument();
 fireEvent.click(screen.getByRole('tab',{name:'Session replay'}));expect(screen.getByText('Replay session: current-session')).toBeInTheDocument();
});
