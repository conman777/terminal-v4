import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useEffect } from 'react';
import { MobileShell } from './MobileShell';
import { splitContext } from './composer-context/composerContext';
import { getComposerDraftStore } from '../utils/composerDraftStore';
import { setActiveEnvironment } from '../utils/remoteEnvironments';
import { resetPullRequestMentionCache } from '../hooks/useCurrentPullRequest';

const terminals = new Map();
let pullRequest = null;
let lastStatusBarProps = null;
const noop = () => Promise.resolve({});

const sessionApi = vi.hoisted(() => {
  const noop = () => Promise.resolve({});
  return { listSessionGitBranches: () => Promise.resolve({ branches: [], currentBranch: null }), checkoutSessionGitBranch: noop, createSession: noop,
    updateThreadMetadata: (_id, patch) => Promise.resolve({ ...patch }), restoreSession: () => Promise.resolve({ restored: true }), updateStructuredSessionSelection: noop, sendRawToSession: noop };
});
vi.mock('../contexts/TerminalSessionContext', () => ({ useTerminalSession: () => sessionApi }));
vi.mock('../hooks/useSupervisedInputCapability', () => ({ useSupervisedInputCapability: () => 'legacy' }));
vi.mock('../hooks/useInstalledSkills', () => ({ useInstalledSkills: () => [] }));
vi.mock('../utils/api', async importOriginal => {
  const actual = await importOriginal();
  return { ...actual, apiGet: url => (String(url).startsWith('/api/workspace/git/pull-request') ? Promise.resolve({ pullRequest }) : actual.apiGet(url)),
    apiFetch: () => Promise.resolve({ ok: false, status: 404, json: async () => ({}) }) };
});
vi.mock('./TerminalChat', () => ({
  TerminalChat: props => {
    useEffect(() => {
      const listeners = new Set();
      const terminal = { text: '', copied: 0, listeners };
      terminal.actions = { sessionId: props.sessionId, hasSelection: () => Boolean(terminal.text), copySelection: () => { terminal.copied += 1; return true; }, getSelectionText: () => terminal.text,
        clearSelection: () => { terminal.text = ''; listeners.forEach(listener => listener()); },
        subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener); } };
      terminals.set(props.sessionId, terminal);
      props.onRegisterSelectionActions?.(terminal.actions);
      return () => { terminals.delete(props.sessionId); props.onRegisterSelectionActions?.(null); };
    }, [props.sessionId, props.onRegisterSelectionActions]);
    return <div data-testid="terminal-chat" data-session-id={props.sessionId} />;
  },
}));
vi.mock('./DesktopConversationView', () => ({ DesktopConversationView: () => <div data-testid="desktop-conversation-view" /> }));
vi.mock('./DesktopStatusBar', () => ({ DesktopStatusBar: props => { lastStatusBarProps = props; return <div data-testid="desktop-status-bar" />; } }));
vi.mock('./MobileKeybar', () => ({ MobileKeybar: () => null }));
const chatTurns = vi.hoisted(() => ({ turns: [], isLoading: false, isSendReady: true, handleTurn: () => {}, handleRegisterSendText: () => {}, handleChatSend: () => ({ queued: false }), handleRawSend: () => ({ queued: false }), handleInterrupt: () => ({ queued: false }) }));
vi.mock('../hooks/useMobileChatTurns', () => ({ useMobileChatTurns: () => chatTurns }));
vi.mock('../hooks/useStructuredSession', () => ({ useStructuredSession: () => ({ messages: [], currentToolCalls: [], pendingApproval: null, isStreaming: false, connectionState: 'online', sendMessage: vi.fn(), interrupt: vi.fn(), approve: vi.fn() }) }));
vi.mock('../hooks/useSessionBrowserApprovals', () => ({ useSessionBrowserApprovals: () => ({ requests: [], decide: vi.fn(), isDeciding: false, error: '' }) }));
vi.mock('./WorkspaceToolsButton', () => ({ WorkspaceToolsButton: () => null }));
vi.mock('./WorkspaceProfileButton', () => ({ WorkspaceProfileButton: () => null }));
vi.mock('./ConversationContextButton', () => ({ ConversationContextButton: () => null }));

const thread = (id, title) => ({ id, title, runtime: 'codex', cwd: '/repo/current' });
const shell = (sessions, activeSessionId, extra = {}) => (
  <MobileShell visible sessions={sessions} terminalSessions={sessions} activeSessionId={activeSessionId} mobileView="terminal" threadTerminalOpen={extra.threadTerminalOpen}
    onSelectSession={vi.fn()} onCreateSession={vi.fn()} onSessionBusyChange={vi.fn()} projectInfo={{ cwd: '/repo/current' }} sessionActivity={{}} fontSize={14} viewportHeight={800}
    onViewChange={vi.fn()} onChatModeChange={vi.fn()} onAccessoryToggle={vi.fn()} onAccessoryHeightChange={vi.fn()} onRegisterFocusTerminal={vi.fn()} onUrlDetected={vi.fn()}
    sessionAiTypes={{}} customAiProviders={[]} onSetSessionAiType={vi.fn()} onAddCustomAiProvider={vi.fn()} />
);
const draft = id => splitContext(getComposerDraftStore(id).getSnapshot().text);
const select = (id, text) => act(() => { const terminal = terminals.get(id); terminal.text = text; terminal.listeners.forEach(listener => listener()); });
const longPress = element => { fireEvent.touchStart(element, { touches: [{ clientX: 40, clientY: 60 }] }); act(() => { vi.advanceTimersByTime(600); }); fireEvent.touchEnd(element); };

