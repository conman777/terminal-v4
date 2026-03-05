import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { DesktopConversationView } from './DesktopConversationView';

vi.mock('./ToolCallBlock', () => ({
  default: ({ item }) => <div data-testid={`tool-call-${item.type}`}>{item.content}</div>
}));

function buildProps(overrides = {}) {
  return {
    turns: [],
    isStreaming: false,
    connectionState: 'online',
    isSendReady: true,
    terminalPreview: '',
    launchCommand: 'codex',
    launchQueued: false,
    onSend: vi.fn(),
    onInterrupt: vi.fn(),
    onLaunchAgent: vi.fn(),
    onOpenTerminal: vi.fn(),
    onImageUpload: vi.fn(),
    sessionId: 'session-1',
    isLoadingHistory: false,
    aiType: 'codex',
    showTerminalMirror: false,
    ...overrides
  };
}

describe('DesktopConversationView', () => {
  it('renders AI-specific placeholder text', () => {
    render(<DesktopConversationView {...buildProps()} />);
    expect(screen.getByPlaceholderText('Message Codex...')).toBeInTheDocument();
  });

  it('renders turns with user and assistant entries', () => {
    render(
      <DesktopConversationView
        {...buildProps({
          turns: [
            { role: 'user', content: 'first prompt', ts: 1 },
            { role: 'assistant', content: 'assistant reply', ts: 2 }
          ]
        })}
      />
    );

    expect(screen.getByText('first prompt')).toBeInTheDocument();
    expect(screen.getByText('assistant reply')).toBeInTheDocument();
  });

  it('sends message when pressing Enter without Shift', () => {
    const onSend = vi.fn();
    render(<DesktopConversationView {...buildProps({ onSend })} />);

    const input = screen.getByPlaceholderText('Message Codex...');
    fireEvent.change(input, { target: { value: 'hello world' } });
    fireEvent.keyDown(input, { key: 'Enter', code: 'Enter' });

    expect(onSend).toHaveBeenCalledWith('hello world');
  });

  it('shows launch action and calls handler', () => {
    const onLaunchAgent = vi.fn();
    render(<DesktopConversationView {...buildProps({ onLaunchAgent, aiType: 'claude', launchCommand: 'claude' })} />);

    fireEvent.click(screen.getByRole('button', { name: 'Launch Claude Code' }));
    expect(onLaunchAgent).toHaveBeenCalledTimes(1);
  });

  it('renders background preview output in startup card', () => {
    render(<DesktopConversationView {...buildProps({ terminalPreview: 'line one\nline two' })} />);
    expect(screen.getByText('Background output')).toBeInTheDocument();
    expect(screen.getByText(/line one/)).toBeInTheDocument();
    expect(screen.getByText(/line two/)).toBeInTheDocument();
  });

  it('renders live terminal screen snapshot when available', () => {
    render(
      <DesktopConversationView
        {...buildProps({
          terminalScreenSnapshot: 'Claude Code v2.1.68\n> bypass permissions'
        })}
      />
    );

    expect(screen.getByText('Live terminal screen')).toBeInTheDocument();
    expect(screen.getByText(/bypass permissions/i)).toBeInTheDocument();
  });

  it('shows launched-in-background status when preview output exists', () => {
    render(
      <DesktopConversationView
        {...buildProps({
          connectionState: 'online',
          isSendReady: false,
          terminalPreview: 'Claude Code v2.1.68'
        })}
      />
    );

    expect(screen.getByText(/launched in background/i)).toBeInTheDocument();
  });

  it('shows connecting state before transport is online', () => {
    render(<DesktopConversationView {...buildProps({ connectionState: 'connecting', isSendReady: false })} />);
    expect(screen.getByText('Connecting')).toBeInTheDocument();
  });

  it('filters bootstrap noise turns before first user message', () => {
    render(
      <DesktopConversationView
        {...buildProps({
          turns: [
            { role: 'assistant', content: 'Microsoft Windows [Version 10.0.26200.7840]', ts: 1 },
            { role: 'assistant', content: 'Claude Code v2.1.68', ts: 2 },
          ]
        })}
      />
    );

    expect(screen.queryByText(/Microsoft Windows/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Claude Code v2\.1\.68/)).not.toBeInTheDocument();
    expect(screen.getByText(/No Codex response yet/)).toBeInTheDocument();
  });

  it('sanitizes Claude startup TUI noise in conversation view', () => {
    render(
      <DesktopConversationView
        {...buildProps({
          aiType: 'claude',
          turns: [
            {
              role: 'assistant',
              content: [
                'claude --dangerously-skip-permissions',
                '1MCPserverfailed·/mcp ▘▘ ▝▝ ~\\OneDrive\\Personal\\Documents\\coding projects',
                '▘▘ ▝▝ ~\\OneDrive\\Personal\\Documents\\coding projects',
              ].join('\n'),
              ts: 1,
            },
          ],
        })}
      />
    );

    expect(screen.getByText(/MCP server failed/i)).toBeInTheDocument();
    expect(screen.queryByText(/OneDrive/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/dangerously-skip-permissions/i)).not.toBeInTheDocument();
  });

  it('renders inline conversation notice when provided', () => {
    render(
      <DesktopConversationView
        {...buildProps({
          conversationNotice: 'Interactive CLI prompt detected. Open terminal panel to continue.'
        })}
      />
    );

    expect(screen.getByText(/interactive cli prompt detected/i)).toBeInTheDocument();
  });

  it('filters noisy Claude thinking/progress line fragments', () => {
    render(
      <DesktopConversationView
        {...buildProps({
          aiType: 'claude',
          turns: [
            {
              role: 'assistant',
              content: '· Caramelizing… > ●It looks like this is terminal noise * Caramelizing… (thinking) >',
              ts: 1
            }
          ]
        })}
      />
    );

    expect(screen.queryByText(/Caramelizing/i)).not.toBeInTheDocument();
    expect(screen.getByText(/No Claude Code response yet/i)).toBeInTheDocument();
  });

  it('hides AI launch command user turn for non-Claude agents too', () => {
    render(
      <DesktopConversationView
        {...buildProps({
          aiType: 'codex',
          turns: [
            { role: 'user', content: 'codex', ts: 1 },
            { role: 'assistant', content: 'Normal response', ts: 2 },
          ]
        })}
      />
    );

    expect(screen.queryByTestId('tool-call-user')).not.toBeInTheDocument();
    expect(screen.getByText(/Normal response/)).toBeInTheDocument();
  });

  it('filters generic decorated path lines for other CLI agents', () => {
    render(
      <DesktopConversationView
        {...buildProps({
          aiType: 'gemini',
          turns: [
            { role: 'assistant', content: '*** ~\\OneDrive\\Personal\\Documents\\coding projects', ts: 1 }
          ]
        })}
      />
    );

    expect(screen.queryByText(/OneDrive/i)).not.toBeInTheDocument();
    expect(screen.getByText(/No Gemini response yet/i)).toBeInTheDocument();
  });

  it('filters generic interactive status/progress fragments for other agents', () => {
    render(
      <DesktopConversationView
        {...buildProps({
          aiType: 'codex',
          turns: [
            { role: 'assistant', content: '* Running... > select an option', ts: 1 }
          ]
        })}
      />
    );

    expect(screen.queryByText(/Running/)).not.toBeInTheDocument();
    expect(screen.getByText(/No Codex response yet/i)).toBeInTheDocument();
  });

  it('supports unknown CLI providers with fallback label and launch filtering', () => {
    render(
      <DesktopConversationView
        {...buildProps({
          aiType: 'deepseek',
          launchCommand: 'deepseek',
          turns: [
            { role: 'user', content: 'deepseek --model r1', ts: 1 },
            { role: 'assistant', content: 'Ready.', ts: 2 }
          ]
        })}
      />
    );

    expect(screen.getByPlaceholderText('Message Deepseek...')).toBeInTheDocument();
    expect(screen.queryByText(/deepseek --model r1/i)).not.toBeInTheDocument();
    expect(screen.getByText('Ready.')).toBeInTheDocument();
  });

  it('shows terminal mirror and suppresses assistant bubbles during interactive mode', () => {
    render(
      <DesktopConversationView
        {...buildProps({
          showTerminalMirror: true,
          terminalScreenSnapshot: 'OpenAI Codex\n> Find and fix a bug',
          turns: [
            { role: 'user', content: 'hey', ts: 1 },
            { role: 'assistant', content: 'noisy wrapped status line', ts: 2 }
          ]
        })}
      />
    );

    expect(screen.getByText('Live terminal mirror')).toBeInTheDocument();
    expect(screen.getByText(/Find and fix a bug/i)).toBeInTheDocument();
    expect(screen.getByText('hey')).toBeInTheDocument();
    expect(screen.queryByText(/noisy wrapped status line/i)).not.toBeInTheDocument();
  });
});
