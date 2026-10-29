import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeAll, afterAll, beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { MobileHeader } from './MobileHeader';
import { setActiveEnvironment } from '../utils/remoteEnvironments';

vi.mock('../contexts/ThemeContext', () => ({
  useTheme: () => ({
    theme: 'dark',
    toggleTheme: vi.fn()
  })
}));

function buildProps(overrides = {}) {
  return {
    activeSessions: [{ id: 'session-1', title: 'Terminal 1', isBusy: false }],
    activeSessionId: 'session-1',
    onSelectSession: vi.fn(),
    onCreateSession: vi.fn(),
    onRenameSession: vi.fn(),
    onCloseSession: vi.fn(),
    onOpenSettings: vi.fn(),
    onOpenApiSettings: vi.fn(),
    onOpenBrowserSettings: vi.fn(),
    onOpenBookmarks: vi.fn(),
    onOpenNotes: vi.fn(),
    onOpenProcessManager: vi.fn(),
    keybarOpen: false,
    onToggleKeybar: vi.fn(),
    projects: [],
    projectsLoading: false,
    onFolderSelect: vi.fn(),
    currentPath: '',
    onAddScanFolder: vi.fn(),
    mobileView: 'terminal',
    onViewChange: vi.fn(),
    previewUrl: '',
    showFileManager: false,
    onToggleFileManager: vi.fn(),
    onNavigateToPath: vi.fn(),
    isNavCollapsed: false,
    sessionActivity: {},
    sessionsGroupedByProject: [],
    showTabStatusLabels: false,
    sessionAiTypes: {},
    onSetSessionAiType: vi.fn(),
    ...overrides
  };
}

