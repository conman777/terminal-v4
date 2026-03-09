import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { TerminalPane } from './TerminalPane';

const refreshSessionGitStats = vi.fn();
const listSessionGitBranches = vi.fn();
const checkoutSessionGitBranch = vi.fn();

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
  TerminalChat: () => <div data-testid="terminal-chat" />
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
    listSessionGitBranches.mockResolvedValue({ currentBranch: 'main', branches: ['main', 'feature/ui'] });
  });

  it('loads git branches for the active terminal footer', async () => {
    render(<TerminalPane {...buildProps()} />);

    await waitFor(() => {
      expect(listSessionGitBranches).toHaveBeenCalledWith('session-1');
    });
  });
});
