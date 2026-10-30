import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useEffect } from 'react';
import { TerminalPane } from './TerminalPane';
import { splitContext } from './composer-context/composerContext';
import { getComposerDraftStore } from '../utils/composerDraftStore';
import { setActiveEnvironment, setEnvironmentIdentity } from '../utils/remoteEnvironments';
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
vi.mock('./DesktopStatusBar', () => ({ DesktopStatusBar: props => { lastStatusBarProps = props; return <div data-testid="desktop-status-bar"><textarea aria-label="composer" value={props.composerValue} onChange={event => props.onComposerChange(event.target.value)} />{props.composerSecondaryAction}</div>; } }));
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

const typeDraft = text => fireEvent.change(screen.getByLabelText('composer'), { target: { value: text } });
// With an empty stash the picker runs its single action directly instead of opening a menu.
const openStash = () => fireEvent.click(screen.getByRole('button', { name: 'Stashed drafts' }));
const failStashWrites = () => {
  const original = Storage.prototype.setItem;
  return vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (key, value) {
    if (String(key).includes('tv4StashedDrafts')) throw new Error('quota');
    return original.call(this, key, value);
  });
};

describe('stashing a draft', () => {
  beforeEach(() => {
    localStorage.clear();
    terminals.clear();
    setActiveEnvironment(null);
    setEnvironmentIdentity('account-a');
  });
  afterEach(() => {
    vi.restoreAllMocks();
    setEnvironmentIdentity('');
  });

  it('keeps the typed draft and says why when the stash cannot be saved', async () => {
    render(<TerminalPane {...props({ sessions: [thread('ss-a', 'A')] })} />);
    typeDraft('do not lose me');
    failStashWrites();
    openStash();
    expect([screen.getByLabelText('composer').value, (await screen.findByRole('alert')).textContent])
      .toEqual(['do not lose me', expect.stringContaining('could not be stashed')]);
  });

  it('clears the composer only after the stash was saved', async () => {
    render(<TerminalPane {...props({ sessions: [thread('ss-a', 'A')] })} />);
    typeDraft('save me');
    openStash();
    await waitFor(() => expect(screen.getByLabelText('composer').value).toBe(''));
    expect([screen.queryByRole('alert'), screen.getByRole('button', { name: 'Stashed drafts' }).textContent]).toEqual([null, expect.stringContaining('Stash (1)')]);
  });

  it('does not show one account\'s stash after another account signs in', async () => {
    render(<TerminalPane {...props({ sessions: [thread('ss-a', 'A')] })} />);
    typeDraft('only for account A');
    openStash();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Stashed drafts' }).textContent).toContain('Stash (1)'));
    act(() => setEnvironmentIdentity('account-b'));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Stashed drafts' }).textContent).not.toContain('(1)'));
    act(() => setEnvironmentIdentity('account-a'));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Stashed drafts' }).textContent).toContain('Stash (1)'));
  });
});
