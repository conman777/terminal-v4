import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { DesktopConversationView } from './DesktopConversationView';

vi.mock('./ToolCallBlock', () => ({
  default: ({ item }) => (
    <div
      data-testid={`tool-call-${item.type}`}
      data-tool={item.tool || ''}
      data-result={item.result ? JSON.stringify(item.result) : ''}
    >
      {item.content || item.result?.toolResult || item.tool || ''}
    </div>
  )
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
    expect(screen.getByText(/line one/)).toBeInTheDocument();
    expect(screen.getByText(/line two/)).toBeInTheDocument();
  });

  it('does not render a live terminal screen snapshot inline by default', () => {
    render(
      <DesktopConversationView
        {...buildProps({
          terminalScreenSnapshot: 'Claude Code v2.1.68\n> bypass permissions'
        })}
      />
    );

    expect(screen.queryByText(/bypass permissions/i)).not.toBeInTheDocument();
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
    expect(screen.getByText('connecting')).toBeInTheDocument();
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

  it('hides Claude dashboard TUI text while terminal prompt mode is active', () => {
    render(
      <DesktopConversationView
        {...buildProps({
          aiType: 'claude',
          showTerminalMirror: true,
          interactivePromptEvent: {
            type: 'prompt_required',
            prompt: 'bypass permissions on (shift+tab to cycle) 1 claude.ai connector needs auth · /mcp',
            actions: ['tab', 'shift_tab']
          },
          turns: [
            {
              role: 'assistant',
              content: [
                '| Recentactivity | WelcomebackConor! | 11hagohey | | /resumeformore |',
                '| Whatsnew | Addedthe /claude-api skillforbuildingapplicationswiththeClaudeAPIandAnth... |',
                '| AddedCtrl+Utoanemptybashprompt(!)toexitbashmode,matchingescapeand... |',
                '| Opus4.6withhigheffort:ClaudeMax | Addednumerickeypadsupportforselectingoptions... |'
              ].join('\n'),
              ts: 1
            }
          ]
        })}
      />
    );

    expect(screen.getByText('input')).toBeInTheDocument();
    expect(screen.queryByText(/Recentactivity/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/WelcomebackConor/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/claude-api/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/ClaudeMax/i)).not.toBeInTheDocument();
  });

  it('extracts the readable Claude reply from mixed status noise', () => {
    render(
      <DesktopConversationView
        {...buildProps({
          aiType: 'claude',
          turns: [
            {
              role: 'assistant',
              content: 'MCP server failed (/mcp). Open Terminal Panel for details. ● Hello! Playwright MCP tools are available if you need browser automation, testing, or screenshots. Opus 4.6 | Ctx: 11% | USD 0.1320 | v2.1.69',
              ts: 1
            }
          ]
        })}
      />
    );

    expect(screen.getByText(/Hello! Playwright MCP tools are available/i)).toBeInTheDocument();
    expect(screen.queryByText(/USD 0\.1320/i)).not.toBeInTheDocument();
  });

  it('filters Claude model usage footer noise from assistant turns', () => {
    render(
      <DesktopConversationView
        {...buildProps({
          aiType: 'claude',
          turns: [
            {
              role: 'assistant',
              content: 'ts\\coding projects\\uplifting | 🪟 Opus 4.6 | 💰 $0.51 session / $0.00 today / $0.00 block (3h 3m left) | 🔥 $0.00/hr | 🧠 58,776 (29%)',
              ts: 1
            }
          ]
        })}
      />
    );

    expect(screen.queryByText(/Opus 4\.6/i)).not.toBeInTheDocument();
    expect(screen.getByText(/No Claude Code response yet/i)).toBeInTheDocument();
  });

  it('hides Codex startup noise turns from the conversation thread', () => {
    render(
      <DesktopConversationView
        {...buildProps({
          aiType: 'codex',
          turns: [
            {
              role: 'assistant',
              content: 'codex --yolo │ model: gpt-5.4 high /model to change │ Tip: New 2x rate limits until April 2nd. • Booting MCP server: playwright (0s • esc to interrupt) gpt-5.4 high · 100% left · ~\\repo',
              ts: 1
            }
          ]
        })}
      />
    );

    expect(screen.queryByText(/OpenAI Codex/i)).not.toBeInTheDocument();
    expect(screen.getByText(/No Codex response yet/i)).toBeInTheDocument();
  });

  it('hides Codex launch command user turns even after prior conversation exists', () => {
    render(
      <DesktopConversationView
        {...buildProps({
          aiType: 'codex',
          turns: [
            { role: 'user', content: 'what do you think of this app?', ts: 1 },
            { role: 'assistant', content: 'It looks promising.', ts: 2 },
            { role: 'user', content: 'codex --yolo', ts: 3 }
          ]
        })}
      />
    );

    expect(screen.getByText(/what do you think of this app/i)).toBeInTheDocument();
    expect(screen.getByText(/It looks promising/i)).toBeInTheDocument();
    expect(screen.queryByText(/^codex --yolo$/i)).not.toBeInTheDocument();
  });

  it('hides Codex update prompt and wrapped launch echo from assistant turns', () => {
    render(
      <DesktopConversationView
        {...buildProps({
          aiType: 'codex',
          turns: [
            {
              role: 'assistant',
              content: [
                'code',
                'x --',
                'yolo',
                '✨ Update available! 0.110.0 -> 0.111.0',
                'Release notes: https://github.com/openai/codex/releases/latest',
                '› 1. Update now (runs `npm install -g @openai/codex`)',
                '2. Skip',
                '3. Skip until next version',
                'Press enter to continue'
              ].join('\n'),
              ts: 1
            }
          ]
        })}
      />
    );

    expect(screen.queryByText(/^code$/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/^x --$/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/^yolo$/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Update available!/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/npm install -g @openai\/codex/i)).not.toBeInTheDocument();
    expect(screen.getByText(/No Codex response yet/i)).toBeInTheDocument();
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

  it('hides slash-command control turns from the conversation thread', () => {
    render(
      <DesktopConversationView
        {...buildProps({
          aiType: 'claude',
          turns: [
            { role: 'user', content: '/model', ts: 1 },
            { role: 'assistant', content: 'Normal response', ts: 2 },
          ]
        })}
      />
    );

    expect(screen.queryByText('/model')).not.toBeInTheDocument();
    expect(screen.getByText('Normal response')).toBeInTheDocument();
  });

  it('hides short chunk-fragment user turns from the conversation thread', () => {
    render(
      <DesktopConversationView
        {...buildProps({
          aiType: 'claude',
          turns: [
            { role: 'user', content: 'el', ts: 1 },
            { role: 'assistant', content: 'Normal response', ts: 2 },
          ]
        })}
      />
    );

    expect(screen.queryByText(/^el$/i)).not.toBeInTheDocument();
    expect(screen.getByText('Normal response')).toBeInTheDocument();
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

  it('keeps the conversation transcript visible during mirror mode', () => {
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

    expect(screen.getByText('hey')).toBeInTheDocument();
    expect(screen.getByText(/Continue anyway\? \[y\/N\]:/i)).toBeInTheDocument();
    expect(screen.queryByText(/Continue anyway\? \[y\/N\]/i, { selector: 'pre' })).not.toBeInTheDocument();
  });

  it('shows the sent Codex user prompt in the normal conversation thread during mirror mode', () => {
    render(
      <DesktopConversationView
        {...buildProps({
          aiType: 'codex',
          showTerminalMirror: true,
          terminalScreenSnapshot: [
            'OpenAI Codex (v0.110.0)',
            '› what do you think of this app',
            'gpt-5.4 medium · 100% left'
          ].join('\n'),
          turns: [
            { role: 'user', content: 'what do you think of this app', ts: 1 }
          ]
        })}
      />
    );

    expect(screen.getByText('what do you think of this app')).toBeInTheDocument();
    expect(screen.queryByText(/what do you think of this app/i, { selector: 'pre' })).not.toBeInTheDocument();
  });

  it('does not switch the main thread into terminal-first layout for mirror state', () => {
    const { container } = render(
      <DesktopConversationView
        {...buildProps({
          showTerminalMirror: true,
          terminalScreenSnapshot: 'Microsoft Windows [Version 10.0.26200.7840]\nC:\\Users\\conor\\repo>\n> Implement {feature}'
        })}
      />
    );

    expect(container.querySelector('.desktop-conversation-view.terminal-first')).toBeNull();
    expect(container.querySelector('.desktop-thread-inner.wide-layout')).toBeNull();
    expect(container.querySelector('.desktop-thread .desktop-cli-focus-screen-block')).toBeNull();
  });

  it('still suppresses noisy assistant terminal chrome while mirror mode is active', () => {
    render(
      <DesktopConversationView
        {...buildProps({
          aiType: 'claude',
          showTerminalMirror: true,
          terminalScreenSnapshot: 'Claude Code v2.1.69\n1 claude.ai connector needs auth · /mcp',
          turns: [
            { role: 'user', content: 'Implement {feature}', ts: 1 },
            { role: 'assistant', content: '| Whatsnew |', ts: 2 }
          ]
        })}
      />
    );

    expect(screen.getByText('Implement {feature}')).toBeInTheDocument();
    expect(screen.queryByText(/\| Whatsnew \|/i)).not.toBeInTheDocument();
  });

  it('uses a prompt notice instead of rendering the full terminal snapshot inline', () => {
    render(
      <DesktopConversationView
        {...buildProps({
          aiType: 'claude',
          showTerminalMirror: true,
          interactivePromptEvent: {
            type: 'prompt_required',
            prompt: 'bypass permissions on (shift+tab to cycle)',
            actions: ['tab', 'shift_tab']
          },
          terminalScreenSnapshot: [
            'Claude Code v2.1.69',
            'Opus 4.6 with high effort · Claude Max',
            '~\\OneDrive\\Personal\\Documents\\coding projects',
            '> bypass permissions on (shift+tab to cycle)',
            '| What\'s new |'
          ].join('\n'),
          turns: [
            { role: 'assistant', content: '| What\'s new |', ts: 1 }
          ]
        })}
      />
    );

    expect(screen.getByText(/bypass permissions on \(shift\+tab to cycle\)/i)).toBeInTheDocument();
    expect(screen.queryByText(/Claude Code v2\.1\.69/i, { selector: 'pre' })).not.toBeInTheDocument();
    expect(screen.queryByText(/What's new/i, { selector: 'pre' })).not.toBeInTheDocument();
  });

  it('renders prompt-mode header with status and working directory', () => {
    render(
      <DesktopConversationView
        {...buildProps({
          aiType: 'claude',
          showTerminalMirror: true,
          interactivePromptEvent: {
            type: 'prompt_required',
            prompt: 'bypass permissions on (shift+tab to cycle)',
            actions: ['tab', 'shift_tab']
          },
          terminalScreenSnapshot: [
            'Claude Code v2.1.69',
            'Opus 4.6 with high effort · Claude Max',
            '~\\OneDrive\\Personal\\Documents\\coding projects',
            '> bypass permissions on (shift+tab to cycle)'
          ].join('\n')
        })}
      />
    );

    expect(screen.getByText('input')).toBeInTheDocument();
    expect(screen.getByText('Claude Code')).toBeInTheDocument();
    expect(screen.getAllByText(/~\\OneDrive\\Personal\\Documents\\coding projects/i).length).toBeGreaterThan(0);
  });

  it('does not render a live terminal snapshot section during prompt mode', () => {
    render(
      <DesktopConversationView
        {...buildProps({
          aiType: 'claude',
          showTerminalMirror: true,
          interactivePromptEvent: {
            type: 'prompt_required',
            prompt: 'bypass permissions on (shift+tab to cycle)',
            actions: ['tab', 'shift_tab']
          },
          terminalScreenSnapshot: [
            'Claude Code v2.1.69',
            '~\\OneDrive\\Personal\\Documents\\coding projects',
            '> bypass permissions on (shift+tab to cycle)'
          ].join('\n')
        })}
      />
    );

    expect(screen.queryByText(/bypass permissions/i, { selector: 'pre' })).not.toBeInTheDocument();
  });

  it('does not render the Claude startup snapshot inline in mirror mode', () => {
    render(
      <DesktopConversationView
        {...buildProps({
          aiType: 'claude',
          showTerminalMirror: true,
          terminalScreenSnapshot: 'Claude Code v2.1.69\nOpus 4.6 with high effort · Claude Max\n1 claude.ai connector needs auth · /mcp'
        })}
      />
    );

    expect(screen.queryByText(/claude\.ai connector needs auth/i, { selector: 'pre' })).not.toBeInTheDocument();
    expect(screen.queryByText(/Claude Code v2\.1\.69/i, { selector: 'pre' })).not.toBeInTheDocument();
  });

  it('does not render the Codex startup snapshot inline in mirror mode', () => {
    render(
      <DesktopConversationView
        {...buildProps({
          aiType: 'codex',
          showTerminalMirror: true,
          terminalScreenSnapshot: 'OpenAI Codex (v0.110.0)\nTip: New 2x rate limits until April 2nd.\nBooting MCP server: playwright'
        })}
      />
    );

    expect(screen.queryByText(/Booting MCP server: playwright/i, { selector: 'pre' })).not.toBeInTheDocument();
    expect(screen.queryByText(/OpenAI Codex/i, { selector: 'pre' })).not.toBeInTheDocument();
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

  it('renders inline prompt actions when prompt metadata arrives before the snapshot', () => {
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

    expect(screen.getByText(/Continue anyway\? \[y\/N\]:/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Yes' }));
    expect(onSendRaw).toHaveBeenCalledWith('y\r');
  });

  it('renders numeric prompt actions from terminal snapshot in the main pane', () => {
    const onSendRaw = vi.fn();
    render(
      <DesktopConversationView
        {...buildProps({
          aiType: 'codex',
          onSendRaw,
          terminalScreenSnapshot: [
            '✨ Update available! 0.110.0 -> 0.111.0',
            'Release notes: https://github.com/openai/codex/releases/latest',
            '› 1. Update now (runs `npm install -g @openai/codex`)',
            '2. Skip',
            '3. Skip until next version',
            'Press enter to continue'
          ].join('\n')
        })}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: /2\. Skip$/i }));
    expect(onSendRaw).toHaveBeenCalledWith('\x1b[B\r');
    expect(screen.getByRole('button', { name: /1\. Update now/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /3\. Skip until next version/i })).toBeInTheDocument();
  });

  it('renders structured tool results with the tool result payload shape', () => {
    render(
      <DesktopConversationView
        {...buildProps({
          mode: 'structured',
          structuredMessages: [
            { role: 'assistant', content: 'Working on it', ts: 1 },
            { role: 'tool', toolName: 'bash', toolInput: { cmd: 'pwd' }, result: 'C:/repo', isError: false, ts: 2 }
          ]
        })}
      />
    );

    expect(screen.getByText('Working on it')).toBeInTheDocument();
    const tool = screen.getByTestId('tool-call-tool_use');
    expect(tool.dataset.tool).toBe('bash');
    expect(tool.dataset.result).toContain('"toolResult":"C:/repo"');
    expect(tool.dataset.result).toContain('"isError":false');
    expect(tool).toHaveTextContent('C:/repo');
  });

  it('shows a startup prompt for empty structured sessions', () => {
    render(
      <DesktopConversationView
        {...buildProps({
          mode: 'structured',
          structuredMessages: [],
          structuredToolCalls: [],
          pendingApproval: null
        })}
      />
    );

    expect(screen.getByText(/Send a message to start this Codex session/i)).toBeInTheDocument();
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
