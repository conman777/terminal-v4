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
  DesktopStatusBar: ({ isTerminalPanelOpen, onToggleTerminalPanel, showTerminalToggle = true }) => (
    showTerminalToggle ? (
      <button type="button" aria-label="toggle-terminal-panel" onClick={onToggleTerminalPanel}>
        {isTerminalPanelOpen ? 'Hide Terminal' : 'Open Terminal'}
      </button>
    ) : <div data-testid="terminal-toggle-hidden" />
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
    handleRawSend: vi.fn(),
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

  it('renders the terminal as the primary surface for CLI sessions', () => {
    const { container } = render(<TerminalPane {...buildProps()} />);

    expect(latestTerminalChatProps).not.toBeNull();
    expect(screen.getByTestId('terminal-chat-mock')).toBeInTheDocument();
    expect(screen.queryByTestId('desktop-conversation-view-mock')).not.toBeInTheDocument();
    expect(screen.getByTestId('terminal-toggle-hidden')).toBeInTheDocument();
    expect(screen.getByLabelText('Agent session controls')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Launch Claude Code' })).toBeInTheDocument();
    expect(container.querySelector('.terminal-with-status.terminal-first')).not.toBeNull();
    expect(container.querySelector('.desktop-terminal-runtime.terminal-first')).not.toBeNull();
  });

  it('launches the active CLI agent from the terminal-first toolbar', () => {
    render(<TerminalPane {...buildProps()} />);

    fireEvent.click(screen.getByRole('button', { name: 'Launch Claude Code' }));

    expect(handleChatSendMock).toHaveBeenCalledWith('claude --dangerously-skip-permissions');
  });

  it('still renders the structured conversation view for structured sessions', () => {
    render(<TerminalPane {...buildProps({
      pane: { id: 'pane-1', sessionId: 'ss-session-1' },
      sessions: [{ id: 'ss-session-1', title: 'Structured Session', usesTmux: false, thread: null }],
      sessionAiTypes: { 'ss-session-1': 'codex' }
    })} />);

    expect(screen.getByTestId('desktop-conversation-view-mock')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'toggle-terminal-panel' })).toHaveTextContent('Open Terminal');
  });

  it('does not auto-open a secondary terminal panel for CLI sessions when interactive output arrives', () => {
    render(<TerminalPane {...buildProps()} />);
    expect(latestTerminalChatProps).not.toBeNull();

    act(() => {
      latestTerminalChatProps.onOutputChunk(INTERACTIVE_OUTPUT);
    });

    expect(screen.getByTestId('terminal-chat-mock')).toBeInTheDocument();
    expect(screen.getByTestId('terminal-toggle-hidden')).toBeInTheDocument();
  });

  it('forwards canonical prompt_required events into conversation view state', () => {
    render(<TerminalPane {...buildProps({
      pane: { id: 'pane-1', sessionId: 'ss-session-1' },
      sessions: [{ id: 'ss-session-1', title: 'Structured Session', usesTmux: false, thread: null }],
      sessionAiTypes: { 'ss-session-1': 'codex' }
    })} />);
    expect(latestTerminalChatProps).not.toBeNull();

    act(() => {
      latestTerminalChatProps.onCliEvent({
        type: 'prompt_required',
        prompt: 'Continue anyway? [y/N]:',
        actions: ['yes', 'no']
      });
    });

    expect(latestConversationProps.showTerminalMirror).toBe(true);
    expect(latestConversationProps.interactivePromptEvent?.type).toBe('prompt_required');
  });

  it('returns to conversation mode once a prompt is followed by a conversation turn', () => {
    render(<TerminalPane {...buildProps({
      pane: { id: 'pane-1', sessionId: 'ss-session-1' },
      sessions: [{ id: 'ss-session-1', title: 'Structured Session', usesTmux: false, thread: null }],
      sessionAiTypes: { 'ss-session-1': 'codex' }
    })} />);
    expect(latestTerminalChatProps).not.toBeNull();

    act(() => {
      latestTerminalChatProps.onCliEvent({
        type: 'prompt_required',
        prompt: 'Continue anyway? [y/N]:',
        actions: ['yes', 'no']
      });
    });

    expect(latestConversationProps.showTerminalMirror).toBe(true);

    act(() => {
      latestTerminalChatProps.onCliEvent({
        type: 'assistant_turn',
        content: 'Environment variables downloaded.'
      });
    });

    expect(latestConversationProps.showTerminalMirror).toBe(false);
    expect(latestConversationProps.interactivePromptEvent).toBeNull();
  });

  it('returns to conversation mode when interactive output gives way to normal terminal output', () => {
    render(<TerminalPane {...buildProps({
      pane: { id: 'pane-1', sessionId: 'ss-session-1' },
      sessions: [{ id: 'ss-session-1', title: 'Structured Session', usesTmux: false, thread: null }],
      sessionAiTypes: { 'ss-session-1': 'codex' }
    })} />);
    expect(latestTerminalChatProps).not.toBeNull();

    act(() => {
      latestTerminalChatProps.onOutputChunk(INTERACTIVE_OUTPUT);
    });

    expect(latestConversationProps.showTerminalMirror).toBe(false);

    act(() => {
      latestTerminalChatProps.onOutputChunk('Downloading production environment variables...\n');
    });

    expect(latestConversationProps.showTerminalMirror).toBe(false);
    expect(latestConversationProps.interactivePromptEvent).toBeNull();
  });
});
