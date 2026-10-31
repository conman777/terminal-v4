import { setActiveEnvironment } from '../utils/remoteEnvironments';
import { clearTokens, setTokens, setUser } from '../utils/auth';
import fs from 'node:fs';
import path from 'node:path';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MobileShell } from './MobileShell';
import { RawInputPending } from './RawInputPending';
import { getSupervisedInputQueues } from '../utils/supervisedRawInputQueue';
import { withAttachmentWriteLock } from '../utils/attachmentWriteLock';

let lastMobileTerminalProps = null;
let lastStatusBarProps = null;
let lastConversationViewProps = null;
let lastBrowserReviewOptions = null;
let browserReviewRequests = [];
const decideBrowserReview = vi.fn();
let lastContextProps = null;
let mockRawInputMode = 'legacy';
const mockUseMobileChatTurns = vi.fn();
const mockUseStructuredSession = vi.fn();
const mockListSessionGitBranches = vi.fn(() => Promise.resolve({ branches: [], currentBranch: null }));
const mockCheckoutSessionGitBranch = vi.fn(() => Promise.resolve({ branches: [], currentBranch: null }));
const mockCreateSession = vi.fn(() => Promise.resolve({ id: 'pty-mobile' }));
const mockCloseSession = vi.fn(() => Promise.resolve());
const echoThreadPatch = (_id, patch) => Promise.resolve({ ...patch });
const mockUpdateThreadMetadata = vi.fn(echoThreadPatch);
const mockRestoreSession = vi.fn(() => Promise.resolve());
const mockUpdateStructuredSessionSelection = vi.fn(() => Promise.resolve());
const mockSendRawToSession = vi.fn();
let mockServerQueue = { status: 'unavailable', snapshot: null, reason: 'fixture', refresh: () => {} };
const enqueueServerFollowup = vi.fn();
vi.mock('../hooks/useServerFollowupQueue', () => ({ useServerFollowupQueue: () => mockServerQueue }));
vi.mock('../utils/serverFollowupQueue', () => ({ enqueueServerFollowup: (...args) => enqueueServerFollowup(...args) }));
vi.mock('../hooks/useSupervisedInputCapability', () => ({ useSupervisedInputCapability: () => mockRawInputMode }));

vi.mock('../hooks/useInstalledSkills', () => ({ useInstalledSkills: () => [{ name: 'project-review', description: 'Review this project' }] }));

vi.mock('./TerminalChat', () => ({
  TerminalChat(props) {
    lastMobileTerminalProps = props;
    return (
	  <div
	    data-testid="terminal-chat"
	    data-session-id={props.sessionId}
	    data-surface={props.surface}
	    data-input-enabled={props.inputEnabled === false ? 'false' : 'true'}
	  >
	    <button
	      type="button"
	      onClick={() => props.onScreenSnapshot?.({
	        text: 'OpenAI Codex (v0.110.0)\ngpt-5.5 xhigh · 100% left · ~/terminal-v4'
	      })}
	    >
	      mark-codex-screen
	    </button>
	  </div>
	);
      },
}));

vi.mock('./DesktopConversationView', () => ({
  DesktopConversationView(props) {
    lastConversationViewProps = props;
    return (
      <div data-testid="desktop-conversation-view" data-requires-cleanup={props.requiresCleanup ? 'true' : 'false'}>
        <button type="button" onClick={() => props.onOpenTerminal?.()}>
          Open terminal view
        </button>
      </div>
    );
  },
}));

vi.mock('./WorkspaceToolsButton', () => ({ WorkspaceToolsButton: props => <span data-testid="workspace-tools-path" data-path={props.workspacePath} /> }));
vi.mock('./WorkspaceProfileButton', () => ({ WorkspaceProfileButton: props => <span data-testid="workspace-knowledge-path" data-path={props.workspacePath} /> }));

vi.mock('./ConversationContextButton', () => ({ ConversationContextButton: props => {
  lastContextProps = props;
  return <section data-testid="context-mount"><button type="button">Context fixture</button><button type="button" disabled={!props.onStopConversation} onClick={() => props.onStopConversation?.()}>Fixture explicit Stop conversation</button></section>;
} }));

vi.mock('./FollowupQueuePanel', () => ({ FollowupQueuePanel: ({ sessionId, onClose }) => <section aria-label="Fixture queue"><span>{sessionId}</span><button onClick={onClose}>Close queue</button></section> }));

vi.mock('./DesktopStatusBar', () => ({
  DesktopStatusBar(props) {
    lastStatusBarProps = props;
    return (
	  <div
	    data-testid="desktop-status-bar"
	    data-cwd={props.cwd}
        data-git-branch={props.gitBranch || ""}
        data-current-git-branch={props.currentGitBranch || ""}
	    data-connection-state={props.connectionState}
	    data-terminal-open={props.isTerminalPanelOpen ? 'true' : 'false'}
	    data-show-ai-selector={props.showAiSelector === false ? 'false' : 'true'}
	    data-show-terminal-toggle={props.showTerminalToggle ? 'true' : 'false'}
	    data-show-terminal-view-mode-toggle={props.showTerminalViewModeToggle ? 'true' : 'false'}
	    data-terminal-view-mode={props.terminalViewMode}
	  >
        <textarea
          aria-label="Command composer"
          disabled={props.composerDisabled}
          placeholder={props.composerPlaceholder}
          value={props.composerValue}
          onChange={(event) => props.onComposerChange?.(event.target.value)}
        />
        {props.composerAttachments.map(attachment => <span key={attachment.path}>{attachment.name}</span>)}
        {props.composerSecondaryAction}
        <button type="button" aria-label={props.composerSubmitLabel} disabled={props.composerDisabled || props.composerSubmitDisabled} onClick={() => props.onComposerSubmit?.(props.composerValue)}>
          Send composer
        </button>
	    {props.showTerminalToggle ? (
	      <button type="button" onClick={() => props.onToggleTerminalPanel?.()}>
	        Toggle terminal
	      </button>
	    ) : null}
	    {props.showTerminalViewModeToggle ? (
	      <>
	        <button type="button" onClick={() => props.onToggleTerminalViewMode?.('codex')}>
	          Codex UI
	        </button>
	        <button type="button" onClick={() => props.onToggleTerminalViewMode?.('terminal')}>
	          Raw Terminal
	        </button>
	      </>
	    ) : null}
	  </div>
    );
  },
}));

vi.mock('./MobileKeybar', () => ({
  MobileKeybar(props) {
    return (
      <div
        data-testid="mobile-keybar"
        data-session-id={props.sessionId}
        data-open={props.isOpen ? 'true' : 'false'}
      />
    );
  },
}));

vi.mock('../hooks/useMobileChatTurns', () => ({
  useMobileChatTurns(args) {
    return mockUseMobileChatTurns(args);
  },
}));

vi.mock('../hooks/useStructuredSession', () => ({
  useStructuredSession(args) {
    return mockUseStructuredSession(args);
  },
}));
vi.mock('../hooks/useSessionBrowserApprovals', () => ({
  useSessionBrowserApprovals: options => {
    lastBrowserReviewOptions = options;
    return { requests: options.enabled ? browserReviewRequests : [], decide: decideBrowserReview, isDeciding: false, error: '' };
  },
}));

vi.mock('../contexts/TerminalSessionContext', () => ({
  useTerminalSession() {
    return {
      listSessionGitBranches: mockListSessionGitBranches,
      checkoutSessionGitBranch: mockCheckoutSessionGitBranch,
      createSession: mockCreateSession,
      closeSession: mockCloseSession,
      updateThreadMetadata: mockUpdateThreadMetadata,
      restoreSession: mockRestoreSession,
      updateStructuredSessionSelection: mockUpdateStructuredSessionSelection,
      sendRawToSession: mockSendRawToSession,
    };
  },
}));

const BASE_SESSIONS = [
  {
    id: 'session-a',
    title: 'Main terminal',
    cwd: 'C:/work/terminal-v4',
    thread: {
      topic: 'Ship mobile parity',
      topicAutoGenerated: false,
      projectPath: 'C:/work/terminal-v4',
    },
  },
  {
    id: 'session-b',
    title: 'Docs terminal',
    cwd: 'C:/work/docs',
    thread: {
      topic: 'Review release checklist',
      topicAutoGenerated: false,
      projectPath: 'C:/work/docs',
    },
  },
];

function createMobileChatTurnsState() {
  return {
    turns: [],
    isLoading: false,
    isSendReady: true,
    handleTurn: vi.fn(),
    handleRegisterSendText: vi.fn(),
    handleChatSend: vi.fn(() => ({ queued: false })),
    handleRawSend: vi.fn(() => ({ queued: false })),
    handleInterrupt: vi.fn(() => ({ queued: false })),
  };
}

function createStructuredSessionState() {
  return {
    messages: [],
    currentToolCalls: [],
    pendingApproval: null,
    isStreaming: false,
    connectionState: 'online',
    sendMessage: vi.fn(),
    interrupt: vi.fn(),
    approve: vi.fn(),
  };
}

function renderMobileShell(overrides = {}) {
  const sessions = overrides.sessions ?? BASE_SESSIONS;
  return render(
    <MobileShell
      visible={overrides.visible ?? true}
      showWorkspaceStart={overrides.showWorkspaceStart ?? false}
      sessions={sessions}
      activeSessionId={overrides.activeSessionId ?? sessions[0]?.id ?? null}
      onSelectSession={overrides.onSelectSession ?? vi.fn()}
      onCreateSession={overrides.onCreateSession ?? vi.fn()}
      onSubmitPrompt={overrides.onSubmitPrompt}
      projectInfo={overrides.projectInfo ?? { cwd: 'C:/work/terminal-v4', gitBranch: 'main' }}
      sessionActivity={overrides.sessionActivity ?? {}}
      onSessionBusyChange={overrides.onSessionBusyChange ?? vi.fn()}
      fontSize={14}
      webglEnabled
      viewportHeight={800}
      mobileView="terminal"
      showSessionStrip={overrides.showSessionStrip}
      threadTerminalOpen={overrides.threadTerminalOpen}
      onThreadTerminalOpenChange={overrides.onThreadTerminalOpenChange}
      terminalSessions={overrides.terminalSessions}
      onViewChange={overrides.onViewChange ?? vi.fn()}
      chatMode={false}
      onChatModeChange={overrides.onChatModeChange ?? vi.fn()}
      accessoryOpen={overrides.accessoryOpen ?? false}
      onAccessoryToggle={overrides.onAccessoryToggle ?? vi.fn()}
      onAccessoryHeightChange={overrides.onAccessoryHeightChange ?? vi.fn()}
      onRegisterFocusTerminal={overrides.onRegisterFocusTerminal ?? vi.fn()}
      onUrlDetected={overrides.onUrlDetected ?? vi.fn()}
      sessionAiTypes={overrides.sessionAiTypes ?? { 'session-a': 'codex', 'ss-structured': 'codex' }}
      customAiProviders={overrides.customAiProviders ?? []}
      onSetSessionAiType={overrides.onSetSessionAiType ?? vi.fn()}
      onAddCustomAiProvider={overrides.onAddCustomAiProvider ?? vi.fn()}
    />
  );
}

