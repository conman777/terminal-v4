import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { TerminalPane } from './TerminalPane';

const refreshSessionGitStats = vi.fn();
const listSessionGitBranches = vi.fn();
const checkoutSessionGitBranch = vi.fn();
const sendToSession = vi.fn();
let lastTerminalChatProps = null;
let lastConversationViewProps = null;

vi.mock('../contexts/TerminalSessionContext', () => ({
  useTerminalSession: () => ({
    refreshSessionGitStats,
    listSessionGitBranches,
    checkoutSessionGitBranch,
    sendToSession
  })
}));

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
    return <div data-testid="terminal-chat" />;
  }
}));

vi.mock('./DesktopConversationView', () => ({
  DesktopConversationView: (props) => {
    lastConversationViewProps = props;
    return <div data-testid="desktop-conversation-view" />;
  }
}));

vi.mock('./DesktopStatusBar', () => ({
  DesktopStatusBar: (props) => (
    <div
      data-testid="desktop-status-bar"
      data-connection-state={props.connectionState}
      data-terminal-open={props.isTerminalPanelOpen ? 'true' : 'false'}
      data-conversation-view={props.isConversationViewEnabled ? 'true' : 'false'}
    >
      <textarea
        aria-label="Command composer"
        placeholder={props.composerPlaceholder}
        value={props.composerValue}
        onChange={(event) => props.onComposerChange?.(event.target.value)}
      />
      {props.showConversationToggle ? (
        <button
          type="button"
          aria-label={props.isConversationViewEnabled
            ? 'Disable chat view and show the classic terminal layout'
            : 'Enable chat view'}
          onClick={() => props.onToggleConversationView?.()}
        >
          Chat View
        </button>
      ) : null}
      {props.showTerminalToggle ? (
        <button
          type="button"
          aria-label={props.isTerminalPanelOpen ? 'Hide inline terminal panel' : 'Show inline terminal panel'}
          onClick={() => props.onToggleTerminalPanel?.()}
        >
          {props.isTerminalPanelOpen ? 'Hide Terminal' : 'Open Terminal'}
        </button>
      ) : null}
    </div>
  )
}));

vi.mock('../hooks/useMobileChatTurns', () => ({
  useMobileChatTurns: () => ({
    turns: [],
    isLoading: false,
    isSendReady: true,
    handleTurn: vi.fn(),
    handleRegisterSendText: vi.fn(),
    handleChatSend: vi.fn(() => ({ queued: false })),
    handleRawSend: vi.fn()
  })
}));

