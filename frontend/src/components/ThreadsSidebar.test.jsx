import { beforeEach, describe, it, expect, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import ThreadsSidebar from './ThreadsSidebar';
import userEvent from '@testing-library/user-event';
import { clearTokens, setUser } from '../utils/auth';
import { setActiveEnvironment } from '../utils/remoteEnvironments';

const toggleTheme = vi.fn();
const downloadProjectArchiveMock = vi.fn();
const apiFetch = vi.fn();
vi.mock('../utils/api', () => ({ apiFetch: (...args) => apiFetch(...args) }));

vi.mock('../contexts/ThemeContext', () => ({
  useTheme: () => ({
    theme: 'dark',
    toggleTheme
  })
}));

vi.mock('../utils/projectArchiveDownload', () => ({
  downloadProjectArchive: (...args) => downloadProjectArchiveMock(...args)
}));

vi.mock('./WorkspaceGitPanel', () => ({
  WorkspaceGitPanel: ({ workspacePath, onStartTask }) => <button onClick={() => onStartTask(workspacePath + '/worktree')}>Start worktree task</button>,
}));
vi.mock('./WorkspaceTasksPanel', () => ({
  WorkspaceTasksPanel: ({ currentSessionId, latestAssistantText, onInsertPrompt }) => <>
    <p>Task parent: {currentSessionId}</p>
    <p>Task response: {latestAssistantText}</p>
    <button disabled={!onInsertPrompt} onClick={() => onInsertPrompt('Task context')}>Add task context</button>
  </>,
}));
vi.mock('./WorkspaceProposalsPanel', () => ({
  WorkspaceProposalsPanel: ({ latestAssistantText, onRequestSuggestions }) => <button disabled={!onRequestSuggestions} onClick={() => onRequestSuggestions('Review project suggestions')}>{latestAssistantText}</button>,
}));
vi.mock('./SessionHistorySearch', () => ({
  SessionHistorySearch: ({ onSelectSession }) => <button onClick={() => onSelectSession('saved-conversation')}>Restore saved thread</button>,
}));
vi.mock('../utils/workspaceProfile', async importOriginal => ({
  ...await importOriginal(),
  loadWorkspaceProfile: vi.fn(async () => ({ memory: 'Keep project conventions.', skills: [], defaultAgent: '', selection: {} })),
}));

function buildSession(id, title, overrides = {}) {
  return {
    id,
    title,
    shell: 'claude',
    updatedAt: '2026-03-05T18:00:00.000Z',
    cwd: 'C:\\repo',
    thread: {
      topic: title,
      projectPath: 'C:\\repo',
      ...overrides.thread
    },
    ...overrides
  };
}

function openApps() {
  fireEvent.click(screen.getByRole('button', { name: 'Workspace apps' }));
  return screen.getByRole('menu', { name: 'Workspace apps' });
}

function openProjects() {
  fireEvent.click(screen.getByRole('button', { name: 'Filter threads by project' }));
  return screen.getByRole('dialog', { name: 'Projects' });
}

function buildProps(overrides = {}) {
  return {
    isCollapsed: false,
    workspacePath: 'C:/repo',
    onToggle: vi.fn(),
    sessionsGroupedByProject: [
      {
        projectName: 'terminal v4',
        projectPath: 'C:\\repo',
        sessions: [buildSession('session-1', 'Implement feature'), buildSession('session-2', 'Fix layout')]
      }
    ],
    pinnedSessions: [buildSession('session-3', 'Pinned work', { thread: { pinned: true, topic: 'Pinned work', projectPath: 'C:\\repo' } })],
    archivedSessions: [buildSession('session-4', 'Archived work', { thread: { archived: true, topic: 'Archived work', projectPath: 'C:\\repo' } })],
    activeSessionId: 'session-1',
    sessionActivity: {},
    onSelectSession: vi.fn(),
    onPinSession: vi.fn(),
    onUnpinSession: vi.fn(),
    onArchiveSession: vi.fn(),
    onUnarchiveSession: vi.fn(),
    onTopicChange: vi.fn(),
    onCloseSession: vi.fn(),
    onCreateSession: vi.fn(),
    onCloseProject: vi.fn(),
    projects: [{ path: 'C:\\repo', name: 'terminal v4' }],
    onAddProject: vi.fn(),
    onOpenSettings: vi.fn(),
    onOpenBookmarks: vi.fn(),
    onOpenNotes: vi.fn(),
    showPreview: false,
    onTogglePreview: vi.fn(),
    showFileManager: false,
    onToggleFileManager: vi.fn(),
    logout: vi.fn(),
    ...overrides
  };
}

describe('ThreadsSidebar', () => {
  it('keeps background work visible while approval state may change between polls', () => {
    const session = buildSession('ss-work', 'Background work', { status: 'running', isBusy: true, threadLifecycle: { supported: true, requiresAttention: false } });
    render(<ThreadsSidebar {...buildProps({ sessionsGroupedByProject: [{ projectName: 'Project', projectPath: 'C:\\repo', sessions: [session] }], pinnedSessions: [], archivedSessions: [] })} />);
    expect(screen.queryByRole('button', { name: /Working \(1\)/ })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Select Background work' })).toBeVisible();
  });
  it('groups known background work without hiding selected, pinned, pending or unknown threads', () => {
    const ready = { supported: true, snoozed: false, requiresAttention: false };
    const selected = buildSession('ss-selected', 'Selected work', { status: 'running', isBusy: true, threadLifecycle: ready });
    const pinned = buildSession('ss-pinned', 'Pinned work', { status: 'running', isBusy: true, threadLifecycle: ready, thread: { pinned: true } });
    const working = buildSession('ss-working', 'Background work', { status: 'running', isBusy: true, threadLifecycle: ready });
    const attention = buildSession('ss-attention', 'Needs a response', { status: 'running', isBusy: true, threadLifecycle: { ...ready, requiresAttention: true } });
    const unknown = buildSession('ss-unknown', 'Unknown work', { isBusy: true });
    render(<ThreadsSidebar {...buildProps({ activeSessionId: selected.id, sessionsGroupedByProject: [{ projectName: 'Project', projectPath: 'C:\\repo', sessions: [selected, pinned, working, attention, unknown] }], pinnedSessions: [pinned], archivedSessions: [] })} />);
    expect(screen.getByRole('region', { name: 'Working threads' })).toHaveTextContent('Background work');
    expect(screen.getByRole('button', { name: 'Select Background work' })).toBeVisible();
    for (const title of ['Selected work', 'Pinned work', 'Needs a response', 'Unknown work']) expect(screen.getByRole('button', { name: `Select ${title}` })).toBeVisible();
    fireEvent.change(screen.getByRole('textbox', { name: 'Search threads' }), { target: { value: 'Background' } });
    expect(screen.getByRole('button', { name: 'Select Background work' })).toBeVisible();
  });
  it('retains focus when a selected thread becomes background work', () => {
    const lifecycle = { supported: true, snoozed: false, requiresAttention: false };
    const current = buildSession('ss-current', 'Current work', { status: 'running', isBusy: true, threadLifecycle: lifecycle });
    const other = buildSession('ss-other', 'Other work', { status: 'running', isBusy: true, threadLifecycle: lifecycle });
    const props = buildProps({ activeSessionId: current.id, sessionsGroupedByProject: [{ projectName: 'Project', projectPath: 'C:\\repo', sessions: [current, other] }], pinnedSessions: [], archivedSessions: [] });
    const view = render(<ThreadsSidebar {...props} />);
    screen.getByRole('button', { name: 'Select Current work' }).focus();
    view.rerender(<ThreadsSidebar {...props} activeSessionId="ss-elsewhere" />);
    expect(screen.getByRole('region', { name: 'Working threads' })).toHaveTextContent('Working (2)');
    expect(screen.getByRole('button', { name: 'Select Current work' })).toHaveFocus();
  });
  it('shows only confirmed idle threads in the visible Settled shelf', () => {
    const lifecycle = { supported: true, settlementSupported: true, settled: true, requiresAttention: false, snoozed: false };
    const done = buildSession('ss-done', 'Finished work', { runtime: 'v4', status: 'completed', threadLifecycle: lifecycle });
    const pending = buildSession('ss-pending', 'Needs a response', { runtime: 'v4', status: 'completed', threadLifecycle: { ...lifecycle, requiresAttention: true } });
    const props = buildProps({ sessionsGroupedByProject: [{ projectName: 'Project', projectPath: 'C:\\repo', sessions: [done, pending] }], pinnedSessions: [], archivedSessions: [] });
    const view = render(<ThreadsSidebar {...props} />);
    expect(screen.getByRole('region', { name: 'Settled threads' })).toHaveTextContent('Finished work');
    expect(screen.getByRole('button', { name: 'Select Needs a response' })).toBeVisible();
    const awakened = { ...done, threadLifecycle: { ...lifecycle, settled: false } };
    view.rerender(<ThreadsSidebar {...props} sessionsGroupedByProject={[{ projectName: 'Project', projectPath: 'C:\\repo', sessions: [awakened, pending] }]} />);
    expect(screen.queryByRole('region', { name: 'Settled threads' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Select Finished work' })).toBeVisible();
  });
  it('restores keyboard focus when a thread moves into and out of Settled', () => {
    const lifecycle = { supported: true, settlementSupported: true, settled: false, canSettle: true, requiresAttention: false, snoozed: false };
    const session = buildSession('ss-focus', 'Focused work', { runtime: 'v4', status: 'completed', threadLifecycle: lifecycle });
    const group = current => [{ projectName: 'Project', projectPath: 'C:\\repo', sessions: [current] }];
    const props = buildProps({ sessionsGroupedByProject: group(session), pinnedSessions: [], archivedSessions: [] });
    const view = render(<ThreadsSidebar {...props} />);
    screen.getByRole('button', { name: 'Select Focused work' }).focus();
    view.rerender(<ThreadsSidebar {...props} sessionsGroupedByProject={group({ ...session, threadLifecycle: { ...lifecycle, settled: true } })} />);
    expect(screen.getByRole('button', { name: 'Select Focused work' })).toHaveFocus();
    view.rerender(<ThreadsSidebar {...props} sessionsGroupedByProject={group(session)} />);
    expect(screen.getByRole('button', { name: 'Select Focused work' })).toHaveFocus();
  });
  it('returns cached settled threads to the main list when inventory is unavailable', () => {
    const lifecycle = { supported: true, settlementSupported: true, settled: true, requiresAttention: false, snoozed: false };
    const session = buildSession('ss-stale', 'Stale work', { runtime: 'v4', status: 'idle', threadLifecycle: lifecycle });
    render(<ThreadsSidebar {...buildProps({ sessionLoadError: true, sessionsGroupedByProject: [{ projectName: 'Project', projectPath: 'C:\\repo', sessions: [session] }], pinnedSessions: [], archivedSessions: [] })} />);
    expect(screen.queryByRole('region', { name: 'Settled threads' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Select Stale work' })).toBeVisible();
  });
  it('keeps snoozed threads visible and returns attention threads to the main list', () => {
    const snoozed = buildSession('ss-a', 'Snoozed work', { threadLifecycle: { supported: true, snoozed: true, requiresAttention: false } });
    const props = buildProps({ sessionsGroupedByProject: [{ projectName: 'Project', projectPath: 'C:\\repo', sessions: [snoozed] }], pinnedSessions: [], archivedSessions: [] });
    const view = render(<ThreadsSidebar {...props} />);
    expect(screen.getByRole('region', { name: 'Snoozed threads' })).toHaveTextContent('Snoozed work');
    view.rerender(<ThreadsSidebar {...props} sessionsGroupedByProject={[{ ...props.sessionsGroupedByProject[0], sessions: [{ ...snoozed, threadLifecycle: { supported: true, snoozed: false, requiresAttention: true } }] }]} />);
    expect(screen.queryByRole('region', { name: 'Snoozed threads' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Select Snoozed work' })).toBeVisible();
  });
  it('preserves keyboard focus when a snoozed thread wakes', () => {
    const session = buildSession('ss-a', 'Snoozed work', { threadLifecycle: { supported: true, snoozed: true, requiresAttention: false } });
    const props = buildProps({ sessionsGroupedByProject: [{ projectName: 'Project', projectPath: 'C:\\repo', sessions: [session] }], pinnedSessions: [], archivedSessions: [] });
    const view = render(<ThreadsSidebar {...props} />);
    screen.getByRole('button', { name: 'Select Snoozed work' }).focus();
    view.rerender(<ThreadsSidebar {...props} sessionsGroupedByProject={[{ ...props.sessionsGroupedByProject[0], sessions: [{ ...session, threadLifecycle: { supported: true, snoozed: false, requiresAttention: true } }] }]} />);
    expect(screen.getByRole('button', { name: 'Select Snoozed work' })).toHaveFocus();
  });
  it('does not wake a snoozed running thread merely because it has unread output', () => {
    const session = buildSession('ss-a', 'Snoozed work', { threadLifecycle: { supported: true, snoozed: true, requiresAttention: false } });
    render(<ThreadsSidebar {...buildProps({ sessionsGroupedByProject: [{ projectName: 'Project', projectPath: 'C:\\repo', sessions: [session] }], pinnedSessions: [], archivedSessions: [], sessionActivity: { 'ss-a': { isBusy: true, needsAttention: true } } })} />);
    expect(screen.getByRole('region', { name: 'Snoozed threads' })).toHaveTextContent('Snoozed work');
  });
  it('does not present a failed session inventory as an empty thread list', () => {
    const props = buildProps({ sessionsGroupedByProject: [], pinnedSessions: [], archivedSessions: [], sessionLoadError: true });
    const { rerender } = render(<ThreadsSidebar {...props} />);
    expect(screen.getByText('Thread list may be incomplete')).toBeVisible();
    expect(screen.queryByText('No threads yet')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('0 threads')).not.toBeInTheDocument();
    rerender(<ThreadsSidebar {...buildProps({ sessionLoadError: true })} />);
    expect(screen.getByText('Thread list may be incomplete')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Select Implement feature' })).toBeVisible();
  });
  it('keeps configured custom agents available in project knowledge defaults', async () => {
    render(<ThreadsSidebar {...buildProps({ aiOptions: [{ id: 'custom-provider', label: 'Configured custom agent' }] })} />);
    fireEvent.click(screen.getByRole('button', { name: 'Workspace knowledge' }));
    const defaults = await screen.findByRole('combobox', { name: 'Default agent for new tasks' });
    expect(defaults).toContainElement(screen.getByRole('option', { name: 'Configured custom agent' }));
  });
  beforeEach(() => {
    downloadProjectArchiveMock.mockReset();
    apiFetch.mockReset();
    apiFetch.mockResolvedValue({ ok: true, json: async () => [] });
  });

  it('offers to undo archiving a thread', async () => {
    const props = buildProps({ onArchiveSession: vi.fn().mockResolvedValue(true), onUnarchiveSession: vi.fn().mockResolvedValue(true) });
    render(<ThreadsSidebar {...props} />);
    const first = document.querySelector('.threads-recent .threads-card .threads-session-topic').textContent;
    fireEvent.click(screen.getByRole('button', { name: `Thread actions for ${first}` }));
    await act(async () => { fireEvent.click(screen.getByRole('menuitem', { name: 'Archive' })); });
    fireEvent.click(await screen.findByRole('button', { name: 'Undo' }));
    expect([props.onArchiveSession.mock.calls.length, props.onUnarchiveSession.mock.calls.length, screen.queryByRole('button', { name: 'Undo' })]).toEqual([1, 1, null]);
  });

  it('renders the T3 toolbar row and a flat list of thread cards', () => {
    render(<ThreadsSidebar {...buildProps({ onCreateTerminal: vi.fn() })} />);
    const toolbar = document.querySelector('.pro-sidebar-toolbar');
    expect(['Search threads', 'Filter threads by project', 'Add Project', 'New terminal', 'New thread'].map(name => toolbar.contains(screen.getByRole(name === 'Search threads' ? 'textbox' : 'button', { name, exact: true })))).toEqual([true, true, true, true, true]);
    const cards = [...document.querySelectorAll('.threads-card-list > .threads-recent .threads-card')];
    expect(cards.map(card => [card.querySelector('.threads-card-project').textContent, card.querySelector('.threads-session-topic').textContent])).toEqual([['terminal v4', 'Implement feature'], ['terminal v4', 'Fix layout']]);
    expect(screen.queryByText('Projects')).not.toBeInTheDocument();
  });

  it('keeps settings, project tools, knowledge and apps in one footer icon row', async () => {
    render(<ThreadsSidebar {...buildProps({ onToggleBrowser: vi.fn() })} />);
    const footer = screen.getByRole('button', { name: 'Settings' }).closest('footer');
    expect(['Project tools', 'Workspace knowledge', 'Workspace apps', 'More options'].map(name => footer.contains(screen.getByLabelText(name)))).toEqual([true, true, true, true]);
    const apps = openApps();
    expect([...apps.querySelectorAll('[role="menuitem"]')].map(item => item.textContent)).toEqual(['Browser', 'Files', 'Preview', 'Notes', 'Bookmarks']);
  });

  it('passes current conversation context and insertion actions from sidebar project tools', () => {
    const props = buildProps({ currentSessionId: 'selected-conversation', latestAssistantText: 'Current assistant response', onInsertPrompt: vi.fn(), onSelectHistorySession: vi.fn() });
    render(<ThreadsSidebar {...props} />);
    const tools = screen.getByRole('button', { name: 'Project tools' });
    fireEvent.click(tools);
    fireEvent.click(screen.getByRole('button', { name: 'Start worktree task' }));
    expect(props.onCreateSession.mock.calls).toEqual([['C:/repo/worktree']]);
    fireEvent.click(tools);
    fireEvent.click(screen.getByRole('tab', { name: 'Tasks & schedules' }));
    expect(screen.getByText('Task parent: selected-conversation')).toBeInTheDocument();
    expect(screen.getByText('Task response: Current assistant response')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Add task context' }));
    fireEvent.click(tools);
    fireEvent.click(screen.getByRole('tab', { name: 'Learning' }));
    fireEvent.click(screen.getByRole('button', { name: 'Current assistant response' }));
    expect(props.onInsertPrompt.mock.calls).toEqual([['Task context'], ['Review project suggestions']]);
    fireEvent.click(tools);
    fireEvent.click(screen.getByRole('tab', { name: 'History' }));
    fireEvent.click(screen.getByRole('button', { name: 'Restore saved thread' }));
    expect(props.onSelectHistorySession.mock.calls).toEqual([['saved-conversation']]);
    expect(props.onSelectSession).not.toHaveBeenCalled();
    expect(tools).toHaveFocus();
  });

  it('uses the active session as the default task parent and leaves insertion disabled without a callback', () => {
    render(<ThreadsSidebar {...buildProps()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Project tools' }));
    fireEvent.click(screen.getByRole('tab', { name: 'Tasks & schedules' }));
    expect(screen.getByText('Task parent: session-1')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add task context' })).toBeDisabled();
  });

  it('opens project knowledge from the sidebar and inserts its selected context into the current draft', async () => {
    const onInsertPrompt = vi.fn();
    render(<ThreadsSidebar {...buildProps({ onInsertPrompt })} />);
    const knowledge = screen.getByRole('button', { name: 'Workspace knowledge' });
    fireEvent.click(knowledge);
    expect(await screen.findByLabelText('Project knowledge')).toHaveValue('Keep project conventions.');
    fireEvent.click(screen.getByRole('button', { name: 'Add to prompt' }));
    expect(onInsertPrompt.mock.calls).toEqual([['Workspace knowledge:\nKeep project conventions.']]);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(knowledge).toHaveFocus();
  });

  it('opens the workspace composer from home and new thread without launching a shell', () => {
    const onOpenWorkspaceStart = vi.fn();
    const onCreateSession = vi.fn();
    render(<ThreadsSidebar {...buildProps({ onOpenWorkspaceStart, onCreateSession })} />);
    fireEvent.click(screen.getByRole('button', { name: 'Terminal v4 home' }));
    fireEvent.click(screen.getByRole('button', { name: 'New thread' }));
    expect(onOpenWorkspaceStart).toHaveBeenCalledTimes(2);
    expect(onCreateSession).not.toHaveBeenCalled();
  });

  it('opens each workspace app from the apps menu and closes the menu', async () => {
    const onOpenBookmarks = vi.fn();
    const onOpenNotes = vi.fn();
    const onToggleFileManager = vi.fn();
    const onTogglePreview = vi.fn();
    render(<ThreadsSidebar {...buildProps({ onOpenBookmarks, onOpenNotes, onToggleFileManager, onTogglePreview })} />);
    for (const name of ['Bookmarks', 'Notes', 'Files', 'Preview']) {
      fireEvent.click(openApps().querySelector(`[aria-label="${name}"]`));
      expect(screen.queryByRole('menu', { name: 'Workspace apps' })).not.toBeInTheDocument();
    }
    expect([onOpenBookmarks, onOpenNotes, onToggleFileManager, onTogglePreview].map(fn => fn.mock.calls.length)).toEqual([1, 1, 1, 1]);
  });

  it('renders add project button', () => {
    render(<ThreadsSidebar {...buildProps()} />);

    expect(screen.getByRole('button', { name: 'Add Project' })).toBeInTheDocument();
  });

  it('keeps project actions out of the empty sidebar until a workspace is selected', () => {
    render(<ThreadsSidebar {...buildProps({ workspacePath: null })} />);
    expect(screen.queryByRole('button', { name: 'Project tools' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Workspace knowledge' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add Project' })).toBeEnabled();
  });

  it('keeps New terminal available before a workspace has been selected', () => {
    const onCreateTerminal = vi.fn();
    render(<ThreadsSidebar {...buildProps({ workspacePath: '', projects: [], sessionsGroupedByProject: [], pinnedSessions: [], archivedSessions: [], onCreateTerminal })} />);
    const terminal = screen.getByRole('button', { name: 'New terminal', exact: true });
    expect(terminal.closest('.pro-sidebar-toolbar')).not.toBeNull();
    fireEvent.click(terminal);
    expect(onCreateTerminal).toHaveBeenCalledTimes(1);
  });

  it('renders settings button', () => {
    render(<ThreadsSidebar {...buildProps()} />);

    expect(screen.getByRole('button', { name: 'Settings' })).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText('More options'));
    expect(screen.getByRole('button', { name: 'Toggle Theme' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Logout' })).toBeInTheDocument();
  });

  it('labels every workspace app and keeps account actions in the footer', async () => {
    render(<ThreadsSidebar {...buildProps()} />);
    const apps = openApps();
    expect(['Files', 'Preview', 'Notes', 'Bookmarks'].every(name => apps.textContent.includes(name))).toBe(true);
    expect(screen.getByRole('button', { name: 'Settings' }).closest('footer')).toBeInTheDocument();
    expect(document.querySelector('.pro-sidebar-rail')).not.toBeInTheDocument();
  });

  it('minimizes the expanded sidebar from the panel header', () => {
    const onToggle = vi.fn();
    render(<ThreadsSidebar {...buildProps({ onToggle })} />);

    fireEvent.click(screen.getByRole('button', { name: 'Minimize sidebar' }));

    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it('hides the thread list when collapsed but keeps the rail toggle available', () => {
    render(<ThreadsSidebar {...buildProps({ isCollapsed: true })} />);
    expect(document.querySelector('.threads-card-list')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Show threads' })).toBeInTheDocument();
  });

  it('exposes Archived as a disclosure that opens with Enter and closes with Space', async () => {
    const user = userEvent.setup();
    const props = buildProps();
    render(<ThreadsSidebar {...props} />);
    const disclosure = screen.getByRole('button', { name: 'Archived (1)' });

    expect(disclosure).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('button', { name: 'Select Archived work' })).not.toBeInTheDocument();
    disclosure.focus();
    await user.keyboard('{Enter}');
    expect(disclosure).toHaveAttribute('aria-expanded', 'true');
    await user.click(screen.getByRole('button', { name: 'Select Archived work' }));
    expect(props.onSelectSession.mock.calls).toEqual([['session-4']]);
    disclosure.focus();
    await user.keyboard(' ');
    expect(disclosure).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('button', { name: 'Select Archived work' })).not.toBeInTheDocument();
  });

  it('keeps named collapsed controls reachable by Tab and activates them with Enter', async () => {
    const user = userEvent.setup();
    const props = buildProps({ isCollapsed: true, onOpenWorkspaceStart: vi.fn(), onToggleBrowser: vi.fn() });
    render(<ThreadsSidebar {...props} />);
    const controls = [
      ['Terminal v4 home', props.onOpenWorkspaceStart],
      ['Show threads', props.onToggle],
      ['New thread', props.onOpenWorkspaceStart],
      ['Files', props.onToggleFileManager],
      ['Preview', props.onTogglePreview],
      ['Notes', props.onOpenNotes],
      ['Bookmarks', props.onOpenBookmarks],
      ['Browser', props.onToggleBrowser],
      ['Toggle Theme', toggleTheme],
      ['Settings', props.onOpenSettings],
      ['Logout', props.logout],
    ];

    expect(screen.getByRole('button', { name: 'Show threads' })).toHaveAttribute('aria-expanded', 'false');
    for (const [name, callback] of controls) {
      const callsBefore = callback.mock.calls.length;
      await user.tab();
      expect(screen.getByRole('button', { name })).toHaveFocus();
      await user.keyboard('{Enter}');
      expect(callback).toHaveBeenCalledTimes(callsBefore + 1);
    }
    expect(props.onCreateSession).not.toHaveBeenCalled();
  });

  it('shows empty state when no projects and no sessions', () => {
    render(<ThreadsSidebar {...buildProps({ projects: [], sessionsGroupedByProject: [], pinnedSessions: [], archivedSessions: [] })} />);
    expect(screen.getByText('No threads yet')).toBeInTheDocument();
  });

  it('announces loading instead of claiming there are no threads while sessions load', () => {
    const props = buildProps({ projects: [], sessionsGroupedByProject: [], pinnedSessions: [], archivedSessions: [], sessionsLoading: true });
    const { rerender } = render(<ThreadsSidebar {...props} />);
    expect(screen.getByRole('status')).toHaveTextContent('Loading threads…');
    expect(screen.queryByText('No threads yet')).not.toBeInTheDocument();
    rerender(<ThreadsSidebar {...props} sessionsLoading={false} />);
    expect(screen.getByText('No threads yet')).toBeInTheDocument();
    expect(screen.queryByText('Loading threads…')).not.toBeInTheDocument();
  });

  it('lists manually added projects without sessions in the project filter', () => {
    render(<ThreadsSidebar {...buildProps({ projects: [{ path: 'C:\\manual-project', name: 'manual-project' }], sessionsGroupedByProject: [], pinnedSessions: [], archivedSessions: [] })} />);
    expect(openProjects()).toHaveTextContent('manual-project');
  });

  it('does not duplicate a manual project when a session group uses forward slashes', () => {
    render(<ThreadsSidebar {...buildProps({
      projects: [{ path: 'C:\\repo\\uplifting', name: 'uplifting' }],
      sessionsGroupedByProject: [{ projectName: 'uplifting', projectPath: 'C:/repo/uplifting', sessions: [buildSession('session-1', 'Implement feature', { thread: { projectPath: 'C:/repo/uplifting' } })] }],
      pinnedSessions: [], archivedSessions: []
    })} />);
    expect(screen.getByText('Implement feature')).toBeInTheDocument();
    expect([...openProjects().querySelectorAll('.threads-project-row .threads-project-row-name')].map(row => row.textContent)).toEqual(['uplifting']);
  });

  it('shows threads as soon as they load for an already listed project', () => {
    const { rerender } = render(<ThreadsSidebar {...buildProps({ sessionsGroupedByProject: [], pinnedSessions: [], archivedSessions: [] })} />);
    expect(screen.queryByText('Implement feature')).not.toBeInTheDocument();
    rerender(<ThreadsSidebar {...buildProps({ pinnedSessions: [], archivedSessions: [] })} />);
    expect(screen.getByText('Implement feature')).toBeInTheDocument();
  });

  it('orders threads by most recent activity across projects', () => {
    render(<ThreadsSidebar {...buildProps({
      pinnedSessions: [], archivedSessions: [],
      sessionsGroupedByProject: [
        { projectName: 'alpha', projectPath: '/alpha', sessions: [buildSession('old', 'Older work', { updatedAt: '2026-03-01T10:00:00.000Z', thread: { projectPath: '/alpha' } })] },
        { projectName: 'beta', projectPath: '/beta', sessions: [buildSession('new', 'Newest work', { updatedAt: '2026-03-05T10:00:00.000Z', thread: { projectPath: '/beta' } })] },
      ],
    })} />);
    expect([...document.querySelectorAll('.threads-recent .threads-session-topic')].map(node => node.textContent)).toEqual(['Newest work', 'Older work']);
  });

  it('filters the thread list to one project and back to all projects', () => {
    render(<ThreadsSidebar {...buildProps({
      pinnedSessions: [], archivedSessions: [],
      projects: [],
      sessionsGroupedByProject: [
        { projectName: 'alpha', projectPath: '/alpha', sessions: [buildSession('a', 'Alpha work', { thread: { projectPath: '/alpha' } })] },
        { projectName: 'beta', projectPath: '/beta', sessions: [buildSession('b', 'Beta work', { thread: { projectPath: '/beta' } })] },
      ],
    })} />);
    openProjects();
    fireEvent.click(screen.getByRole('button', { name: 'Show only beta' }));
    const visible = () => [...document.querySelectorAll('.threads-recent .threads-session-topic')].map(node => node.textContent);
    expect(visible()).toEqual(['Beta work']);
    expect(screen.getByRole('button', { name: 'Filter threads by project' })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(screen.getByRole('button', { name: 'Filter threads by project' }));
    fireEvent.click(screen.getByRole('button', { name: 'Show all projects' }));
    expect(visible()).toEqual(['Alpha work', 'Beta work']);
  });


  it('searches thread titles, project names and paths', async () => {
    const user = userEvent.setup();
    const props = buildProps({ pinnedSessions: [], archivedSessions: [], projects: [{ path: '/manual', name: 'Manual project' }] });
    render(<ThreadsSidebar {...props} />);
    const search = screen.getByRole('textbox', { name: 'Search threads' });
    await user.type(search, 'layout');
    expect([...document.querySelectorAll('.threads-recent .threads-session-topic')].map(node => node.textContent)).toEqual(['Fix layout']);
    await user.clear(search);
    await user.type(search, 'terminal v4');
    expect(screen.getByRole('button', { name: 'Select Implement feature' })).toBeInTheDocument();
    await user.clear(search);
    await user.type(search, 'C:\\repo');
    expect(screen.getByRole('button', { name: 'Select Fix layout' })).toBeInTheDocument();
  });


  it('searches saved conversation content and opens the matching session', async () => {
    const onSelectHistorySession = vi.fn();
    apiFetch.mockResolvedValue({ ok: true, json: async () => [{ sessionId: 'saved-1', title: 'Earlier work', snippet: 'Found the compiler fix.', workspacePath: '/repo', kind: 'structured' }] });
    render(<ThreadsSidebar {...buildProps({ onSelectHistorySession })} />);
    fireEvent.change(screen.getByRole('textbox', { name: 'Search threads' }), { target: { value: 'compiler' } });
    const result = await screen.findByRole('button', { name: /Earlier work.*Found the compiler fix/ });
    expect(apiFetch).toHaveBeenCalledWith('/api/workspace/history?q=compiler&limit=20', { signal: expect.any(AbortSignal) });
    fireEvent.click(result);
    expect(onSelectHistorySession).toHaveBeenCalledWith('saved-1');
  });

  it('passes the complete search result through the dedicated navigation callback', async () => {
    const row = { sessionId: 'saved-1', title: 'Earlier work', snippet: 'Found it', matchType: 'message', anchor: { type: 'message', messageId: 'msg-1', role: 'assistant' } };
    const onSelectHistoryResult = vi.fn();
    const onSelectHistorySession = vi.fn();
    apiFetch.mockResolvedValue({ ok: true, json: async () => [row] });
    render(<ThreadsSidebar {...buildProps({ onSelectHistoryResult, onSelectHistorySession })} />);
    fireEvent.change(screen.getByRole('textbox', { name: 'Search threads' }), { target: { value: 'Found' } });
    fireEvent.click(await screen.findByRole('button', { name: /Earlier work.*Found it/ }));
    expect(onSelectHistoryResult).toHaveBeenCalledWith(row);
    expect(onSelectHistorySession).not.toHaveBeenCalled();
  });

  it('discards stale content results when the search changes', async () => {
    let resolveOld;
    apiFetch.mockImplementationOnce(() => new Promise(resolve => { resolveOld = resolve; }))
      .mockResolvedValueOnce({ ok: true, json: async () => [{ sessionId: 'new', title: 'New result', snippet: 'new text', workspacePath: '/repo' }] });
    render(<ThreadsSidebar {...buildProps()} />);
    const input = screen.getByRole('textbox', { name: 'Search threads' });
    fireEvent.change(input, { target: { value: 'old' } });
    await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(1));
    fireEvent.change(input, { target: { value: 'new' } });
    expect(await screen.findByText('new text')).toBeInTheDocument();
    await act(async () => resolveOld({ ok: true, json: async () => [{ sessionId: 'old', title: 'Old result', snippet: 'old text' }] }));
    expect(screen.queryByText('old text')).not.toBeInTheDocument();
  });

  it('clears saved search results on account switch and rejects late responses', async () => {
    act(() => setUser({ id: 'search-account-a' }));
    let resolveOld, oldSignal;
    apiFetch.mockImplementation((url, options) => {
      if (url.startsWith('/api/workspace/history') && !resolveOld) {
        oldSignal = options.signal;
        return new Promise(resolve => { resolveOld = resolve; });
      }
      return Promise.resolve({ ok: true, json: async () => [] });
    });
    const view = render(<ThreadsSidebar {...buildProps()} />);
    fireEvent.change(screen.getByRole('textbox', { name: 'Search threads' }), { target: { value: 'private note' } });
    await waitFor(() => expect(resolveOld).toBeTypeOf('function'));
    act(() => setUser({ id: 'search-account-b' }));
    expect(oldSignal.aborted).toBe(true);
    expect(screen.getByRole('textbox', { name: 'Search threads' })).toHaveValue('');
    await act(async () => resolveOld({ ok: true, json: async () => [{ sessionId: 'old', title: 'Account A result', snippet: 'private note' }] }));
    expect(screen.queryByText('Account A result')).not.toBeInTheDocument();
    view.unmount();
    act(() => clearTokens(true));
  });

  it('clears saved search results immediately when the environment changes', async () => {
    apiFetch.mockImplementation(url => Promise.resolve({ ok: true, json: async () => url.startsWith('/api/workspace/history')
      ? [{ sessionId: 'old', title: 'Home result', snippet: 'needle' }] : [] }));
    const view = render(<ThreadsSidebar {...buildProps()} />);
    fireEvent.change(screen.getByRole('textbox', { name: 'Search threads' }), { target: { value: 'needle' } });
    expect(await screen.findByText('Home result')).toBeInTheDocument();
    act(() => setActiveEnvironment({ id: 'synthetic-remote-search' }));
    expect(screen.queryByText('Home result')).not.toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Search threads' })).toHaveValue('');
    view.unmount();
    act(() => setActiveEnvironment(null));
  });

  it('does not send a pending search to a newly selected environment', async () => {
    const view = render(<ThreadsSidebar {...buildProps()} />);
    fireEvent.change(screen.getByRole('textbox', { name: 'Search threads' }), { target: { value: 'private lookup' } });
    act(() => setActiveEnvironment({ id: 'new-search-environment' }));
    await act(async () => new Promise(resolve => setTimeout(resolve, 400)));
    expect(apiFetch.mock.calls.filter(([url]) => url.startsWith('/api/workspace/history'))).toEqual([]);
    view.unmount();
    act(() => setActiveEnvironment(null));
  });

  it('scopes content search to the selected original project path', async () => {
    render(<ThreadsSidebar {...buildProps({ projects: [], pinnedSessions: [], archivedSessions: [], sessionsGroupedByProject: [{projectName: 'Alpha', projectPath: '/AlphaCase', sessions: [buildSession('a', 'Alpha', {thread: {projectPath: '/AlphaCase'}})]}] })} />);
    openProjects();
    fireEvent.click(screen.getByRole('button', { name: 'Show only Alpha' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Search threads' }), { target: { value: 'compiler' } });
    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith('/api/workspace/history?' + new URLSearchParams({ q: 'compiler', limit: '20', path: '/AlphaCase' }), { signal: expect.any(AbortSignal) }));
  });

  it('does not search all projects when a selected project disappears', async () => {
    const props = buildProps({ projects: [], pinnedSessions: [], archivedSessions: [], sessionsGroupedByProject: [{projectName: 'Alpha', projectPath: '/AlphaCase', sessions: [buildSession('a', 'Alpha', {thread: {projectPath: '/AlphaCase'}})]}] });
    const { rerender } = render(<ThreadsSidebar {...props} />);
    openProjects();
    fireEvent.click(screen.getByRole('button', { name: 'Show only Alpha' }));
    rerender(<ThreadsSidebar {...props} sessionsGroupedByProject={[]} />);
    fireEvent.change(screen.getByRole('textbox', { name: 'Search threads' }), { target: { value: 'compiler' } });
    expect(await screen.findByRole('alert')).toHaveTextContent('Selected project is no longer available');
    expect(apiFetch.mock.calls.filter(([url]) => url.startsWith('/api/workspace/history'))).toEqual([]);
  });

  it('clears content results and ignores an in-flight response', async () => {
    let resolveSearch;
    apiFetch.mockImplementationOnce(() => new Promise(resolve => { resolveSearch = resolve; }));
    render(<ThreadsSidebar {...buildProps()} />);
    fireEvent.change(screen.getByRole('textbox', { name: 'Search threads' }), { target: { value: 'compiler' } });
    await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole('button', { name: 'Clear search' }));
    await act(async () => resolveSearch({ ok: true, json: async () => [{ sessionId: 'old', title: 'Old result', snippet: 'old text' }] }));
    expect(screen.queryByLabelText('Saved conversation results')).not.toBeInTheDocument();
  });

  it('reports content search errors while retaining title matches', async () => {
    apiFetch.mockResolvedValue({ ok: false, json: async () => ({ error: 'History unavailable' }) });
    render(<ThreadsSidebar {...buildProps()} />);
    fireEvent.change(screen.getByRole('textbox', { name: 'Search threads' }), { target: { value: 'layout' } });
    expect(await screen.findByRole('alert')).toHaveTextContent('History unavailable');
    expect(screen.getByRole('button', { name: 'Select Fix layout' })).toBeInTheDocument();
  });

  it('starts a new thread in a project from the project filter with the keyboard', async () => {
    const user = userEvent.setup();
    const props = buildProps({ pinnedSessions: [], archivedSessions: [] });
    render(<ThreadsSidebar {...props} />);
    openProjects();
    screen.getByRole('button', { name: 'New thread in terminal v4' }).focus();
    await user.keyboard('{Enter}');
    expect(props.onCreateSession).toHaveBeenCalledWith('C:\\repo');
  });

  it('lists threads before the footer tools', () => {
    render(<ThreadsSidebar {...buildProps()} />);
    const list = document.querySelector('.threads-card-list');
    expect(list.compareDocumentPosition(screen.getByRole('button', { name: 'Workspace apps' })) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('renders pinned section when pinned sessions exist', () => {
    render(<ThreadsSidebar {...buildProps()} />);

    expect(screen.getByText('Pinned')).toBeInTheDocument();
  });

  it('shows a pinned thread only once when it is also in its project session list', () => {
    const pinned = buildSession('pinned', 'Pinned investigation', { thread: { pinned: true, topic: 'Pinned investigation', projectPath: 'C:\\repo' } });
    const other = buildSession('other', 'Other thread');
    render(<ThreadsSidebar {...buildProps({ sessionsGroupedByProject: [{ projectName: 'terminal v4', projectPath: 'C:\\repo', sessions: [pinned, other] }], pinnedSessions: [pinned], archivedSessions: [] })} />);
    expect(screen.getAllByRole('button', { name: 'Select Pinned investigation' })).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Select Other thread' })).toBeVisible();
    fireEvent.change(screen.getByRole('textbox', { name: 'Search threads' }), { target: { value: 'Pinned' } });
    expect(screen.getAllByRole('button', { name: 'Select Pinned investigation' })).toHaveLength(1);
  });

  it('calls onCloseProject with the project path and session ids', () => {
    const onCloseProject = vi.fn();
    render(<ThreadsSidebar {...buildProps({ onCloseProject })} />);
    openProjects();
    fireEvent.click(screen.getByRole('button', { name: 'Close project terminal v4' }));
    expect(onCloseProject).toHaveBeenCalledWith('C:\\repo', ['session-1', 'session-2', 'session-3', 'session-4']);
  });

  it('downloads a zipped project from the project filter', () => {
    render(<ThreadsSidebar {...buildProps()} />);
    openProjects();
    fireEvent.click(screen.getByRole('button', { name: 'Zip and download terminal v4' }));
    expect(downloadProjectArchiveMock).toHaveBeenCalledWith('C:\\repo');
  });

  it('reveals archived search results and restores the disclosure after clearing search', async () => {
    const user = userEvent.setup();
    render(<ThreadsSidebar {...buildProps()} />);
    const search = screen.getByRole('textbox', {name: 'Search threads'});
    await user.type(search, 'Archived work');
    expect(screen.getByRole('button', {name: 'Select Archived work'})).toBeInTheDocument();
    await user.click(screen.getByRole('button', {name: 'Clear search'}));
    expect(search).toHaveFocus();
    expect(search).toHaveValue('');
    expect(screen.queryByRole('button', {name: 'Select Archived work'})).not.toBeInTheDocument();
  });

  it('labels empty search results accurately and clears them with Escape', async () => {
    const user = userEvent.setup();
    render(<ThreadsSidebar {...buildProps()} />);
    const search = screen.getByRole('textbox', {name: 'Search threads'});
    await user.type(search, 'unmatched query');
    expect(screen.getByText('No matching thread names or projects')).toBeInTheDocument();
    await user.keyboard('{Escape}');
    expect(screen.getByRole('button', {name: 'Select Implement feature'})).toBeInTheDocument();
    expect(search).toHaveValue('');
  });



});


describe('ThreadsSidebar project close scope', () => {
  it('closes complete owned project membership when search only renders one thread', () => {
    const owned = [buildSession('one', 'Amber'), buildSession('two', 'Violet')];
    const archived = buildSession('archived', 'Archive', {thread: {archived: true, projectPath: 'C:/repo'}});
    const pinned = buildSession('pinned', 'Pin', {thread: {pinned: true, projectPath: 'C:/repo'}});
    const onCloseProject = vi.fn();
    render(<ThreadsSidebar {...buildProps({ sessionsGroupedByProject: [{projectPath: 'C:/repo', projectName: 'Repo', sessions: owned}, {projectPath: '/outside', projectName: 'Outside', sessions: [buildSession('outside', 'Amber outside')]}], pinnedSessions: [pinned], archivedSessions: [archived], projects: [], onCloseProject })} />);
    fireEvent.change(screen.getByRole('textbox', {name: 'Search threads'}), {target: {value: 'Amber'}});
    expect(screen.queryByText('Violet')).not.toBeInTheDocument();
    openProjects();
    const close = screen.getByRole('button', {name: 'Close project Repo'});
    expect(close.title).toContain('4 threads');
    fireEvent.click(close);
    expect(onCloseProject.mock.calls).toEqual([['C:/repo', ['one', 'two', 'pinned', 'archived']]]);
  });
});
