import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TerminalPane } from './TerminalPane';

let latestTerminalChatProps = null;
let latestConversationProps = null;
const handleChatSendMock = vi.fn(() => ({ queued: false }));
const handleInterruptMock = vi.fn();

vi.mock('./TerminalChat', () => ({
  TerminalChat: (props) => {
    latestTerminalChatProps = props;
    return <div data-testid="terminal-chat-mock" />;
  }
}));

vi.mock('./DesktopConversationView', () => ({
  DesktopConversationView: (props) => {
    latestConversationProps = props;
    return <div data-testid="desktop-conversation-view-mock" />;
  }
}));

vi.mock('./DesktopStatusBar', () => ({
  DesktopStatusBar: ({ isTerminalPanelOpen, onToggleTerminalPanel }) => (
    <button type="button" aria-label="toggle-terminal-panel" onClick={onToggleTerminalPanel}>
      {isTerminalPanelOpen ? 'Hide Terminal' : 'Open Terminal'}
    </button>
  )
}));

vi.mock('../hooks/useMobileChatTurns', () => ({
  useMobileChatTurns: () => ({
    turns: [],
    isLoading: false,
    isSendReady: true,
    handleTurn: vi.fn(),
    handleRegisterSendText: vi.fn(),
    handleChatSend: handleChatSendMock,
    handleInterrupt: handleInterruptMock,
  })
}));

function buildProps(overrides = {}) {
  return {
    pane: { id: 'pane-1', sessionId: 'session-1' },
    isActive: true,
    isFullscreen: false,
    sessions: [{ id: 'session-1', title: 'Claude Code', usesTmux: false, thread: null }],
    canSplit: false,
    canClose: false,
    onSessionSelect: vi.fn(),
    onSplit: vi.fn(),
    onClose: vi.fn(),
    onFocus: vi.fn(),
    onFullscreen: vi.fn(),
    showPreview: false,
    onMinimizeMainTerminal: vi.fn(),
    keybarOpen: false,
    viewportHeight: 900,
    onUrlDetected: vi.fn(),
    fontSize: 14,
    webglEnabled: false,
    sessionActivity: {},
    projectInfo: { cwd: 'C:\\repo', gitBranch: 'main' },
    sessionAiTypes: { 'session-1': 'claude' },
    onCwdChange: vi.fn(),
    onSessionBusyChange: vi.fn(),
    currentDesktopId: 'desktop-1',
    fitSignal: 0,
    ...overrides
  };
}

const INTERACTIVE_OUTPUT = 'Accessing workspace: C:\\repo\nQuick safety check. Trust this folder? Enter to confirm. Esc to cancel.';

describe('TerminalPane', () => {
  beforeEach(() => {
    latestTerminalChatProps = null;
    latestConversationProps = null;
    handleChatSendMock.mockClear();
    handleInterruptMock.mockClear();
  });

  it('does not auto-open terminal panel for interactive output', () => {
    render(<TerminalPane {...buildProps()} />);

    const toggleButton = screen.getByRole('button', { name: 'toggle-terminal-panel' });
    expect(toggleButton).toHaveTextContent('Open Terminal');
    expect(latestTerminalChatProps).not.toBeNull();

    act(() => {
      latestTerminalChatProps.onOutputChunk(INTERACTIVE_OUTPUT);
    });
    expect(screen.getByRole('button', { name: 'toggle-terminal-panel' })).toHaveTextContent('Open Terminal');
    expect(latestConversationProps.showTerminalMirror).toBe(true);
  });

  it('keeps panel hidden after manual hide even if interactive output continues', () => {
    render(<TerminalPane {...buildProps()} />);
    expect(latestTerminalChatProps).not.toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'toggle-terminal-panel' }));
    expect(screen.getByRole('button', { name: 'toggle-terminal-panel' })).toHaveTextContent('Hide Terminal');

    fireEvent.click(screen.getByRole('button', { name: 'toggle-terminal-panel' }));
    expect(screen.getByRole('button', { name: 'toggle-terminal-panel' })).toHaveTextContent('Open Terminal');

    act(() => {
      latestTerminalChatProps.onOutputChunk(INTERACTIVE_OUTPUT);
    });

    expect(screen.getByRole('button', { name: 'toggle-terminal-panel' })).toHaveTextContent('Open Terminal');
  });

  it('forwards live terminal screen snapshots to conversation view', () => {
    render(<TerminalPane {...buildProps()} />);
    expect(latestTerminalChatProps).not.toBeNull();
    expect(latestConversationProps).not.toBeNull();

    act(() => {
      latestTerminalChatProps.onScreenSnapshot({ text: 'Claude Code v2.1.68\n> ready' });
    });

    expect(latestConversationProps.terminalScreenSnapshot).toContain('Claude Code v2.1.68');
  });
});