describe('MobileHeader', () => {
  it('settles an eligible V4 thread without changing the open conversation', async () => {
    const onUpdateThreadMetadata = vi.fn().mockResolvedValue({});
    const lifecycle = { supported: true, settlementSupported: true, settled: false, canSettle: true, requiresAttention: false };
    const props = buildProps({ activeSessions: [{ id: 'ss-phone', title: 'Phone', runtime: 'v4', status: 'idle', threadLifecycle: lifecycle }], activeSessionId: 'ss-phone', onUpdateThreadMetadata });
    const view = render(<MobileHeader {...props} />);
    fireEvent.click(screen.getByRole('button', { name: 'More actions' }));
    fireEvent.click(screen.getByRole('button', { name: 'Settle thread' }));
    await waitFor(() => expect(onUpdateThreadMetadata).toHaveBeenCalledWith('ss-phone', { settled: true }));
    expect(props.onSelectSession).not.toHaveBeenCalled();
    expect(props.onCloseSession).not.toHaveBeenCalled();
    view.rerender(<MobileHeader {...props} activeSessions={[{ ...props.activeSessions[0], threadLifecycle: { ...lifecycle, settled: true } }]} />);
    fireEvent.click(screen.getByRole('button', { name: 'More actions' }));
    fireEvent.click(screen.getByRole('button', { name: 'Un-settle thread' }));
    await waitFor(() => expect(onUpdateThreadMetadata).toHaveBeenCalledWith('ss-phone', { settled: false }));
  });
  it('keeps a settlement error visible and allows retry', async () => {
    const onUpdateThreadMetadata = vi.fn().mockRejectedValueOnce(new Error('Queue is busy')).mockResolvedValueOnce({});
    const lifecycle = { supported: true, settlementSupported: true, settled: false, canSettle: true, requiresAttention: false };
    const props = buildProps({ activeSessions: [{ id: 'ss-phone', title: 'Phone', runtime: 'v4', status: 'idle', threadLifecycle: lifecycle }], activeSessionId: 'ss-phone', onUpdateThreadMetadata });
    render(<MobileHeader {...props} />);
    fireEvent.click(screen.getByRole('button', { name: 'More actions' }));
    fireEvent.click(screen.getByRole('button', { name: 'Settle thread' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Queue is busy');
    fireEvent.click(screen.getByRole('button', { name: 'Retry settlement change' }));
    await waitFor(() => expect(onUpdateThreadMetadata).toHaveBeenCalledTimes(2));
    expect(props.onCloseSession).not.toHaveBeenCalled();
  });
  it('snoozes a supported structured thread without leaving the conversation', async () => {
    const onUpdateThreadMetadata = vi.fn().mockResolvedValue({ snooze: { untilMs: 999999, afterSeq: 0 } });
    const props = buildProps({ activeSessions: [{ id: 'ss-phone', title: 'Phone', threadLifecycle: { supported: true, snoozed: false, requiresAttention: false } }], activeSessionId: 'ss-phone', onUpdateThreadMetadata });
    render(<MobileHeader {...props} />);
    fireEvent.click(screen.getByRole('button', { name: 'More actions' }));
    fireEvent.click(screen.getByRole('button', { name: 'Snooze for one hour' }));
    await waitFor(() => expect(onUpdateThreadMetadata).toHaveBeenCalledWith('ss-phone', { snoozeForSeconds: 3600 }));
    expect(props.onSelectSession).not.toHaveBeenCalled();
    expect(props.onCloseSession).not.toHaveBeenCalled();
  });
  it('provides sign out in mobile settings and closes navigation without changing the active thread', () => {
    const onLogout = vi.fn();
    const props = buildProps({ onLogout });
    render(<MobileHeader {...props} />);
    fireEvent.click(screen.getByRole('button', { name: 'Menu' }));
    const drawer = screen.getByRole('dialog', { name: 'Mobile menu' });
    fireEvent.click(within(drawer).getByRole('button', { name: 'Sign out' }));
    expect(onLogout).toHaveBeenCalledTimes(1);
    expect(props.onSelectSession).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog', { name: 'Mobile menu' })).not.toBeInTheDocument();
  });
  it('archives and restores the selected thread without closing or replacing it', async () => {
    const onArchiveSession = vi.fn().mockResolvedValue({ archived: true });
    const onUnarchiveSession = vi.fn().mockResolvedValue({ archived: false });
    const props = buildProps({ onArchiveSession, onUnarchiveSession });
    const view = render(<MobileHeader {...props} />);
    fireEvent.click(screen.getByRole('button', { name: 'More actions' }));
    fireEvent.click(screen.getByRole('button', { name: 'Archive thread' }));
    await waitFor(() => expect(onArchiveSession).toHaveBeenCalledWith('session-1'));
    view.rerender(<MobileHeader {...props} activeSessions={[{ id: 'session-1', title: 'Terminal 1', thread: { archived: true } }]} />);
    expect(view.container.querySelector('.mobile-header-current-thread')).toHaveTextContent('Terminal 1');
    expect(view.container.querySelector('.mobile-header-project-context')).toHaveTextContent('Archived');
    fireEvent.click(screen.getByRole('button', { name: 'More actions' }));
    fireEvent.click(screen.getByRole('button', { name: 'Restore thread' }));
    await waitFor(() => expect(onUnarchiveSession).toHaveBeenCalledWith('session-1'));
    expect(props.onCloseSession).not.toHaveBeenCalled();
    expect(props.onSelectSession).not.toHaveBeenCalled();
  });

  it('retains the thread on archive failure and lets the user retry', async () => {
    const onArchiveSession = vi.fn().mockRejectedValueOnce(new Error('Synthetic failure')).mockResolvedValueOnce({ archived: true });
    render(<MobileHeader {...buildProps({ onArchiveSession, onUnarchiveSession: vi.fn() })} />);
    fireEvent.click(screen.getByRole('button', { name: 'More actions' }));
    fireEvent.click(screen.getByRole('button', { name: 'Archive thread' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Synthetic failure');
    fireEvent.click(screen.getByRole('button', { name: 'Retry archive' }));
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
    expect(onArchiveSession).toHaveBeenCalledTimes(2);
  });

  it('ignores an archive failure after the environment changes', async () => {
    let reject;
    const onArchiveSession = vi.fn(() => new Promise((_, fail) => { reject = fail; }));
    render(<MobileHeader {...buildProps({ onArchiveSession, onUnarchiveSession: vi.fn() })} />);
    fireEvent.click(screen.getByRole('button', { name: 'More actions' }));
    fireEvent.click(screen.getByRole('button', { name: 'Archive thread' }));
    act(() => setActiveEnvironment({ id: 'archive-test-environment' }));
    await act(async () => reject(new Error('Stale archive failure')));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    act(() => setActiveEnvironment(null));
  });

  it('pins and unpins the selected thread with existing metadata callbacks', async () => {
    const onPinSession = vi.fn().mockResolvedValue({ pinned: true });
    const onUnpinSession = vi.fn().mockResolvedValue({ pinned: false });
    const props = buildProps({ onPinSession, onUnpinSession });
    const view = render(<MobileHeader {...props} />);
    fireEvent.click(screen.getByRole('button', { name: 'More actions' }));
    fireEvent.click(screen.getByRole('button', { name: 'Pin thread' }));
    await waitFor(() => expect(onPinSession).toHaveBeenCalledWith('session-1'));
    view.rerender(<MobileHeader {...props} activeSessions={[{ id: 'session-1', title: 'Terminal 1', thread: { pinned: true } }]} />);
    fireEvent.click(screen.getByRole('button', { name: 'More actions' }));
    fireEvent.click(screen.getByRole('button', { name: 'Unpin thread' }));
    await waitFor(() => expect(onUnpinSession).toHaveBeenCalledWith('session-1'));
  });

  it('prevents duplicate pinning and hides a stale failure after switching threads', async () => {
    let reject;
    const onPinSession = vi.fn(() => new Promise((_, fail) => { reject = fail; }));
    const props = buildProps({ onPinSession, onUnpinSession: vi.fn(), activeSessions: [{ id: 'session-1', title: 'First' }, { id: 'session-2', title: 'Second' }] });
    const view = render(<MobileHeader {...props} />);
    fireEvent.click(screen.getByRole('button', { name: 'More actions' }));
    fireEvent.click(screen.getByRole('button', { name: 'Pin thread' }));
    fireEvent.click(screen.getByRole('button', { name: 'More actions' }));
    expect(screen.getByRole('button', { name: 'Pin thread' })).toBeDisabled();
    view.rerender(<MobileHeader {...props} activeSessionId="session-2" />);
    await act(async () => reject(new Error('Synthetic failure')));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(onPinSession).toHaveBeenCalledTimes(1);
  });

  it('reports a pin failure and lets the user retry', async () => {
    const onPinSession = vi.fn().mockRejectedValueOnce(new Error('Synthetic failure')).mockResolvedValueOnce({ pinned: true });
    render(<MobileHeader {...buildProps({ onPinSession, onUnpinSession: vi.fn() })} />);
    fireEvent.click(screen.getByRole('button', { name: 'More actions' }));
    fireEvent.click(screen.getByRole('button', { name: 'Pin thread' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Synthetic failure');
    fireEvent.click(screen.getByRole('button', { name: 'Retry pin' }));
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
    expect(onPinSession).toHaveBeenCalledTimes(2);
  });

  it('opens find for the visible structured conversation from More actions', () => {
    const onFindInThread = vi.fn();
    const props = buildProps({ activeSessions: [{ id: 'ss-phone', title: 'Thread' }], activeSessionId: 'ss-phone', onFindInThread });
    const view = render(<MobileHeader {...props} />);
    fireEvent.click(screen.getByRole('button', { name: 'More actions', exact: true }));
    fireEvent.click(screen.getByRole('button', { name: 'Find in thread', exact: true }));
    expect(onFindInThread).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('group', { name: 'More actions' })).not.toBeInTheDocument();
    view.rerender(<MobileHeader {...props} mobileView="preview" />);
    fireEvent.click(screen.getByRole('button', { name: 'More actions', exact: true }));
    expect(screen.queryByRole('button', { name: 'Find in thread', exact: true })).not.toBeInTheDocument();
  });

  it('keeps a menu action available when Safari reports a null focus destination before click', () => {
    const props = buildProps();
    render(<MobileHeader {...props} />);
    fireEvent.click(screen.getByRole('button', { name: 'More actions', exact: true }));
    const menu = screen.getByRole('group', { name: 'More actions', exact: true });
    fireEvent.blur(menu, { relatedTarget: null });
    fireEvent.click(screen.getByRole('button', { name: 'Show keyboard bar', exact: true }));
    expect(props.onToggleKeybar).toHaveBeenCalledTimes(1);
  });
  it('dismisses More actions with Escape and restores its trigger', () => {
    render(<MobileHeader {...buildProps()} />);
    const trigger = screen.getByRole('button', { name: 'More actions' });
    fireEvent.click(trigger);
    expect(screen.getByRole('button', { name: 'New thread' })).toHaveFocus();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(trigger).toHaveFocus();
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
  });

  it('identifies the current conversation in the single-row navigation', () => {
    const { container } = render(<MobileHeader {...buildProps({
      singleRow: true,
      activeSessions: [{ id: 'ss-codex-phone', title: 'Review the terminal UI', runtime: 'codex' }],
      activeSessionId: 'ss-codex-phone'
    })} />);
    expect(container.querySelector('.mobile-header-title-block')).toHaveTextContent('Review the terminal UI');
  });

  const originalResizeObserver = globalThis.ResizeObserver;

  beforeAll(() => {
    globalThis.ResizeObserver = class {
      observe() {}
      disconnect() {}
    };
  });

  afterAll(() => {
    globalThis.ResizeObserver = originalResizeObserver;
  });

  it('opens the drawer on right swipe from the left edge', () => {
    const { container } = render(<MobileHeader {...buildProps()} />);
    const topRow = container.querySelector('.mobile-header-top-row');
    expect(topRow).toBeTruthy();

    expect(screen.queryByRole('dialog', { name: /mobile menu/i })).not.toBeInTheDocument();

    fireEvent.touchStart(topRow, {
      touches: [{ clientX: 10, clientY: 20 }]
    });
    fireEvent.touchEnd(topRow, {
      changedTouches: [{ clientX: 96, clientY: 22 }]
    });

    expect(screen.getByRole('dialog', { name: /mobile menu/i })).toBeInTheDocument();
  });

  it('toggles keybar on vertical swipe in terminal view', () => {
    const onToggleKeybar = vi.fn();
    const { container, rerender } = render(
      <MobileHeader {...buildProps({ keybarOpen: false, onToggleKeybar })} />
    );
    const topRow = container.querySelector('.mobile-header-top-row');
    expect(topRow).toBeTruthy();

    fireEvent.touchStart(topRow, {
      touches: [{ clientX: 180, clientY: 10 }]
    });
    fireEvent.touchEnd(topRow, {
      changedTouches: [{ clientX: 180, clientY: 96 }]
    });
    expect(onToggleKeybar).toHaveBeenCalledTimes(1);

    rerender(<MobileHeader {...buildProps({ keybarOpen: true, onToggleKeybar })} />);
    fireEvent.touchStart(topRow, {
      touches: [{ clientX: 180, clientY: 92 }]
    });
    fireEvent.touchEnd(topRow, {
      changedTouches: [{ clientX: 180, clientY: 12 }]
    });
    expect(onToggleKeybar).toHaveBeenCalledTimes(2);
  });

  it('does not toggle keybar when preview is active', () => {
    const onToggleKeybar = vi.fn();
    const { container } = render(
      <MobileHeader {...buildProps({ mobileView: 'preview', keybarOpen: false, onToggleKeybar })} />
    );
    const topRow = container.querySelector('.mobile-header-top-row');
    expect(topRow).toBeTruthy();

    fireEvent.touchStart(topRow, {
      touches: [{ clientX: 180, clientY: 12 }]
    });
    fireEvent.touchEnd(topRow, {
      changedTouches: [{ clientX: 180, clientY: 98 }]
    });

    expect(onToggleKeybar).not.toHaveBeenCalled();
  });

  it('does not toggle keybar when conversation mode is active', () => {
    const onToggleKeybar = vi.fn();
    const { container } = render(
      <MobileHeader {...buildProps({ chatMode: true, keybarOpen: false, onToggleKeybar })} />
    );
    const topRow = container.querySelector('.mobile-header-top-row');
    expect(topRow).toBeTruthy();

    fireEvent.touchStart(topRow, {
      touches: [{ clientX: 180, clientY: 12 }]
    });
    fireEvent.touchEnd(topRow, {
      changedTouches: [{ clientX: 180, clientY: 98 }]
    });

    expect(onToggleKeybar).not.toHaveBeenCalled();
  });

  it('ignores swipe gestures that start on interactive header controls', () => {
    const onToggleKeybar = vi.fn();
    render(<MobileHeader {...buildProps({ onToggleKeybar })} />);

    const menuButton = screen.getByRole('button', { name: /menu/i });

    fireEvent.touchStart(menuButton, {
      touches: [{ clientX: 10, clientY: 20 }]
    });
    fireEvent.touchEnd(menuButton, {
      changedTouches: [{ clientX: 96, clientY: 22 }]
    });

    expect(screen.queryByRole('dialog', { name: /mobile menu/i })).not.toBeInTheDocument();
    expect(onToggleKeybar).not.toHaveBeenCalled();
  });

  it('shows project context and opens the selected terminal without changing sessions', () => {
    const props = buildProps({ currentPath: '/work/project', mobileView: 'preview' });
    render(<MobileHeader {...props} />);
    expect(screen.getByText('project')).toHaveAttribute('title', '/work/project');
    fireEvent.click(screen.getByRole('button', { name: 'Show terminal' }));
    expect(props.onViewChange).toHaveBeenCalledWith('terminal');
    expect(props.onSelectSession).not.toHaveBeenCalled();
  });

  it('offers to create a terminal from a structured conversation without switching the thread', () => {
    const props = buildProps({ onCreateTerminal: vi.fn(), activeSessions: [{ id: 'ss-codex-phone', title: 'Conversation', runtime: 'codex' }], activeSessionId: 'ss-codex-phone' });
    render(<MobileHeader {...props} />);
    fireEvent.click(screen.getByRole('button', { name: 'New terminal' }));
    expect(props.onCreateTerminal).toHaveBeenCalledTimes(1);
    expect(props.onSelectSession).not.toHaveBeenCalled();
    expect(props.onViewChange).not.toHaveBeenCalled();
  });

  it('toggles the current conversation terminal without opening the generic launcher', () => {
    const props = buildProps({ onCreateTerminal: vi.fn(), onToggleThreadTerminal: vi.fn(), activeSessions: [{ id: 'ss-phone', title: 'Conversation', runtime: 'codex' }], activeSessionId: 'ss-phone' });
    render(<MobileHeader {...props} />);
    fireEvent.click(screen.getByRole('button', { name: 'Show thread terminal' }));
    expect(props.onToggleThreadTerminal).toHaveBeenCalledTimes(1);
    expect(props.onCreateTerminal).not.toHaveBeenCalled();
    expect(props.onSelectSession).not.toHaveBeenCalled();
  });

  it('reveals the complete current thread title and restores focus on dismissal', () => {
    const title = 'Investigate the mobile terminal layout on a narrow phone';
    const props = buildProps({ activeSessions: [{ id: 'ss-phone', title, runtime: 'codex' }], activeSessionId: 'ss-phone', currentPath: '/work/project' });
    render(<MobileHeader {...props} />);
    const trigger = screen.getByRole('button', { name: `Show full thread title: ${title}` });
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(trigger);
    const dialog = screen.getByRole('dialog', { name: 'Thread title' });
    expect(within(dialog).getByText(title)).toBeVisible();
    expect(within(dialog).getByText('/work/project')).toBeVisible();
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: 'Thread title' })).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it('dismisses the revealed title when the user selects another thread', () => {
    const props = buildProps({ activeSessions: [{ id: 'ss-first', title: 'Original thread' }, { id: 'ss-next', title: 'Next thread' }], activeSessionId: 'ss-first' });
    const view = render(<MobileHeader {...props} />);
    fireEvent.click(screen.getByRole('button', { name: 'Show full thread title: Original thread' }));
    view.rerender(<MobileHeader {...props} activeSessionId="ss-next" />);
    expect(screen.queryByRole('dialog', { name: 'Thread title' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Show full thread title: Next thread' })).toBeVisible();
  });

  it('dismisses the title when another header action is chosen without blocking that action', () => {
    const props = buildProps({ activeSessions: [{ id: 'ss-phone', title: 'A long thread title', runtime: 'codex' }], activeSessionId: 'ss-phone' });
    render(<MobileHeader {...props} />);
    fireEvent.click(screen.getByRole('button', { name: 'Show full thread title: A long thread title' }));
    const files = screen.getByRole('button', { name: 'Files' });
    fireEvent.pointerDown(files);
    fireEvent.click(files);
    expect(screen.queryByRole('dialog', { name: 'Thread title' })).not.toBeInTheDocument();
    expect(props.onToggleFileManager).toHaveBeenCalledOnce();
  });

  it('keeps a single row with thread actions and puts the server selector in navigation', () => {
    const { container } = render(<MobileHeader {...buildProps({
      serverControl: <button type="button">Servers</button>,
      onOpenGit: vi.fn(),
    })} />);
    const header = container.querySelector('header');
    expect(within(header).getAllByRole('button').map(button => button.textContent || button.getAttribute('aria-label')))
      .toEqual(['Menu', 'Terminal 1', 'Show terminal', 'Files', 'Git', 'More actions']);
    expect(container.querySelector('.mobile-header-title-block')).toHaveTextContent('Terminal 1');
    expect(container.querySelector('.mobile-header-session-row')).toBeNull();
    expect(screen.queryByRole('tablist')).not.toBeInTheDocument();
    expect(within(header).queryByRole('button', { name: /new terminal/i })).not.toBeInTheDocument();
    fireEvent.click(within(header).getByRole('button', { name: 'Menu' }));
    expect(within(screen.getByRole('dialog', { name: 'Mobile menu' })).getByRole('button', { name: 'Servers' })).toBeVisible();
  });

  it('routes Files and Git without selecting another thread', () => {
    const props = buildProps({ onOpenGit: vi.fn(), showFileManager: true });
    render(<MobileHeader {...props} />);
    const files = within(screen.getByRole('banner')).getByRole('button', { name: 'Files' });
    expect(files).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(files);
    fireEvent.click(screen.getByRole('button', { name: 'Git' }));
    expect(props.onToggleFileManager).toHaveBeenCalledWith();
    expect(props.onOpenGit).toHaveBeenCalledWith();
    expect(props.onSelectSession).not.toHaveBeenCalled();
  });

  it('keeps thread commands in More and creates a thread without the click event', () => {
    const props = buildProps();
    render(<MobileHeader {...props} />);
    fireEvent.click(screen.getByRole('button', { name: 'More actions' }));
    const overflow = screen.getByRole('group', { name: 'More actions' });
    expect(within(overflow).getAllByRole('button').map(button => button.textContent))
      .toEqual(['New thread', 'Rename thread', 'Settling unavailableTerminal sessions cannot be settled: Terminal V4 cannot verify their running processes.', 'Close thread', 'Show keyboard bar']);
    fireEvent.click(within(overflow).getByRole('button', { name: 'New thread' }));
    expect(props.onCreateSession).toHaveBeenCalledWith();
  });

  it('seeds the rename form from the preferred topic and closes the selected thread', async () => {
    const props = buildProps({ activeSessions: [{ id: 'session-1', title: 'Terminal 1', thread: { topic: 'Visible topic' } }] });
    const { container } = render(<MobileHeader {...props} />);
    expect(container.querySelector('.mobile-header-current-thread')).toHaveTextContent('Visible topic');
    fireEvent.click(screen.getByRole('button', { name: 'More actions' }));
    fireEvent.click(screen.getByRole('button', { name: 'Rename thread' }));
    const dialog = screen.getByRole('dialog', {name: 'Rename thread'});
    const input = within(dialog).getByRole('textbox', {name: 'Thread title'});
    expect(input).toHaveValue('Visible topic');
    fireEvent.change(input, {target: {value: '  Revised topic  '}});
    fireEvent.click(within(dialog).getByRole('button', {name: 'Save'}));
    await waitFor(() => expect(screen.queryByRole('dialog', {name: 'Rename thread'})).not.toBeInTheDocument());
    expect(props.onRenameSession).toHaveBeenCalledWith('session-1', 'Revised topic');
    fireEvent.click(screen.getByRole('button', { name: 'More actions' }));
    fireEvent.click(screen.getByRole('button', { name: 'Close thread' }));
    expect(props.onCloseSession).toHaveBeenCalledWith('session-1');
  });

  it('uses the start view title and hides stale thread actions', () => {
    const { container, rerender } = render(<MobileHeader {...buildProps({ isWorkspaceStart: true })} />);
    expect(container.querySelector('.mobile-header-current-thread')).toHaveTextContent('New thread');
    fireEvent.click(screen.getByRole('button', { name: 'More actions' }));
    expect(screen.queryByRole('button', { name: 'Rename thread' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Close thread' })).not.toBeInTheDocument();
    rerender(<MobileHeader {...buildProps({ isWorkspaceStart: true, activeTitle: 'Choose a project' })} />);
    expect(container.querySelector('.mobile-header-current-thread')).toHaveTextContent('Choose a project');
  });

  it('dismisses More on outside pointer and focus movement', () => {
    render(<MobileHeader {...buildProps()} />);
    const trigger = screen.getByRole('button', { name: 'More actions' });
    fireEvent.click(trigger);
    fireEvent.pointerDown(document.body);
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(trigger);
    fireEvent.blur(screen.getByRole('button', { name: 'New thread' }), { relatedTarget: screen.getByRole('button', { name: 'Show terminal' }) });
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
  });

  it('closes stale overflow when the selected thread changes', () => {
    const props = buildProps({ activeSessions: [{ id: 'one', title: 'One' }, { id: 'two', title: 'Two' }], activeSessionId: 'one' });
    const { rerender } = render(<MobileHeader {...props} />);
    fireEvent.click(screen.getByRole('button', { name: 'More actions' }));
    rerender(<MobileHeader {...props} activeSessionId="two" />);
    expect(screen.queryByRole('group', { name: 'More actions' })).not.toBeInTheDocument();
  });

  it('makes Browser, global settings, and project actions reachable in the drawer', () => {
    const props = buildProps({
      onOpenWorkspaceBrowser: vi.fn(),
      workspaceActions: <button type="button">Project knowledge</button>,
    });
    render(<MobileHeader {...props} />);
    fireEvent.click(screen.getByRole('button', { name: 'Menu' }));
    const drawer = screen.getByRole('dialog', { name: 'Mobile menu' });
    for (const name of ['Browser', 'Browser settings', 'API settings', 'Settings', 'Light mode', 'Bookmarks', 'Notes', 'Process Manager', 'Project knowledge', 'New thread']) {
      expect(within(drawer).getByRole('button', { name })).toBeInTheDocument();
    }
    fireEvent.click(within(drawer).getByRole('button', { name: 'Browser' }));
    expect(props.onOpenWorkspaceBrowser).toHaveBeenCalledWith();
    expect(screen.queryByRole('dialog', { name: 'Mobile menu' })).not.toBeInTheDocument();
  });

  it('selects live threads through the drawer and filters archived ones', () => {
    const sessions = [
      { id: 'one', title: 'One' },
      { id: 'two', title: 'Two' },
      { id: 'archived', title: 'Archived', thread: { archived: true } },
    ];
    const props = buildProps({ activeSessions: sessions, activeSessionId: 'one' });
    render(<MobileHeader {...props} />);
    fireEvent.click(screen.getByRole('button', { name: 'Menu' }));
    const drawer = screen.getByRole('dialog', { name: 'Mobile menu' });
    expect(within(drawer).queryByText('Archived')).not.toBeInTheDocument();
    fireEvent.click(within(drawer).getByRole('button', { name: 'Two' }));
    expect(props.onSelectSession).toHaveBeenCalledWith('two');
  });

  it('keeps keyboard entry and preview compact with navigation in the drawer', () => {
    const props = buildProps({ compactForTextEntry: true });
    const { container, rerender } = render(<MobileHeader {...props} />);
    expect(container.querySelector('.mobile-header')).toHaveClass('single-row', 'keyboard-compact');
    rerender(<MobileHeader {...props} mobileView="preview" previewUrl="https://example.com" />);
    expect(container.querySelector('.mobile-header-current-thread')).toHaveTextContent('Preview');
    expect(screen.queryByRole('tablist')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Menu' }));
    fireEvent.click(screen.getByRole('button', { name: 'Workspace' }));
    expect(props.onViewChange).toHaveBeenCalledWith('terminal');
  });
});

describe('MobileHeader rename recovery', () => {
  beforeEach(() => { vi.spyOn(window, 'prompt').mockReturnValue(null); });
  afterEach(() => { vi.restoreAllMocks(); });

  function openRename() {
    fireEvent.click(screen.getByRole('button', {name: 'More actions', exact: true}));
    fireEvent.click(screen.getByRole('button', {name: 'Rename thread', exact: true}));
    return screen.getByRole('dialog', {name: 'Rename thread'});
  }

  it.each(['failure result', 'rejected promise', 'synchronous throw'])('retains the title after a %s and retries Save', async failureMode => {
    const user = userEvent.setup();
    const error = new Error('Synthetic rename unavailable');
    const onRenameSession = vi.fn().mockImplementationOnce(() => {
      if (failureMode === 'failure result') return {ok: false, error};
      if (failureMode === 'synchronous throw') throw error;
      return Promise.reject(error);
    }).mockResolvedValueOnce(undefined);
    render(<MobileHeader {...buildProps({onRenameSession})} />);
    const dialog = openRename();
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    const input = within(dialog).getByRole('textbox', {name: 'Thread title'});
    expect(input).toHaveFocus();
    await user.clear(input);
    await user.type(input, 'Retained mobile draft{Enter}');
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Synthetic rename unavailable');
    expect(input).toHaveValue('Retained mobile draft');
    expect(input).toHaveAttribute('aria-invalid', 'true');
    await user.click(within(dialog).getByRole('button', {name: 'Save'}));
    await waitFor(() => expect(screen.queryByRole('dialog', {name: 'Rename thread'})).not.toBeInTheDocument());
    expect(onRenameSession.mock.calls).toEqual([['session-1', 'Retained mobile draft'], ['session-1', 'Retained mobile draft']]);
    expect(screen.getByRole('button', {name: 'More actions'})).toHaveFocus();
    expect(window.prompt).not.toHaveBeenCalled();
  });

  it('blocks duplicate pending submits and permits cancelling without accepting a late failure', async () => {
    const user = userEvent.setup();
    let finish;
    const onRenameSession = vi.fn(() => new Promise(resolve => { finish = resolve; }));
    render(<MobileHeader {...buildProps({onRenameSession})} />);
    const dialog = openRename();
    const input = within(dialog).getByRole('textbox', {name: 'Thread title'});
    await user.clear(input);
    await user.type(input, 'Pending mobile draft{Enter}');
    expect(within(dialog).getByRole('button', {name: 'Saving…'})).toBeDisabled();
    expect(input).toHaveAttribute('readonly');
    fireEvent.submit(input.closest('form'));
    expect(onRenameSession.mock.calls).toEqual([['session-1', 'Pending mobile draft']]);
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog', {name: 'Rename thread'})).not.toBeInTheDocument();
    openRename();
    expect(screen.getByRole('textbox', {name: 'Thread title'})).toHaveValue('Terminal 1');
    expect(screen.getByRole('button', {name: 'Saving…'})).toBeDisabled();
    await act(async () => finish({ok: false, error: new Error('Stale failure')}));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByRole('button', {name: 'Save'})).toBeEnabled();
  });

  it.each(['selection', 'removed', 'archived', 'preview', 'start view'])('fences a pending rename after %s changes', async change => {
    let finish;
    const onRenameSession = vi.fn(() => new Promise(resolve => { finish = resolve; }));
    const props = buildProps({onRenameSession, activeSessions: [{id: 'session-1', title: 'Terminal 1'}, {id: 'session-2', title: 'Terminal 2'}]});
    const {rerender} = render(<MobileHeader {...props} />);
    const dialog = openRename();
    fireEvent.change(within(dialog).getByRole('textbox', {name: 'Thread title'}), {target: {value: 'Bound to first session'}});
    fireEvent.click(within(dialog).getByRole('button', {name: 'Save'}));
    const changed = change === 'selection' ? {activeSessionId: 'session-2'}
      : change === 'removed' ? {activeSessions: props.activeSessions.slice(1)}
      : change === 'archived' ? {activeSessions: [{...props.activeSessions[0], thread: {archived: true}}, props.activeSessions[1]]}
      : change === 'preview' ? {mobileView: 'preview'} : {isWorkspaceStart: true};
    rerender(<MobileHeader {...props} {...changed} />);
    expect(screen.queryByRole('dialog', {name: 'Rename thread'})).not.toBeInTheDocument();
    await act(async () => finish({ok: false, error: new Error('Stale failure')}));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(onRenameSession.mock.calls).toEqual([['session-1', 'Bound to first session']]);
  });

  it('keeps focus inside the form, cancels without writing, and preserves drawer Browser navigation', async () => {
    const user = userEvent.setup();
    const props = buildProps({onOpenWorkspaceBrowser: vi.fn()});
    render(<MobileHeader {...props} />);
    const dialog = openRename();
    await user.tab({shift: true});
    expect(within(dialog).getByRole('button', {name: 'Save'})).toHaveFocus();
    await user.tab();
    expect(within(dialog).getByRole('textbox', {name: 'Thread title'})).toHaveFocus();
    await user.click(within(dialog).getByRole('button', {name: 'Cancel'}));
    expect(screen.getByRole('button', {name: 'More actions'})).toHaveFocus();
    expect(props.onRenameSession).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', {name: 'Menu'}));
    await user.click(within(screen.getByRole('dialog', {name: 'Mobile menu'})).getByRole('button', {name: 'Browser', exact: true}));
    expect(props.onOpenWorkspaceBrowser).toHaveBeenCalledWith();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('rejects blank input and enforces the existing 60-character title bound', async () => {
    const props = buildProps();
    render(<MobileHeader {...props} />);
    const dialog = openRename();
    const input = within(dialog).getByRole('textbox', {name: 'Thread title'});
    fireEvent.change(input, {target: {value: '   '}});
    expect(within(dialog).getByRole('button', {name: 'Save'})).toBeDisabled();
    fireEvent.submit(input.closest('form'));
    expect(props.onRenameSession).not.toHaveBeenCalled();
    fireEvent.change(input, {target: {value: '😀'.repeat(61)}});
    fireEvent.submit(input.closest('form'));
    expect(within(dialog).getByRole('alert')).toHaveTextContent('60 characters');
    expect(props.onRenameSession).not.toHaveBeenCalled();
  });
});

describe('MobileHeader close recovery', () => {
  function closeFromMenu() {
    fireEvent.click(screen.getByRole('button', {name: 'More actions', exact: true}));
    fireEvent.click(screen.getByRole('button', {name: 'Close thread', exact: true}));
  }

  it('reports a failed close after the menu unmounts and retries the original session', async () => {
    const onCloseSession = vi.fn()
      .mockResolvedValueOnce({ok: false, error: new Error('Synthetic close unavailable')})
      .mockResolvedValueOnce(undefined);
    const props = buildProps({onCloseSession});
    render(<MobileHeader {...props} />);
    closeFromMenu();
    expect(screen.queryByRole('group', {name: 'More actions'})).not.toBeInTheDocument();
    expect(await screen.findByRole('alert')).toHaveTextContent('Synthetic close unavailable');
    expect(screen.getByRole('button', {name: 'Retry'})).toBeEnabled();
    fireEvent.click(screen.getByRole('button', {name: 'Retry'}));
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
    expect(onCloseSession.mock.calls).toEqual([['session-1'], ['session-1']]);
    expect(props.onSelectSession).not.toHaveBeenCalled();
    expect(screen.getByRole('button', {name: 'More actions'})).toHaveFocus();
  });

  it('blocks duplicate pending close attempts while keeping the menu available', async () => {
    let finish;
    const onCloseSession = vi.fn(() => new Promise(resolve => { finish = resolve; }));
    render(<MobileHeader {...buildProps({onCloseSession})} />);
    closeFromMenu();
    expect(screen.getByRole('status')).toHaveTextContent('Closing Terminal 1');
    fireEvent.click(screen.getByRole('button', {name: 'More actions', exact: true}));
    const close = screen.getByRole('button', {name: 'Close thread', exact: true});
    expect(close).toBeDisabled();
    fireEvent.click(close);
    expect(onCloseSession.mock.calls).toEqual([['session-1']]);
    await act(async () => finish({ok: false, error: new Error('Synthetic close unavailable')}));
    expect(screen.getByRole('alert')).toHaveTextContent('Synthetic close unavailable');
    expect(close).toBeEnabled();
  });

  it.each(['rejected promise', 'synchronous throw'])('catches a close %s and permits retry', async failureMode => {
    const error = new Error('Synthetic close rejected');
    const onCloseSession = vi.fn().mockImplementationOnce(() => {
      if (failureMode === 'synchronous throw') throw error;
      return Promise.reject(error);
    }).mockResolvedValueOnce(undefined);
    render(<MobileHeader {...buildProps({onCloseSession})} />);
    closeFromMenu();
    expect(await screen.findByRole('alert')).toHaveTextContent('Synthetic close rejected');
    fireEvent.click(screen.getByRole('button', {name: 'Retry'}));
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
    expect(onCloseSession.mock.calls).toEqual([['session-1'], ['session-1']]);
  });

  it.each(['selection', 'removed', 'archived', 'preview', 'start view', 'drawer', 'selection round trip'])('ignores a late close failure after %s changes', async change => {
    let finish;
    const onCloseSession = vi.fn(() => new Promise(resolve => { finish = resolve; }));
    const props = buildProps({onCloseSession, activeSessions: [{id: 'session-1', title: 'Terminal 1'}, {id: 'session-2', title: 'Terminal 2'}]});
    const {rerender} = render(<MobileHeader {...props} />);
    closeFromMenu();
    if (change === 'drawer') fireEvent.click(screen.getByRole('button', {name: 'Menu', exact: true}));
    else {
      const changed = change === 'selection' || change === 'selection round trip' ? {activeSessionId: 'session-2'}
        : change === 'removed' ? {activeSessions: props.activeSessions.slice(1)}
        : change === 'archived' ? {activeSessions: [{...props.activeSessions[0], thread: {archived: true}}, props.activeSessions[1]]}
        : change === 'preview' ? {mobileView: 'preview'} : {isWorkspaceStart: true};
      rerender(<MobileHeader {...props} {...changed} />);
      if (change === 'selection round trip') rerender(<MobileHeader {...props} />);
    }
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    await act(async () => finish({ok: false, error: new Error('Stale close failure')}));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', {name: 'Retry'})).not.toBeInTheDocument();
    expect(onCloseSession.mock.calls).toEqual([['session-1']]);
  });

  it('retires failed retry feedback on selection change and only closes the new thread on an explicit menu action', async () => {
    const onCloseSession = vi.fn().mockResolvedValue({ok: false, error: new Error('Synthetic close failure')});
    const props = buildProps({onCloseSession, activeSessions: [{id: 'session-1', title: 'Terminal 1'}, {id: 'session-2', title: 'Terminal 2'}]});
    const {rerender} = render(<MobileHeader {...props} />);
    closeFromMenu();
    const retry = await screen.findByRole('button', {name: 'Retry'});
    rerender(<MobileHeader {...props} activeSessionId="session-2" />);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    fireEvent.click(retry);
    expect(onCloseSession.mock.calls).toEqual([['session-1']]);
    closeFromMenu();
    expect(await screen.findByRole('alert')).toHaveTextContent('Synthetic close failure');
    expect(onCloseSession.mock.calls).toEqual([['session-1'], ['session-2']]);
  });

  it('dismisses close feedback, returns focus, and preserves rename and drawer Browser actions', async () => {
    const props = buildProps({onCloseSession: vi.fn().mockResolvedValue({ok: false, error: new Error('Synthetic close failure')}), onOpenWorkspaceBrowser: vi.fn()});
    render(<MobileHeader {...props} />);
    closeFromMenu();
    await screen.findByRole('alert');
    fireEvent.click(screen.getByRole('button', {name: 'Dismiss close error'}));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByRole('button', {name: 'More actions'})).toHaveFocus();
    fireEvent.click(screen.getByRole('button', {name: 'More actions', exact: true}));
    fireEvent.click(screen.getByRole('button', {name: 'Rename thread', exact: true}));
    fireEvent.click(within(screen.getByRole('dialog', {name: 'Rename thread'})).getByRole('button', {name: 'Cancel'}));
    fireEvent.click(screen.getByRole('button', {name: 'Menu', exact: true}));
    fireEvent.click(within(screen.getByRole('dialog', {name: 'Mobile menu'})).getByRole('button', {name: 'Browser', exact: true}));
    expect(props.onOpenWorkspaceBrowser).toHaveBeenCalledWith();
    expect(props.onCloseSession.mock.calls).toEqual([['session-1']]);
  });

  it('offers longer snooze choices and a custom time on mobile and keeps the chosen duration on retry', async () => {
    const onUpdateThreadMetadata = vi.fn().mockRejectedValueOnce(new Error('Busy')).mockResolvedValue({});
    const props = buildProps({ activeSessions: [{ id: 'ss-phone', title: 'Phone', threadLifecycle: { supported: true, snoozed: false, requiresAttention: false } }], activeSessionId: 'ss-phone', onUpdateThreadMetadata });
    render(<MobileHeader {...props} />);
    fireEvent.click(screen.getByRole('button', { name: 'More actions' }));
    fireEvent.click(screen.getByRole('button', { name: 'Snooze for 4 hours' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Busy');
    fireEvent.click(screen.getByRole('button', { name: 'Retry snooze change' }));
    await waitFor(() => expect(onUpdateThreadMetadata.mock.calls).toEqual([['ss-phone', { snoozeForSeconds: 14400 }], ['ss-phone', { snoozeForSeconds: 14400 }]]));
    const prompt = vi.spyOn(window, 'prompt').mockReturnValueOnce('2d');
    fireEvent.click(screen.getByRole('button', { name: 'More actions' }));
    fireEvent.click(screen.getByRole('button', { name: 'Snooze for custom time…' }));
    await waitFor(() => expect(onUpdateThreadMetadata).toHaveBeenLastCalledWith('ss-phone', { snoozeForSeconds: 172800 }));
    prompt.mockReturnValueOnce('0');
    fireEvent.click(screen.getByRole('button', { name: 'More actions' }));
    fireEvent.click(screen.getByRole('button', { name: 'Snooze for custom time…' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('between 1 minute and 30 days');
    expect(onUpdateThreadMetadata).toHaveBeenCalledTimes(3);
  });

  it('shows the visible reason a native session cannot be settled', () => {
    const props = buildProps({ activeSessions: [{ id: 'ss-native', title: 'Native', runtime: 'codex', threadLifecycle: { supported: true, settlementSupported: false, requiresAttention: false } }], activeSessionId: 'ss-native', onUpdateThreadMetadata: vi.fn() });
    render(<MobileHeader {...props} />);
    fireEvent.click(screen.getByRole('button', { name: 'More actions' }));
    const item = screen.getByRole('button', { name: /Settling unavailable/ });
    expect(item).toBeDisabled();
    expect(item).toHaveTextContent('Claude and Codex sessions cannot be settled');
  });
});
