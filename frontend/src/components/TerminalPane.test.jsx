import { beforeEach, describe, expect, it, vi } from 'vitest';
import userEvent from '@testing-library/user-event';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { setActiveEnvironment, setEnvironmentIdentity } from '../utils/remoteEnvironments';
import { clearTokens, setTokens, setUser } from '../utils/auth';
import { TerminalPane } from './TerminalPane';
import { MobileShell } from './MobileShell';
import { RawInputPending } from './RawInputPending';
import { getSupervisedInputQueues } from '../utils/supervisedRawInputQueue';
import { getNativeFollowupQueue } from '../utils/nativeFollowupQueue';
import { withAttachmentWriteLock } from '../utils/attachmentWriteLock';

const refreshSessionGitStats = vi.fn();
const listSessionGitBranches = vi.fn();
const checkoutSessionGitBranch = vi.fn();
const sendToSession = vi.fn();
const sendRawToSession = vi.fn();
const terminalChatSend = vi.fn(() => ({ queued: false }));
const updateThreadMetadata = vi.fn();
const renameSession = vi.fn();
const createSession = vi.fn();
const restoreSession = vi.fn();
const updateStructuredSessionSelection = vi.fn();
const updateStructuredSessionAccess = vi.fn();
const CODEX_CATALOG = { agents: [{ id: 'codex', label: 'Codex', runtime: 'codex', available: true, status: 'ready',
  models: [{ id: 'gpt-5.6-sol', label: 'GPT-5.6-Sol', default: true }, { id: 'gpt-5.5', label: 'GPT-5.5' }],
  reasoningLevels: ['low', 'medium', 'high', 'xhigh'] }] };
const catalogFetch = vi.fn();
let lastTerminalChatProps = null;
let lastConversationViewProps = null;
let lastStatusBarProps = null;
const structuredSendMessage = vi.fn();
let structuredIsStreaming = false;
let structuredPendingApproval = null;
let browserReviewRequests = [];
let lastBrowserReviewOptions = null;
const decideBrowserReview = vi.fn();
let structuredConnectionState = 'online';
let structuredRequiresCleanup = false;
let lastStructuredOptions = null;
let lastContextProps = null;
let mockRawInputMode = 'legacy';
const unavailableServerQueue = () => ({ status: 'unavailable', snapshot: null, reason: 'fixture', refresh: vi.fn() });
let mockServerQueue = unavailableServerQueue();
const enqueueServerFollowup = vi.fn();
let structuredControlState = { sessionId: null, generation: 0, latestSeq: 0, events: [], truncated: false };
const structuredInterrupt = vi.fn();
let structuredIsInterrupting = false;
let structuredControlError = '';

vi.mock('../hooks/useServerFollowupQueue', () => ({ useServerFollowupQueue: () => mockServerQueue }));
vi.mock('../utils/serverFollowupQueue', () => ({ enqueueServerFollowup: (...args) => enqueueServerFollowup(...args) }));
vi.mock('../hooks/useSupervisedInputCapability', () => ({ useSupervisedInputCapability: () => mockRawInputMode }));

vi.mock('../contexts/TerminalSessionContext', () => ({
  useTerminalSession: () => ({
    refreshSessionGitStats,
    listSessionGitBranches,
    checkoutSessionGitBranch,
    sendToSession,
    sendRawToSession,
    updateThreadMetadata,
    renameSession,
    updateStructuredSessionSelection,
    updateStructuredSessionAccess,
    createSession,
    restoreSession
  })
}));

vi.mock('../utils/api', async importOriginal => {
  const actual = await importOriginal();
  return { ...actual, apiFetch: (url, ...rest) => (String(url).startsWith('/api/agent/catalog') ? catalogFetch(url) : actual.apiFetch(url, ...rest)) };
});

vi.mock('../contexts/AutocorrectContext', () => ({
  useAutocorrect: () => ({
    autocorrectEnabled: true,
    toggleAutocorrect: vi.fn()
  })
}));

vi.mock('../utils/autocorrect', () => ({
  getSpellChecker: vi.fn(async () => ({
    correct: () => true,
    suggest: () => []
  })),
  getTerminalAutocorrectEdit: vi.fn(() => null),
  shouldResetTerminalAutocorrectState: vi.fn(() => false)
}));

vi.mock('./TerminalChat', () => ({
  TerminalChat: (props) => {
    lastTerminalChatProps = props;
    return <div data-testid="terminal-chat" data-session-id={props.sessionId} />;
  }
}));

vi.mock('./DesktopConversationView', () => ({
  DesktopConversationView: (props) => {
    lastConversationViewProps = props;
    return <div data-testid="desktop-conversation-view" />;
  }
}));

vi.mock('./DesktopStatusBar', () => ({
  DesktopStatusBar: (props) => {
    lastStatusBarProps = props;
    return (<div
      data-testid="desktop-status-bar"
      data-connection-state={props.connectionState}
      data-terminal-open={props.isTerminalPanelOpen ? 'true' : 'false'}
      data-terminal-view-mode={props.terminalViewMode}
      data-attachments={JSON.stringify(props.composerAttachments)}
    >
      <textarea
        aria-label="Command composer"
        disabled={props.composerDisabled}
        placeholder={props.composerPlaceholder}
        value={props.composerValue}
        onChange={(event) => props.onComposerChange?.(event.target.value)}
      />
      {props.showTerminalToggle ? (
        <button
          type="button"
          aria-label={props.isTerminalPanelOpen ? 'Hide inline terminal panel' : 'Show inline terminal panel'}
          onClick={() => props.onToggleTerminalPanel?.()}
        >
          {props.isTerminalPanelOpen ? 'Hide Terminal' : 'Open Terminal'}
        </button>
      ) : null}
      {props.showTerminalViewModeToggle ? (
        <div role="group" aria-label="Terminal view mode">
          <button
            type="button"
            aria-label="Show Codex UI"
            aria-pressed={props.terminalViewMode === 'codex' ? 'true' : 'false'}
            onClick={() => {
              if (props.terminalViewMode !== 'codex') {
                props.onToggleTerminalViewMode?.();
              }
            }}
          >
            Codex UI
          </button>
          <button
            type="button"
            aria-label="Show Raw Terminal"
            aria-pressed={props.terminalViewMode === 'terminal' ? 'true' : 'false'}
            onClick={() => {
              if (props.terminalViewMode !== 'terminal') {
                props.onToggleTerminalViewMode?.();
              }
            }}
          >
            Raw Terminal
          </button>
        </div>
      ) : null}
      <button type="button" disabled={props.composerDisabled} onClick={() => props.onComposerSubmit?.(props.composerValue)}>Send composer</button>
      {props.composerSecondaryAction}
    </div>);
  }
}));

vi.mock('../hooks/useMobileChatTurns', () => ({
  useMobileChatTurns: () => ({
    turns: [],
    isLoading: false,
    isSendReady: true,
    handleTurn: vi.fn(),
    handleRegisterSendText: vi.fn(),
    handleChatSend: terminalChatSend,
    handleRawSend: vi.fn()
  })
}));

vi.mock('./ProviderAuthModal', () => ({ ProviderAuthModal: ({ isOpen, onClose, focusProviderId }) => isOpen
  ? <div role="dialog" aria-label="Provider authentication" data-provider={focusProviderId}><button type="button" onClick={onClose}>Close provider settings</button></div> : null }));
vi.mock('./WorkspaceToolsButton', () => ({ WorkspaceToolsButton: props => <span data-testid="workspace-tools-path" data-path={props.workspacePath} /> }));
vi.mock('./WorkspaceProfileButton', () => ({ WorkspaceProfileButton: props => <span data-testid="workspace-knowledge-path" data-path={props.workspacePath} /> }));

vi.mock('./ConversationContextButton', () => ({ ConversationContextButton: props => {
  lastContextProps = props;
  return <section data-testid="context-mount"><button type="button">Context fixture</button><button type="button" disabled={!props.onStopConversation} onClick={() => props.onStopConversation?.()}>Fixture explicit Stop conversation</button></section>;
} }));

vi.mock('./FollowupQueuePanel', () => ({ FollowupQueuePanel: ({ sessionId, onClose }) => <section aria-label="Fixture queue"><span>{sessionId}</span><button onClick={onClose}>Close queue</button></section> }));

vi.mock('../hooks/useStructuredSession', () => ({
  useStructuredSession: options => { lastStructuredOptions = options; return ({
    messages: [],
    currentToolCalls: [],
    pendingApproval: structuredPendingApproval,
    isStreaming: structuredIsStreaming, requiresCleanup: structuredRequiresCleanup,
    connectionState: structuredConnectionState,
    sendMessage: structuredSendMessage,
    interrupt: structuredInterrupt,
    isInterrupting: structuredIsInterrupting, controlError: structuredControlError, controlState: structuredControlState,
    approve: vi.fn()
  }); }
}));
vi.mock('../hooks/useSessionBrowserApprovals', () => ({
  useSessionBrowserApprovals: options => {
    lastBrowserReviewOptions = options;
    return { requests: options.enabled ? browserReviewRequests : [], decide: decideBrowserReview, isDeciding: false, error: '' };
  },
}));

function buildProps(overrides = {}) {
  return {
    pane: { id: 'pane-1', sessionId: 'session-1' },
    isActive: true,
    isFullscreen: false,
    sessions: [{
      id: 'session-1',
      title: 'Claude Terminal',
      isActive: true,
      updatedAt: new Date().toISOString(),
      thread: { gitStats: null, topic: 'Review code' }
    }],
    canSplit: false,
    canClose: false,
    onSessionSelect: vi.fn(),
    onSplit: vi.fn(),
    onClose: vi.fn(),
    onFocus: vi.fn(),
    onFullscreen: vi.fn(),
    showPreview: false,
    keybarOpen: false,
    viewportHeight: 900,
    fontSize: 14,
    webglEnabled: false,
    sessionActivity: {},
    projectInfo: { cwd: 'C:\\repo', gitBranch: 'main' },
    sessionAiTypes: { 'session-1': 'claude' },
    customAiProviders: [],
    onSetSessionAiType: vi.fn(),
    onAddCustomAiProvider: vi.fn(),
    desktopAllowTerminalInput: false,
    currentDesktopId: 'desktop-1',
    fitSignal: 0,
    ...overrides
  };
}

