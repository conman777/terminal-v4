import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useEffect } from 'react';
import { TerminalPane } from './TerminalPane';
import { splitContext } from './composer-context/composerContext';
import { getComposerDraftStore } from '../utils/composerDraftStore';
import { setActiveEnvironment } from '../utils/remoteEnvironments';
import { resetPullRequestMentionCache } from '../hooks/useCurrentPullRequest';

const terminals = new Map();
let activeSessionId = null;
let pullRequest = null;
let lastStatusBarProps = null;
const noop = () => Promise.resolve({});

vi.mock('../contexts/TerminalSessionContext', () => ({
  useTerminalSession: () => ({ activeSessionId, refreshSessionGitStats: noop, listSessionGitBranches: noop, checkoutSessionGitBranch: noop, sendToSession: noop,
    sendRawToSession: noop, updateThreadMetadata: (_id, patch) => Promise.resolve({ ...patch }), renameSession: noop, updateStructuredSessionSelection: noop,
    updateStructuredSessionAccess: noop, createSession: noop, restoreSession: () => Promise.resolve({ restored: true }) }),
}));
vi.mock('../hooks/useSupervisedInputCapability', () => ({ useSupervisedInputCapability: () => 'legacy' }));
vi.mock('../utils/api', async importOriginal => {
  const actual = await importOriginal();
  return { ...actual, apiGet: url => (String(url).startsWith('/api/workspace/git/pull-request') ? Promise.resolve({ pullRequest }) : actual.apiGet(url)),
    apiFetch: () => Promise.resolve({ ok: false, status: 404, json: async () => ({}) }) };
});
vi.mock('../contexts/AutocorrectContext', () => ({ useAutocorrect: () => ({ autocorrectEnabled: false, toggleAutocorrect() {} }) }));
vi.mock('./TerminalChat', () => ({
  TerminalChat: props => {
    useEffect(() => {
      const listeners = new Set();
      const terminal = { text: '', cleared: 0, listeners };
      terminal.actions = { sessionId: props.sessionId, hasSelection: () => Boolean(terminal.text), copySelection: () => true, getSelectionText: () => terminal.text,
        clearSelection: () => { terminal.cleared += 1; terminal.text = ''; listeners.forEach(listener => listener()); },
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
vi.mock('../hooks/useMobileChatTurns', () => ({ useMobileChatTurns: () => ({ turns: [], isLoading: false, isSendReady: true, handleTurn: vi.fn(), handleRegisterSendText: vi.fn(), handleChatSend: vi.fn(), handleRawSend: vi.fn() }) }));
vi.mock('../hooks/useStructuredSession', () => ({ useStructuredSession: () => ({ messages: [], currentToolCalls: [], pendingApproval: null, isStreaming: false, requiresCleanup: false, connectionState: 'online',
  sendMessage: vi.fn(), interrupt: vi.fn(), isInterrupting: false, controlError: '', controlState: { sessionId: null, generation: 0, latestSeq: 0, events: [], truncated: false }, approve: vi.fn() }) }));
vi.mock('../hooks/useSessionBrowserApprovals', () => ({ useSessionBrowserApprovals: () => ({ requests: [], decide: vi.fn(), isDeciding: false, error: '' }) }));
vi.mock('./WorkspaceToolsButton', () => ({ WorkspaceToolsButton: () => null }));
vi.mock('./WorkspaceProfileButton', () => ({ WorkspaceProfileButton: () => null }));
vi.mock('./ConversationContextButton', () => ({ ConversationContextButton: () => null }));

const thread = (id, title) => ({ id, title, aiType: 'claude', cwd: '/repo/current', isActive: true });
const props = overrides => ({ pane: { id: 'pane-1', sessionId: 'ss-a' }, isActive: true, isFullscreen: false, canSplit: false, canClose: false, onSessionSelect: vi.fn(),
  onSplit: vi.fn(), onClose: vi.fn(), onFocus: vi.fn(), onFullscreen: vi.fn(), showPreview: false, keybarOpen: false, viewportHeight: 900, fontSize: 14, webglEnabled: false,
  sessionActivity: {}, projectInfo: { cwd: '/repo/current' }, sessionAiTypes: {}, customAiProviders: [], onSetSessionAiType: vi.fn(), onAddCustomAiProvider: vi.fn(),
  desktopAllowTerminalInput: true, currentDesktopId: 'desktop-1', fitSignal: 0, sessions: [], ...overrides });
const draft = id => splitContext(getComposerDraftStore(id).getSnapshot().text);
const select = (id, text) => act(() => { const terminal = terminals.get(id); terminal.text = text; terminal.listeners.forEach(listener => listener()); });

beforeEach(() => { resetPullRequestMentionCache(); localStorage.clear(); setActiveEnvironment(null); terminals.clear(); activeSessionId = null; pullRequest = null; lastStatusBarProps = null; });

async function openDrawer() {
  fireEvent.click(screen.getByRole('button', { name: 'Toggle terminal drawer' }));
  const drawer = await screen.findByRole('region', { name: 'Thread terminal' });
  await waitFor(() => expect(terminals.has('pty-drawer')).toBe(true));
  return drawer;
}

describe('TerminalPane add to chat', () => {
  const sessions = [thread('ss-a', 'Alpha'), thread('ss-b', 'Bravo'), { id: 'pty-drawer', isActive: true, cwd: '/repo/current', thread: { companionOf: 'ss-a' } }];

  it('adds drawer terminal output to the thread that owns the drawer', async () => {
    render(<TerminalPane {...props({ sessions })} />);
    const drawer = await openDrawer();
    select('pty-drawer', 'npm test\nFAIL auth');
    fireEvent.click(within(drawer).getByRole('button', { name: 'Add to chat: Alpha' }));
    expect(draft('ss-a').chips).toEqual([expect.objectContaining({ kind: 'terminal', label: 'Thread terminal · lines 1-2', body: 'npm test\nFAIL auth' })]);
    expect(draft('ss-b').chips).toEqual([]);
    expect(terminals.get('pty-drawer').text).toBe('');
  });

  it('keeps the drawer selection from leaking into another thread after switching mid-selection', async () => {
    const view = render(<TerminalPane {...props({ sessions })} />);
    await openDrawer();
    select('pty-drawer', 'secret output');
    view.rerender(<TerminalPane {...props({ sessions, pane: { id: 'pane-1', sessionId: 'ss-b' } })} />);
    await waitFor(() => expect(screen.queryByRole('button', { name: /Add to chat/ })).not.toBeInTheDocument());
    expect(draft('ss-b').chips).toEqual([]);
    expect(draft('ss-a').chips).toEqual([]);
  });

  it('retains the added chip in the saved draft across a reload', async () => {
    render(<TerminalPane {...props({ sessions })} />);
    const drawer = await openDrawer();
    select('pty-drawer', 'build ok');
    fireEvent.click(within(drawer).getByRole('button', { name: 'Add to chat: Alpha' }));
    vi.resetModules();
    const reloaded = await import('../utils/composerDraftStore');
    expect(splitContext(reloaded.getComposerDraftStore('ss-a').getSnapshot().text).chips).toEqual([expect.objectContaining({ body: 'build ok' })]);
  });

  it('targets the active structured thread from a standalone terminal view', async () => {
    activeSessionId = 'ss-b';
    const all = [thread('ss-b', 'Bravo'), { id: 'pty-solo', title: 'Shell', isActive: true, cwd: '/repo/current' }];
    render(<TerminalPane {...props({ sessions: all, pane: { id: 'pane-1', sessionId: 'pty-solo' }, desktopAllowTerminalInput: true })} />);
    await waitFor(() => expect(terminals.has('pty-solo')).toBe(true));
    select('pty-solo', 'ls');
    fireEvent.click(await screen.findByRole('button', { name: 'Add to chat: Bravo' }));
    expect(draft('ss-b').chips).toHaveLength(1);
  });

  it('disables Add to chat with a reason when a standalone terminal has no thread', async () => {
    const all = [{ id: 'pty-solo', title: 'Shell', isActive: true, cwd: '/repo/current' }];
    render(<TerminalPane {...props({ sessions: all, pane: { id: 'pane-1', sessionId: 'pty-solo' } })} />);
    await waitFor(() => expect(terminals.has('pty-solo')).toBe(true));
    select('pty-solo', 'ls');
    const button = await screen.findByRole('button', { name: 'Add to chat' });
    expect(button).toHaveAttribute('aria-disabled', 'true');
    expect(button).toHaveAccessibleDescription(/Open this terminal from a thread/);
    fireEvent.click(button);
    expect(getComposerDraftStore('pty-solo').getSnapshot().text).toBe('');
  });

  it('offers the current branch pull request as a mention', async () => {
    pullRequest = { number: 7, title: 'Fix login', url: 'https://github.com/acme/app/pull/7', state: 'OPEN' };
    render(<TerminalPane {...props({ sessions })} />);
    await waitFor(() => expect(lastStatusBarProps.mentionPullRequests).toEqual([{ id: '7', title: '#7 Fix login', url: pullRequest.url }]));
  });
});