describe('MobileShell', () => {
  it('lets a phone user confirm closing the selected terminal without losing the conversation draft', async () => {
    const session = { id: 'ss-mobile-close', runtime: 'codex', cwd: '/work/project' };
    const terminals = [
      { id: 'pty-mobile-first', isActive: true, thread: { companionOf: session.id }, createdAt: '2026-01-01' },
      { id: 'pty-mobile-second', isActive: true, thread: { companionOf: session.id }, createdAt: '2026-01-02' },
    ];
    renderMobileShell({ sessions: [session], terminalSessions: [session, ...terminals], activeSessionId: session.id, threadTerminalOpen: true });
    await screen.findByTestId('desktop-conversation-view');
    fireEvent.change(screen.getByLabelText('Command composer'), { target: { value: 'Keep this draft' } });
    const drawer = screen.getByRole('region', { name: 'Thread terminal' });
    fireEvent.click(within(drawer).getByRole('tab', { name: 'Terminal 2' }));
    fireEvent.click(within(drawer).getByRole('button', { name: 'Close Terminal 2' }));
    expect(mockCloseSession).not.toHaveBeenCalled();
    const confirmation = within(drawer).getByRole('group', { name: 'Confirm closing Terminal 2' });
    expect(within(confirmation).getByText(/Anything running in it will stop/)).toBeVisible();
    fireEvent.click(within(confirmation).getByRole('button', { name: 'Close Terminal 2' }));
    await waitFor(() => expect(mockCloseSession).toHaveBeenCalledWith('pty-mobile-second'));
    expect(screen.getByLabelText('Command composer')).toHaveValue('Keep this draft');
  });

  it('keeps the selected terminal open when the confirmation is dismissed', async () => {
    const session = { id: 'ss-mobile-keep-terminal', runtime: 'codex', cwd: '/work/project' };
    const terminal = { id: 'pty-mobile-keep', isActive: true, thread: { companionOf: session.id } };
    renderMobileShell({ sessions: [session], terminalSessions: [session, terminal], activeSessionId: session.id, threadTerminalOpen: true, onThreadTerminalOpenChange: vi.fn() });
    const drawer = screen.getByRole('region', { name: 'Thread terminal' });
    const close = within(drawer).getByRole('button', { name: 'Close Terminal 1' });
    fireEvent.click(close);
    const confirmation = within(drawer).getByRole('group', { name: 'Confirm closing Terminal 1' });
    expect(within(confirmation).getByRole('button', { name: 'Keep open' })).toHaveFocus();
    fireEvent.keyDown(confirmation, { key: 'Escape' });
    expect(within(drawer).queryByRole('group', { name: 'Confirm closing Terminal 1' })).not.toBeInTheDocument();
    expect(close).toHaveFocus();
    expect(mockCloseSession).not.toHaveBeenCalled();
  });

  it('closes the drawer before removing its last terminal and reopens it on a failed close', async () => {
    const session = { id: 'ss-mobile-last-terminal', runtime: 'codex', cwd: '/work/project' };
    const terminal = { id: 'pty-mobile-last', isActive: true, thread: { companionOf: session.id } };
    const onThreadTerminalOpenChange = vi.fn();
    mockCreateSession.mockClear();
    mockCloseSession.mockRejectedValueOnce(new Error('close failed'));
    renderMobileShell({ sessions: [session], terminalSessions: [session, terminal], activeSessionId: session.id, threadTerminalOpen: true, onThreadTerminalOpenChange });
    const drawer = screen.getByRole('region', { name: 'Thread terminal' });
    fireEvent.click(within(drawer).getByRole('button', { name: 'Close Terminal 1' }));
    const confirmation = within(drawer).getByRole('group', { name: 'Confirm closing Terminal 1' });
    fireEvent.click(within(confirmation).getByRole('button', { name: 'Close Terminal 1' }));
    await waitFor(() => expect(onThreadTerminalOpenChange.mock.calls).toEqual([[session.id, false], [session.id, true]]));
    expect(within(drawer).getByRole('alert')).toHaveTextContent('This terminal could not be closed.');
    expect(mockCreateSession).not.toHaveBeenCalled();
  });

  it('does not reopen an old thread terminal when a pending close fails after switching threads', async () => {
    const first = { id: 'ss-mobile-close-old', runtime: 'codex', cwd: '/work/project' };
    const second = { id: 'ss-mobile-close-new', runtime: 'codex', cwd: '/work/project' };
    const firstTerminal = { id: 'pty-mobile-close-old', isActive: true, thread: { companionOf: first.id } };
    const secondTerminal = { id: 'pty-mobile-close-new', isActive: true, thread: { companionOf: second.id } };
    const sessions = [first, second], terminals = [...sessions, firstTerminal, secondTerminal];
    const onThreadTerminalOpenChange = vi.fn();
    let finish;
    mockCloseSession.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const view = renderMobileShell({ sessions, terminalSessions: terminals, activeSessionId: first.id, threadTerminalOpen: true, onThreadTerminalOpenChange });
    let drawer = screen.getByRole('region', { name: 'Thread terminal' });
    fireEvent.click(within(drawer).getByRole('button', { name: 'Close Terminal 1' }));
    fireEvent.click(within(within(drawer).getByRole('group', { name: 'Confirm closing Terminal 1' })).getByRole('button', { name: 'Close Terminal 1' }));
    expect(onThreadTerminalOpenChange).toHaveBeenCalledWith(first.id, false);
    view.rerender(<MobileShell sessions={sessions} terminalSessions={terminals} activeSessionId={second.id} threadTerminalOpen onThreadTerminalOpenChange={onThreadTerminalOpenChange} />);
    await act(async () => finish({ ok: false }));
    drawer = screen.getByRole('region', { name: 'Thread terminal' });
    expect(within(drawer).queryByRole('alert')).not.toBeInTheDocument();
    expect(onThreadTerminalOpenChange).toHaveBeenCalledTimes(1);
    expect(await within(drawer).findByTestId('terminal-chat')).toHaveAttribute('data-session-id', secondTerminal.id);
  });
  it('copies an earlier message into the current draft without discarding what was typed', async () => {
    const session = { id: 'ss-mobile-edit', runtime: 'codex', cwd: '/work/project' };
    renderMobileShell({ sessions: [session], activeSessionId: session.id });
    await screen.findByTestId('desktop-conversation-view');
    fireEvent.change(screen.getByLabelText('Command composer'), { target: { value: 'Existing draft' } });
    act(() => lastConversationViewProps.onEditMessage('Earlier message'));
    expect(screen.getByLabelText('Command composer')).toHaveValue('Existing draft\n\nEarlier message');
  });

  it('sends a plan request and implements a plan without losing a separate draft', async () => {
    const session = { id: 'ss-mobile-plan', runtime: 'codex', cwd: '/work/project' };
    const state = { ...createStructuredSessionState(), sendMessage: vi.fn().mockResolvedValue({ accepted: true }) };
    mockUseStructuredSession.mockReturnValue(state);
    renderMobileShell({ sessions: [session], activeSessionId: session.id });
    await screen.findByTestId('desktop-conversation-view');
    fireEvent.click(screen.getByRole('button', { name: 'Plan mode' }));
    fireEvent.change(screen.getByLabelText('Command composer'), { target: { value: 'Review this change' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
    await waitFor(() => expect(state.sendMessage).toHaveBeenCalledWith('[Plan] Review this change'));
    fireEvent.change(screen.getByLabelText('Command composer'), { target: { value: 'Keep this follow-up' } });
    await act(async () => { await lastConversationViewProps.onImplementPlan('Plan'); });
    expect(state.sendMessage).toHaveBeenCalledWith('Implement the plan above.');
    expect(screen.getByLabelText('Command composer')).toHaveValue('Keep this follow-up');
    expect(screen.getByRole('button', { name: 'Plan mode' })).toHaveAttribute('aria-pressed', 'false');
  });

  it('starts a fork and a plan in a new thread with the same project and model', async () => {
    const session = { id: 'ss-mobile-fork', runtime: 'codex', cwd: '/work/project', model: 'example-model', reasoning: 'high' };
    const onSubmitPrompt = vi.fn().mockResolvedValue({ accepted: true });
    renderMobileShell({ sessions: [session], activeSessionId: session.id, onSubmitPrompt });
    await screen.findByTestId('desktop-conversation-view');
    fireEvent.change(screen.getByLabelText('Command composer'), { target: { value: 'Keep my draft' } });
    await act(async () => { await lastConversationViewProps.onForkFromMessage('Fork context'); });
    await act(async () => { await lastConversationViewProps.onImplementPlanInNewThread('The plan'); });
    expect(onSubmitPrompt.mock.calls).toEqual([
      ['Fork context', { path: '/work/project', agentId: 'codex', selection: { model: 'example-model', reasoning: 'high' } }],
      ['Implement this plan:\n\nThe plan', { path: '/work/project', agentId: 'codex', selection: { model: 'example-model', reasoning: 'high' } }],
    ]);
    expect(screen.getByLabelText('Command composer')).toHaveValue('Keep my draft');
  });

  it('shows a failed fork without clearing the current draft', async () => {
    const session = { id: 'ss-mobile-fork-failed', runtime: 'codex', cwd: '/work/project' };
    renderMobileShell({ sessions: [session], activeSessionId: session.id, onSubmitPrompt: vi.fn().mockRejectedValue(new Error('Could not create the thread.')) });
    await screen.findByTestId('desktop-conversation-view');
    fireEvent.change(screen.getByLabelText('Command composer'), { target: { value: 'Keep this draft' } });
    await act(async () => { await lastConversationViewProps.onForkFromMessage('Fork context'); });
    expect(screen.getByText('Could not create the thread.')).toBeVisible();
    expect(screen.getByLabelText('Command composer')).toHaveValue('Keep this draft');
  });

  it('shows a fork send failure on the newly opened conversation', async () => {
    const session = { id: 'ss-mobile-fork-origin', runtime: 'codex', cwd: '/work/project' };
    const next = { ...session, id: 'ss-mobile-fork-created' };
    let reject;
    const onSubmitPrompt = vi.fn(() => new Promise((_, rejectPromise) => { reject = rejectPromise; }));
    const view = renderMobileShell({ sessions: [session], activeSessionId: session.id, onSubmitPrompt });
    await screen.findByTestId('desktop-conversation-view');
    let pending;
    act(() => { pending = lastConversationViewProps.onForkFromMessage('Fork context'); });
    view.rerender(<MobileShell sessions={[session, next]} activeSessionId={next.id} onSubmitPrompt={onSubmitPrompt} />);
    const failure = Object.assign(new Error('The prompt is saved in the conversation.'), { sessionId: next.id });
    await act(async () => { reject(failure); await pending; });
    expect(screen.getByText('The prompt is saved in the conversation.')).toBeVisible();
  });

  it.each(['offline', 'cleanup'])('does not start actions while %s', async status => {
    const session = { id: `ss-mobile-action-${status}`, runtime: 'codex', cwd: '/work/project' };
    mockUseStructuredSession.mockReturnValue({ ...createStructuredSessionState(), connectionState: status === 'offline' ? 'offline' : 'online', requiresCleanup: status === 'cleanup' });
    renderMobileShell({ sessions: [session], activeSessionId: session.id, onSubmitPrompt: vi.fn() });
    await screen.findByTestId('desktop-conversation-view');
    expect(lastConversationViewProps.onForkFromMessage).toBeUndefined();
    expect(lastConversationViewProps.onImplementPlan).toBeUndefined();
  });

  it('does not offer mutating conversation actions in a read-only environment', async () => {
    setActiveEnvironment({ id: 'observer-actions', capabilities: {} });
    const session = { id: 'ss-mobile-readonly-actions', runtime: 'codex', cwd: '/work/project' };
    renderMobileShell({ sessions: [session], activeSessionId: session.id, onSubmitPrompt: vi.fn() });
    await screen.findByTestId('desktop-conversation-view');
    expect(lastConversationViewProps).toMatchObject({ onEditMessage: undefined, onImplementPlan: undefined, onImplementPlanInNewThread: undefined, onForkFromMessage: undefined });
    expect(screen.queryByRole('button', { name: 'Plan mode' })).not.toBeInTheDocument();
  });
  it('opens a thread-owned terminal in the conversation folder without changing the draft', async () => {
    const session = { id: 'ss-companion', title: 'Conversation', runtime: 'codex', cwd: '/work/project' };
    const onSelectSession = vi.fn();
    renderMobileShell({ sessions: [session], terminalSessions: [session], activeSessionId: session.id, threadTerminalOpen: true, onSelectSession });
    fireEvent.change(screen.getByLabelText('Command composer'), { target: { value: 'Keep this draft' } });
    const terminal = await screen.findByTestId('terminal-chat');
    expect(terminal).toHaveAttribute('data-session-id', 'pty-mobile');
    expect(mockCreateSession).toHaveBeenCalledWith({ cwd: '/work/project', title: 'Terminal', select: false, requestId: expect.stringMatching(/^[0-9a-f-]{36}$/), companionOf: session.id });
    expect(mockUpdateThreadMetadata).toHaveBeenCalledWith('pty-mobile', { companionOf: session.id });
    expect(screen.getByLabelText('Command composer')).toHaveValue('Keep this draft');
    expect(onSelectSession).not.toHaveBeenCalled();
  });

  it('reuses existing thread terminals and sends the keyboard bar to the selected shell', async () => {
    const session = { id: 'ss-companion-existing', runtime: 'v4', cwd: '/work/project' };
    const terminals = [
      { id: 'pty-first', isActive: true, thread: { companionOf: session.id }, createdAt: '2026-01-01' },
      { id: 'pty-second', isActive: true, thread: { companionOf: session.id }, createdAt: '2026-01-02' },
    ];
    mockCreateSession.mockClear();
    renderMobileShell({ sessions: [session], terminalSessions: [...terminals, session], activeSessionId: session.id, threadTerminalOpen: true, accessoryOpen: true });
    expect(await screen.findByTestId('terminal-chat')).toHaveAttribute('data-session-id', 'pty-first');
    fireEvent.click(screen.getByRole('tab', { name: 'Terminal 2' }));
    expect(await screen.findByTestId('terminal-chat')).toHaveAttribute('data-session-id', 'pty-second');
    expect(screen.getByTestId('mobile-keybar')).toHaveAttribute('data-session-id', 'pty-second');
    expect(mockCreateSession).not.toHaveBeenCalled();
  });

  it('keeps a working thread terminal visible when adding another fails', async () => {
    const session = { id: 'ss-companion-add-fails', runtime: 'codex', cwd: '/work/project' };
    const terminal = { id: 'pty-working-mobile', isActive: true, thread: { companionOf: session.id } };
    mockCreateSession.mockReset().mockRejectedValueOnce(new Error('Cannot add terminal'));
    try {
      renderMobileShell({ sessions: [session], terminalSessions: [session, terminal], activeSessionId: session.id, threadTerminalOpen: true });
      const drawer = await screen.findByRole('region', { name: 'Thread terminal' });
      expect(within(drawer).getByTestId('terminal-chat')).toHaveAttribute('data-session-id', terminal.id);
      fireEvent.click(within(drawer).getByRole('button', { name: 'New terminal in this thread' }));
      expect(await within(drawer).findByRole('alert')).toHaveTextContent('Cannot add terminal');
      expect(within(drawer).getByTestId('terminal-chat')).toHaveAttribute('data-session-id', terminal.id);
      expect(within(drawer).getByRole('button', { name: 'I checked the list; start another' })).toBeVisible();
      fireEvent.click(within(drawer).getByRole('button', { name: 'Dismiss terminal error' }));
      expect(within(drawer).queryByRole('alert')).not.toBeInTheDocument();
      expect(within(drawer).getByTestId('terminal-chat')).toHaveAttribute('data-session-id', terminal.id);
    } finally {
      mockCreateSession.mockReset().mockResolvedValue({ id: 'pty-mobile' });
    }
  });

  it('removes old thread terminal controls when the environment changes while the drawer is open', async () => {
    const session = { id: 'ss-companion-env-change', runtime: 'codex', cwd: '/work/project' };
    const terminal = { id: 'pty-old-environment', isActive: true, thread: { companionOf: session.id } };
    renderMobileShell({ sessions: [session], terminalSessions: [session, terminal], activeSessionId: session.id, threadTerminalOpen: true, accessoryOpen: true });
    expect(await screen.findByTestId('mobile-keybar')).toHaveAttribute('data-session-id', terminal.id);
    act(() => setActiveEnvironment({ id: 'other-server', capabilities: { terminalInput: true, agentExecute: true } }));
    expect(await screen.findByRole('alert')).toHaveTextContent('The account or environment changed. Close and reopen the terminal.');
    expect(screen.queryByTestId('mobile-keybar')).not.toBeInTheDocument();
    expect(screen.queryByTestId('terminal-chat')).not.toBeInTheDocument();
    expect(screen.queryByRole('tablist', { name: 'Thread terminals' })).not.toBeInTheDocument();
  });

  it('does not show an old thread terminal when the new environment denies terminal input', async () => {
    const session = { id: 'ss-companion-env-readonly', runtime: 'codex', cwd: '/work/project' };
    const terminal = { id: 'pty-old-readonly', isActive: true, thread: { companionOf: session.id } };
    renderMobileShell({ sessions: [session], terminalSessions: [session, terminal], activeSessionId: session.id, threadTerminalOpen: true, accessoryOpen: true });
    expect(await screen.findByTestId('terminal-chat')).toHaveAttribute('data-session-id', terminal.id);
    act(() => setActiveEnvironment({ id: 'other-readonly-server', capabilities: { agentExecute: true } }));
    expect(await screen.findByText('Terminal access is unavailable for this environment.')).toBeVisible();
    expect(screen.queryByTestId('mobile-keybar')).not.toBeInTheDocument();
    expect(screen.queryByTestId('terminal-chat')).not.toBeInTheDocument();
    expect(screen.queryByRole('tablist', { name: 'Thread terminals' })).not.toBeInTheDocument();
  });

  it('keeps a thread terminal mounted but disables its input while the workspace is covered', async () => {
    const session = { id: 'ss-companion-covered', runtime: 'codex', cwd: '/work/project' };
    const terminal = { id: 'pty-covered', isActive: true, thread: { companionOf: session.id } };
    const sessions = [session, terminal];
    const view = renderMobileShell({ sessions: [session], terminalSessions: sessions, activeSessionId: session.id, threadTerminalOpen: true });
    const surface = await screen.findByTestId('terminal-chat');
    expect(surface).toHaveAttribute('data-session-id', terminal.id);
    view.rerender(<MobileShell sessions={[session]} terminalSessions={sessions} activeSessionId={session.id} threadTerminalOpen visible={false} />);
    expect(screen.getByTestId('terminal-chat')).toBe(surface);
    expect(surface).toHaveAttribute('data-input-enabled', 'false');
    expect(screen.queryByTestId('mobile-keybar')).not.toBeInTheDocument();
  });

  it('waits for restored terminal permission before linking a pending thread terminal', async () => {
    let finishCreate;
    mockCreateSession.mockReset().mockImplementationOnce(() => new Promise(resolve => { finishCreate = resolve; }));
    mockUpdateThreadMetadata.mockReset().mockImplementation(echoThreadPatch);
    const session = { id: 'ss-companion-capability-change', runtime: 'codex', cwd: '/work/project' };
    const allowed = { id: 'capability-server', capabilities: { terminalInput: true, agentExecute: true } };
    try {
      act(() => setActiveEnvironment(allowed));
      renderMobileShell({ sessions: [session], terminalSessions: [session], activeSessionId: session.id, threadTerminalOpen: true });
      await waitFor(() => expect(mockCreateSession).toHaveBeenCalledOnce());
      act(() => setActiveEnvironment({ ...allowed, capabilities: { agentExecute: true } }));
      await act(async () => finishCreate({ id: 'pty-pending-capability' }));
      expect(mockUpdateThreadMetadata).not.toHaveBeenCalled();
      expect(screen.queryByTestId('terminal-chat')).not.toBeInTheDocument();
      act(() => setActiveEnvironment(allowed));
      expect(await screen.findByRole('alert')).toHaveTextContent('Terminal access changed before it could be linked.');
      fireEvent.click(screen.getByRole('button', { name: 'Retry opening terminal' }));
      expect(await screen.findByTestId('terminal-chat')).toHaveAttribute('data-session-id', 'pty-pending-capability');
      expect(mockCreateSession).toHaveBeenCalledOnce();
      expect(mockUpdateThreadMetadata).toHaveBeenCalledWith('pty-pending-capability', { companionOf: session.id });
    } finally {
      mockCreateSession.mockReset().mockResolvedValue({ id: 'pty-mobile' });
      mockUpdateThreadMetadata.mockReset().mockImplementation(echoThreadPatch);
    }
  });

  it('does not show a shortcut bar without a target while a thread terminal opens', async () => {
    let finishCreate;
    mockCreateSession.mockReset().mockImplementationOnce(() => new Promise(resolve => { finishCreate = resolve; }));
    mockUpdateThreadMetadata.mockReset().mockImplementation(echoThreadPatch);
    const session = { id: 'ss-companion-opening', aiType: 'claude', runtime: 'claude', cwd: '/work/project' };
    try {
      renderMobileShell({ sessions: [session], terminalSessions: [session], activeSessionId: session.id, threadTerminalOpen: true, accessoryOpen: true });
      await waitFor(() => expect(mockCreateSession).toHaveBeenCalledOnce());
      fireEvent.click(screen.getByRole('button', { name: 'Open terminal view' }));
      expect(screen.queryByTestId('mobile-keybar')).not.toBeInTheDocument();
      await act(async () => finishCreate({ id: 'pty-opened' }));
      expect(await screen.findByTestId('mobile-keybar')).toHaveAttribute('data-session-id', 'pty-opened');
    } finally {
      mockCreateSession.mockReset().mockResolvedValue({ id: 'pty-mobile' });
      mockUpdateThreadMetadata.mockReset().mockImplementation(echoThreadPatch);
    }
  });

  it('hides the shortcut bar when a thread terminal loses its scope even if the inline terminal is open', async () => {
    const session = { id: 'ss-claude-scope', aiType: 'claude', runtime: 'claude', cwd: '/work/project' };
    const terminal = { id: 'pty-claude-scope', isActive: true, thread: { companionOf: session.id } };
    renderMobileShell({ sessions: [session], terminalSessions: [session, terminal], activeSessionId: session.id, threadTerminalOpen: true, accessoryOpen: true });
    expect(await screen.findByTestId('mobile-keybar')).toHaveAttribute('data-session-id', terminal.id);
    fireEvent.click(screen.getByRole('button', { name: 'Open terminal view' }));
    act(() => setActiveEnvironment({ id: 'claude-other-server', capabilities: { terminalInput: true, agentExecute: true } }));
    expect(await screen.findByRole('alert')).toHaveTextContent('The account or environment changed.');
    expect(screen.queryByTestId('mobile-keybar')).not.toBeInTheDocument();
  });

  it('does not create a terminal when the environment cannot use terminal input', async () => {
    setActiveEnvironment({ id: 'observer-terminal', capabilities: { agentExecute: true } });
    const session = { id: 'ss-companion-readonly', runtime: 'v4', cwd: '/work/project' };
    mockCreateSession.mockClear();
    renderMobileShell({ sessions: [session], activeSessionId: session.id, threadTerminalOpen: true });
    expect(await screen.findByText('Terminal access is unavailable for this environment.')).toBeVisible();
    expect(mockCreateSession).not.toHaveBeenCalled();
  });

  it('lets the user retry a failed thread terminal creation', async () => {
    mockCreateSession.mockRejectedValueOnce(new Error('Terminal unavailable')).mockResolvedValueOnce({ id: 'pty-retry' });
    const session = { id: 'ss-companion-retry', runtime: 'codex', cwd: '/work/project' };
    renderMobileShell({ sessions: [session], activeSessionId: session.id, threadTerminalOpen: true });
    expect(await screen.findByRole('alert')).toHaveTextContent('Terminal unavailable');
    fireEvent.click(screen.getByRole('button', { name: 'I checked the list; start another' }));
    expect(await screen.findByTestId('terminal-chat')).toHaveAttribute('data-session-id', 'pty-retry');
  });
  it('lets the user retry a failed restore of an existing thread terminal', async () => {
    const session = { id: 'ss-companion-restart', runtime: 'codex', cwd: '/work/project' };
    const terminal = { id: 'pty-ended', isActive: false, thread: { companionOf: session.id } };
    mockRestoreSession.mockReset().mockRejectedValueOnce(new Error('Restore failed')).mockResolvedValueOnce({ restored: true });
    renderMobileShell({ sessions: [session], terminalSessions: [session, terminal], activeSessionId: session.id, threadTerminalOpen: true });
    expect(await screen.findByRole('alert')).toHaveTextContent('This terminal could not be restarted.');
    fireEvent.click(screen.getByRole('button', { name: 'Retry opening terminal' }));
    await waitFor(() => expect(mockRestoreSession).toHaveBeenCalledTimes(2));
    expect(await screen.findByTestId('terminal-chat')).toHaveAttribute('data-session-id', 'pty-ended');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('keeps the selected terminal retry visible when another tab fails later', async () => {
    const pending = {};
    mockRestoreSession.mockReset().mockImplementation(id => new Promise((resolve, reject) => { pending[id] = { resolve, reject }; }));
    const session = { id: 'ss-companion-two-failures', runtime: 'codex', cwd: '/work/project' };
    const terminals = [
      { id: 'pty-first-fail', isActive: false, thread: { companionOf: session.id }, createdAt: '2026-01-01' },
      { id: 'pty-second-fail', isActive: false, thread: { companionOf: session.id }, createdAt: '2026-01-02' },
    ];
    try {
      renderMobileShell({ sessions: [session], terminalSessions: [session, ...terminals], activeSessionId: session.id, threadTerminalOpen: true });
      await waitFor(() => expect(mockRestoreSession).toHaveBeenCalledTimes(1));
      const drawer = screen.getByRole('region', { name: 'Thread terminal' });
      fireEvent.click(within(drawer).getByRole('tab', { name: 'Terminal 2' }));
      await waitFor(() => expect(mockRestoreSession).toHaveBeenCalledTimes(2));
      await act(async () => pending['pty-second-fail'].reject(new Error('second failed')));
      await act(async () => pending['pty-first-fail'].reject(new Error('first failed late')));
      expect(within(drawer).getByRole('alert')).toHaveTextContent('This terminal could not be restarted.');
      fireEvent.click(within(drawer).getByRole('button', { name: 'Retry opening terminal' }));
      expect(mockRestoreSession).toHaveBeenCalledTimes(3);
      await act(async () => pending['pty-second-fail'].resolve({ restored: true }));
      expect(within(drawer).queryByRole('alert')).not.toBeInTheDocument();
      fireEvent.click(within(drawer).getByRole('tab', { name: 'Terminal 1' }));
      expect(within(drawer).getByRole('alert')).toHaveTextContent('This terminal could not be restarted.');
    } finally {
      mockRestoreSession.mockReset().mockResolvedValue({ restored: true });
    }
  });
  it('keeps the terminal mounted while a covered workspace disables input and sizing ownership', async () => {
    const view = renderMobileShell();
    const terminal = await screen.findByTestId('terminal-chat');
    const composer = screen.getByLabelText('Command composer');
    fireEvent.change(composer, { target: { value: 'keep this draft' } });
    view.rerender(<MobileShell sessions={BASE_SESSIONS} activeSessionId={BASE_SESSIONS[0].id} visible={false} />);
    expect(screen.getByTestId('terminal-chat')).toBe(terminal);
    expect({ input: lastMobileTerminalProps.inputEnabled, primary: lastMobileTerminalProps.isPrimary, activeComposer: lastStatusBarProps.isActive, voiceAvailable: lastStatusBarProps.voiceAvailable }).toEqual({ input: false, primary: false, activeComposer: false, voiceAvailable: false });
    expect(screen.getByLabelText('Command composer')).toHaveValue('keep this draft');
    expect(mockUseMobileChatTurns.mock.results.at(-1).value.handleChatSend).not.toHaveBeenCalled();
  });
  it('hides private output review when the mobile workspace is covered', async () => {
    const session = { id: 'ss-private-review', runtime: 'v4', cwd: '/work/project' };
    const view = renderMobileShell({ sessions: [session], activeSessionId: session.id });
    await screen.findByTestId('desktop-conversation-view');
    expect(lastConversationViewProps.privateReviewVisible).toBe(true);
    view.rerender(<MobileShell sessions={[session]} activeSessionId={session.id} visible={false} />);
    expect(lastConversationViewProps.privateReviewVisible).toBe(false);
  });
  it('keeps the phone terminal draft while HTTP acceptance is pending and after rejection', async () => {
    let rejectDelivery;
    const terminal = createMobileChatTurnsState();
    terminal.handleChatSend.mockImplementation(() => ({ queued: false, completion: new Promise((_resolve, reject) => { rejectDelivery = reject; }) }));
    mockUseMobileChatTurns.mockReturnValue(terminal);
    renderMobileShell();
    fireEvent.change(screen.getByLabelText('Command composer'), { target: { value: 'echo phone pending' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send composer' }));
    expect(screen.getByLabelText('Command composer')).toHaveValue('echo phone pending');
    await act(async () => { rejectDelivery(new Error('Terminal input was not accepted (404).')); });
    expect(screen.getByLabelText('Command composer')).toHaveValue('echo phone pending');
    expect(screen.getByText('Terminal input was not accepted (404).')).toBeInTheDocument();
  });
  it('shows the new-task composer without falling back to an existing conversation', () => {
    renderMobileShell({ showWorkspaceStart: true });
    expect(screen.getByRole('heading', { name: 'What should we build?' })).toBeInTheDocument();
    expect(screen.getByLabelText('Project')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Start task' })).toBeDisabled();
  });
  beforeEach(() => {
    setActiveEnvironment(null);
    lastContextProps = null;
    lastStatusBarProps = null;
    lastConversationViewProps = null; lastBrowserReviewOptions = null; browserReviewRequests = []; decideBrowserReview.mockReset();
    mockUseMobileChatTurns.mockReturnValue(createMobileChatTurnsState());
    mockUseStructuredSession.mockReturnValue(createStructuredSessionState());
    mockListSessionGitBranches.mockClear();
    mockCheckoutSessionGitBranch.mockClear();
    mockUpdateStructuredSessionSelection.mockClear();
    mockSendRawToSession.mockReset();
    mockCloseSession.mockReset().mockResolvedValue(undefined);
    mockRawInputMode = 'legacy';
  });

  it('offers project mentions, installed skills and supported file attachments in structured conversations', () => {
    const session = { id: 'ss-phone-files', runtime: 'codex', cwd: '/work/project' };
    const view = renderMobileShell({ sessions: [session], activeSessionId: session.id });
    expect(lastStatusBarProps).toMatchObject({ mentionRoot: '/work/project', allowAnyFile: true, skills: [{ name: 'project-review', description: 'Review this project' }] });
    const v4 = { ...session, id: 'ss-phone-v4-files', runtime: 'v4' };
    view.rerender(<MobileShell sessions={[v4]} activeSessionId={v4.id} />);
    expect(lastStatusBarProps).toMatchObject({ mentionRoot: '/work/project', allowAnyFile: false });
  });

  it('passes provider-reported context to the phone composer only for supported native sessions', () => {
    mockUseStructuredSession.mockReturnValue({ ...createStructuredSessionState(), contextUsage: { contextTokens: 50, contextWindow: 200 } });
    const session = { id: 'ss-phone-meter', runtime: 'codex', cwd: '/work/project' };
    const view = renderMobileShell({ sessions: [session], activeSessionId: session.id });
    expect(lastStatusBarProps.composerContext).toEqual({ percent: 25, label: 'Context 25%', detail: '50 of 200 tokens' });
    const v4 = { ...session, runtime: 'v4' };
    view.rerender(<MobileShell sessions={[v4]} activeSessionId={v4.id} />);
    expect(lastStatusBarProps.composerContext).toBeNull();
  });

  it('reports an uncertain raw input without clearing the mobile draft', async () => {
    mockSendRawToSession.mockRejectedValueOnce(Object.assign(new Error('Input may have been delivered. Check the terminal.'), { deliveryUncertain: true }));
    const session = { id: 'ss-phone-raw-error', aiType: 'claude', cwd: '/work/project' };
    renderMobileShell({ sessions: [session], activeSessionId: session.id });
    render(<RawInputPending />);
    await screen.findByTestId('desktop-conversation-view');
    fireEvent.change(screen.getByLabelText('Command composer'), { target: { value: 'Keep the phone draft' } });
    await act(async () => { await lastConversationViewProps.onSendRaw('\r'); });
    await waitFor(() => expect(mockSendRawToSession).toHaveBeenCalledWith(session.id, '\r', { requireLegacy: true }));
    expect(screen.getByLabelText('Command composer')).toHaveValue('Keep the phone draft');
    expect(await screen.findByText('Input may have been delivered. Check the terminal.')).toBeInTheDocument();
    act(() => getSupervisedInputQueues().find(entry => entry.sessionId === session.id)?.queue.discard());
  });

  it('batches legacy prompt keys before sending them in order', async () => {
    const session = { id: 'ss-phone-legacy-batch', aiType: 'claude', cwd: '/work/project' };
    mockSendRawToSession.mockResolvedValue({ accepted: true });
    renderMobileShell({ sessions: [session], activeSessionId: session.id });
    await screen.findByTestId('desktop-conversation-view');
    vi.useFakeTimers();
    try {
      act(() => { lastConversationViewProps.onSendRaw('a'); lastConversationViewProps.onSendRaw('\x1b[A'); });
      expect(mockSendRawToSession).not.toHaveBeenCalled();
      await act(async () => { await vi.advanceTimersByTimeAsync(40); });
      expect(mockSendRawToSession).toHaveBeenCalledWith(session.id, 'a\x1b[A', { requireLegacy: true });
    } finally { vi.useRealTimers(); }
  });

  it('keeps file attachments with their conversation when switching threads', () => {
    const sessions = [
      { id: 'ss-files-one', runtime: 'codex', cwd: '/work/one' },
      { id: 'ss-files-two', runtime: 'codex', cwd: '/work/two' },
    ];
    const view = renderMobileShell({ sessions, activeSessionId: sessions[0].id });
    fireEvent.change(screen.getByLabelText('Command composer'), { target: { value: 'Review this file' } });
    act(() => lastStatusBarProps.onComposerAttachmentAdd({ name: 'first.txt', path: '/work/one/first.txt' }));
    expect(screen.getByText('first.txt')).toBeInTheDocument();

    view.rerender(<MobileShell sessions={sessions} activeSessionId={sessions[1].id} />);
    expect(screen.queryByText('first.txt')).not.toBeInTheDocument();
    act(() => lastStatusBarProps.onComposerAttachmentAdd({ name: 'second.txt', path: '/work/two/second.txt' }));

    view.rerender(<MobileShell sessions={sessions} activeSessionId={sessions[0].id} />);
    expect(screen.getByLabelText('Command composer')).toHaveValue('Review this file');
    expect(screen.getByText('first.txt')).toBeInTheDocument();
    expect(screen.queryByText('second.txt')).not.toBeInTheDocument();

    view.rerender(<MobileShell sessions={sessions} activeSessionId={sessions[1].id} />);
    expect(screen.getByText('second.txt')).toBeInTheDocument();
    expect(screen.queryByText('first.txt')).not.toBeInTheDocument();
  });

  it('does not carry file attachments across a change of account', () => {
    const session = { id: 'ss-phone-attachment-auth', runtime: 'codex', cwd: '/work/project' };
    renderMobileShell({ sessions: [session], activeSessionId: session.id });
    act(() => lastStatusBarProps.onComposerAttachmentAdd({ name: 'private.txt', path: '/work/project/private.txt' }));
    expect(screen.getByText('private.txt')).toBeInTheDocument();
    act(() => setTokens('fixture-access', 'fixture-refresh'));
    expect(screen.queryByText('private.txt')).not.toBeInTheDocument();
    act(() => clearTokens(true));
  });

  it('blocks sending and offers a retry if file selections cannot be saved', async () => {
    setUser({ id: 'mobile-attachment-storage-fixture' });
    const session = { id: 'ss-phone-storage-error', runtime: 'codex', cwd: '/work/project' };
    const state = { ...createStructuredSessionState(), sendMessage: vi.fn() };
    mockUseStructuredSession.mockReturnValue(state);
    renderMobileShell({ sessions: [session], activeSessionId: session.id });
    const original = Storage.prototype.setItem;
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (key, value) {
      if (key.includes('composerFiles:')) throw new Error('storage full');
      return original.call(this, key, value);
    });
    await act(async () => { lastStatusBarProps.onComposerAttachmentAdd({ name: 'private.txt', path: '/work/project/private.txt' }); });
    expect(screen.getByRole('alert')).toHaveTextContent('File selections could not be saved');
    expect(screen.getByRole('button', { name: 'Send message' })).toBeDisabled();
    await act(async () => { await lastStatusBarProps.onComposerSubmit('Review'); });
    expect(state.sendMessage).not.toHaveBeenCalled();
    setItem.mockRestore();
    fireEvent.click(screen.getByRole('button', { name: 'Retry saving files' }));
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Send message' })).toBeEnabled();
    act(() => clearTokens(true));
  });

  it('keeps the mobile draft while reviewing a conflicting saved file selection', async () => {
    setUser({ id: 'mobile-attachment-conflict-fixture' });
    const session = { id: 'ss-phone-attachment-conflict-review', runtime: 'codex', cwd: '/work/project' };
    const state = { ...createStructuredSessionState(), sendMessage: vi.fn().mockResolvedValue({ accepted: true }) };
    mockUseStructuredSession.mockReturnValue(state);
    renderMobileShell({ sessions: [session], activeSessionId: session.id });
    fireEvent.change(screen.getByLabelText('Command composer'), { target: { value: 'Keep this message' } });
    await act(async () => { lastStatusBarProps.onComposerAttachmentAdd({ name: 'mine.txt', path: '/work/project/mine.txt' }); });
    const key = Object.keys(localStorage).find(value => value.includes('composerFiles:') && value.includes(session.id));
    const saved = JSON.stringify({ version: 1, sessionId: session.id, items: [{ name: 'saved.txt', path: '/work/project/saved.txt' }] });
    localStorage.setItem(key, saved);
    act(() => window.dispatchEvent(new StorageEvent('storage', { key, newValue: saved, storageArea: localStorage })));
    expect(screen.getByRole('button', { name: 'Send message' })).toBeDisabled();
    expect(screen.getByText('mine.txt')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Review saved files' }));
    expect(screen.getByRole('group', { name: 'Saved file selections' })).toHaveTextContent('/work/project/saved.txt');
    fireEvent.click(screen.getByRole('button', { name: 'Use saved files' }));
    expect(screen.getByLabelText('Command composer')).toHaveValue('Keep this message');
    expect(screen.queryByText('mine.txt')).not.toBeInTheDocument();
    expect(screen.getByText('saved.txt')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
    await waitFor(() => expect(state.sendMessage).toHaveBeenCalledOnce());
    expect(state.sendMessage.mock.calls[0][0]).toContain('/work/project/saved.txt');
    expect(state.sendMessage.mock.calls[0][0]).not.toContain('/work/project/mine.txt');
    act(() => clearTokens(true));
  });

  it('queues a mid-turn phone message on the server queue and keeps the draft when that fails', async () => {
    const session = { id: 'ss-phone-server-queue', runtime: 'codex', cwd: '/work/project' };
    const refresh = vi.fn();
    mockServerQueue = { status: 'available', snapshot: { revision: 1, mode: 'running', holdReason: null, items: [], order: [] }, reason: '', refresh };
    const state = { ...createStructuredSessionState(), isStreaming: true, sendMessage: vi.fn().mockResolvedValue({ accepted: true }) };
    enqueueServerFollowup.mockClear();
    mockUseStructuredSession.mockReturnValue(state);
    try {
      renderMobileShell({ sessions: [session], activeSessionId: session.id });
      expect(screen.getByRole('button', { name: 'Open follow-up queue' })).toBeInTheDocument();
      enqueueServerFollowup.mockResolvedValueOnce({ mode: 'running', queueRevision: 2 });
      await act(async () => { await lastStatusBarProps.onComposerSubmit('Then run the tests'); });
      expect([enqueueServerFollowup.mock.calls[0], state.sendMessage.mock.calls.length, refresh.mock.calls.length]).toEqual([['ss-phone-server-queue', 'Then run the tests'], 0, 1]);
      fireEvent.change(screen.getByLabelText('Command composer'), { target: { value: 'Keep me' } });
      enqueueServerFollowup.mockRejectedValueOnce(new Error('Queue changed on another device.'));
      await act(async () => { await lastStatusBarProps.onComposerSubmit('Keep me'); });
      expect(screen.getByLabelText('Command composer')).toHaveValue('Keep me');
      expect(screen.getByText('Queue changed on another device.')).toBeInTheDocument();
    } finally {
      mockServerQueue = { status: 'unavailable', snapshot: null, reason: 'fixture', refresh: () => {} };
    }
  });

  it('checks saved files before mobile send even if the cross-tab event is delayed', async () => {
    setUser({ id: 'mobile-attachment-late-event-fixture' });
    const session = { id: 'ss-phone-attachment-late-event', runtime: 'codex', cwd: '/work/project' };
    const state = { ...createStructuredSessionState(), sendMessage: vi.fn().mockResolvedValue({ accepted: true }) };
    mockUseStructuredSession.mockReturnValue(state);
    renderMobileShell({ sessions: [session], activeSessionId: session.id });
    fireEvent.change(screen.getByLabelText('Command composer'), { target: { value: 'Keep this message' } });
    await act(async () => { lastStatusBarProps.onComposerAttachmentAdd({ name: 'mine.txt', path: '/work/project/mine.txt' }); });
    const key = Object.keys(localStorage).find(value => value.includes('composerFiles:') && value.includes(session.id));
    localStorage.setItem(key, JSON.stringify({ version: 1, sessionId: session.id, items: [{ name: 'other.txt', path: '/work/project/other.txt' }] }));
    await act(async () => { await lastStatusBarProps.onComposerSubmit('Keep this message'); });
    expect(state.sendMessage).not.toHaveBeenCalled();
    expect(screen.getByLabelText('Command composer')).toHaveValue('Keep this message');
    expect(screen.getByRole('alert')).toHaveTextContent('changed in another tab');
    act(() => clearTokens(true));
  });

  it('does not send a stale file selection when another tab wins the lock first', async () => {
    setUser({ id: 'mobile-attachment-send-lock' });
    const session = { id: 'ss-phone-attachment-send-lock', runtime: 'codex', cwd: '/work/project' };
    const state = { ...createStructuredSessionState(), sendMessage: vi.fn().mockResolvedValue({ accepted: true }) };
    mockUseStructuredSession.mockReturnValue(state);
    renderMobileShell({ sessions: [session], activeSessionId: session.id });
    fireEvent.change(screen.getByLabelText('Command composer'), { target: { value: 'Keep this message' } });
    await act(async () => { lastStatusBarProps.onComposerAttachmentAdd({ name: 'mine.txt', path: '/work/project/mine.txt' }); });
    let release;
    withAttachmentWriteLock.mockImplementationOnce(action => new Promise(resolve => { release = () => resolve(action()); }));
    let sending;
    act(() => { sending = lastStatusBarProps.onComposerSubmit('Keep this message'); });
    expect(state.sendMessage).not.toHaveBeenCalled();
    await act(async () => {});
    const key = Object.keys(localStorage).find(value => value.includes('composerFiles:') && value.includes(session.id));
    localStorage.setItem(key, JSON.stringify({ version: 1, sessionId: session.id, items: [{ name: 'theirs.txt', path: '/work/project/theirs.txt' }] }));
    await act(async () => { release(); await sending; });
    expect(state.sendMessage).not.toHaveBeenCalled();
    expect(screen.getByLabelText('Command composer')).toHaveValue('Keep this message');
    expect(screen.getByText('mine.txt')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('changed in another tab');
    act(() => clearTokens(true));
  });

  it('starts only one mobile send when the user submits twice while file validation waits', async () => {
    setUser({ id: 'mobile-attachment-double-send' });
    const session = { id: 'ss-phone-attachment-double-send', runtime: 'codex', cwd: '/work/project' };
    const state = { ...createStructuredSessionState(), sendMessage: vi.fn().mockResolvedValue({ accepted: true }) };
    mockUseStructuredSession.mockReturnValue(state);
    renderMobileShell({ sessions: [session], activeSessionId: session.id });
    fireEvent.change(screen.getByLabelText('Command composer'), { target: { value: 'Send once' } });
    await act(async () => { lastStatusBarProps.onComposerAttachmentAdd({ name: 'mine.txt', path: '/work/project/mine.txt' }); });
    let release;
    withAttachmentWriteLock.mockImplementationOnce(action => new Promise(resolve => { release = () => resolve(action()); }));
    let first, second;
    act(() => { first = lastStatusBarProps.onComposerSubmit('Send once'); second = lastStatusBarProps.onComposerSubmit('Send once'); });
    expect(state.sendMessage).not.toHaveBeenCalled();
    await act(async () => { release(); await Promise.all([first, second]); });
    expect(state.sendMessage).toHaveBeenCalledTimes(1);
    expect(state.sendMessage.mock.calls[0][0]).toContain('/work/project/mine.txt');
    act(() => clearTokens(true));
  });

  it('keeps a mobile draft if the conversation changes from streaming while validation waits', async () => {
    setUser({ id: 'mobile-attachment-route-change' });
    enqueueServerFollowup.mockClear();
    const session = { id: 'ss-phone-attachment-route-change', runtime: 'codex', cwd: '/work/project' };
    const state = { ...createStructuredSessionState(), isStreaming: true, sendMessage: vi.fn().mockResolvedValue({ accepted: true }) };
    mockServerQueue = { status: 'available', snapshot: { revision: 1, order: [] }, refresh: vi.fn() };
    mockUseStructuredSession.mockReturnValue(state);
    try {
      const view = renderMobileShell({ sessions: [session], activeSessionId: session.id });
      fireEvent.change(screen.getByLabelText('Command composer'), { target: { value: 'Keep this message' } });
      await act(async () => { lastStatusBarProps.onComposerAttachmentAdd({ name: 'mine.txt', path: '/work/project/mine.txt' }); });
      let release, sending;
      withAttachmentWriteLock.mockImplementationOnce(action => new Promise(resolve => { release = () => resolve(action()); }));
      act(() => { sending = lastStatusBarProps.onComposerSubmit('Keep this message'); });
      mockUseStructuredSession.mockReturnValue({ ...state, isStreaming: false });
      view.rerender(<MobileShell sessions={[session]} activeSessionId={session.id} />);
      await act(async () => { release(); await sending; });
      expect(state.sendMessage).not.toHaveBeenCalled();
      expect(enqueueServerFollowup).not.toHaveBeenCalled();
      expect(screen.getByLabelText('Command composer')).toHaveValue('Keep this message');
      expect(screen.getByText(/conversation or file selection changed while preparing/i)).toBeInTheDocument();
    } finally {
      mockServerQueue = { status: 'unavailable', snapshot: null, reason: 'fixture', refresh: () => {} };
      act(() => clearTokens(true));
    }
  });

  it('does not send from the old environment if the phone switches servers while validation waits', async () => {
    setUser({ id: 'mobile-attachment-environment-switch' });
    const session = { id: 'ss-phone-attachment-environment-switch', runtime: 'codex', cwd: '/work/project' };
    const state = { ...createStructuredSessionState(), sendMessage: vi.fn().mockResolvedValue({ accepted: true }) };
    mockUseStructuredSession.mockReturnValue(state);
    try {
      renderMobileShell({ sessions: [session], activeSessionId: session.id });
      fireEvent.change(screen.getByLabelText('Command composer'), { target: { value: 'Keep original draft' } });
      await act(async () => { lastStatusBarProps.onComposerAttachmentAdd({ name: 'mine.txt', path: '/work/project/mine.txt' }); });
      let release, sending;
      withAttachmentWriteLock.mockImplementationOnce(action => new Promise(resolve => { release = () => resolve(action()); }));
      act(() => { sending = lastStatusBarProps.onComposerSubmit('Keep original draft'); });
      act(() => setActiveEnvironment({ id: 'other-host', capabilities: { agentExecute: true } }));
      await act(async () => { release(); await sending; });
      expect(state.sendMessage).not.toHaveBeenCalled();
      act(() => setActiveEnvironment(null));
      expect(screen.getByLabelText('Command composer')).toHaveValue('Keep original draft');
      expect(screen.getByText('mine.txt')).toBeInTheDocument();
    } finally { act(() => clearTokens(true)); }
  });

  it('sends and clears only the current conversation’s attachments', async () => {
    const sessions = [
      { id: 'ss-phone-send-files-one', runtime: 'codex', cwd: '/work/one' },
      { id: 'ss-phone-send-files-two', runtime: 'codex', cwd: '/work/two' },
    ];
    const state = { ...createStructuredSessionState(), sendMessage: vi.fn().mockResolvedValue({ accepted: true }) };
    mockUseStructuredSession.mockReturnValue(state);
    const view = renderMobileShell({ sessions, activeSessionId: sessions[0].id });
    await act(async () => { lastStatusBarProps.onComposerAttachmentAdd({ name: 'first.txt', path: '/work/one/first.txt' }); });
    view.rerender(<MobileShell sessions={sessions} activeSessionId={sessions[1].id} />);
    await act(async () => { lastStatusBarProps.onComposerAttachmentAdd({ name: 'second.txt', path: '/work/two/second.txt' }); });
    fireEvent.change(screen.getByLabelText('Command composer'), { target: { value: 'Read this' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
    await waitFor(() => expect(screen.queryByText('second.txt')).not.toBeInTheDocument());
    expect(state.sendMessage).toHaveBeenCalledWith(expect.stringContaining('/work/two/second.txt'));
    expect(state.sendMessage.mock.calls[0][0]).not.toContain('/work/one/first.txt');
    view.rerender(<MobileShell sessions={sessions} activeSessionId={sessions[0].id} />);
    expect(screen.getByText('first.txt')).toBeInTheDocument();
  });

  it('does not carry file attachments to another environment with the same session ID', () => {
    const session = { id: 'ss-phone-attachment-environment', runtime: 'codex', cwd: '/work/project' };
    renderMobileShell({ sessions: [session], activeSessionId: session.id });
    act(() => lastStatusBarProps.onComposerAttachmentAdd({ name: 'first.txt', path: '/work/project/first.txt' }));
    act(() => setActiveEnvironment({ id: 'other-host', capabilities: { agentExecute: true } }));
    expect(screen.queryByText('first.txt')).not.toBeInTheDocument();
  });

  it('changes the Claude model through the structured session without clearing the draft', async () => {
    const session = { id: 'ss-phone-claude', aiType: 'claude', cwd: '/work/project', model: 'old-claude', reasoning: 'low' };
    renderMobileShell({ sessions: [session], activeSessionId: session.id });
    fireEvent.change(screen.getByLabelText('Command composer'), { target: { value: 'Keep this Claude draft' } });
    expect(lastStatusBarProps.composerPrimaryAction.props.agentId).toBe('claude');
    await act(async () => { await lastStatusBarProps.composerPrimaryAction.props.onChange({ model: 'new-claude', reasoning: 'high' }); });
    expect(mockUpdateStructuredSessionSelection).toHaveBeenCalledWith(session.id, { model: 'new-claude', reasoning: 'high' });
    expect(screen.getByLabelText('Command composer')).toHaveValue('Keep this Claude draft');
  });

  it('routes mobile response cancellation to the composer and preserves read-only limits', async () => {
    const state = { ...createStructuredSessionState(), isStreaming: true, isInterrupting: false, requiresCleanup: false };
    mockUseStructuredSession.mockReturnValue(state);
    const sessions = [{ id: 'ss-mobile-stop', runtime: 'codex', title: 'Review', cwd: '/tmp' }];
    const view = renderMobileShell({ sessions, activeSessionId: 'ss-mobile-stop' });
    await screen.findByTestId('desktop-conversation-view');
    expect(lastStatusBarProps).toMatchObject({ isStreaming: true, isInterrupting: false, requiresCleanup: false, onInterrupt: state.interrupt });
    expect(lastStatusBarProps.composerSubmitLabel).toBe('Send message');
    expect(lastConversationViewProps.showHeader).toBe(false);
    view.unmount();
    setActiveEnvironment({ id: 'observer', capabilities: {} });
    renderMobileShell({ sessions, activeSessionId: 'ss-mobile-stop' });
    expect(lastStatusBarProps.isStreaming).toBe(true);
    expect(lastStatusBarProps.onInterrupt).toBeUndefined();
  });

  it('keeps the broker decision in the current phone conversation with explicit permission gating', async () => {
    browserReviewRequests = [{ id: 'phone-browser-review', name: 'browser_tabs', arguments: {} }];
    const sessions = [{ id: 'ss-phone-review', runtime: 'codex', title: 'Review', cwd: '/tmp' }];
    const view = renderMobileShell({ sessions, activeSessionId: 'ss-phone-review' });
    await screen.findByTestId('desktop-conversation-view');
    expect(lastBrowserReviewOptions).toEqual({ sessionId: 'ss-phone-review', enabled: true, canDecide: true });
    expect(lastConversationViewProps).toMatchObject({ browserApprovals: browserReviewRequests, onBrowserApprove: decideBrowserReview });
    view.unmount();
    setActiveEnvironment({ id: 'phone-observer', capabilities: {} });
    renderMobileShell({ sessions, activeSessionId: 'ss-phone-review' });
    expect(lastBrowserReviewOptions.canDecide).toBe(false);
    expect(lastConversationViewProps.browserApprovals).toEqual(browserReviewRequests);
    expect(lastConversationViewProps.onBrowserApprove).toBeUndefined();
  });

  it('keeps connection recovery visible without a duplicate conversation header', async () => {
    mockUseStructuredSession.mockReturnValue({ ...createStructuredSessionState(), connectionState: 'offline' });
    renderMobileShell({ sessions: [{ id: 'ss-offline-chat', runtime: 'codex', cwd: '/tmp' }], activeSessionId: 'ss-offline-chat' });
    expect(screen.getByText('Conversation offline. Reconnecting…')).toBeVisible();
    await screen.findByTestId('desktop-conversation-view');
    expect(lastConversationViewProps.showHeader).toBe(false);
    expect(lastBrowserReviewOptions.canDecide).toBe(false);
  });

  it.each([false, true])('explains persisted cancellation recovery without a session strip (stopping: %s)', async isInterrupting => {
    mockUseStructuredSession.mockReturnValue({ ...createStructuredSessionState(), requiresCleanup: true, isInterrupting, actionError: '' });
    renderMobileShell({ sessions: [{ id: 'ss-persisted-cleanup', runtime: 'codex', status: 'cleanup_required', cwd: '/tmp' }], activeSessionId: 'ss-persisted-cleanup', showSessionStrip: false });
    const notice = screen.getByRole('status', { name: 'Response cancellation' });
    expect(notice).toHaveTextContent(isInterrupting ? 'Stopping response…' : 'Cancellation is not confirmed. Retry cancellation before sending another message.');
    expect(screen.queryByRole('tab')).not.toBeInTheDocument();
    expect(lastStatusBarProps.requiresCleanup).toBe(true);
  });

  it('uses Terminal v4 stable full terminal for mobile AI sessions (no Codex dual UI)', async () => {
    const mobileChatState = createMobileChatTurnsState();
    mockUseMobileChatTurns.mockReturnValue(mobileChatState);

    renderMobileShell();

	expect(mockUseMobileChatTurns).toHaveBeenCalledWith({ sessionId: 'session-a', chatMode: true });
	expect(screen.queryByTestId('desktop-conversation-view')).not.toBeInTheDocument();
	const terminalChat = await screen.findByTestId('terminal-chat');
	expect(terminalChat).toHaveAttribute('data-session-id', 'session-a');
	expect(terminalChat).toHaveAttribute('data-surface', 'mobile');
	expect(terminalChat).toHaveAttribute('data-input-enabled', 'true');
	expect(screen.getByTestId('desktop-status-bar')).toHaveAttribute('data-show-terminal-view-mode-toggle', 'false');
	expect(screen.getByTestId('desktop-status-bar')).toHaveAttribute('data-terminal-view-mode', 'terminal');
	expect(screen.getByPlaceholderText('Message Codex…')).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Command composer'), {
      target: { value: 'Fix the mobile composer layout' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send composer' }));

    expect(mobileChatState.handleChatSend).toHaveBeenCalledWith('Fix the mobile composer layout');
  });

  it('keeps mobile AI sessions in full terminal mode', async () => {
    renderMobileShell();

    expect(await screen.findByTestId('terminal-chat')).toHaveAttribute('data-input-enabled', 'true');
    expect(screen.queryByTestId('desktop-conversation-view')).not.toBeInTheDocument();
    expect(screen.getByTestId('desktop-status-bar')).toHaveAttribute('data-terminal-view-mode', 'terminal');
    expect(screen.queryByRole('button', { name: 'Raw Terminal' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Codex UI' })).not.toBeInTheDocument();
  });

  it('stays in full terminal mode even when Codex runtime is detected on screen', async () => {
    renderMobileShell();

    expect(await screen.findByTestId('terminal-chat')).toHaveAttribute('data-input-enabled', 'true');
    fireEvent.click(screen.getByRole('button', { name: 'mark-codex-screen' }));

    expect(screen.queryByTestId('desktop-conversation-view')).not.toBeInTheDocument();
    expect(screen.getByTestId('desktop-status-bar')).toHaveAttribute('data-show-terminal-view-mode-toggle', 'false');
    expect(screen.getByTestId('desktop-status-bar')).toHaveAttribute('data-terminal-view-mode', 'terminal');
    expect(screen.getByTestId('terminal-chat')).toHaveAttribute('data-input-enabled', 'true');
  });

  it('does not switch into Codex UI when mobile detects a Codex runtime without saved metadata', async () => {
    renderMobileShell({ sessionAiTypes: {} });

    expect(screen.queryByTestId('desktop-conversation-view')).not.toBeInTheDocument();
    expect(await screen.findByTestId('terminal-chat')).toHaveAttribute('data-input-enabled', 'true');

    fireEvent.click(screen.getByRole('button', { name: 'mark-codex-screen' }));

    expect(screen.queryByTestId('desktop-conversation-view')).not.toBeInTheDocument();
    expect(screen.getByTestId('desktop-status-bar')).toHaveAttribute('data-show-terminal-view-mode-toggle', 'false');
    expect(screen.getByTestId('desktop-status-bar')).toHaveAttribute('data-terminal-view-mode', 'terminal');
    expect(screen.getByTestId('terminal-chat')).toHaveAttribute('data-input-enabled', 'true');
  });

  it('uses the desktop structured-session flow and can open the inline terminal', async () => {
    const sessions = [
      {
        id: 'ss-structured',
        title: 'Structured session',
        cwd: 'C:/work/terminal-v4',
        thread: {
          topic: 'Structured agent session',
          topicAutoGenerated: false,
          projectPath: 'C:/work/terminal-v4',
        },
      },
    ];

    renderMobileShell({
      sessions,
      activeSessionId: 'ss-structured',
    });

    expect(mockUseMobileChatTurns).toHaveBeenCalledWith({ sessionId: 'ss-structured', chatMode: false });
    expect(mockUseStructuredSession).toHaveBeenCalledWith({ sessionId: 'ss-structured', active: true });
    expect(mockListSessionGitBranches).not.toHaveBeenCalled();
    expect(await screen.findByTestId('desktop-conversation-view')).toBeInTheDocument();
    expect(screen.getByTestId('desktop-status-bar')).toHaveAttribute('data-show-terminal-toggle', 'true');
    expect(screen.getByTestId('desktop-status-bar')).toHaveAttribute('data-connection-state', 'online');
    expect(screen.queryByTestId('terminal-chat')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Open terminal view' }));

    expect(screen.getByTestId('desktop-status-bar')).toHaveAttribute('data-terminal-open', 'true');
    expect(await screen.findByTestId('terminal-chat')).toHaveAttribute('data-input-enabled', 'true');
  });

  it('switches sessions from the mobile session rail', () => {
    const onSelectSession = vi.fn();

    renderMobileShell({ onSelectSession });

    fireEvent.click(screen.getByRole('tab', { name: /review release checklist/i }));

    expect(onSelectSession).toHaveBeenCalledWith('session-b');
  });

  it('preserves parent mobile state and renders the accessory keybar when opened', () => {
    const onViewChange = vi.fn();
    const onChatModeChange = vi.fn();

    renderMobileShell({
      accessoryOpen: true,
      onViewChange,
      onChatModeChange,
      sessionAiTypes: {},
    });

    expect(onViewChange).not.toHaveBeenCalled();
    expect(onChatModeChange).not.toHaveBeenCalled();
    expect(screen.getByTestId('mobile-keybar')).toHaveAttribute('data-session-id', 'session-a');
    expect(screen.getByTestId('mobile-keybar')).toHaveAttribute('data-open', 'true');
  });

  it('keeps mobile text inputs at 16px to prevent Safari keyboard zoom', () => {
    const css = fs.readFileSync(path.resolve(process.cwd(), 'src/styles.css'), 'utf8');

    expect(css).toMatch(/\.mobile-terminal-input\s*\{[\s\S]*font-size:\s*16px;/);
    expect(css).toMatch(/\.mobile-shell-parity \.desktop-conversation-input\s*\{[\s\S]*font-size:\s*16px;/);
    expect(css).toMatch(/\.mobile-shell-parity \.status-composer-input\s*\{[\s\S]*font-size:\s*16px;/);
    expect(css).toMatch(/\.mobile-shell-parity \.status-view-mode-toggle\s*\{[\s\S]*grid-template-columns:\s*repeat\(2, minmax\(0, 1fr\)\);/);
    expect(css).toMatch(/\.mobile-shell-parity \.mobile-terminal-slot\.is-collapsed\s*\{[\s\S]*visibility:\s*hidden;/);
  });
  it('disables the phone composer and terminal input for an observer device', async () => {
    setActiveEnvironment({id:'observer',capabilities:{}});
    renderMobileShell();
    expect(await screen.findByTestId('terminal-chat')).toHaveAttribute('data-input-enabled','false');
    expect(screen.getByRole('textbox',{name:'Command composer'})).toBeDisabled();
    expect(lastStatusBarProps.voiceAvailable).toBe(false);
  });
  it('submits the phone structured composer through its structured agent', async () => {
    const structured=createStructuredSessionState();mockUseStructuredSession.mockReturnValue(structured);
    const terminal=createMobileChatTurnsState();mockUseMobileChatTurns.mockReturnValue(terminal);
    renderMobileShell({sessions:[{...BASE_SESSIONS[0],id:'ss-structured'}],activeSessionId:'ss-structured'});
    fireEvent.change(screen.getByRole('textbox',{name:'Command composer'}),{target:{value:'Explain this file'}});
    fireEvent.click(screen.getByRole('button',{name:'Send message'}));
    expect(structured.sendMessage).toHaveBeenCalledWith('Explain this file');
    expect(terminal.handleChatSend).not.toHaveBeenCalled();
  });

  it('keeps the phone draft pending until accepted and retains a rejected send for retry', async () => {
    let resolve;
    const structured = createStructuredSessionState();
    structured.sendMessage.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    mockUseStructuredSession.mockReturnValue(structured);
    renderMobileShell({ sessions: [{ ...BASE_SESSIONS[0], id: 'ss-phone' }], activeSessionId: 'ss-phone' });
    fireEvent.change(screen.getByLabelText('Command composer'), { target: { value: 'Phone draft' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
    expect(screen.getByLabelText('Command composer')).toHaveValue('Phone draft');
    expect(screen.getByRole('button', { name: 'Send message' })).toBeDisabled();
    await act(async () => { resolve({ accepted: true }); });
    expect(screen.getByLabelText('Command composer')).toHaveValue('');
    structured.sendMessage.mockRejectedValueOnce(new Error('Phone send rejected.'));
    fireEvent.change(screen.getByLabelText('Command composer'), { target: { value: 'Keep rejected phone text' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
    await waitFor(() => expect(screen.getByText('Phone send rejected.')).toBeInTheDocument());
    expect(screen.getByLabelText('Command composer')).toHaveValue('Keep rejected phone text');
  });

  it('passes owned V4 runtime identity to the actual mobile structured hook', async () => {
    renderMobileShell({ sessions: [{ ...BASE_SESSIONS[0], id: 'ss-v4-phone', runtime: 'v4' }], activeSessionId: 'ss-v4-phone' });
    expect(mockUseStructuredSession).toHaveBeenCalledWith({ sessionId: 'ss-v4-phone', active: true, runtime: 'v4' });
    expect(screen.getByTestId('desktop-status-bar')).toHaveAttribute('data-show-terminal-toggle', 'false');
    expect(screen.getByTestId('desktop-status-bar')).toHaveAttribute('data-show-ai-selector', 'false');
  });

  it('maps cleanup recovery into the actual mobile view and keeps queue work separate from its main draft', async () => {
    mockUseStructuredSession.mockReturnValue({ ...createStructuredSessionState(), requiresCleanup: true });
    const onSessionBusyChange = vi.fn();
    renderMobileShell({ sessions: [{ id: 'ss-phone-queue', runtime: 'v4', status: 'reconciliation_required', statusSeq: 7 }, BASE_SESSIONS[1]], activeSessionId: 'ss-phone-queue', onSessionBusyChange });
    expect(mockUseStructuredSession).toHaveBeenCalledWith({ sessionId: 'ss-phone-queue', active: true, runtime: 'v4', status: 'reconciliation_required', statusSeq: 7 });
    expect(screen.getByTestId('desktop-conversation-view')).toHaveAttribute('data-requires-cleanup', 'true');
    expect(onSessionBusyChange).toHaveBeenLastCalledWith('ss-phone-queue', true);
    expect(screen.getByRole('tab', { selected: true })).toHaveTextContent('Cleanup required');
    fireEvent.change(screen.getByLabelText('Command composer'), { target: { value: 'Keep main phone draft' } });
    fireEvent.click(screen.getByRole('button', { name: 'Open follow-up queue' }));
    expect(screen.getByRole('dialog', { name: 'Follow-up queue' })).toHaveTextContent('ss-phone-queue');
    fireEvent.click(screen.getByRole('button', { name: 'Close queue' }));
    expect(screen.getByLabelText('Command composer')).toHaveValue('Keep main phone draft');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
  it('keeps active structured session badges and app activity consistent while a turn is running', async () => {
    const structured = { ...createStructuredSessionState(), isStreaming: true };
    mockUseStructuredSession.mockReturnValue(structured);
    const onSessionBusyChange = vi.fn();
    const { unmount } = renderMobileShell({ sessions: [{ ...BASE_SESSIONS[0], id: 'ss-mobile-activity', title: 'Owned V4', runtime: 'v4' }, BASE_SESSIONS[1]], activeSessionId: 'ss-mobile-activity', onSessionBusyChange });
    await waitFor(() => expect(onSessionBusyChange).toHaveBeenLastCalledWith('ss-mobile-activity', true));
    expect(screen.getByRole('tab', { selected: true })).toHaveTextContent('Running');
    unmount();
    expect(onSessionBusyChange).toHaveBeenLastCalledWith('ss-mobile-activity', true);
  });

  it('keeps administration out of the mobile composer and uses its canonical structured cwd for status without unrelated Git metadata', () => {
    renderMobileShell({ sessions: [{ id: 'ss-canonical-workspace', runtime: 'v4', cwd: '/canonical/mobile', thread: { projectPath: '/editable/group' } }],
      projectInfo: { cwd: '/unrelated/pane', gitBranch: 'unrelated-branch' } });
    expect(screen.queryByTestId('workspace-tools-path')).not.toBeInTheDocument();
    expect(screen.queryByTestId('workspace-knowledge-path')).not.toBeInTheDocument();
    expect(screen.getByTestId('desktop-status-bar')).toHaveAttribute('data-cwd', '/canonical/mobile');
    expect(screen.getByTestId('desktop-status-bar')).toHaveAttribute('data-git-branch', '');
    expect(screen.getByTestId('desktop-status-bar')).toHaveAttribute('data-current-git-branch', '');
  });
  it('keeps mobile PTY cwd and rejects global Git fallback belonging to a different workspace', async () => {
    mockListSessionGitBranches.mockResolvedValue({ currentBranch: null, branches: [] });
    renderMobileShell({ sessions: [{ id: 'session-mobile', cwd: '/own/mobile' }], projectInfo: { cwd: '/another/pane', gitBranch: 'unrelated-branch' } });
    await waitFor(() => expect(mockListSessionGitBranches).toHaveBeenCalled());
    expect(screen.getByTestId('desktop-status-bar')).toHaveAttribute('data-cwd', '/own/mobile');
    expect(screen.getByTestId('desktop-status-bar')).toHaveAttribute('data-git-branch', '');
    expect(screen.getByTestId('desktop-status-bar')).toHaveAttribute('data-current-git-branch', '');
  });
  it('retains matching-workspace mobile PTY Git metadata when branch discovery is unavailable', async () => {
    mockListSessionGitBranches.mockResolvedValue({ currentBranch: null, branches: [] });
    renderMobileShell({ sessions: [{ id: 'session-mobile', cwd: '/own/mobile' }], projectInfo: { cwd: '/own/mobile', gitBranch: 'matching-branch' } });
    await waitFor(() => expect(mockListSessionGitBranches).toHaveBeenCalled());
    expect(screen.getByTestId('desktop-status-bar')).toHaveAttribute('data-cwd', '/own/mobile');
    expect(screen.getByTestId('desktop-status-bar')).toHaveAttribute('data-git-branch', 'matching-branch');
    expect(screen.getByTestId('desktop-status-bar')).toHaveAttribute('data-current-git-branch', 'matching-branch');
  });

  it('shows the selected conversation as unavailable instead of falling back to another workspace chat', () => {
    renderMobileShell({ activeSessionId: 'ss-missing-workspace', sessions: BASE_SESSIONS, projectInfo: { cwd: '/unrelated/workspace', gitBranch: 'unrelated-branch' } });
    expect(screen.queryByTestId('terminal-chat')).not.toBeInTheDocument();
    expect(screen.queryByTestId('desktop-conversation-view')).not.toBeInTheDocument();
    expect(screen.queryByTestId('workspace-tools-path')).not.toBeInTheDocument();
    expect(screen.queryByTestId('workspace-knowledge-path')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Command composer')).not.toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Selected conversation is loading or unavailable');
  });

  it('ignores a previous mobile terminal cwd callback after session switches including ABA', () => {
    const view = renderMobileShell();
    const oldCwd = lastMobileTerminalProps.onCwdChange;
    act(() => oldCwd('/old/live'));
    view.rerender(<MobileShell sessions={BASE_SESSIONS} activeSessionId="session-b" projectInfo={null} />);
    expect(screen.getByTestId('desktop-status-bar')).toHaveAttribute('data-cwd', 'C:/work/docs');
    act(() => oldCwd('/old/late'));
    expect(screen.getByTestId('desktop-status-bar')).toHaveAttribute('data-cwd', 'C:/work/docs');
    view.rerender(<MobileShell sessions={BASE_SESSIONS} activeSessionId="session-a" projectInfo={null} />);
    act(() => oldCwd('/old/late-after-ABA'));
    expect(screen.getByTestId('desktop-status-bar')).toHaveAttribute('data-cwd', 'C:/work/terminal-v4');
  });


  it('mounts Context beside Queue only for the actual own V4 mobile session', () => {
    const own = { id: 'ss-mobile-context', runtime: 'v4', cwd: '/canonical/mobile' };
    const view = renderMobileShell({ sessions: [own], activeSessionId: own.id });
    expect(screen.getByTestId('context-mount')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Open follow-up queue' })).toBeInTheDocument();
    view.rerender(<MobileShell sessions={[{ ...own, runtime: undefined, shell: 'claude' }]} activeSessionId={own.id} />);
    expect(screen.queryByTestId('context-mount')).not.toBeInTheDocument();
    view.rerender(<MobileShell sessions={BASE_SESSIONS} activeSessionId="session-a" />);
    expect(screen.queryByTestId('context-mount')).not.toBeInTheDocument();
  });
  it('passes mobile canonical controls and existing explicit Stop without invoking it on mount', () => {
    const own = { id: 'ss-mobile-context-props', runtime: 'v4' };
    const controls = { sessionId: own.id, generation: 9, latestSeq: 14, events: [], truncated: false };
    const state = { ...createStructuredSessionState(), controlState: controls, isInterrupting: true, controlError: 'Mobile Stop recovery' };
    mockUseStructuredSession.mockReturnValue(state);
    renderMobileShell({ sessions: [own], activeSessionId: own.id });
    expect(lastContextProps).toMatchObject({ sessionId: own.id, active: true, isStopping: true, stopError: 'Mobile Stop recovery', readOnly: false });
    expect(lastContextProps.controlState).toBe(controls);
    expect(state.interrupt).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Fixture explicit Stop conversation' }));
    expect(state.interrupt).toHaveBeenCalledTimes(1);
  });
  it('passes mobile busy and cleanup while withholding forbidden remote Stop', () => {
    setActiveEnvironment({ id: 'mobile-context-observer', capabilities: {} });
    const own = { id: 'ss-mobile-context-readonly', runtime: 'v4', status: 'running' };
    const state = { ...createStructuredSessionState(), requiresCleanup: true };
    mockUseStructuredSession.mockReturnValue(state);
    renderMobileShell({ sessions: [own], activeSessionId: own.id });
    expect(lastContextProps).toMatchObject({ sessionId: own.id, readOnly: true, requiresCleanup: true, conversationBusy: true });
    expect(lastContextProps.onStopConversation).toBeUndefined();
    expect(screen.getByRole('button', { name: 'Fixture explicit Stop conversation' })).toBeDisabled();
    expect(state.interrupt).not.toHaveBeenCalled();
  });
  it('retains the ordinary mobile draft and Queue when Context metadata updates', () => {
    const own = { id: 'ss-mobile-context-draft', runtime: 'v4' };
    const state = createStructuredSessionState();mockUseStructuredSession.mockReturnValue(state);
    const view = renderMobileShell({ sessions: [own], activeSessionId: own.id });
    fireEvent.change(screen.getByLabelText('Command composer'), { target: { value: 'Keep the ordinary phone draft' } });
    mockUseStructuredSession.mockReturnValue({ ...state, controlState: { sessionId: own.id, generation: 10, latestSeq: 15, events: [], truncated: true } });
    view.rerender(<MobileShell sessions={[own]} activeSessionId={own.id} />);
    expect(screen.getByTestId('context-mount')).toBeInTheDocument();
    expect(screen.getByLabelText('Command composer')).toHaveValue('Keep the ordinary phone draft');
    expect(screen.getByRole('button', { name: 'Open follow-up queue' })).toBeInTheDocument();
    expect(state.sendMessage).not.toHaveBeenCalled();expect(state.interrupt).not.toHaveBeenCalled();
  });

});