describe('TerminalPane', () => {
  it('forwards optional strict authority to the structured hook and terminal', async () => {
    const legacy = render(<TerminalPane {...buildProps()} />);
    await screen.findByTestId('terminal-chat');
    expect(Object.hasOwn(lastStructuredOptions, 'authLifecycle')).toBe(false);
    expect(Object.hasOwn(lastTerminalChatProps, 'authLifecycle')).toBe(false);
    legacy.unmount();
    const authority = { read: vi.fn() };
    render(<TerminalPane {...buildProps({ authLifecycle: authority, strictReady: false })} />);
    await screen.findByTestId('terminal-chat');
    expect(lastStructuredOptions).toMatchObject({ authLifecycle: authority, strictReady: false });
    expect(lastTerminalChatProps).toMatchObject({ authLifecycle: authority, strictReady: false });
  });
  beforeEach(() => {
    terminalChatSend.mockReset().mockReturnValue({ queued: false });
    setActiveEnvironment(null);
    refreshSessionGitStats.mockReset();
    listSessionGitBranches.mockReset();
    checkoutSessionGitBranch.mockReset();
    sendToSession.mockReset();
    sendRawToSession.mockReset();
    mockRawInputMode = 'legacy';
    mockServerQueue = unavailableServerQueue();
    enqueueServerFollowup.mockReset();
    updateThreadMetadata.mockReset();
    restoreSession.mockReset().mockResolvedValue({ restored: true });
    renameSession.mockReset().mockResolvedValue(undefined);
    updateStructuredSessionSelection.mockReset().mockResolvedValue({});
    updateStructuredSessionAccess.mockReset().mockResolvedValue({});
    catalogFetch.mockReset().mockResolvedValue({ ok: true, json: async () => CODEX_CATALOG });
    window.localStorage.clear();
    lastTerminalChatProps = null;
    lastConversationViewProps = null; lastStatusBarProps = null;
    structuredIsStreaming = false; structuredPendingApproval = null; structuredConnectionState = 'online'; structuredRequiresCleanup = false; lastStructuredOptions = null;
    browserReviewRequests = []; lastBrowserReviewOptions = null; decideBrowserReview.mockReset();
    structuredSendMessage.mockReset().mockResolvedValue({ accepted: true });
    lastContextProps = null; structuredControlState = { sessionId: null, generation: 0, latestSeq: 0, events: [], truncated: false };
    structuredInterrupt.mockReset().mockResolvedValue({ accepted: true }); structuredIsInterrupting = false; structuredControlError = '';
    listSessionGitBranches.mockResolvedValue({ currentBranch: 'main', branches: ['main', 'feature/ui'] });
  });

  it('opens the shared browser from beside the session name and reflects whether it is visible', () => {
    const onToggleBrowser = vi.fn();
    const props = buildProps({ showBrowser: false, onToggleBrowser });
    const { rerender } = render(<TerminalPane {...props} />);
    const button = screen.getByRole('button', { name: 'Toggle browser pane' });
    expect(button.closest('[aria-label="Pane controls"]')).toBeInTheDocument();
    expect(button).toHaveAttribute('title', 'Browser');
    expect(button).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(button);
    expect(onToggleBrowser).toHaveBeenCalledTimes(1);
    expect(terminalChatSend).not.toHaveBeenCalled();
    rerender(<TerminalPane {...props} showBrowser />);
    expect(button).toHaveAttribute('aria-pressed', 'true');
  });

  it('shows the PTY identity, live cwd and honest connection status without replacing the terminal host', async () => {
    const props = buildProps({ sessions: [{ id: 'session-1', title: 'Project shell', cwd: '/repo/project' }] });
    const view = render(<TerminalPane {...props} />);
    await waitFor(() => expect(lastTerminalChatProps).not.toBeNull());
    const host = screen.getByTestId('terminal-chat');
    const header = view.container.querySelector('.ph-bar');
    expect(header).toHaveTextContent('Project shell');
    expect(header).toHaveTextContent('/repo/project');
    expect(header).toHaveTextContent('Connecting');
    act(() => lastTerminalChatProps.onConnectionChange(true));
    act(() => lastTerminalChatProps.onCwdChange('/repo/project/src'));
    expect(header).toHaveTextContent('Connected');
    expect(header).toHaveTextContent('/repo/project/src');
    act(() => lastTerminalChatProps.onConnectionChange(false));
    expect(header).toHaveTextContent('Offline');
    view.rerender(<TerminalPane {...props} showBrowser onToggleBrowser={vi.fn()} fitSignal={1} />);
    expect(screen.getByTestId('terminal-chat')).toBe(host);
    expect(screen.getByLabelText('Command composer')).toBeInTheDocument();
  });

  it('shows structured status with its project breadcrumb and keeps the canonical cwd in its tooltip', () => {
    structuredIsStreaming = true;
    const view = render(<TerminalPane {...buildProps({ pane: { id: 'pane-1', sessionId: 'ss-header' },
      sessions: [{ id: 'ss-header', runtime: 'v4', title: 'Review changes', cwd: '/own/workspace' }] })} />);
    const header = view.container.querySelector('.ph-bar');
    expect(header).toHaveTextContent('Review changes');
    expect(header.querySelector('.ph-project')).toHaveAttribute('title', '/own/workspace');
    expect(header.querySelector('.ph-project-name')).toHaveTextContent('workspace');
    expect(header).toHaveTextContent('Working');
    expect(header.querySelector('.ph-stop-btn')).toBeNull();
    expect(lastStatusBarProps).toMatchObject({ isStreaming: true, onInterrupt: structuredInterrupt });
    expect(header).not.toHaveTextContent('C:\\repo');
  });

  it('opens project files and offers thread actions in an unsplit pane', async () => {
    const onOpenFiles = vi.fn();
    const id = 'ss-breadcrumb';
    const props = buildProps({ pane: { id: 'pane-1', sessionId: id }, isActive: false, canClose: false, onOpenFiles,
      sessions: [{ id, runtime: 'codex', title: 'Review', cwd: '/repo/project', thread: { pinned: false } },
        { id: 'ss-other', title: 'Other', cwd: '/repo/project' }] });
    render(<TerminalPane {...props} />);
    fireEvent.click(screen.getByRole('button', { name: 'Open project in Files' }));
    expect(onOpenFiles).toHaveBeenCalledWith('/repo/project');
    expect(props.onFocus).toHaveBeenCalledWith('pane-1');
    fireEvent.click(screen.getByRole('button', { name: 'Review' }));
    fireEvent.click(screen.getByRole('button', { name: 'Pin thread' }));
    await waitFor(() => expect(updateThreadMetadata).toHaveBeenCalledWith(id, { pinned: true }));
    fireEvent.click(screen.getByRole('button', { name: 'Review' }));
    fireEvent.click(screen.getByRole('button', { name: 'Other' }));
    expect(props.onSessionSelect).toHaveBeenCalledWith('pane-1', 'ss-other');
  });

  it('focuses the requested structured pane before opening Find in thread', () => {
    const onFindInThread = vi.fn();
    const id = 'ss-find-pane';
    const props = buildProps({ pane: { id: 'pane-find', sessionId: id }, isActive: false, onFindInThread,
      sessions: [{ id, runtime: 'v4', title: 'Review', cwd: '/repo' }] });
    render(<TerminalPane {...props} />);
    const trigger = screen.getByRole('button', { name: 'Find in thread', exact: true });
    fireEvent.click(trigger);
    expect(props.onFocus).toHaveBeenCalledWith('pane-find');
    expect(onFindInThread).toHaveBeenCalledWith('pane-find', id, trigger);
    expect(props.onFocus.mock.invocationCallOrder[0]).toBeLessThan(onFindInThread.mock.invocationCallOrder[0]);
  });

  it('does not offer Find in thread for a plain terminal', () => {
    render(<TerminalPane {...buildProps({ onFindInThread: vi.fn() })} />);
    expect(screen.queryByRole('button', { name: 'Find in thread', exact: true })).not.toBeInTheDocument();
  });

  it('prevents repeated pin requests and reports failures for the current thread', async () => {
    let rejectUpdate;
    updateThreadMetadata.mockImplementationOnce(() => new Promise((_, reject) => { rejectUpdate = reject; }));
    const id = 'ss-pin-pending';
    render(<TerminalPane {...buildProps({ pane: { id: 'pane-1', sessionId: id },
      sessions: [{ id, runtime: 'codex', title: 'Pin test', cwd: '/repo' }] })} />);
    fireEvent.click(screen.getByRole('button', { name: 'Pin test' }));
    const pin = screen.getByRole('button', { name: 'Pin thread' });
    fireEvent.click(pin);
    expect(pin).toBeDisabled();
    fireEvent.click(pin);
    expect(updateThreadMetadata).toHaveBeenCalledTimes(1);
    await act(async () => rejectUpdate(new Error('Pin failed')));
    expect(screen.getByRole('alert')).toHaveTextContent('Pin failed');
    expect(pin).toBeEnabled();
  });

  it('renames the thread through the existing title and topic operations', async () => {
    const id = 'ss-rename-crumb';
    render(<TerminalPane {...buildProps({ pane: { id: 'pane-1', sessionId: id },
      sessions: [{ id, runtime: 'codex', title: 'Old title', cwd: '/repo' }] })} />);
    fireEvent.click(screen.getByRole('button', { name: 'Old title' }));
    fireEvent.click(screen.getByRole('button', { name: 'Rename thread' }));
    fireEvent.change(screen.getByLabelText('Thread title'), { target: { value: '  New title  ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save thread title' }));
    await waitFor(() => expect(updateThreadMetadata).toHaveBeenCalledWith(id, { topic: 'New title', topicAutoGenerated: false }));
    expect(renameSession).toHaveBeenCalledWith(id, 'New title');
  });

  it('does not update the topic in a different environment after a delayed pane rename', async () => {
    let resolveRename;
    renameSession.mockImplementationOnce(() => new Promise(resolve => { resolveRename = resolve; }));
    const id = 'ss-rename-scope';
    render(<TerminalPane {...buildProps({ pane: { id: 'pane-1', sessionId: id },
      sessions: [{ id, runtime: 'codex', title: 'Old title', cwd: '/repo' }] })} />);
    fireEvent.click(screen.getByRole('button', { name: 'Old title' }));
    fireEvent.click(screen.getByRole('button', { name: 'Rename thread' }));
    fireEvent.change(screen.getByLabelText('Thread title'), { target: { value: 'New title' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save thread title' }));
    await waitFor(() => expect(resolveRename).toBeTypeOf('function'));
    act(() => setActiveEnvironment({ id: 'different-host', capabilities: { agentExecute: true } }));
    await act(async () => resolveRename());
    expect(updateThreadMetadata).not.toHaveBeenCalled();
  });

  it('keeps a pin request locked when navigating away and back before it settles', async () => {
    let resolveUpdate;
    updateThreadMetadata.mockImplementationOnce(() => new Promise(resolve => { resolveUpdate = resolve; }));
    const sessions = [{ id: 'ss-lock', runtime: 'codex', title: 'Locked', cwd: '/repo' }, { id: 'ss-away', title: 'Away', cwd: '/repo' }];
    const props = buildProps({ pane: { id: 'pane-1', sessionId: 'ss-lock' }, sessions });
    const view = render(<TerminalPane {...props} />);
    fireEvent.click(screen.getByRole('button', { name: 'Locked' }));
    fireEvent.click(screen.getByRole('button', { name: 'Pin thread' }));
    view.rerender(<TerminalPane {...props} pane={{ id: 'pane-1', sessionId: 'ss-away' }} />);
    view.rerender(<TerminalPane {...props} />);
    fireEvent.click(screen.getByRole('button', { name: 'Locked' }));
    expect(screen.getByRole('button', { name: 'Pin thread' })).toBeDisabled();
    expect(updateThreadMetadata).toHaveBeenCalledTimes(1);
    await act(async () => resolveUpdate());
  });

  it('lets agent chats choose how much they may do without asking', async () => {
    const accessChoices = (sessionId, session) => {
      const view = render(<TerminalPane {...buildProps({ pane: { id: 'pane-1', sessionId }, sessions: [{ id: sessionId, title: 'Fix it', cwd: '/repo', ...session }] })} />);
      const host = render(lastStatusBarProps.composerSecondaryAction);
      const controls = within(host.container);
      const trigger = controls.getByRole('button', { name: 'Access' });
      fireEvent.click(trigger);
      const choices = controls.getAllByRole('menuitemradio').map(item => item.querySelector('span span').textContent);
      return { view, host, controls, trigger: trigger.textContent, choices };
    };
    const claude = accessChoices('ss-claude', { aiType: 'claude' });
    fireEvent.click(claude.controls.getAllByRole('menuitemradio')[2]);
    expect([claude.trigger, claude.choices, updateStructuredSessionAccess.mock.calls]).toEqual([
      'Auto-edit', ['Supervised', 'Auto-edit', 'Full access'], [['ss-claude', 'full']],
    ]);
    claude.host.unmount(); claude.view.unmount();
    const codex = accessChoices('ss-codex', { runtime: 'codex', accessMode: 'supervised' });
    expect([codex.trigger, codex.choices, screen.queryByRole('button', { name: 'Launch permissions unavailable' })]).toEqual([
      'Supervised', ['Supervised', 'Auto-edit', 'Full access'], null,
    ]);
  });

  it('sends attached files to Codex as paths it can open', async () => {
    render(<TerminalPane {...buildProps({ pane: { id: 'pane-1', sessionId: 'ss-files' }, sessions: [{ id: 'ss-files', runtime: 'codex', title: 'Review', cwd: '/work' }] })} />);
    const attachmentsEnabled = lastStatusBarProps.attachmentsEnabled;
    act(() => { lastStatusBarProps.onComposerAttachmentAdd({ path: '/work/spec.pdf', name: 'spec.pdf' }); });
    await act(async () => { await lastStatusBarProps.onComposerSubmit('Review the spec'); });
    expect([attachmentsEnabled, structuredSendMessage.mock.calls]).toEqual([true, [['Review the spec\n\nAttached files:\n- /work/spec.pdf']]]);
  });

  it('keeps a conversation’s file attachments when switching sessions and reopening a pane', () => {
    const sessions = [
      { id: 'ss-desktop-files-one', runtime: 'codex', cwd: '/work/one' },
      { id: 'ss-desktop-files-two', runtime: 'codex', cwd: '/work/two' },
    ];
    const props = buildProps({ pane: { id: 'pane-1', sessionId: sessions[0].id }, sessions });
    const view = render(<TerminalPane {...props} />);
    act(() => lastStatusBarProps.onComposerAttachmentAdd({ name: 'first.txt', path: '/work/one/first.txt' }));
    view.rerender(<TerminalPane {...props} pane={{ id: 'pane-1', sessionId: sessions[1].id }} />);
    expect(lastStatusBarProps.composerAttachments).toEqual([]);
    act(() => lastStatusBarProps.onComposerAttachmentAdd({ name: 'second.txt', path: '/work/two/second.txt' }));
    view.rerender(<TerminalPane {...props} />);
    expect(lastStatusBarProps.composerAttachments).toEqual([{ name: 'first.txt', path: '/work/one/first.txt' }]);
    view.unmount();
    render(<TerminalPane {...props} pane={{ id: 'pane-reopened', sessionId: sessions[0].id }} />);
    expect(lastStatusBarProps.composerAttachments).toEqual([{ name: 'first.txt', path: '/work/one/first.txt' }]);
  });

  it('shares attachments between panes and preserves files added while a send is pending', async () => {
    const session = { id: 'ss-desktop-shared-files', runtime: 'codex', cwd: '/work/project' };
    const props = buildProps({ pane: { id: 'first-pane', sessionId: session.id }, sessions: [session] });
    const first = render(<TerminalPane {...props} />);
    const second = render(<TerminalPane {...props} pane={{ id: 'second-pane', sessionId: session.id }} />);
    act(() => lastStatusBarProps.onComposerAttachmentAdd({ name: 'first.txt', path: '/work/project/first.txt' }));
    const displayed = view => JSON.parse(within(view.container).getByTestId('desktop-status-bar').getAttribute('data-attachments'));
    expect([displayed(first), displayed(second)]).toEqual([
      [{ name: 'first.txt', path: '/work/project/first.txt' }],
      [{ name: 'first.txt', path: '/work/project/first.txt' }],
    ]);
    let resolveSend;
    structuredSendMessage.mockImplementationOnce(() => new Promise(resolve => { resolveSend = resolve; }));
    fireEvent.change(within(first.container).getByLabelText('Command composer'), { target: { value: 'Review files' } });
    act(() => { lastStatusBarProps.onComposerSubmit('Review files'); });
    fireEvent.change(within(first.container).getByLabelText('Command composer'), { target: { value: 'A newer draft' } });
    act(() => lastStatusBarProps.onComposerAttachmentAdd({ name: 'later.txt', path: '/work/project/later.txt' }));
    await act(async () => resolveSend({ accepted: true }));
    expect([displayed(first), displayed(second)]).toEqual([
      [{ name: 'later.txt', path: '/work/project/later.txt' }],
      [{ name: 'later.txt', path: '/work/project/later.txt' }],
    ]);
    expect(within(first.container).getByLabelText('Command composer')).toHaveValue('A newer draft');
    expect(structuredSendMessage).toHaveBeenCalledWith('Review files\n\nAttached files:\n- /work/project/first.txt');
  });

  it('does not carry desktop file attachments across account or environment changes', () => {
    const session = { id: 'ss-desktop-scope-files', runtime: 'codex', cwd: '/work/project' };
    render(<TerminalPane {...buildProps({ pane: { id: 'pane-1', sessionId: session.id }, sessions: [session] })} />);
    act(() => lastStatusBarProps.onComposerAttachmentAdd({ name: 'private.txt', path: '/work/project/private.txt' }));
    act(() => setTokens('fixture-access', 'fixture-refresh'));
    expect(lastStatusBarProps.composerAttachments).toEqual([]);
    act(() => lastStatusBarProps.onComposerAttachmentAdd({ name: 'other.txt', path: '/work/project/other.txt' }));
    act(() => setActiveEnvironment({ id: 'another-host', capabilities: { agentExecute: true } }));
    expect(lastStatusBarProps.composerAttachments).toEqual([]);
    act(() => clearTokens(true));
  });

  it('keeps the desktop draft editable and prevents sending when the conversation is unavailable', async () => {
    const session = { id: 'ss-desktop-unavailable', runtime: 'codex', cwd: '/work/project' };
    const props = buildProps({ pane: { id: 'pane-unavailable', sessionId: session.id }, sessions: [session] });
    const view = render(<TerminalPane {...props} />);
    fireEvent.change(screen.getByLabelText('Command composer'), { target: { value: 'Keep this draft' } });
    structuredConnectionState = 'unavailable';
    view.rerender(<TerminalPane {...props} pane={{ ...props.pane }} />);
    expect(screen.getByLabelText('Command composer')).toBeEnabled();
    expect(screen.getByLabelText('Command composer')).toHaveValue('Keep this draft');
    expect(lastStatusBarProps.composerSubmitDisabled).toBe(true);
    await act(async () => { await lastStatusBarProps.onComposerSubmit('Keep this draft'); });
    expect(structuredSendMessage).not.toHaveBeenCalled();
  });

  it('reviews conflicting saved file selections without losing the desktop message', async () => {
    setUser({ id: 'desktop-attachment-conflict-fixture' });
    const session = { id: 'ss-desktop-attachment-conflict-review', runtime: 'codex', cwd: '/work/project' };
    render(<TerminalPane {...buildProps({ pane: { id: 'pane-1', sessionId: session.id }, sessions: [session] })} />);
    fireEvent.change(screen.getByLabelText('Command composer'), { target: { value: 'Keep this message' } });
    await act(async () => { lastStatusBarProps.onComposerAttachmentAdd({ name: 'mine.txt', path: '/work/project/mine.txt' }); });
    const key = Object.keys(localStorage).find(value => value.includes('composerFiles:') && value.includes(session.id));
    const saved = JSON.stringify({ version: 1, sessionId: session.id, items: [{ name: 'saved.txt', path: '/work/project/saved.txt' }] });
    localStorage.setItem(key, saved);
    act(() => window.dispatchEvent(new StorageEvent('storage', { key, newValue: saved, storageArea: localStorage })));
    expect(lastStatusBarProps.composerSubmitDisabled).toBe(true);
    expect(lastStatusBarProps.composerAttachments).toEqual([{ name: 'mine.txt', path: '/work/project/mine.txt' }]);
    fireEvent.click(screen.getByRole('button', { name: 'Review saved files' }));
    expect(screen.getByRole('group', { name: 'Saved file selections' })).toHaveTextContent('/work/project/saved.txt');
    fireEvent.click(screen.getByRole('button', { name: 'Use saved files' }));
    expect(screen.getByLabelText('Command composer')).toHaveValue('Keep this message');
    expect(lastStatusBarProps.composerAttachments).toEqual([{ name: 'saved.txt', path: '/work/project/saved.txt' }]);
    await act(async () => { await lastStatusBarProps.onComposerSubmit('Keep this message'); });
    expect(structuredSendMessage).toHaveBeenCalledWith('Keep this message\n\nAttached files:\n- /work/project/saved.txt');
    act(() => clearTokens(true));
  });

  it('does not send stale desktop file selections when another tab wins the lock first', async () => {
    setUser({ id: 'desktop-attachment-send-lock' });
    const session = { id: 'ss-desktop-attachment-send-lock', runtime: 'codex', cwd: '/work/project' };
    render(<TerminalPane {...buildProps({ pane: { id: 'pane-1', sessionId: session.id }, sessions: [session] })} />);
    fireEvent.change(screen.getByLabelText('Command composer'), { target: { value: 'Keep this message' } });
    await act(async () => { lastStatusBarProps.onComposerAttachmentAdd({ name: 'mine.txt', path: '/work/project/mine.txt' }); });
    let release;
    withAttachmentWriteLock.mockImplementationOnce(action => new Promise(resolve => { release = () => resolve(action()); }));
    let sending;
    act(() => { sending = lastStatusBarProps.onComposerSubmit('Keep this message'); });
    expect(structuredSendMessage).not.toHaveBeenCalled();
    await act(async () => {});
    const key = Object.keys(localStorage).find(value => value.includes('composerFiles:') && value.includes(session.id));
    localStorage.setItem(key, JSON.stringify({ version: 1, sessionId: session.id, items: [{ name: 'theirs.txt', path: '/work/project/theirs.txt' }] }));
    await act(async () => { release(); await sending; });
    expect(structuredSendMessage).not.toHaveBeenCalled();
    expect(screen.getByLabelText('Command composer')).toHaveValue('Keep this message');
    expect(lastStatusBarProps.composerAttachments).toEqual([{ name: 'mine.txt', path: '/work/project/mine.txt' }]);
    expect(screen.getByRole('alert')).toHaveTextContent('changed in another tab');
    act(() => clearTokens(true));
  });

  it('keeps a desktop draft if the conversation stops streaming while file validation waits', async () => {
    setUser({ id: 'desktop-attachment-route-change' });
    structuredIsStreaming = true;
    mockServerQueue = { ...unavailableServerQueue(), status: 'available', snapshot: { revision: 1, mode: 'running', order: [] } };
    const session = { id: 'ss-desktop-attachment-route-change', runtime: 'codex', cwd: '/work/project' };
    const props = buildProps({ pane: { id: 'pane-1', sessionId: session.id }, sessions: [session] });
    const view = render(<TerminalPane {...props} />);
    fireEvent.change(screen.getByLabelText('Command composer'), { target: { value: 'Keep this message' } });
    await act(async () => { lastStatusBarProps.onComposerAttachmentAdd({ name: 'mine.txt', path: '/work/project/mine.txt' }); });
    let release, sending;
    withAttachmentWriteLock.mockImplementationOnce(action => new Promise(resolve => { release = () => resolve(action()); }));
    act(() => { sending = lastStatusBarProps.onComposerSubmit('Keep this message'); });
    structuredIsStreaming = false;
    view.rerender(<TerminalPane {...props} fontSize={15} />);
    await act(async () => { release(); await sending; });
    expect(structuredSendMessage).not.toHaveBeenCalled();
    expect(enqueueServerFollowup).not.toHaveBeenCalled();
    expect(screen.getByLabelText('Command composer')).toHaveValue('Keep this message');
    expect(lastConversationViewProps.conversationNotice).toMatch(/conversation or file selection changed while preparing/i);
    act(() => clearTokens(true));
  });

  it('sends plan-mode messages as plans and implements a finished plan here or in a new thread', async () => {
    const onStartThreadWithPrompt = vi.fn();
    const session = { id: 'ss-plan', aiType: 'claude', title: 'Search', cwd: '/work', model: 'sonnet' };
    render(<TerminalPane {...buildProps({ pane: { id: 'pane-1', sessionId: 'ss-plan' }, sessions: [session], onStartThreadWithPrompt })} />);
    const controls = within(render(lastStatusBarProps.composerSecondaryAction).container);
    fireEvent.click(controls.getByRole('button', { name: 'Plan mode' }));
    await act(async () => { await lastStatusBarProps.onComposerSubmit('Add search'); });
    await act(async () => { await lastConversationViewProps.onImplementPlan('1. Index'); });
    lastConversationViewProps.onImplementPlanInNewThread('1. Index');
    expect([structuredSendMessage.mock.calls.map(call => call[0]), onStartThreadWithPrompt.mock.calls]).toEqual([
      ['[Plan] Add search', 'Implement the plan above.'],
      [['Implement this plan:\n\n1. Index', session]],
    ]);
  });

  it('queues a message sent while the agent is replying and sends it when the reply ends', async () => {
    structuredIsStreaming = true;
    const props = buildProps({ pane: { id: 'pane-1', sessionId: 'ss-queue-claude' }, sessions: [{ id: 'ss-queue-claude', aiType: 'claude', title: 'Q', cwd: '/work' }] });
    const view = render(<TerminalPane {...props} />);
    await act(async () => { await lastStatusBarProps.onComposerSubmit('Also add tests'); });
    const queued = [structuredSendMessage.mock.calls.length, screen.getByRole('status', { name: 'Queued message' }).textContent.includes('Also add tests')];
    structuredIsStreaming = false;
    await act(async () => { view.rerender(<TerminalPane {...props} fontSize={15} />); });
    await waitFor(() => expect(structuredSendMessage.mock.calls.map(call => call[0])).toEqual(['Also add tests']));
    expect([queued, screen.queryByRole('status', { name: 'Queued message' })]).toEqual([[0, true], null]);
  });

  it('sends a message sent mid-turn to the server queue when it exists, never the tab-only queue', async () => {
    structuredIsStreaming = true;
    mockServerQueue = { ...unavailableServerQueue(), status: 'available', snapshot: { revision: 1, mode: 'running', holdReason: null, items: [], order: [] } };
    enqueueServerFollowup.mockResolvedValue({ mode: 'running', queueRevision: 2 });
    const props = buildProps({ pane: { id: 'pane-1', sessionId: 'ss-server-queue' }, sessions: [{ id: 'ss-server-queue', aiType: 'claude', title: 'Q', cwd: '/work' }] });
    render(<TerminalPane {...props} />);
    await act(async () => { await lastStatusBarProps.onComposerSubmit('Also add tests'); });
    expect(enqueueServerFollowup).toHaveBeenCalledWith('ss-server-queue', 'Also add tests');
    expect([structuredSendMessage.mock.calls.length, screen.queryByRole('status', { name: 'Queued message' })]).toEqual([0, null]);
    expect(mockServerQueue.refresh).toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Open follow-up queue' })).toBeInTheDocument();
  });

  it('keeps the draft and shows the failure when the server queue rejects a mid-turn message', async () => {
    structuredIsStreaming = true;
    mockServerQueue = { ...unavailableServerQueue(), status: 'available', snapshot: { revision: 1, mode: 'running', holdReason: null, items: [], order: [] } };
    enqueueServerFollowup.mockRejectedValue(new Error('Queue changed on another device.'));
    const props = buildProps({ pane: { id: 'pane-1', sessionId: 'ss-server-queue-fail' }, sessions: [{ id: 'ss-server-queue-fail', aiType: 'claude', title: 'Q', cwd: '/work' }] });
    render(<TerminalPane {...props} />);
    fireEvent.change(screen.getByLabelText('Command composer'), { target: { value: 'Keep me' } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Send composer' })); });
    await waitFor(() => expect(lastConversationViewProps.conversationNotice).toBe('Queue changed on another device.'));
    expect([screen.getByLabelText('Command composer').value, screen.queryByRole('status', { name: 'Queued message' })]).toEqual(['Keep me', null]);
  });

  it('does not send mid-turn text anywhere while the queue probe is still unknown', async () => {
    structuredIsStreaming = true;
    mockServerQueue = { ...unavailableServerQueue(), status: 'unknown' };
    const props = buildProps({ pane: { id: 'pane-1', sessionId: 'ss-queue-unknown' }, sessions: [{ id: 'ss-queue-unknown', aiType: 'claude', title: 'Q', cwd: '/work' }] });
    render(<TerminalPane {...props} />);
    await act(async () => { await lastStatusBarProps.onComposerSubmit('Wait for the probe'); });
    expect([enqueueServerFollowup.mock.calls.length, structuredSendMessage.mock.calls.length, screen.queryByRole('status', { name: 'Queued message' })]).toEqual([0, 0, null]);
    expect(lastConversationViewProps.conversationNotice).toMatch(/Checking the follow-up queue/);
  });

  it('labels the tab-local queue as tab-only and never replays it once the server queue exists', async () => {
    structuredIsStreaming = false;
    mockServerQueue = { ...unavailableServerQueue(), status: 'available', snapshot: { revision: 1, mode: 'running', holdReason: null, items: [], order: [] } };
    const props = buildProps({ pane: { id: 'pane-1', sessionId: 'ss-tab-only' }, sessions: [{ id: 'ss-tab-only', aiType: 'claude', title: 'Q', cwd: '/work' }] });
    const store = getNativeFollowupQueue('ss-tab-only');
    store.update(current => [...current, { id: 'local-1', text: 'Old tab copy', status: 'queued' }]);
    render(<TerminalPane {...props} />);
    expect(screen.getByRole('status', { name: 'Queued message' })).toHaveTextContent('Tab-only, not sent automatically');
    expect(structuredSendMessage).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Remove queued copy' })).toBeInTheDocument();
  });

  it('labels a fallback tab-local queue as tab-only', async () => {
    structuredIsStreaming = true;
    const props = buildProps({ pane: { id: 'pane-1', sessionId: 'ss-fallback-label' }, sessions: [{ id: 'ss-fallback-label', aiType: 'claude', title: 'Q', cwd: '/work' }] });
    render(<TerminalPane {...props} />);
    await act(async () => { await lastStatusBarProps.onComposerSubmit('Fallback'); });
    expect(screen.getByRole('status', { name: 'Queued message' })).toHaveTextContent('Tab-only queue');
    expect(screen.queryByRole('button', { name: 'Open follow-up queue' })).not.toBeInTheDocument();
  });

  it('retains a queued message after the pane is unmounted and reopened', () => {
    structuredIsStreaming = true;
    const props = buildProps({ pane: { id: 'pane-1', sessionId: 'ss-queue-reopen' }, sessions: [{ id: 'ss-queue-reopen', aiType: 'claude' }] });
    const view = render(<TerminalPane {...props} />);
    fireEvent.change(screen.getByLabelText('Command composer'), { target: { value: 'Keep this queued message' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send composer' }));
    view.unmount();
    render(<TerminalPane {...props} />);
    expect(screen.getByRole('status', { name: 'Queued message' })).toHaveTextContent('Keep this queued message');
    expect(structuredSendMessage).not.toHaveBeenCalled();
  });

  it('holds a restored queue for review until the user resumes it', async () => {
    setEnvironmentIdentity('queue-reload-owner');
    try {
      structuredIsStreaming = true;
      const props = buildProps({ pane: { id: 'pane-1', sessionId: 'ss-queue-reload' }, sessions: [{ id: 'ss-queue-reload', aiType: 'claude' }] });
      const view = render(<TerminalPane {...props} />);
      fireEvent.change(screen.getByLabelText('Command composer'), { target: { value: 'Review before continuing' } });
      fireEvent.click(screen.getByRole('button', { name: 'Send composer' }));
      view.unmount();
      setEnvironmentIdentity('different-owner');
      setEnvironmentIdentity('queue-reload-owner');
      structuredIsStreaming = false;
      render(<TerminalPane {...props} />);
      expect(screen.getByRole('status', { name: 'Queued message' })).toHaveTextContent('Restored for review');
      expect(structuredSendMessage).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole('button', { name: 'Resume queue' }));
      await waitFor(() => expect(structuredSendMessage).toHaveBeenCalledWith('Review before continuing'));
    } finally { setEnvironmentIdentity(null); }
  });

  it('holds the message when acceptance cannot be recorded in browser storage', async () => {
    structuredIsStreaming = true;
    let finish;
    structuredSendMessage.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const props = buildProps({ pane: { id: 'pane-1', sessionId: 'ss-queue-receipt-storage' }, sessions: [{ id: 'ss-queue-receipt-storage', aiType: 'claude' }] });
    const view = render(<TerminalPane {...props} />);
    fireEvent.change(screen.getByLabelText('Command composer'), { target: { value: 'Message with uncertain receipt' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send composer' }));
    structuredIsStreaming = false;
    view.rerender(<TerminalPane {...props} fontSize={15} />);
    await waitFor(() => expect(structuredSendMessage).toHaveBeenCalledTimes(1));
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('quota'); });
    try {
      await act(async () => finish({ accepted: true }));
      expect(screen.getByRole('status', { name: 'Queued message' })).toHaveTextContent('Send unconfirmed');
      expect(screen.getByText(/follow-up queue could not be saved/i)).toBeInTheDocument();
      expect(structuredSendMessage).toHaveBeenCalledTimes(1);
    } finally { setItem.mockRestore(); }
  });

  it('keeps the composer draft when a queued message cannot be saved', () => {
    structuredIsStreaming = true;
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('storage full'); });
    try {
      render(<TerminalPane {...buildProps({ pane: { id: 'pane-1', sessionId: 'ss-queue-no-storage' }, sessions: [{ id: 'ss-queue-no-storage', aiType: 'claude' }] })} />);
      fireEvent.change(screen.getByLabelText('Command composer'), { target: { value: 'Keep my draft' } });
      fireEvent.click(screen.getByRole('button', { name: 'Send composer' }));
      expect(screen.getByLabelText('Command composer')).toHaveValue('Keep my draft');
      expect(screen.queryByRole('status', { name: 'Queued message' })).not.toBeInTheDocument();
      expect(screen.getByText(/follow-up queue could not be saved/i)).toBeInTheDocument();
    } finally { setItem.mockRestore(); }
  });

  it('does not queue the same draft twice if clearing the draft fails', () => {
    structuredIsStreaming = true;
    const original = Storage.prototype.setItem;
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (key, value) {
      if (this === localStorage) throw new Error('local draft storage unavailable');
      return original.call(this, key, value);
    });
    try {
      render(<TerminalPane {...buildProps({ pane: { id: 'pane-1', sessionId: 'ss-queue-draft-clear-fails' }, sessions: [{ id: 'ss-queue-draft-clear-fails', aiType: 'claude' }] })} />);
      fireEvent.change(screen.getByLabelText('Command composer'), { target: { value: 'One intended message' } });
      fireEvent.click(screen.getByRole('button', { name: 'Send composer' }));
      fireEvent.click(screen.getByRole('button', { name: 'Send composer' }));
      expect(screen.getAllByRole('status', { name: 'Queued message' })).toHaveLength(1);
      expect(screen.getByLabelText('Command composer')).toHaveValue('One intended message');
    } finally { setItem.mockRestore(); }
  });

  it('retains an editable queue copy alongside an existing draft and a later transcript', async () => {
    structuredIsStreaming = true;
    render(<TerminalPane {...buildProps({ pane: { id: 'pane-1', sessionId: 'ss-queue-edit-safe' }, sessions: [{ id: 'ss-queue-edit-safe', aiType: 'claude' }] })} />);
    fireEvent.change(screen.getByLabelText('Command composer'), { target: { value: 'Queued original' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send composer' }));
    fireEvent.change(screen.getByLabelText('Command composer'), { target: { value: 'New draft' } });
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    expect(screen.getByLabelText('Command composer')).toHaveValue('New draft\n\nQueued original');
    act(() => lastStatusBarProps.onComposerChange(`${lastStatusBarProps.composerValue} dictated words`));
    expect(screen.getByLabelText('Command composer')).toHaveValue('New draft\n\nQueued original dictated words');
    expect(screen.getByRole('status', { name: 'Queued message' })).toHaveTextContent('Queued original');
    await act(async () => { await lastStatusBarProps.onComposerSubmit('New draft\n\nQueued original dictated words'); });
    expect(screen.getByLabelText('Command composer')).toHaveValue('New draft\n\nQueued original dictated words');
    expect(structuredSendMessage).not.toHaveBeenCalled();
  });

  it('keeps the original if a transcript arrives with a stale composer value during edit', () => {
    structuredIsStreaming = true;
    render(<TerminalPane {...buildProps({ pane: { id: 'pane-1', sessionId: 'ss-edit-transcript' }, sessions: [{ id: 'ss-edit-transcript', aiType: 'claude' }] })} />);
    fireEvent.change(screen.getByLabelText('Command composer'), { target: { value: 'Queued original' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send composer' }));
    fireEvent.change(screen.getByLabelText('Command composer'), { target: { value: 'New draft' } });
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    act(() => lastStatusBarProps.onComposerChange('New draft dictated words'));
    expect(screen.getByLabelText('Command composer')).toHaveValue('New draft dictated words');
    expect(screen.getByRole('status', { name: 'Queued message' })).toHaveTextContent('Queued original');
  });

  it('dispatches queued messages in order after the accepted turn has finished', async () => {
    structuredIsStreaming = true;
    let resolve;
    structuredSendMessage.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    const props = buildProps({ pane: { id: 'pane-1', sessionId: 'ss-queue-order' }, sessions: [{ id: 'ss-queue-order', aiType: 'claude' }] });
    const view = render(<TerminalPane {...props} />);
    for (const text of ['First queued', 'Second queued']) {
      fireEvent.change(screen.getByLabelText('Command composer'), { target: { value: text } });
      fireEvent.click(screen.getByRole('button', { name: 'Send composer' }));
      await waitFor(() => expect(screen.getAllByRole('status', { name: 'Queued message' }).some(node => node.textContent.includes(text))).toBe(true));
    }
    structuredIsStreaming = false;
    view.rerender(<TerminalPane {...props} fontSize={15} />);
    await waitFor(() => expect(structuredSendMessage).toHaveBeenCalledTimes(1));
    fireEvent.change(screen.getByLabelText('Command composer'), { target: { value: 'New draft' } });
    await act(async () => resolve({ accepted: true }));
    expect(screen.getByLabelText('Command composer')).toHaveValue('New draft');
    expect(structuredSendMessage.mock.calls.map(call => call[0])).toEqual(['First queued']);
    structuredIsStreaming = true;
    view.rerender(<TerminalPane {...props} fontSize={16} />);
    structuredIsStreaming = false;
    view.rerender(<TerminalPane {...props} fontSize={17} />);
    await waitFor(() => expect(structuredSendMessage.mock.calls.map(call => call[0])).toEqual(['First queued', 'Second queued']));
  });

  it('keeps a queued message until the conversation reconnects', async () => {
    structuredIsStreaming = true;
    const props = buildProps({ pane: { id: 'pane-1', sessionId: 'ss-queue-reconnect' }, sessions: [{ id: 'ss-queue-reconnect', aiType: 'claude' }] });
    const view = render(<TerminalPane {...props} />);
    fireEvent.change(screen.getByLabelText('Command composer'), { target: { value: 'Send after reconnecting' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send composer' }));
    structuredConnectionState = 'offline';
    structuredIsStreaming = false;
    view.rerender(<TerminalPane {...props} fontSize={15} />);
    expect(structuredSendMessage).not.toHaveBeenCalled();
    expect(screen.getByRole('status', { name: 'Queued message' })).toHaveTextContent('Send after reconnecting');
    structuredConnectionState = 'online';
    view.rerender(<TerminalPane {...props} fontSize={16} />);
    await waitFor(() => expect(structuredSendMessage).toHaveBeenCalledWith('Send after reconnecting'));
  });

  it('keeps a queued message while session cleanup is required', async () => {
    structuredIsStreaming = true;
    const props = buildProps({ pane: { id: 'pane-1', sessionId: 'ss-queue-cleanup' }, sessions: [{ id: 'ss-queue-cleanup', runtime: 'codex' }] });
    const view = render(<TerminalPane {...props} />);
    fireEvent.change(screen.getByLabelText('Command composer'), { target: { value: 'Wait for cleanup' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send composer' }));
    structuredRequiresCleanup = true;
    structuredIsStreaming = false;
    view.rerender(<TerminalPane {...props} fontSize={15} />);
    expect(structuredSendMessage).not.toHaveBeenCalled();
    expect(screen.getByRole('status', { name: 'Queued message' })).toHaveTextContent('Wait for cleanup');
    structuredRequiresCleanup = false;
    view.rerender(<TerminalPane {...props} fontSize={16} />);
    await waitFor(() => expect(structuredSendMessage).toHaveBeenCalledWith('Wait for cleanup'));
  });

  it('does not dispatch a queued message when remote execution permission is revoked', async () => {
    const allowed = { id: 'queue-remote', capabilities: { terminalInput: true, agentExecute: true } };
    setActiveEnvironment(allowed);
    try {
      structuredIsStreaming = true;
      const props = buildProps({ pane: { id: 'pane-1', sessionId: 'ss-queue-permission' }, sessions: [{ id: 'ss-queue-permission', runtime: 'codex' }] });
      const view = render(<TerminalPane {...props} />);
      fireEvent.change(screen.getByLabelText('Command composer'), { target: { value: 'Wait for permission' } });
      fireEvent.click(screen.getByRole('button', { name: 'Send composer' }));
      structuredIsStreaming = false;
      act(() => setActiveEnvironment({ ...allowed, capabilities: { terminalInput: true, agentExecute: false } }));
      expect(structuredSendMessage).not.toHaveBeenCalled();
      expect(screen.getByRole('status', { name: 'Queued message' })).toHaveTextContent('Wait for permission');
      act(() => setActiveEnvironment(allowed));
      await waitFor(() => expect(structuredSendMessage).toHaveBeenCalledWith('Wait for permission'));
      view.unmount();
    } finally { setActiveEnvironment(null); }
  });

  it.each(['rejection', 'not accepted'])('holds an unconfirmed %s without overwriting the draft or retrying', async failure => {
    structuredIsStreaming = true;
    let settle;
    structuredSendMessage.mockImplementationOnce(() => new Promise((resolve, reject) => { settle = failure === 'rejection' ? () => reject(new Error('offline')) : () => resolve({ accepted: false }); }));
    const props = buildProps({ pane: { id: 'pane-1', sessionId: `ss-queue-${failure}` }, sessions: [{ id: `ss-queue-${failure}`, runtime: 'codex' }] });
    const view = render(<TerminalPane {...props} />);
    fireEvent.change(screen.getByLabelText('Command composer'), { target: { value: 'First queued' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send composer' }));
    await waitFor(() => expect(screen.getByRole('status', { name: 'Queued message' })).toHaveTextContent('First queued'));
    fireEvent.change(screen.getByLabelText('Command composer'), { target: { value: 'Second queued' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send composer' }));
    await waitFor(() => expect(screen.getAllByRole('status', { name: 'Queued message' })).toHaveLength(2));
    structuredIsStreaming = false;
    view.rerender(<TerminalPane {...props} fontSize={15} />);
    await waitFor(() => expect(structuredSendMessage).toHaveBeenCalledTimes(1));
    fireEvent.change(screen.getByLabelText('Command composer'), { target: { value: 'New draft' } });
    act(() => lastStatusBarProps.onComposerChange(`${lastStatusBarProps.composerValue} dictated words`));
    await act(async () => settle());
    expect(screen.getByLabelText('Command composer')).toHaveValue('New draft dictated words');
    expect(screen.getAllByRole('status', { name: 'Queued message' }).map(node => node.textContent)).toEqual([expect.stringContaining('First queued'), expect.stringContaining('Second queued')]);
    view.rerender(<TerminalPane {...props} fontSize={16} />);
    expect(structuredSendMessage.mock.calls.map(call => call[0])).toEqual(['First queued']);
  });

  it('holds a queued message when the send function throws synchronously', async () => {
    structuredIsStreaming = true;
    structuredSendMessage.mockImplementationOnce(() => { throw new Error('unavailable'); });
    const props = buildProps({ pane: { id: 'pane-1', sessionId: 'ss-queue-sync-error' }, sessions: [{ id: 'ss-queue-sync-error', aiType: 'claude' }] });
    const view = render(<TerminalPane {...props} />);
    fireEvent.change(screen.getByLabelText('Command composer'), { target: { value: 'Keep this queued message' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send composer' }));
    structuredIsStreaming = false;
    view.rerender(<TerminalPane {...props} fontSize={15} />);
    await waitFor(() => expect(screen.getByRole('status', { name: 'Queued message' })).toHaveTextContent('Send unconfirmed'));
    expect(structuredSendMessage).toHaveBeenCalledTimes(1);
  });

  it('keeps a pending queue with its original session after switching sessions', async () => {
    structuredIsStreaming = true;
    let resolve;
    structuredSendMessage.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    const first = { id: 'ss-queue-switch-first', aiType: 'claude' }, second = { id: 'ss-queue-switch-second', aiType: 'claude' };
    const props = buildProps({ pane: { id: 'pane-1', sessionId: first.id }, sessions: [first, second] });
    const view = render(<TerminalPane {...props} />);
    fireEvent.change(screen.getByLabelText('Command composer'), { target: { value: 'First session queued' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send composer' }));
    structuredIsStreaming = false;
    view.rerender(<TerminalPane {...props} fontSize={15} />);
    await waitFor(() => expect(structuredSendMessage).toHaveBeenCalledTimes(1));
    view.rerender(<TerminalPane {...props} pane={{ id: 'pane-1', sessionId: second.id }} />);
    fireEvent.change(screen.getByLabelText('Command composer'), { target: { value: 'Second session draft' } });
    await act(async () => resolve({ accepted: false, stale: true }));
    expect(screen.getByLabelText('Command composer')).toHaveValue('Second session draft');
    expect(screen.queryByRole('status', { name: 'Queued message' })).toBeNull();
    view.rerender(<TerminalPane {...props} />);
    expect(screen.getByRole('status', { name: 'Queued message' })).toHaveTextContent('First session queued');
    expect(structuredSendMessage).toHaveBeenCalledTimes(1);
  });

  it('stops the current reply to send a queued message now', async () => {
    structuredIsStreaming = true;
    render(<TerminalPane {...buildProps({ pane: { id: 'pane-1', sessionId: 'ss-steer' }, sessions: [{ id: 'ss-steer', aiType: 'claude', title: 'S', cwd: '/work' }] })} />);
    await act(async () => { await lastStatusBarProps.onComposerSubmit('Use the other API'); });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Send now' })); });
    expect(structuredInterrupt).toHaveBeenCalledTimes(1);
  });

  it('shows the paused approval state and keeps Stop in the composer', () => {
    structuredIsStreaming = true;
    structuredPendingApproval = { approvalId: 'browser-review', toolName: 'terminal_v4_browser.browser_tabs', toolInput: {} };
    const view = render(<TerminalPane {...buildProps({ pane: { id: 'pane-1', sessionId: 'ss-paused' },
      sessions: [{ id: 'ss-paused', runtime: 'codex', title: 'Project review' }] })} />);
    expect(view.container.querySelector('.ph-status')).toHaveTextContent('Waiting for approval');
    expect(view.container.querySelector('.ph-bar')).not.toHaveTextContent('Working');
    expect(lastStatusBarProps).toMatchObject({ isStreaming: true, isInterrupting: false, requiresCleanup: false, onInterrupt: structuredInterrupt });
  });

  it('labels a pending agent question as waiting for an answer', () => {
    structuredIsStreaming = true;
    structuredPendingApproval = { approvalId: 'question', toolName: 'ask_user', toolInput: { questions: [] } };
    const view = render(<TerminalPane {...buildProps({ pane: { id: 'pane-1', sessionId: 'ss-question' },
      sessions: [{ id: 'ss-question', runtime: 'v4', title: 'Project review' }] })} />);
    expect(view.container.querySelector('.ph-status')).toHaveTextContent('Waiting for your answer');
  });

  it('presents the scoped broker approval in the conversation and reports its paused state', async () => {
    structuredIsStreaming = true;
    browserReviewRequests = [{ id: 'owned-browser-review', name: 'browser_tabs', arguments: {} }];
    const view = render(<TerminalPane {...buildProps({ pane: { id: 'pane-1', sessionId: 'ss-broker' },
      sessions: [{ id: 'ss-broker', runtime: 'codex', title: 'Project review' }] })} />);
    await screen.findByTestId('desktop-conversation-view');
    expect(lastBrowserReviewOptions).toEqual({ sessionId: 'ss-broker', enabled: true, canDecide: true });
    expect(view.container.querySelector('.ph-status')).toHaveTextContent('Waiting for approval');
    expect(lastConversationViewProps).toMatchObject({ browserApprovals: browserReviewRequests, onBrowserApprove: decideBrowserReview });
    expect(lastStatusBarProps.onInterrupt).toBe(structuredInterrupt);
  });

  it.each([['offline', 'Offline'], ['unavailable', 'Unavailable'], ['connecting', 'Connecting']])('reports a structured %s connection accurately', (state, label) => {
    structuredConnectionState = state;
    const view = render(<TerminalPane {...buildProps({ pane: { id: 'pane-1', sessionId: 'ss-header-connection' },
      sessions: [{ id: 'ss-header-connection', runtime: 'v4', title: 'Project review' }] })} />);
    expect(view.container.querySelector('.ph-status')).toHaveTextContent(label);
    expect(structuredInterrupt).not.toHaveBeenCalled();
  });

  it('retains the visible Stop recovery action while keeping observer input disabled', () => {
    structuredRequiresCleanup = true;
    setActiveEnvironment({ id: 'header-observer', capabilities: {} });
    const view = render(<TerminalPane {...buildProps({ pane: { id: 'pane-1', sessionId: 'ss-header-cleanup' },
      sessions: [{ id: 'ss-header-cleanup', runtime: 'v4', title: 'Project review' }] })} />);
    expect(view.container.querySelector('.ph-status')).toHaveTextContent('Needs attention');
    expect(lastStatusBarProps.requiresCleanup).toBe(true);
    expect(lastStatusBarProps.onInterrupt).toBeUndefined();
    expect(structuredInterrupt).not.toHaveBeenCalled();
  });

  it('makes the split session selector a keyboard dismissible disclosure and retains drag ownership', () => {
    const props = buildProps({ canClose: true, sessions: [
      { id: 'session-1', title: 'Project shell' }, { id: 'session-2', title: 'Build shell' },
    ] });
    const view = render(<TerminalPane {...props} />);
    const trigger = screen.getByRole('button', { name: 'Project shell' });
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(trigger);
    const choices = screen.getByRole('group', { name: 'Switch session' });
    expect(trigger).toHaveAttribute('aria-controls', choices.id);
    fireEvent.keyDown(choices, { key: 'Escape' });
    expect(screen.queryByRole('group', { name: 'Switch session' })).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole('button', { name: 'Build shell' }));
    expect(props.onSessionSelect).toHaveBeenCalledWith('pane-1', 'session-2');
    const dataTransfer = { setData: vi.fn() };
    fireEvent.dragStart(view.container.querySelector('.ph-bar'), { dataTransfer });
    expect(dataTransfer.setData).toHaveBeenCalledWith('pane-drag', JSON.stringify({ paneId: 'pane-1', sessionId: 'session-1', fromDesktopId: 'desktop-1' }));
  });

  it('loads git branches for the active terminal footer', async () => {
    render(<TerminalPane {...buildProps()} />);

    await waitFor(() => {
      expect(listSessionGitBranches).toHaveBeenCalledWith('session-1');
    });
  });

  it('keeps the desktop terminal draft while HTTP acceptance is pending and after rejection', async () => {
    let rejectDelivery;
    terminalChatSend.mockImplementation(() => ({ queued: false, completion: new Promise((_resolve, reject) => { rejectDelivery = reject; }) }));
    render(<TerminalPane {...buildProps()} />);
    fireEvent.change(screen.getByLabelText('Command composer'), { target: { value: 'echo synthetic pending' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send composer' }));
    expect(screen.getByLabelText('Command composer')).toHaveValue('echo synthetic pending');
    await act(async () => { rejectDelivery(new Error('Terminal input was not accepted (404).')); });
    expect(screen.getByLabelText('Command composer')).toHaveValue('echo synthetic pending');
    expect(screen.getByText('Terminal input was not accepted (404).')).toBeInTheDocument();
  });

  it('skips git branch loading for structured sessions', async () => {
    render(<TerminalPane {...buildProps({
      pane: { id: 'pane-1', sessionId: 'ss-structured' },
      sessions: [{
        id: 'ss-structured',
        title: 'Structured session',
        shell: 'claude',
        isActive: true,
        updatedAt: new Date().toISOString(),
        thread: { topic: 'Review code', projectPath: 'C:\\repo' }
      }],
      sessionAiTypes: {}
    })} />);

    await waitFor(() => {
      expect(screen.getByTestId('desktop-conversation-view')).toBeInTheDocument();
    });

    expect(listSessionGitBranches).not.toHaveBeenCalled();
    expect(screen.queryByTestId('terminal-chat')).not.toBeInTheDocument();
    expect(screen.getByTestId('desktop-status-bar')).toHaveAttribute('data-connection-state', 'online');
  });

  it('mounts the structured terminal runtime only after opening the inline terminal panel', async () => {
    render(<TerminalPane {...buildProps({
      pane: { id: 'pane-1', sessionId: 'ss-structured' },
      sessions: [{
        id: 'ss-structured',
        title: 'Structured session',
        shell: 'claude',
        isActive: true,
        updatedAt: new Date().toISOString(),
        thread: { topic: 'Review code', projectPath: 'C:\\repo' }
      }],
      sessionAiTypes: {}
    })} />);

    expect(screen.queryByTestId('terminal-chat')).not.toBeInTheDocument();

    screen.getByRole('button', { name: 'Show inline terminal panel' }).click();

    await waitFor(() => {
      expect(screen.getByTestId('terminal-chat')).toBeInTheDocument();
    });
    expect(lastTerminalChatProps?.sessionId).toBe('ss-structured');
    expect(lastTerminalChatProps?.inputEnabled).toBe(false);
  });

  it('only enables direct terminal typing for structured sessions when desktop terminal input is allowed', async () => {
    render(<TerminalPane {...buildProps({
      pane: { id: 'pane-1', sessionId: 'ss-structured' },
      sessions: [{
        id: 'ss-structured',
        title: 'Structured session',
        shell: 'claude',
        isActive: true,
        updatedAt: new Date().toISOString(),
        thread: { topic: 'Review code', projectPath: 'C:\\repo' }
      }],
      desktopAllowTerminalInput: true,
      sessionAiTypes: {}
    })} />);

    screen.getByRole('button', { name: 'Show inline terminal panel' }).click();

    await waitFor(() => {
      expect(screen.getByTestId('terminal-chat')).toBeInTheDocument();
    });

    expect(lastTerminalChatProps?.inputEnabled).toBe(true);
  });

  it('routes structured raw input through the session transport instead of the terminal chat sender', async () => {
    sendRawToSession.mockResolvedValue({ accepted: true });
    render(<TerminalPane {...buildProps({
      pane: { id: 'pane-1', sessionId: 'ss-structured' },
      sessions: [{
        id: 'ss-structured',
        title: 'Structured session',
        shell: 'claude',
        isActive: true,
        updatedAt: new Date().toISOString(),
        thread: { topic: 'Review code', projectPath: 'C:\\repo' }
      }],
      sessionAiTypes: {}
    })} />);

    await waitFor(() => {
      expect(screen.getByTestId('desktop-conversation-view')).toBeInTheDocument();
    });

    await act(async () => { await lastConversationViewProps?.onSendRaw?.('\r'); });
    await waitFor(() => expect(sendRawToSession).toHaveBeenCalledWith('ss-structured', '\r', { requireLegacy: true }));
    expect(sendToSession).not.toHaveBeenCalled();
  });

  it('shows an uncertain raw-input error while retaining the conversation draft', async () => {
    sendRawToSession.mockRejectedValueOnce(Object.assign(new Error('Input may have been delivered. Check the terminal.'), { deliveryUncertain: true }));
    render(<TerminalPane {...buildProps({ pane: { id: 'pane-1', sessionId: 'ss-raw-error' }, sessions: [{ id: 'ss-raw-error', shell: 'claude', title: 'Review', cwd: '/work' }] })} />);
    render(<RawInputPending />);
    await screen.findByTestId('desktop-conversation-view');
    fireEvent.change(screen.getByLabelText('Command composer'), { target: { value: 'Keep this draft' } });
    await act(async () => { await lastConversationViewProps.onSendRaw('\r'); });
    expect(screen.getByLabelText('Command composer')).toHaveValue('Keep this draft');
    expect(await screen.findByText('Input may have been delivered. Check the terminal.')).toBeInTheDocument();
    act(() => getSupervisedInputQueues().find(entry => entry.sessionId === 'ss-raw-error')?.queue.discard());
  });

  it('batches protected prompt keys into one supervised operation', async () => {
    mockRawInputMode = 'supervised';
    sendRawToSession.mockResolvedValue({ accepted: true });
    render(<TerminalPane {...buildProps({ pane: { id: 'pane-1', sessionId: 'ss-raw-batch' }, sessions: [{ id: 'ss-raw-batch', shell: 'claude', title: 'Review', cwd: '/work' }] })} />);
    await screen.findByTestId('desktop-conversation-view');
    vi.useFakeTimers();
    try {
      act(() => { lastConversationViewProps.onSendRaw('a'); lastConversationViewProps.onSendRaw('b'); });
      expect(sendRawToSession).not.toHaveBeenCalled();
      await act(async () => { await vi.advanceTimersByTimeAsync(40); });
      expect(sendRawToSession).toHaveBeenCalledWith('ss-raw-batch', 'ab', { requireSupervision: true });
    } finally { vi.useRealTimers(); }
  });

  it('batches legacy prompt keys before sending them in order', async () => {
    mockRawInputMode = 'legacy';
    sendRawToSession.mockResolvedValue({ accepted: true });
    render(<TerminalPane {...buildProps({ pane: { id: 'pane-1', sessionId: 'ss-legacy-batch' }, sessions: [{ id: 'ss-legacy-batch', shell: 'claude', title: 'Review', cwd: '/work' }] })} />);
    await screen.findByTestId('desktop-conversation-view');
    vi.useFakeTimers();
    try {
      act(() => { lastConversationViewProps.onSendRaw('a'); lastConversationViewProps.onSendRaw('\x1b[A'); });
      expect(sendRawToSession).not.toHaveBeenCalled();
      await act(async () => { await vi.advanceTimersByTimeAsync(40); });
      expect(sendRawToSession).toHaveBeenCalledWith('ss-legacy-batch', 'a\x1b[A', { requireLegacy: true });
    } finally { vi.useRealTimers(); }
  });

  it('defaults terminal-backed sessions to Terminal v4 stable full terminal (no Codex dual UI)', () => {
    render(<TerminalPane {...buildProps({ desktopAllowTerminalInput: false })} />);

    expect(screen.queryByTestId('desktop-conversation-view')).not.toBeInTheDocument();
    expect(screen.getByTestId('terminal-chat')).toBeInTheDocument();
    expect(screen.getByTestId('desktop-status-bar')).toHaveAttribute('data-terminal-view-mode', 'terminal');
    expect(screen.queryByRole('button', { name: 'Show Codex UI' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Show Raw Terminal' })).not.toBeInTheDocument();
    expect(lastTerminalChatProps?.inputEnabled).toBe(true);
  });

  it('keeps terminal-backed sessions in terminal mode even when AI metadata is present', () => {
    render(<TerminalPane {...buildProps({ desktopAllowTerminalInput: true })} />);

    expect(screen.queryByTestId('desktop-conversation-view')).not.toBeInTheDocument();
    expect(screen.getByTestId('terminal-chat')).toBeInTheDocument();
    expect(screen.getByTestId('desktop-status-bar')).toHaveAttribute('data-terminal-view-mode', 'terminal');
    expect(lastTerminalChatProps?.inputEnabled).toBe(true);
  });

  it('gates prompt keyboard capture behind the desktop terminal input setting', async () => {
    render(<TerminalPane {...buildProps({
      pane: { id: 'pane-1', sessionId: 'ss-structured' },
      sessions: [{
        id: 'ss-structured',
        title: 'Structured session',
        shell: 'claude',
        isActive: true,
        updatedAt: new Date().toISOString(),
        thread: { topic: 'Review code', projectPath: 'C:\\repo' }
      }],
      desktopAllowTerminalInput: false,
      sessionAiTypes: {}
    })} />);

    await waitFor(() => {
      expect(screen.getByTestId('desktop-conversation-view')).toBeInTheDocument();
    });

    expect(lastConversationViewProps?.allowPromptKeyboardCapture).toBe(false);
  });

  it('keeps plain terminal sessions in raw terminal mode when there is no AI metadata', () => {
    render(<TerminalPane {...buildProps({
      sessions: [{
        id: 'session-1',
        title: 'Terminal session',
        isActive: true,
        updatedAt: new Date().toISOString(),
        thread: { gitStats: null, topic: 'Review code' }
      }],
      sessionAiTypes: {}
    })} />);

    expect(screen.queryByTestId('desktop-conversation-view')).not.toBeInTheDocument();
    expect(screen.getByTestId('terminal-chat')).toBeInTheDocument();
    expect(screen.getByTestId('desktop-status-bar')).toHaveAttribute('data-terminal-view-mode', 'terminal');
    expect(screen.queryByRole('group', { name: 'Terminal view mode' })).not.toBeInTheDocument();
    expect(lastTerminalChatProps?.inputEnabled).toBe(true);
  });

  it('renders the command composer inside the desktop terminal stack', () => {
    render(<TerminalPane {...buildProps()} />);

    const composer = screen.getByRole('textbox', { name: 'Command composer' });
    expect(composer.closest('.desktop-terminal-stack')).not.toBeNull();
  });

  it('offers no permission control for terminals, which run with host access', () => {
    render(<TerminalPane {...buildProps({
      sessions: [{
        id: 'session-1',
        title: 'Claude Terminal',
        cwd: 'C:\\repo',
        isActive: true,
        updatedAt: new Date().toISOString(),
        sandbox: { mode: 'workspace-write', workspaceRoot: 'C:\\repo' },
        thread: { gitStats: null, topic: 'Review code', sandboxMode: 'workspace-write', sandboxWorkspaceRoot: 'C:\\repo' }
      }]
    })} />);

    expect([screen.queryByRole('button', { name: 'Launch permissions unavailable' }), screen.queryByRole('button', { name: 'Access' })]).toEqual([null, null]);
    expect(updateThreadMetadata).not.toHaveBeenCalled();
  });

  it('renders the DesktopStatusBar with the running agent named in the placeholder', () => {
    render(<TerminalPane {...buildProps()} />);

    const composer = screen.getByPlaceholderText('Message Claude Code…');
    expect(composer).toBeInTheDocument();

    expect(screen.getByTestId('desktop-status-bar')).toBeInTheDocument();
  });

  it('hides the fullscreen button when there is only one selectable session', () => {
    render(<TerminalPane {...buildProps()} />);

    expect(screen.queryByTitle('Fullscreen')).not.toBeInTheDocument();
  });

  it('shows the fullscreen button when multiple selectable sessions exist', () => {
    render(<TerminalPane {...buildProps({
      sessions: [
        {
          id: 'session-1',
          title: 'Claude Terminal',
          isActive: true,
          updatedAt: new Date().toISOString(),
          thread: { gitStats: null, topic: 'Review code' }
        },
        {
          id: 'session-2',
          title: 'Second Terminal',
          isActive: true,
          updatedAt: new Date().toISOString(),
          thread: { gitStats: null, topic: 'Second session' }
        }
      ]
    })} />);

    expect(screen.getByTitle('Fullscreen')).toBeInTheDocument();
  });
  it('renders remote observer terminal and composer as read only', async () => {
    setActiveEnvironment({id:'observer',label:'Observer host',capabilities:{}});
    render(<TerminalPane {...buildProps()} />);
    await waitFor(()=>expect(lastTerminalChatProps).not.toBeNull());
    expect(lastTerminalChatProps.inputEnabled).toBe(false);
    expect(screen.getByRole('textbox',{name:'Command composer'})).toBeDisabled();
    expect(screen.getByText(/Read-only access/)).toBeInTheDocument();
  });

  it('keeps the desktop draft and attachments until structured acceptance and prevents a second submit', async () => {
    let resolve;
    structuredSendMessage.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    render(<TerminalPane {...buildProps({ pane: { id: 'pane-1', sessionId: 'ss-ack' }, sessions: [{ id: 'ss-ack', isActive: true, shell: 'claude' }] })} />);
    fireEvent.change(screen.getByLabelText('Command composer'), { target: { value: 'Keep my draft' } });
    act(() => lastStatusBarProps.onComposerAttachmentAdd({ path: '/synthetic/image.png', name: 'image.png' }));
    fireEvent.click(screen.getByRole('button', { name: 'Send composer' }));
    expect(screen.getByLabelText('Command composer')).toHaveValue('Keep my draft');
    expect(screen.getByTestId('desktop-status-bar')).toHaveAttribute('data-attachments', '[{"path":"/synthetic/image.png","name":"image.png"}]');
    expect(screen.getByRole('button', { name: 'Send composer' })).toBeDisabled();
    await act(async () => { await lastStatusBarProps.onComposerSubmit('Keep my draft'); });
    expect(structuredSendMessage).toHaveBeenCalledTimes(1);
    await act(async () => { resolve({ accepted: true }); });
    expect(screen.getByLabelText('Command composer')).toHaveValue('');
    expect(screen.getByTestId('desktop-status-bar')).toHaveAttribute('data-attachments', '[]');
  });

  it('retains a failed desktop send for retry and does not clear a newer session draft on a late receipt', async () => {
    structuredSendMessage.mockRejectedValueOnce(new Error('Message rejected.'));
    const props = buildProps({ pane: { id: 'pane-1', sessionId: 'ss-first' }, sessions: [{ id: 'ss-first', isActive: true, shell: 'claude' }] });
    const { rerender } = render(<TerminalPane {...props} />);
    fireEvent.change(screen.getByLabelText('Command composer'), { target: { value: 'Retain rejected draft' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send composer' }));
    await waitFor(() => expect(lastConversationViewProps.conversationNotice).toContain('Message rejected.'));
    expect(screen.getByLabelText('Command composer')).toHaveValue('Retain rejected draft');
    let resolve;
    structuredSendMessage.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    fireEvent.click(screen.getByRole('button', { name: 'Send composer' }));
    rerender(<TerminalPane {...props} pane={{ id: 'pane-1', sessionId: 'ss-second' }} sessions={[{ id: 'ss-second', isActive: true, shell: 'claude' }]} />);
    fireEvent.change(screen.getByLabelText('Command composer'), { target: { value: 'New session draft' } });
    await act(async () => { resolve({ accepted: true }); });
    expect(screen.getByLabelText('Command composer')).toHaveValue('New session draft');
  });

  it('enables V4 attachments and hides inline PTY controls', async () => {
    render(<TerminalPane {...buildProps({ pane: { id: 'pane-1', sessionId: 'ss-v4' }, sessions: [{ id: 'ss-v4', runtime: 'v4', aiType: 'openai-api', shell: 'openai-api', isActive: true }], sessionAiTypes: { 'ss-v4': 'claude' } })} />);
    await waitFor(() => expect(lastStatusBarProps).not.toBeNull());
    expect([lastStatusBarProps.attachmentsEnabled, lastStatusBarProps.aiType, lastStatusBarProps.showAiSelector, lastStatusBarProps.onSelectAiType, lastStatusBarProps.showTerminalToggle, lastConversationViewProps.onOpenTerminal])
      .toEqual([true, 'openai-api', false, undefined, false, undefined]);
  });

  it('opens provider settings for the thread provider from a V4 thread chip and restores focus', async () => {
    render(<TerminalPane {...buildProps({ pane: { id: 'pane-1', sessionId: 'ss-v4-provider' }, sessions: [{ id: 'ss-v4-provider', runtime: 'v4', aiType: 'azure-foundry', model: 'gpt-deploy', isActive: true }] })} />);
    const chip = await screen.findByRole('button', { name: /Provider settings/ });
    expect(chip).toHaveTextContent('V4 · gpt-deploy');
    expect(chip.tagName).toBe('BUTTON');
    expect(chip.tabIndex).toBe(0);
    expect(screen.getByRole('textbox', { name: 'Command composer' }).compareDocumentPosition(chip) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    chip.focus();
    await userEvent.keyboard(' ');
    expect(screen.getByRole('dialog', { name: 'Provider authentication' })).toHaveAttribute('data-provider', 'azure-foundry');
    fireEvent.click(screen.getByRole('button', { name: 'Close provider settings' }));
    expect(screen.queryByRole('dialog', { name: 'Provider authentication' })).toBeNull();
    expect(chip).toHaveFocus();
  });

  it('passes authoritative cleanup status into the hook and keeps recovery in the actual desktop view', () => {
    structuredRequiresCleanup = true;
    const onSessionBusyChange = vi.fn();
    render(<TerminalPane {...buildProps({ pane: { id: 'pane-1', sessionId: 'ss-cleanup' }, sessions: [{ id: 'ss-cleanup', runtime: 'v4', status: 'cleanup_required', statusSeq: 9 }], onSessionBusyChange })} />);
    expect(lastStructuredOptions).toMatchObject({ status: 'cleanup_required', statusSeq: 9 });
    expect(lastConversationViewProps.requiresCleanup).toBe(true);
    expect(onSessionBusyChange).toHaveBeenLastCalledWith('ss-cleanup', true);
  });
  it('opens the owned V4 queue separately from the desktop draft and closes it when changing sessions', async () => {
    const props = buildProps({ pane: { id: 'pane-1', sessionId: 'ss-queue' }, sessions: [{ id: 'ss-queue', runtime: 'v4' }] });
    const { rerender } = render(<TerminalPane {...props} />);
    fireEvent.change(screen.getByLabelText('Command composer'), { target: { value: 'Keep main desktop draft' } });
    fireEvent.click(screen.getByRole('button', { name: 'Open follow-up queue' }));
    expect(screen.getByRole('dialog', { name: 'Follow-up queue' })).toHaveTextContent('ss-queue');
    expect(screen.getByLabelText('Command composer')).toHaveValue('Keep main desktop draft');
    fireEvent.click(screen.getByRole('button', { name: 'Close queue' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Command composer')).toHaveValue('Keep main desktop draft');
    fireEvent.click(screen.getByRole('button', { name: 'Open follow-up queue' }));
    rerender(<TerminalPane {...props} pane={{ id: 'pane-1', sessionId: 'ss-legacy-queue' }} sessions={[{ id: 'ss-legacy-queue', shell: 'claude' }]} />);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Open follow-up queue' })).not.toBeInTheDocument();
  });
  it('preserves a normal text draft across production desktop and mobile composer remounts', () => {
    const session = { id: 'ss-responsive-draft', runtime: 'v4', aiType: 'deepseek', cwd: '/synthetic' };
    const props = buildProps({ pane: { id: 'pane-1', sessionId: session.id }, sessions: [session] });
    const desktop = render(<TerminalPane {...props} />);
    fireEvent.change(screen.getByLabelText('Command composer'), { target: { value: 'Keep this desktop draft' } });
    desktop.unmount();
    const mobile = render(<MobileShell sessions={[session]} activeSessionId={session.id} projectInfo={{ cwd: '/synthetic' }} />);
    expect(screen.getByLabelText('Command composer')).toHaveValue('Keep this desktop draft');
    fireEvent.change(screen.getByLabelText('Command composer'), { target: { value: 'Keep this newer phone draft' } });
    mobile.unmount();
    render(<TerminalPane {...props} />);
    expect(screen.getByLabelText('Command composer')).toHaveValue('Keep this newer phone draft');
  });
  it('reports canonical structured activity to shared app badges without claiming idle on unmount', async () => {
    const onSessionBusyChange = vi.fn();
    const props = buildProps({ pane: { id: 'pane-1', sessionId: 'ss-v4-activity' }, sessions: [{ id: 'ss-v4-activity', runtime: 'v4', aiType: 'deepseek', isActive: true }], onSessionBusyChange });
    structuredIsStreaming = true;
    const { rerender, unmount } = render(<TerminalPane {...props} />);
    await waitFor(() => expect(onSessionBusyChange).toHaveBeenLastCalledWith('ss-v4-activity', true));
    structuredIsStreaming = false; structuredRequiresCleanup = false; lastStructuredOptions = null;
    rerender(<TerminalPane {...props} fitSignal={1} />);
    await waitFor(() => expect(onSessionBusyChange).toHaveBeenLastCalledWith('ss-v4-activity', false));
    structuredIsStreaming = true;
    rerender(<TerminalPane {...props} fitSignal={2} />);
    await waitFor(() => expect(onSessionBusyChange).toHaveBeenLastCalledWith('ss-v4-activity', true));
    unmount();
    expect(onSessionBusyChange).toHaveBeenLastCalledWith('ss-v4-activity', true);
  });

  it('keeps administration out of the composer and uses its canonical structured cwd for status without unrelated global Git metadata', () => {
    render(<TerminalPane {...buildProps({ pane: { id: 'pane-1', sessionId: 'ss-canonical-workspace' },
      sessions: [{ id: 'ss-canonical-workspace', runtime: 'v4', cwd: '/canonical/pane', thread: { projectPath: '/editable/group' } }],
      projectInfo: { cwd: '/unrelated/pane', gitBranch: 'unrelated-branch' }, sessionAiTypes: {} })} />);
    expect(screen.queryByTestId('workspace-tools-path')).not.toBeInTheDocument();
    expect(screen.queryByTestId('workspace-knowledge-path')).not.toBeInTheDocument();
    expect(lastStatusBarProps.cwd).toBe('/canonical/pane');
    expect(lastStatusBarProps.compactConversation).toBe(true);
    expect(lastStatusBarProps.showTopRow).toBe(false);
    expect(lastConversationViewProps.showHeader).toBe(false);
    expect(lastStatusBarProps.gitBranch).toBeFalsy();
    expect(lastStatusBarProps.currentGitBranch).toBeFalsy();
  });
  it('keeps a PTY pane cwd and suppresses Git fallback from a different focused workspace', async () => {
    listSessionGitBranches.mockResolvedValue({ currentBranch: null, branches: [] });
    render(<TerminalPane {...buildProps({ sessions: [{ id: 'session-1', isActive: true, cwd: '/own/pane' }],
      projectInfo: { cwd: '/another/pane', gitBranch: 'unrelated-branch' } })} />);
    await waitFor(() => expect(listSessionGitBranches).toHaveBeenCalled());
    expect(lastStatusBarProps.cwd).toBe('/own/pane');
    expect(lastStatusBarProps.gitBranch).toBeFalsy();
    expect(lastStatusBarProps.currentGitBranch).toBeFalsy();
  });
  it('retains matching-workspace PTY Git metadata when branch discovery is unavailable', async () => {
    listSessionGitBranches.mockResolvedValue({ currentBranch: null, branches: [] });
    render(<TerminalPane {...buildProps({ sessions: [{ id: 'session-1', isActive: true, cwd: '/own/pane' }],
      projectInfo: { cwd: '/own/pane', gitBranch: 'matching-branch' } })} />);
    await waitFor(() => expect(listSessionGitBranches).toHaveBeenCalled());
    expect(lastStatusBarProps.cwd).toBe('/own/pane');
    expect(lastStatusBarProps.gitBranch).toBe('matching-branch');
    expect(lastStatusBarProps.currentGitBranch).toBe('matching-branch');
  });

  it('never reuses an old pane live cwd or callback after session switches including ABA', () => {
    const sessions = [{ id: 'session-1', cwd: '/one' }, { id: 'session-2', cwd: '/two' }];
    const view = render(<TerminalPane {...buildProps({ sessions, projectInfo: null })} />);
    const oldCwd = lastTerminalChatProps.onCwdChange;
    act(() => oldCwd('/one/live'));
    expect(lastStatusBarProps.cwd).toBe('/one/live');
    view.rerender(<TerminalPane {...buildProps({ sessions, pane: { id: 'pane-1', sessionId: 'session-2' }, projectInfo: null })} />);
    expect(lastStatusBarProps.cwd).toBe('/two');
    act(() => oldCwd('/one/late'));
    expect(lastStatusBarProps.cwd).toBe('/two');
    view.rerender(<TerminalPane {...buildProps({ sessions, projectInfo: null })} />);
    act(() => oldCwd('/one/late-after-ABA'));
    expect(lastStatusBarProps.cwd).toBe('/one');
  });


  it('mounts Context beside Queue only for the actual own V4 desktop session', () => {
    const own = { id: 'ss-desktop-context', runtime: 'v4', cwd: '/canonical/desktop' };
    const props = buildProps({ pane: { id: 'pane-1', sessionId: own.id }, sessions: [own] });
    const view = render(<TerminalPane {...props} />);
    expect(screen.getByTestId('context-mount')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Open follow-up queue' })).toBeInTheDocument();
    view.rerender(<TerminalPane {...props} sessions={[{ ...own, runtime: undefined, shell: 'claude' }]} />);
    expect(screen.queryByTestId('context-mount')).not.toBeInTheDocument();
    view.rerender(<TerminalPane {...buildProps()} />);
    expect(screen.queryByTestId('context-mount')).not.toBeInTheDocument();
  });
  it('passes desktop canonical controls and the existing explicit Stop action without invoking it on mount', () => {
    const own = { id: 'ss-desktop-context-props', runtime: 'v4' };
    structuredControlState = { sessionId: own.id, generation: 7, latestSeq: 12, events: [{ seq: 12, type: 'compaction', turnId: 'compact-turn', status: 'started' }], truncated: false };
    structuredIsInterrupting = true; structuredControlError = 'Synthetic Stop recovery';
    render(<TerminalPane {...buildProps({ pane: { id: 'pane-1', sessionId: own.id }, sessions: [own] })} />);
    expect(lastContextProps).toMatchObject({ sessionId: own.id, active: true, isStopping: true, stopError: 'Synthetic Stop recovery', readOnly: false });
    expect(lastContextProps.controlState).toBe(structuredControlState);
    expect(structuredInterrupt).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Fixture explicit Stop conversation' }));
    expect(structuredInterrupt).toHaveBeenCalledTimes(1);
  });
  it('passes busy and cleanup state but never supplies forbidden remote Stop to desktop Context', () => {
    setActiveEnvironment({ id: 'context-observer', capabilities: {} });
    structuredRequiresCleanup = true;
    const own = { id: 'ss-desktop-context-readonly', runtime: 'v4', status: 'accepted' };
    render(<TerminalPane {...buildProps({ pane: { id: 'pane-1', sessionId: own.id }, sessions: [own] })} />);
    expect(lastContextProps).toMatchObject({ sessionId: own.id, readOnly: true, requiresCleanup: true, conversationBusy: true });
    expect(lastContextProps.onStopConversation).toBeUndefined();
    expect(screen.getByRole('button', { name: 'Fixture explicit Stop conversation' })).toBeDisabled();
    expect(structuredInterrupt).not.toHaveBeenCalled();
  });
  it('retains the ordinary desktop draft and Queue when Context control metadata updates', () => {
    const own = { id: 'ss-desktop-context-draft', runtime: 'v4' };
    const props = buildProps({ pane: { id: 'pane-1', sessionId: own.id }, sessions: [own] });
    const view = render(<TerminalPane {...props} />);
    fireEvent.change(screen.getByLabelText('Command composer'), { target: { value: 'Ordinary draft remains separate' } });
    structuredControlState = { sessionId: own.id, generation: 8, latestSeq: 13, events: [], truncated: true };
    view.rerender(<TerminalPane {...props} fitSignal={2} />);
    expect(screen.getByTestId('context-mount')).toBeInTheDocument();
    expect(screen.getByLabelText('Command composer')).toHaveValue('Ordinary draft remains separate');
    expect(screen.getByRole('button', { name: 'Open follow-up queue' })).toBeInTheDocument();
    expect(structuredSendMessage).not.toHaveBeenCalled();
    expect(structuredInterrupt).not.toHaveBeenCalled();
  });

  it('keeps thread details closed by default and remembers the chosen state per browser', () => {
    const original = window.matchMedia;
    window.matchMedia = query => ({ matches: query === '(min-width: 1280px)', media: query, addEventListener() {}, removeEventListener() {} });
    localStorage.removeItem('tv4ThreadDetailsOpen');
    const props = () => buildProps({ pane: { id: 'pane-1', sessionId: 'ss-details-pref' }, sessionAiTypes: {}, sessions: [{ id: 'ss-details-pref', aiType: 'claude', cwd: '/repo/current', title: 'Chat', isActive: true }] });
    try {
      const first = render(<TerminalPane {...props()} />);
      expect(screen.queryByRole('complementary', { name: 'Thread details' })).toBeNull();
      fireEvent.click(screen.getByRole('button', { name: 'Toggle thread details panel' }));
      first.unmount();
      const second = render(<TerminalPane {...props()} />);
      expect(screen.getByRole('complementary', { name: 'Thread details' })).toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: 'Toggle thread details panel' }));
      second.unmount();
      render(<TerminalPane {...props()} />);
      expect(screen.queryByRole('complementary', { name: 'Thread details' })).toBeNull();
    } finally {
      window.matchMedia = original;
      localStorage.removeItem('tv4ThreadDetailsOpen');
    }
  });

  it('toggles T3-style thread details and opens a terminal drawer in the thread folder', async () => {
    createSession.mockReset().mockResolvedValue({ id: 'pty-drawer' });
    updateThreadMetadata.mockImplementation((_id, patch) => Promise.resolve({ ...patch }));
    const id = 'ss-drawer';
    const original = window.matchMedia;
    const toggleSequence = (wide, active = true) => {
      window.matchMedia = query => ({ matches: wide && query === '(min-width: 1280px)', media: query, addEventListener() {}, removeEventListener() {} });
      const view = render(<TerminalPane {...buildProps({ pane: { id: 'pane-1', sessionId: id }, sessionAiTypes: {}, isActive: active,
        sessions: [{ id, aiType: 'claude', cwd: '/repo/current', title: 'Chat', isActive: true }] })} />);
      const details = screen.getByRole('button', { name: 'Toggle thread details panel' });
      const shown = () => screen.queryByRole('complementary', { name: 'Thread details' })?.className ?? null;
      const visibility = [shown()];
      fireEvent.click(details);
      visibility.push(shown());
      fireEvent.click(details);
      visibility.push(shown());
      view.unmount();
      return visibility;
    };
    try {
      expect([toggleSequence(true), toggleSequence(false), toggleSequence(true, false)]).toEqual([
        [null, 'thread-details-card', null],
        [null, 'thread-details-card thread-details-floating', null],
        [null, null, null],
      ]);
    } finally {
      window.matchMedia = original;
    }
    render(<TerminalPane {...buildProps({ pane: { id: 'pane-1', sessionId: id }, sessionAiTypes: {},
      sessions: [{ id, aiType: 'claude', cwd: '/repo/current', title: 'Chat', isActive: true }] })} />);
    expect(screen.queryByRole('region', { name: 'Thread terminal' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Toggle terminal drawer' }));
    const drawer = await screen.findByRole('region', { name: 'Thread terminal' });
    await waitFor(() => expect(drawer.querySelector('[data-testid="terminal-chat"]')).toHaveAttribute('data-session-id', 'pty-drawer'));
    expect(createSession.mock.calls).toEqual([[{ cwd: '/repo/current', title: 'Terminal', select: false, requestId: expect.stringMatching(/^[0-9a-f-]{36}$/), companionOf: id }]]);
    expect(updateThreadMetadata).toHaveBeenCalledWith('pty-drawer', { companionOf: id });
  });

  it('lets a failed terminal restore be retried without creating a new terminal', async () => {
    const id = 'ss-drawer-retry';
    restoreSession.mockRejectedValueOnce(new Error('Restore failed')).mockResolvedValueOnce({ restored: true });
    createSession.mockReset();
    render(<TerminalPane {...buildProps({ pane: { id: 'pane-1', sessionId: id }, sessionAiTypes: {},
      sessions: [{ id, aiType: 'claude', cwd: '/repo/current', title: 'Chat', isActive: true },
        { id: 'pty-ended', isActive: false, thread: { companionOf: id } }] })} />);
    fireEvent.click(screen.getByRole('button', { name: 'Toggle terminal drawer' }));
    const drawer = await screen.findByRole('region', { name: 'Thread terminal' });
    expect(await within(drawer).findByRole('alert')).toHaveTextContent('This terminal could not be restarted.');
    fireEvent.click(within(drawer).getByRole('button', { name: 'Retry opening terminal' }));
    await waitFor(() => expect(restoreSession).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(drawer.querySelector('[data-testid="terminal-chat"]')).toHaveAttribute('data-session-id', 'pty-ended'));
    expect(createSession).not.toHaveBeenCalled();
  });

  it('keeps a working terminal visible when adding a second one fails', async () => {
    const id = 'ss-drawer-add-fails';
    createSession.mockReset().mockRejectedValueOnce(new Error('Cannot add terminal')).mockResolvedValueOnce({ id: 'pty-added-desktop' });
    updateThreadMetadata.mockImplementation((_id, patch) => Promise.resolve({ ...patch }));
    try {
      render(<TerminalPane {...buildProps({ pane: { id: 'pane-1', sessionId: id }, sessionAiTypes: {},
        sessions: [{ id, runtime: 'codex', cwd: '/repo/current', title: 'Chat', isActive: true },
          { id: 'pty-working-desktop', isActive: true, thread: { companionOf: id } }] })} />);
      fireEvent.click(screen.getByRole('button', { name: 'Toggle terminal drawer' }));
      const drawer = await screen.findByRole('region', { name: 'Thread terminal' });
      expect(within(drawer).getByTestId('terminal-chat')).toHaveAttribute('data-session-id', 'pty-working-desktop');
      fireEvent.click(within(drawer).getByRole('button', { name: 'New terminal in this thread' }));
      expect(await within(drawer).findByRole('alert')).toHaveTextContent('Cannot add terminal');
      expect(within(drawer).getByTestId('terminal-chat')).toHaveAttribute('data-session-id', 'pty-working-desktop');
      fireEvent.click(within(drawer).getByRole('button', { name: 'I checked the list; start another' }));
      await waitFor(() => expect(within(drawer).getByTestId('terminal-chat')).toHaveAttribute('data-session-id', 'pty-added-desktop'));
      expect(within(drawer).queryByRole('alert')).not.toBeInTheDocument();
      expect(createSession).toHaveBeenCalledTimes(2);
      expect(updateThreadMetadata).toHaveBeenCalledWith('pty-added-desktop', { companionOf: id });
    } finally {
      createSession.mockReset();
    }
  });

  it('does not restore or expose a thread terminal when terminal input is unavailable', async () => {
    setActiveEnvironment({ id: 'drawer-observer', capabilities: { agentExecute: true } });
    createSession.mockReset();
    restoreSession.mockReset();
    const id = 'ss-drawer-observer';
    render(<TerminalPane {...buildProps({ pane: { id: 'pane-1', sessionId: id }, sessionAiTypes: {},
      sessions: [{ id, runtime: 'codex', cwd: '/repo/current', title: 'Chat', isActive: true },
        { id: 'pty-observer', isActive: false, thread: { companionOf: id } }] })} />);
    fireEvent.click(screen.getByRole('button', { name: 'Toggle terminal drawer' }));
    const drawer = await screen.findByRole('region', { name: 'Thread terminal' });
    expect(within(drawer).getByText('Terminal access is unavailable for this environment.')).toBeVisible();
    expect(within(drawer).queryByTestId('terminal-chat')).not.toBeInTheDocument();
    expect(within(drawer).queryByRole('tablist', { name: 'Thread terminals' })).not.toBeInTheDocument();
    expect([createSession.mock.calls, restoreSession.mock.calls]).toEqual([[], []]);
  });

  it('explains when a thread has no workspace for its terminal', async () => {
    createSession.mockReset();
    const id = 'ss-drawer-no-folder';
    render(<TerminalPane {...buildProps({ pane: { id: 'pane-1', sessionId: id }, sessionAiTypes: {},
      sessions: [{ id, runtime: 'codex', cwd: '', title: 'Chat', isActive: true }] })} />);
    fireEvent.click(screen.getByRole('button', { name: 'Toggle terminal drawer' }));
    const drawer = await screen.findByRole('region', { name: 'Thread terminal' });
    expect(within(drawer).getByText('This conversation has no workspace folder for a terminal.')).toBeVisible();
    expect(createSession).not.toHaveBeenCalled();
  });

  it('lets a Claude Code chat change its model for the next turn from the composer', async () => {
    catalogFetch.mockResolvedValue({ ok: true, json: async () => ({ agents: [{ id: 'claude', label: 'Claude Code', available: true, status: 'ready',
      capabilities: { structured: true }, models: [{ id: 'sonnet', label: 'Sonnet', default: true }, { id: 'opus', label: 'Opus' }], reasoningLevels: ['low', 'high', 'max'] }] }) });
    const id = 'ss-claude-select';
    render(<TerminalPane {...buildProps({ pane: { id: 'pane-1', sessionId: id }, sessionAiTypes: {},
      sessions: [{ id, aiType: 'claude', cwd: '/repo/current', model: 'sonnet', reasoning: 'high', isActive: true }] })} />);
    expect(document.querySelector('.session-composer-context')).toBeNull();
    fireEvent.click(await screen.findByRole('button', { name: /^Claude Code model Sonnet/ }));
    fireEvent.click(screen.getByRole('option', { name: 'Opus' }));
    await waitFor(() => expect(updateStructuredSessionSelection.mock.calls).toEqual([[id, { model: 'opus', reasoning: 'high' }]]));
  });

  describe('active Codex composer controls', () => {
    const codexSession = id => ({ id, runtime: 'codex', cwd: '/repo/current', model: 'gpt-5.5', reasoning: 'high', isActive: true });
    const renderCodex = (id, overrides = {}) => {
      const props = buildProps({ pane: { id: 'pane-1', sessionId: id }, sessions: [codexSession(id)], sessionAiTypes: {},
        projects: [{ path: '/repo/other', name: 'Other project' }], recentFolders: ['/repo/current'],
        onStartProjectChat: vi.fn(), onStartWorkspaceTask: vi.fn(), ...overrides });
      return { props, view: render(<TerminalPane {...props} />) };
    };
    const modelTrigger = () => screen.findByRole('button', { name: /^Codex model GPT-5\.5/ });

    it.each([['known', 'gpt-5.5'], ['stale', 'retired-model']])('does not PATCH on mount or catalog load for a %s model', async (_, model) => {
      const id = `ss-codex-mount-${model}`;
      render(<TerminalPane {...buildProps({ pane: { id: 'pane-1', sessionId: id }, sessions: [{ ...codexSession(id), model, reasoning: 'unsupported' }], sessionAiTypes: {} })} />);
      await screen.findByRole('button', { name: new RegExp(`^Codex model ${model === 'gpt-5.5' ? 'GPT-5\\.5' : model}`) });
      await waitFor(() => expect(catalogFetch).toHaveBeenCalled());
      expect(updateStructuredSessionSelection).not.toHaveBeenCalled();
    });

    it('PATCHes deliberate model and reasoning choices for the same session', async () => {
      renderCodex('ss-codex-select');
      fireEvent.click(await modelTrigger());
      fireEvent.click(screen.getByRole('option', { name: 'GPT-5.6-Sol' }));
      await waitFor(() => expect(screen.getByRole('button', { name: 'Reasoning: High' })).toBeEnabled());
      fireEvent.click(screen.getByRole('button', { name: 'Reasoning: High' }));
      fireEvent.click(screen.getByRole('option', { name: 'Low' }));
      await waitFor(() => expect(updateStructuredSessionSelection.mock.calls).toEqual([
        ['ss-codex-select', { model: 'gpt-5.6-sol', reasoning: 'high' }],
        ['ss-codex-select', { model: 'gpt-5.5', reasoning: 'low' }],
      ]));
    });

    it('PATCHes an explicit speed change and shows the saved speed', async () => {
      renderCodex('ss-codex-speed', { sessions: [{ ...codexSession('ss-codex-speed'), serviceTier: null }] });
      fireEvent.click(await modelTrigger());
      const speed = await screen.findByRole('button', { name: /^Speed:/ });
      expect(speed).toHaveAttribute('aria-label', 'Speed: Default');
      expect(await screen.findByRole('button', { name: 'Reasoning: High' })).toHaveAttribute('aria-label', 'Reasoning: High');
      fireEvent.click(speed);
      fireEvent.click(screen.getByRole('option', { name: /^Default/ }));
      expect(updateStructuredSessionSelection).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole('button', { name: /^Speed:/ }));
      fireEvent.click(screen.getByRole('option', { name: /^Fast/ }));
      await waitFor(() => expect(updateStructuredSessionSelection.mock.calls).toEqual([
        ['ss-codex-speed', { model: 'gpt-5.5', reasoning: 'high', serviceTier: 'fast' }],
      ]));
    });

    it('keeps the saved speed when model or reasoning changes', async () => {
      const id = 'ss-codex-keep-speed';
      renderCodex(id, { sessions: [{ ...codexSession(id), serviceTier: 'fast' }] });
      fireEvent.click(await modelTrigger());
      expect(await screen.findByRole('button', { name: /^Speed:/ })).toHaveAttribute('aria-label', 'Speed: Fast');
      fireEvent.click(screen.getByRole('option', { name: 'GPT-5.6-Sol' }));
      await waitFor(() => expect(screen.getByRole('button', { name: 'Reasoning: High' })).toBeEnabled());
      fireEvent.click(screen.getByRole('button', { name: 'Reasoning: High' }));
      fireEvent.click(screen.getByRole('option', { name: 'Low' }));
      await waitFor(() => expect(updateStructuredSessionSelection.mock.calls).toEqual([
        [id, { model: 'gpt-5.6-sol', reasoning: 'high' }],
        [id, { model: 'gpt-5.5', reasoning: 'low' }],
      ]));
      expect(screen.getByRole('button', { name: /^Speed:/ })).toHaveAttribute('aria-label', 'Speed: Fast');
    });

    it('does not PATCH a saved speed on mount or catalog load', async () => {
      const id = 'ss-codex-speed-mount';
      renderCodex(id, { sessions: [{ ...codexSession(id), serviceTier: 'ultrafast' }] });
      fireEvent.click(await modelTrigger());
      expect(await screen.findByRole('button', { name: /^Speed:/ })).toHaveAttribute('aria-label', 'Speed: Ultrafast');
      await waitFor(() => expect(catalogFetch).toHaveBeenCalled());
      expect(updateStructuredSessionSelection).not.toHaveBeenCalled();
    });

    it('shows a 409 failure while keeping the previous selection and draft', async () => {
      const busyMessage = 'This conversation is busy. Wait for the current response to finish, then change the model.';
      updateStructuredSessionSelection.mockRejectedValue(Object.assign(new Error(busyMessage), { status: 409 }));
      renderCodex('ss-codex-conflict');
      fireEvent.change(screen.getByLabelText('Command composer'), { target: { value: 'Draft survives a failed model change' } });
      fireEvent.click(await modelTrigger());
      fireEvent.click(screen.getByRole('option', { name: 'GPT-5.6-Sol' }));
      expect(await screen.findByRole('alert')).toHaveTextContent(busyMessage);
      expect(await modelTrigger()).toBeEnabled();
      expect(screen.getByLabelText('Command composer')).toHaveValue('Draft survives a failed model change');
      expect(structuredSendMessage).not.toHaveBeenCalled();
    });

    it.each([
      ['streaming', () => { structuredIsStreaming = true; }, {}],
      ['cleanup', () => { structuredRequiresCleanup = true; }, {}],
      ['running', () => { structuredIsStreaming = true; }, { status: 'running' }],
    ])('disables model changes while %s', async (state, arrange, sessionFields) => {
      arrange();
      const id = `ss-codex-busy-${state}`;
      render(<TerminalPane {...buildProps({ pane: { id: 'pane-1', sessionId: id }, sessions: [{ ...codexSession(id), ...sessionFields }], sessionAiTypes: {} })} />);
      expect(await modelTrigger()).toBeDisabled();
      expect(screen.queryByRole('dialog', { name: 'Choose Codex model' })).not.toBeInTheDocument();
    });

    it('keeps reasoning and speed enabled when live state is idle but inventory still says running', async () => {
      const id = 'ss-codex-stale-running';
      render(<TerminalPane {...buildProps({ pane: { id: 'pane-1', sessionId: id }, sessions: [{ ...codexSession(id), status: 'running' }], sessionAiTypes: {} })} />);
      expect(await modelTrigger()).toBeEnabled();
      fireEvent.click(await modelTrigger());
      expect(screen.getByRole('button', { name: 'Reasoning: High' })).toBeEnabled();
      expect(screen.getByRole('button', { name: /^Speed:/ })).toBeEnabled();
    });

    it('disables further model changes and sending while an update is pending', async () => {
      updateStructuredSessionSelection.mockReturnValue(new Promise(() => {}));
      renderCodex('ss-codex-pending');
      fireEvent.click(await modelTrigger());
      fireEvent.click(screen.getByRole('option', { name: 'GPT-5.6-Sol' }));
      await waitFor(() => expect(screen.getByRole('button', { name: /^Codex model GPT-5\.5/ })).toBeDisabled());
      expect(screen.getByRole('button', { name: 'Send composer' })).toBeDisabled();
      expect(updateStructuredSessionSelection).toHaveBeenCalledTimes(1);
    });

    it('opens a new chat for another project without touching the current conversation', async () => {
      const { props } = renderCodex('ss-codex-project');
      fireEvent.change(screen.getByLabelText('Command composer'), { target: { value: 'Unsent draft' } });
      fireEvent.click(screen.getByRole('button', { name: 'Project' }));
      expect(screen.getByText('New chat in project')).toBeInTheDocument();
      fireEvent.click(screen.getByRole('menuitemradio', { name: /Other project/ }));
      fireEvent.click(screen.getByRole('button', { name: 'Project' }));
      fireEvent.click(screen.getByRole('menuitem', { name: 'Browse for project folder' }));
      expect(props.onStartProjectChat.mock.calls).toEqual([['/repo/other'], [null]]);
      expect(props.onStartWorkspaceTask).not.toHaveBeenCalled();
      expect(structuredInterrupt).not.toHaveBeenCalled();
      expect(structuredSendMessage).not.toHaveBeenCalled();
      expect(updateStructuredSessionSelection).not.toHaveBeenCalled();
      expect(screen.getByLabelText('Command composer')).toHaveValue('Unsent draft');
    });
  });
});