vi.mock('../hooks/useStructuredSession', () => ({
  useStructuredSession: () => ({
    messages: [],
    currentToolCalls: [],
    pendingApproval: null,
    isStreaming: false,
    connectionState: 'online',
    sendMessage: vi.fn(),
    interrupt: vi.fn(),
    approve: vi.fn()
  })
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
  beforeEach(() => {
    refreshSessionGitStats.mockReset();
    listSessionGitBranches.mockReset();
    checkoutSessionGitBranch.mockReset();
    sendToSession.mockReset();
    window.localStorage.clear();
    lastTerminalChatProps = null;
    lastConversationViewProps = null;
    listSessionGitBranches.mockResolvedValue({ currentBranch: 'main', branches: ['main', 'feature/ui'] });
  });

  it('loads git branches for the active terminal footer', async () => {
    render(<TerminalPane {...buildProps()} />);

    await waitFor(() => {
      expect(listSessionGitBranches).toHaveBeenCalledWith('session-1');
    });
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
  });

  it('routes structured raw input through the session transport instead of the terminal chat sender', async () => {
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

    lastConversationViewProps?.onSendRaw?.('\r');
    expect(sendToSession).toHaveBeenCalledWith('ss-structured', '\r');
  });

  it('keeps the existing terminal-first desktop layout while disabling direct terminal input by default', () => {
    render(<TerminalPane {...buildProps({ desktopAllowTerminalInput: false })} />);

    expect(screen.queryByTestId('desktop-conversation-view')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Enable chat view' })).toBeInTheDocument();
    expect(lastTerminalChatProps?.inputEnabled).toBe(false);
  });

  it('keeps terminal-first desktop layout when direct terminal input is enabled', () => {
    render(<TerminalPane {...buildProps({ desktopAllowTerminalInput: true })} />);

    expect(screen.queryByTestId('desktop-conversation-view')).not.toBeInTheDocument();
    expect(lastTerminalChatProps?.inputEnabled).toBe(true);
  });

  it('switches terminal-backed AI sessions into the chat-first view when the toggle is enabled', async () => {
    render(<TerminalPane {...buildProps()} />);

    screen.getByRole('button', { name: 'Enable chat view' }).click();

    await waitFor(() => {
      expect(screen.getByTestId('desktop-conversation-view')).toBeInTheDocument();
    });

    expect(screen.getByTestId('terminal-chat')).toBeInTheDocument();
    expect(screen.getByTestId('desktop-status-bar')).toHaveAttribute('data-conversation-view', 'true');
    expect(window.localStorage.getItem('desktop.aiConversationView.enabled')).toBe('true');
    expect(lastTerminalChatProps?.inputEnabled).toBe(false);
  });

  it('restores the chat-first view from local storage while keeping the terminal runtime mounted in the background', async () => {
    window.localStorage.setItem('desktop.aiConversationView.enabled', 'true');

    render(<TerminalPane {...buildProps()} />);

    await waitFor(() => {
      expect(screen.getByTestId('desktop-conversation-view')).toBeInTheDocument();
    });

    expect(screen.getByTestId('terminal-chat')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Show inline terminal panel' })).toBeInTheDocument();
    expect(lastTerminalChatProps?.inputEnabled).toBe(false);
  });

  it('opens the inline terminal panel from chat view even when direct terminal input is otherwise disabled', async () => {
    window.localStorage.setItem('desktop.aiConversationView.enabled', 'true');

    render(<TerminalPane {...buildProps({ desktopAllowTerminalInput: false })} />);

    await waitFor(() => {
      expect(screen.getByTestId('desktop-conversation-view')).toBeInTheDocument();
    });

    screen.getByRole('button', { name: 'Show inline terminal panel' }).click();

    await waitFor(() => {
      expect(screen.getByTestId('desktop-status-bar')).toHaveAttribute('data-terminal-open', 'true');
      expect(lastTerminalChatProps?.inputEnabled).toBe(true);
    });
  });

  it('forces the inline terminal dock open when an interactive prompt arrives in chat view', async () => {
    window.localStorage.setItem('desktop.aiConversationView.enabled', 'true');

    render(<TerminalPane {...buildProps({ desktopAllowTerminalInput: false })} />);

    await waitFor(() => {
      expect(screen.getByTestId('desktop-conversation-view')).toBeInTheDocument();
    });

    lastTerminalChatProps?.onCliEvent?.({
      type: 'prompt_required',
      prompt: 'bypass permissions on (shift+tab to cycle)',
      actions: ['tab', 'shift_tab']
    });

    await waitFor(() => {
      expect(screen.getByTestId('desktop-status-bar')).toHaveAttribute('data-terminal-open', 'true');
      expect(lastTerminalChatProps?.inputEnabled).toBe(true);
      expect(lastConversationViewProps?.isTerminalDockVisible).toBe(true);
    });
  });

  it('shows the chat view toggle even when the session has no saved AI metadata', () => {
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

    expect(screen.getByRole('button', { name: 'Enable chat view' })).toBeInTheDocument();
  });

  it('renders the command composer inside the desktop terminal stack', () => {
    render(<TerminalPane {...buildProps()} />);

    const composer = screen.getByRole('textbox', { name: 'Command composer' });
    expect(composer.closest('.desktop-terminal-stack')).not.toBeNull();
  });

  it('renders the DesktopStatusBar with the Ask V4 placeholder visible', () => {
    render(<TerminalPane {...buildProps()} />);

    const composer = screen.getByPlaceholderText('Ask V4 anything');
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
});