beforeEach(() => { vi.useFakeTimers({ shouldAdvanceTime: true }); resetPullRequestMentionCache(); localStorage.clear(); setActiveEnvironment(null); terminals.clear(); pullRequest = null; lastStatusBarProps = null; });
afterEach(() => { vi.useRealTimers(); });

describe('MobileShell terminal selection menu', () => {
  const sessions = [thread('ss-a', 'Alpha'), thread('ss-b', 'Bravo'), { id: 'pty-drawer', isActive: true, cwd: '/repo/current', thread: { companionOf: 'ss-a' } }];

  it('adds drawer terminal output to the owning thread from the long-press menu', async () => {
    render(shell(sessions, 'ss-a', { threadTerminalOpen: true }));
    const drawer = await screen.findByRole('region', { name: 'Thread terminal' });
    await waitFor(() => expect(terminals.has('pty-drawer')).toBe(true));
    select('pty-drawer', 'npm test\nFAIL');
    longPress(drawer);
    fireEvent.click(await screen.findByRole('button', { name: 'Add to chat: Alpha' }));
    expect(draft('ss-a').chips).toEqual([expect.objectContaining({ kind: 'terminal', label: 'Thread terminal · lines 1-2', body: 'npm test\nFAIL' })]);
    expect(draft('ss-b').chips).toEqual([]);
    expect(screen.queryByRole('group', { name: 'Context actions' })).not.toBeInTheDocument();
  });

  it('offers Copy selection in the same menu', async () => {
    render(shell(sessions, 'ss-a', { threadTerminalOpen: true }));
    const drawer = await screen.findByRole('region', { name: 'Thread terminal' });
    await waitFor(() => expect(terminals.has('pty-drawer')).toBe(true));
    select('pty-drawer', 'abc');
    longPress(drawer);
    const menu = await screen.findByRole('group', { name: 'Context actions' });
    fireEvent.click(within(menu).getByRole('button', { name: 'Copy selection' }));
    expect(terminals.get('pty-drawer').copied).toBe(1);
  });

  it('opens no menu without a selection', async () => {
    render(shell(sessions, 'ss-a', { threadTerminalOpen: true }));
    const drawer = await screen.findByRole('region', { name: 'Thread terminal' });
    await waitFor(() => expect(terminals.has('pty-drawer')).toBe(true));
    longPress(drawer);
    expect(screen.queryByRole('group', { name: 'Context actions' })).not.toBeInTheDocument();
  });

  it('shows a disabled item with the reason for a blank selection and does not touch the draft', async () => {
    render(shell(sessions, 'ss-a', { threadTerminalOpen: true }));
    const drawer = await screen.findByRole('region', { name: 'Thread terminal' });
    await waitFor(() => expect(terminals.has('pty-drawer')).toBe(true));
    select('pty-drawer', '  \n ');
    longPress(drawer);
    const item = await screen.findByRole('button', { name: /Add to chat \(the selection is blank\)/ });
    expect(item).toBeDisabled();
    expect(getComposerDraftStore('ss-a').getSnapshot().text).toBe('');
  });

  it('disables Add to chat with a reason in a standalone terminal that has no thread', async () => {
    const solo = [{ id: 'pty-solo', title: 'Shell', isActive: true, cwd: '/repo/current' }];
    render(shell(solo, 'pty-solo'));
    await waitFor(() => expect(terminals.has('pty-solo')).toBe(true));
    select('pty-solo', 'ls');
    longPress(document.querySelector('[data-persistent-terminal]'));
    expect(await screen.findByRole('button', { name: /Add to chat \(open this terminal from a thread/ })).toBeDisabled();
  });

  it('adds to the thread that owns a companion terminal opened directly', async () => {
    render(shell(sessions, 'pty-drawer'));
    await waitFor(() => expect(terminals.has('pty-drawer')).toBe(true));
    select('pty-drawer', 'ls');
    longPress(document.querySelector('[data-persistent-terminal]'));
    fireEvent.click(await screen.findByRole('button', { name: 'Add to chat: Alpha' }));
    expect(draft('ss-a').chips).toHaveLength(1);
  });

  it('drops the menu and the selection when the thread changes mid-selection', async () => {
    const view = render(shell(sessions, 'ss-a', { threadTerminalOpen: true }));
    const drawer = await screen.findByRole('region', { name: 'Thread terminal' });
    await waitFor(() => expect(terminals.has('pty-drawer')).toBe(true));
    select('pty-drawer', 'old thread output');
    longPress(drawer);
    await screen.findByRole('group', { name: 'Context actions' });
    view.rerender(shell(sessions, 'ss-b', { threadTerminalOpen: true }));
    await waitFor(() => expect(screen.queryByRole('group', { name: 'Context actions' })).not.toBeInTheDocument());
    expect(draft('ss-a').chips).toEqual([]);
    expect(draft('ss-b').chips).toEqual([]);
  });

  it('offers the current branch pull request as a mention', async () => {
    pullRequest = { number: 9, title: 'Add feature', url: 'https://github.com/acme/app/pull/9', state: 'OPEN' };
    render(shell(sessions, 'ss-a'));
    await waitFor(() => expect(lastStatusBarProps.mentionPullRequests).toEqual([{ id: '9', title: '#9 Add feature', url: pullRequest.url }]));
  });
});
