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
  DesktopStatusBar: (props) => {
    return (
      <div>
        {props.showTerminalToggle ? (
          <button type="button" aria-label="toggle-terminal-panel" onClick={props.onToggleTerminalPanel}>
            {props.isTerminalPanelOpen ? 'Hide Terminal' : 'Open Terminal'}
          </button>
        ) : <div data-testid="terminal-toggle-hidden" />}
        <button type="button" aria-label="status-launch-ai" onClick={props.onLaunchAi}>Launch</button>
        <button type="button" aria-label="status-select-codex" onClick={() => props.onSelectAiType?.('codex')}>Codex</button>
        <button type="button" aria-label="status-add-custom-ai" onClick={() => props.onAddCustomAiCommand?.('Qwen 3', 'qwen --fast')}>Add custom</button>
      </div>
    );
  }
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

vi.mock('../contexts/TerminalSessionContext', () => ({
  useTerminalSession: () => ({
    refreshSessionGitStats: vi.fn()
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
    expect(latestTerminalChatProps.surface).toBe('desktop');
    expect(screen.getByTestId('terminal-chat-mock')).toBeInTheDocument();
    expect(screen.queryByTestId('desktop-conversation-view-mock')).not.toBeInTheDocument();
    expect(screen.getByTestId('terminal-toggle-hidden')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'status-launch-ai' })).toBeInTheDocument();
    expect(container.querySelector('.terminal-with-status.terminal-first')).not.toBeNull();
    expect(container.querySelector('.desktop-terminal-runtime.terminal-first')).not.toBeNull();
  });

  it('launches the active CLI agent from the terminal-first toolbar', () => {
    render(<TerminalPane {...buildProps()} />);

    fireEvent.click(screen.getByRole('button', { name: 'status-launch-ai' }));

    expect(handleChatSendMock).toHaveBeenCalledWith('claude --dangerously-skip-permissions');
  });

  it('updates the current session AI type from the footer selector', () => {
    const onSetSessionAiType = vi.fn();
    render(<TerminalPane {...buildProps({ onSetSessionAiType })} />);

    fireEvent.click(screen.getByRole('button', { name: 'status-select-codex' }));

    expect(onSetSessionAiType).toHaveBeenCalledWith('session-1', 'codex');
    expect(handleChatSendMock).toHaveBeenCalledWith('codex --yolo');
  });

  it('adds and launches a custom AI command from the footer', () => {
    const onSetSessionAiType = vi.fn();
    const onAddCustomAiProvider = vi.fn(() => ({
      id: 'qwen-3',
      label: 'Qwen 3',
      initialCommand: 'qwen --fast'
    }));

    render(<TerminalPane {...buildProps({ onSetSessionAiType, onAddCustomAiProvider })} />);

    fireEvent.click(screen.getByRole('button', { name: 'status-add-custom-ai' }));

    expect(onAddCustomAiProvider).toHaveBeenCalledWith('Qwen 3', 'qwen --fast');
    expect(onSetSessionAiType).toHaveBeenCalledWith('session-1', 'qwen-3');
    expect(handleChatSendMock).toHaveBeenCalledWith('qwen --fast');
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

  it('shows only visible pane sessions and prompts to select when the assigned session is unavailable', () => {
    render(<TerminalPane {...buildProps({
      pane: { id: 'pane-2', sessionId: 'archived-session' },
      canClose: true,
      sessions: [
        {
          id: 'session-1',
          title: 'Active terminal',
          usesTmux: false,
          thread: { archived: false, topic: 'Active terminal' }
        },
        {
          id: 'archived-session',
          title: 'Archived terminal',
          usesTmux: false,
          thread: { archived: true, topic: 'Archived terminal' }
        }
      ]
    })} />);

    expect(screen.getByText('Select terminal')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /select terminal/i }));

    expect(screen.getByText('Active terminal')).toBeInTheDocument();
    expect(screen.queryByText('Archived terminal')).not.toBeInTheDocument();
  });

  it('uses the preferred thread topic in the split session switcher', () => {
    render(<TerminalPane {...buildProps({
      pane: { id: 'pane-1', sessionId: 'session-2' },
      canClose: true,
      sessions: [
        {
          id: 'session-1',
          title: 'Terminal 5',
          usesTmux: false,
          thread: { archived: false, topic: 'this should only show this sho...' }
        },
        {
          id: 'session-2',
          title: 'Terminal 6',
          usesTmux: false,
          thread: { archived: false, topic: 'discard local changes' }
        }
      ]
    })} />);

    expect(screen.getByRole('button', { name: 'discard local changes' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'discard local changes' }));

    expect(screen.getByText('this should only show this sho...')).toBeInTheDocument();
    expect(screen.getAllByText('discard local changes').length).toBeGreaterThan(0);
    expect(screen.queryByText('Terminal 5')).not.toBeInTheDocument();
    expect(screen.queryByText('Terminal 6')).not.toBeInTheDocument();
  });
});
