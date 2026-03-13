import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { TerminalPane } from './TerminalPane';

const refreshSessionGitStats = vi.fn();
const listSessionGitBranches = vi.fn();
const checkoutSessionGitBranch = vi.fn();
let lastTerminalChatProps = null;

vi.mock('../contexts/TerminalSessionContext', () => ({
  useTerminalSession: () => ({
    refreshSessionGitStats,
    listSessionGitBranches,
    checkoutSessionGitBranch
  })
}));

vi.mock('../contexts/AutocorrectContext', () => ({
  useAutocorrect: () => ({
    autocorrectEnabled: true,
    toggleAutocorrect: vi.fn()
  })
}));

vi.mock('./TerminalChat', () => ({
  TerminalChat: (props) => {
    lastTerminalChatProps = props;
    return <div data-testid="terminal-chat" />;
  }
}));

vi.mock('./DesktopConversationView', () => ({
  DesktopConversationView: () => <div data-testid="desktop-conversation-view" />
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
    lastTerminalChatProps = null;
    listSessionGitBranches.mockResolvedValue({ currentBranch: 'main', branches: ['main', 'feature/ui'] });
  });

  it('loads git branches for the active terminal footer', async () => {
    render(<TerminalPane {...buildProps()} />);

    await waitFor(() => {
      expect(listSessionGitBranches).toHaveBeenCalledWith('session-1');
    });
  });

  it('keeps the existing terminal-first desktop layout while disabling direct terminal input by default', () => {
    render(<TerminalPane {...buildProps({ desktopAllowTerminalInput: false })} />);

    expect(screen.queryByTestId('desktop-conversation-view')).not.toBeInTheDocument();
    expect(lastTerminalChatProps?.inputEnabled).toBe(false);
  });

  it('keeps terminal-first desktop layout when direct terminal input is enabled', () => {
    render(<TerminalPane {...buildProps({ desktopAllowTerminalInput: true })} />);

    expect(screen.queryByTestId('desktop-conversation-view')).not.toBeInTheDocument();
    expect(lastTerminalChatProps?.inputEnabled).toBe(true);
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
