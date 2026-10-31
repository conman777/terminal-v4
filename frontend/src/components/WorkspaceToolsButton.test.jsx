import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { WorkspaceToolsButton } from './WorkspaceToolsButton';
import { useState } from 'react';
import { MobileDrawerContext } from '../contexts/MobileDrawerContext';

vi.mock('./WorkspaceBoardPanel', () => ({ WorkspaceBoardPanel: ({ workspacePath }) => <p>Board workspace: {workspacePath}</p> }));
vi.mock('./WorkspaceGitPanel', () => ({ WorkspaceGitPanel: ({ onStartTask }) => <button onClick={() => onStartTask('/worktree')}>Open managed task</button> }));
vi.mock('./SessionHistorySearch', () => ({ SessionHistorySearch: ({ onSelectSession }) => <button onClick={() => onSelectSession('saved-session')}>Open saved conversation</button> }));
vi.mock('./WorkspaceTasksPanel', () => ({ WorkspaceTasksPanel: ({ currentSessionId }) => {
  const [draft, setDraft] = useState('');
  return <><p>Task parent: {currentSessionId}</p><label>Task prompt<textarea value={draft} onChange={event => setDraft(event.target.value)} /></label></>;
} }));
vi.mock('./WorkspaceProposalsPanel', () => ({ WorkspaceProposalsPanel: ({ latestAssistantText, onRequestSuggestions }) => <button onClick={() => onRequestSuggestions('reviewable prompt')}>{latestAssistantText || 'No assistant response'}</button> }));
vi.mock('./WorkspaceSkillsPanel', () => ({ WorkspaceSkillsPanel: () => <p>Installed skills</p> }));

