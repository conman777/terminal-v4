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
    onSendRaw: vi.fn(),
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

  it('shows compact interactive control card during mirror mode', () => {
    render(
      <DesktopConversationView
        {...buildProps({
          showTerminalMirror: true,
          terminalScreenSnapshot: 'Continue anyway? [y/N]:',
          turns: [
            { role: 'user', content: 'hey', ts: 1 },
            { role: 'assistant', content: 'noisy wrapped status line', ts: 2 }
          ]
        })}
      />
    );

    expect(screen.getByText('Interactive CLI input required')).toBeInTheDocument();
    expect(screen.getByText(/Continue anyway\? \[y\/N\]/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Open Terminal Panel' })).toBeInTheDocument();
    expect(screen.getByText('hey')).toBeInTheDocument();
  });

  it('shows compact session-active card for non-interactive terminal states', () => {
    render(
      <DesktopConversationView
        {...buildProps({
          showTerminalMirror: true,
          terminalScreenSnapshot: 'Microsoft Windows [Version 10.0.26200.7840]\nC:\\Users\\conor\\repo>'
        })}
      />
    );

    expect(screen.getByText('CLI session active')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Open Terminal Panel' })).toBeInTheDocument();
    expect(screen.getByText(/Latest terminal line:/i)).toBeInTheDocument();
  });

  it('forwards keyboard controls to raw terminal input in mirror mode', () => {
    const onSendRaw = vi.fn();
    render(
      <DesktopConversationView
        {...buildProps({
          showTerminalMirror: true,
          onSendRaw,
          terminalScreenSnapshot: 'Continue anyway? [y/N]'
        })}
      />
    );

    fireEvent.keyDown(window, { key: 'ArrowDown', code: 'ArrowDown' });
    fireEvent.keyDown(window, { key: 'Enter', code: 'Enter' });
    fireEvent.keyDown(window, { key: 'y', code: 'KeyY' });

    expect(onSendRaw.mock.calls).toEqual([
      ['\x1b[B'],
      ['\r'],
      ['y']
    ]);
  });

  it('sends prompt action buttons as raw terminal input', () => {
    const onSendRaw = vi.fn();
    render(
      <DesktopConversationView
        {...buildProps({
          showTerminalMirror: true,
          onSendRaw,
          terminalScreenSnapshot: 'Continue anyway? [y/N]:'
        })}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Yes' }));
    fireEvent.click(screen.getByRole('button', { name: 'No' }));

    expect(onSendRaw.mock.calls).toEqual([
      ['y\r'],
      ['n\r']
    ]);
  });

  it('renders structured prompt_required events from canonical cli metadata', () => {
    const onSendRaw = vi.fn();
    render(
      <DesktopConversationView
        {...buildProps({
          showTerminalMirror: true,
          onSendRaw,
          interactivePromptEvent: {
            type: 'prompt_required',
            prompt: 'Continue anyway? [y/N]:',
            actions: ['yes', 'no', 'enter']
          }
        })}
      />
    );

    expect(screen.getByText(/Continue anyway\? \[y\/N\]/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Yes' }));
    expect(onSendRaw).toHaveBeenCalledWith('y\r');
  });

  it('routes composer key presses to raw input while mirror mode is active', () => {
    const onSendRaw = vi.fn();
    const onSend = vi.fn();
    render(
      <DesktopConversationView
        {...buildProps({
          showTerminalMirror: true,
          onSend,
          onSendRaw,
          terminalScreenSnapshot: 'Continue anyway? [y/N]'
        })}
      />
    );

    const input = screen.getByPlaceholderText('Message Codex...');
    fireEvent.keyDown(input, { key: 'y', code: 'KeyY' });
    fireEvent.keyDown(input, { key: 'Enter', code: 'Enter' });

    expect(onSendRaw.mock.calls).toEqual([
      ['y'],
      ['\r']
    ]);
    expect(onSend).not.toHaveBeenCalled();
  });

  it('captures global key presses in mirror mode even without mirror focus', () => {
    const onSendRaw = vi.fn();
    render(
      <DesktopConversationView
        {...buildProps({
          showTerminalMirror: true,
          onSendRaw,
          terminalScreenSnapshot: 'Continue anyway? [y/N]'
        })}
      />
    );

    fireEvent.keyDown(window, { key: 'y', code: 'KeyY' });
    fireEvent.keyDown(window, { key: 'Enter', code: 'Enter' });

    expect(onSendRaw.mock.calls).toEqual([
      ['y'],
      ['\r']
    ]);
  });
});