vi.mock('./FileTransferPanel',()=>({FileTransferPanel:({workspacePath})=><p>Transfer workspace: {workspacePath}</p>}));
vi.mock('./CollaborationPanel',()=>({CollaborationPanel:({sessionId})=><p>Share session: {sessionId}</p>}));
vi.mock('./SessionReplayPanel',()=>({SessionReplayPanel:({sessionId})=><p>Replay session: {sessionId}</p>}));
vi.mock('./WorkspaceRewindPanel', () => ({ WorkspaceRewindPanel: () => <p>Rewind workspace</p> }));
describe('WorkspaceToolsButton', () => {
  it('does not offer the task board while its backend is unavailable', () => {
    render(<WorkspaceToolsButton workspacePath="/project" />);
    fireEvent.click(screen.getByRole('button', { name: 'Workspace tools' }));
    expect(screen.queryByRole('tab', { name: 'Task board' })).not.toBeInTheDocument();
  });
  it('reads the latest completed response when navigation opens the tools', () => {
    let response = 'Earlier answer';
    const readLatestAssistantText = vi.fn(() => response);
    render(<WorkspaceToolsButton workspacePath="/project" initialTool="learning" readLatestAssistantText={readLatestAssistantText} />);
    expect(readLatestAssistantText).not.toHaveBeenCalled();
    response = 'Current completed answer';
    fireEvent.click(screen.getByRole('button', { name: 'Workspace tools' }));
    expect(screen.getByRole('button', { name: 'Current completed answer' })).toBeInTheDocument();
  });
  it('uses a named direct tool trigger and selects the requested desktop panel', () => {
    render(<WorkspaceToolsButton workspacePath="/project" initialTool="history" label="Search history" />);
    const trigger = screen.getByRole('button', { name: 'Search history' });
    expect(trigger).toHaveAttribute('aria-haspopup', 'dialog');
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(trigger);
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('tabpanel')).toHaveAccessibleName('History');
    fireEvent.click(screen.getByRole('button', { name: 'Close workspace tools' }));
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(trigger).toHaveFocus();
  });

  it('supports an icon-only trigger with a custom accessible name', () => {
    render(<WorkspaceToolsButton workspacePath="/project" initialTool="git" label="Git" ariaLabel="Open project Git" iconOnly />);
    const trigger = screen.getByRole('button', { name: 'Open project Git' });
    expect(trigger).toHaveClass('workspace-tools-button-icon-only');
    expect(trigger.querySelector('svg')).toBeInTheDocument();
    expect(trigger).toHaveAttribute('title', 'Open project Git');
  });

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

  it('retains an unsent task draft while switching tools and exposes only the active panel', () => {
    render(<WorkspaceToolsButton workspacePath="/project" />);
    fireEvent.click(screen.getByRole('button', { name: 'Workspace tools' }));
    fireEvent.click(screen.getByRole('tab', { name: 'Tasks & schedules' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Task prompt' }), { target: { value: 'Keep this unsent task' } });
    fireEvent.click(screen.getByRole('tab', { name: 'History' }));
    expect(screen.queryByRole('textbox', { name: 'Task prompt' })).not.toBeInTheDocument();
    expect(screen.getAllByRole('tabpanel')).toHaveLength(1);
    fireEvent.click(screen.getByRole('tab', { name: 'Tasks & schedules' }));
    expect(screen.getByRole('textbox', { name: 'Task prompt' })).toHaveValue('Keep this unsent task');
    expect(screen.getByRole('tabpanel')).toHaveAccessibleName('Tasks & schedules');
  });

  it('wraps dialog focus around visible controls after another tool has been mounted', () => {
    render(<WorkspaceToolsButton workspacePath="/project" />);
    fireEvent.click(screen.getByRole('button', { name: 'Workspace tools' }));
    fireEvent.click(screen.getByRole('tab', { name: 'Tasks & schedules' }));
    fireEvent.click(screen.getByRole('tab', { name: 'History' }));
    const close = screen.getByRole('button', { name: 'Close workspace tools' });
    const last = screen.getByRole('button', { name: 'Open saved conversation' });
    close.focus();
    fireEvent.keyDown(close, { key: 'Tab', shiftKey: true });
    expect(last).toHaveFocus();
    fireEvent.keyDown(last, { key: 'Tab' });
    expect(close).toHaveFocus();
  });
});

describe('WorkspaceToolsButton direct mobile tools', () => {
  const originalWidth = window.innerWidth;
  const originalVisualWidth = window.visualViewport.width;

  beforeEach(() => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 390 });
    window.visualViewport.width = 390;
  });

  afterEach(() => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: originalWidth });
    window.visualViewport.width = originalVisualWidth;
  });

  it('opens Git directly, keeps the full tool index reachable and restores header focus on dismissal', () => {
    render(<WorkspaceToolsButton workspacePath="/project" initialTool="git" label="Git" />);
    const trigger = screen.getByRole('button', { name: 'Git' });
    fireEvent.click(trigger);
    expect(screen.getByRole('dialog')).toHaveAccessibleName('Git & worktrees');
    expect(screen.getByRole('tabpanel')).toHaveAccessibleName('Git & worktrees');
    expect(screen.queryByRole('tablist')).not.toBeInTheDocument();
    const back = screen.getByRole('button', { name: 'All tools' });
    expect(back).toHaveFocus();
    fireEvent.click(back);
    expect(screen.getByRole('tab', { name: 'Git & worktrees' })).toHaveFocus();
    fireEvent.click(screen.getByRole('tab', { name: 'History' }));
    expect(screen.getByRole('dialog')).toHaveAccessibleName('History');
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(screen.getByRole('tab', { name: 'History' })).toHaveFocus();
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
    fireEvent.click(trigger);
    expect(screen.getByRole('dialog')).toHaveAccessibleName('Git & worktrees');
    fireEvent.click(screen.getByRole('dialog').parentElement);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it('retains a task draft after navigating back to the index from a direct tool', () => {
    render(<WorkspaceToolsButton workspacePath="/project" initialTool="tasks" label="Project tasks" currentSessionId="parent-session" />);
    fireEvent.click(screen.getByRole('button', { name: 'Project tasks' }));
    expect(screen.getByText('Task parent: parent-session')).toBeInTheDocument();
    fireEvent.change(screen.getByRole('textbox', { name: 'Task prompt' }), { target: { value: 'Keep mobile draft' } });
    fireEvent.click(screen.getByRole('button', { name: 'All tools' }));
    fireEvent.click(screen.getByRole('tab', { name: 'History' }));
    fireEvent.click(screen.getByRole('button', { name: 'All tools' }));
    fireEvent.click(screen.getByRole('tab', { name: 'Tasks & schedules' }));
    expect(screen.getByRole('textbox', { name: 'Task prompt' })).toHaveValue('Keep mobile draft');
  });

  it('falls back to the grouped index when the requested initial tool is unavailable', () => {
    render(<WorkspaceToolsButton workspacePath="/project" initialTool="unknown-tool" />);
    fireEvent.click(screen.getByRole('button', { name: 'Workspace tools' }));
    expect(screen.getByRole('tablist', { name: 'Workspace tools' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Git & worktrees' })).toHaveFocus();
    expect(screen.queryByRole('tabpanel')).not.toBeInTheDocument();
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

it('shows grouped tool navigation and restores focus when returning to the index', () => {
  const originalWidth = window.innerWidth;
  const originalVisualWidth = window.visualViewport.width;
  window.visualViewport.width = 390;
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 390 });
  render(<WorkspaceToolsButton workspacePath="/project" />);
  fireEvent.click(screen.getByRole('button', { name: 'Workspace tools' }));
  expect(screen.getByRole('tablist', { name: 'Workspace tools' })).toHaveAttribute('aria-orientation', 'vertical');
  expect(screen.getByRole('heading', { name: 'Code & history' })).toBeInTheDocument();
  fireEvent.click(screen.getByRole('tab', { name: 'History' }));
  fireEvent.click(screen.getByRole('button', { name: 'All tools' }));
  expect(screen.getByRole('tab', { name: 'History' })).toHaveFocus();
  window.visualViewport.width = originalVisualWidth;
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: originalWidth });
});

describe('WorkspaceToolsButton inside the mobile drawer', () => {
  it('closes the drawer after the tools are dismissed or an item is chosen', async () => {
    const closeDrawer = vi.fn();
    const view = render(<MobileDrawerContext.Provider value={{ closeDrawer }}><WorkspaceToolsButton workspacePath="/project" initialTool="git" label="Project tools" onStartTask={vi.fn()} /></MobileDrawerContext.Provider>);
    fireEvent.click(screen.getByRole('button', { name: 'Project tools' }));
    expect(closeDrawer).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Close workspace tools' }));
    expect(closeDrawer).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Project tools' }));
    fireEvent.click(screen.getByRole('button', { name: 'Open managed task' }));
    await waitFor(() => expect(closeDrawer).toHaveBeenCalledTimes(2));
    view.unmount();
  });

  it('works without a drawer around it', () => {
    render(<WorkspaceToolsButton workspacePath="/project" initialTool="git" label="Project tools" />);
    fireEvent.click(screen.getByRole('button', { name: 'Project tools' }));
    fireEvent.click(screen.getByRole('button', { name: 'Close workspace tools' }));
    expect(screen.getByRole('button', { name: 'Project tools' })).toHaveFocus();
  });
});
