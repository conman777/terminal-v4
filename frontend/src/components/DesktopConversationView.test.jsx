import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { DesktopConversationView } from './DesktopConversationView';
import { WorkspacePanel } from './WorkspacePanel';

vi.mock('./ToolCallBlock', async (importOriginal) => ({
  ...(await importOriginal()),
  default: ({ item }) => (
    <div
      data-testid={`tool-call-${item.type}`}
      data-tool={item.tool || ''}
      data-result={item.result ? JSON.stringify(item.result) : ''}
    >
      {item.content || item.result?.toolResult || item.tool || ''}
      {item.actions?.map(action => <button key={action.label} type="button" onClick={action.onClick}>{action.label}</button>)}
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
  it('identifies rendered structured messages and folded message candidates by exact identity', () => {
    const id = 'message" ] [data-other="danger';
    const { container } = render(<DesktopConversationView {...buildProps({ mode: 'structured', structuredMessages: [
      { role: 'user', messageId: 'prompt', content: 'Prompt', ts: 1 },
      { role: 'assistant', messageId: id, content: 'Intermediate answer', ts: 2 },
      { role: 'tool', toolCallId: 'tool', toolName: 'read', result: 'Read', ts: 3 },
      { role: 'assistant', messageId: 'final', content: 'Final answer', ts: 4 },
    ] })} />);
    expect([...container.querySelectorAll('[data-message-id]')].map(node => [node.dataset.messageId, node.dataset.messageRole])).toEqual([
      ['prompt', 'user'], ['final', 'assistant'],
    ]);
    const candidate = [...container.querySelectorAll('[data-folded-message-id]')].find(node => node.dataset.foldedMessageId === id);
    expect(candidate?.dataset.foldedMessageRole).toBe('assistant');
    fireEvent.click(candidate.parentElement.querySelector('button'));
    expect([...container.querySelectorAll('[data-message-id]')].map(node => node.dataset.messageId)).toContain(id);
  });

  it('announces history loading without a duplicate startup message', () => {
    render(<DesktopConversationView {...buildProps({ mode: 'structured', isLoadingHistory: true })} />);
    expect(screen.getByRole('status')).toHaveTextContent('Loading conversation history');
    expect(screen.queryByText(/Send a message to start/)).not.toBeInTheDocument();
  });

  it('explains unavailable approval actions while preserving the request and disabled controls', () => {
    render(<DesktopConversationView {...buildProps({ mode: 'structured', onApprove: null, pendingApproval: { description: 'Allow reading the selected file?', toolInput: { path: '/work/selected.txt' } } })} />);
    expect(screen.getByRole('group', { name: 'Approval required' })).toHaveTextContent('Allow reading the selected file?');
    expect(screen.getByText('Approval actions are unavailable in this view.')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Approve' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Reject' })).toBeDisabled();
  });
  it('groups consecutive activity without hiding the intervening assistant response', () => {
    render(<DesktopConversationView {...buildProps({ mode: 'structured', structuredMessages: [
      { role: 'tool', toolCallId: 'one', toolName: 'read', result: 'First file' },
      { role: 'tool', toolCallId: 'two', toolName: 'read', result: 'Second file' },
      { role: 'assistant', messageId: 'progress', content: 'I found the relevant code.' },
      { role: 'tool', toolCallId: 'three', toolName: 'test', result: 'Tests passed' },
    ] })} />);
    expect(screen.getByText('Read 2 files')).toBeVisible();
    expect(screen.getByText('I found the relevant code.')).toBeVisible();
    expect(screen.getByText('Tests passed')).toBeVisible();
    expect(screen.queryByText('First file')).not.toBeInTheDocument();
  });

  it.each([
    ['cancelled', 'Stopped — partial response'],
    ['interrupted', 'Stopped — partial response'],
    ['failed', 'Failed — partial response'],
    ['unconfirmed', 'Completion not confirmed — partial response'],
    ['streaming', 'Partial response'],
  ])('labels %s structured output without marking validated output as partial', (completionStatus, label) => {
    render(<DesktopConversationView {...buildProps({ mode: 'structured', structuredMessages: [
      { role: 'assistant', messageId: 'complete', content: 'Validated answer', completionStatus: 'completed' },
      { role: 'assistant', messageId: 'partial', content: 'Tentative answer', completionStatus },
    ] })} />);
    expect(screen.getByText('Validated answer')).toBeInTheDocument();
    expect(screen.getByText('Tentative answer')).toBeInTheDocument();
    expect(screen.getByText(label)).toBeInTheDocument();
    expect(screen.getAllByText(label)).toHaveLength(1);
  });
  it('renders AI-specific provider label in header', () => {
    render(<DesktopConversationView {...buildProps()} />);
    expect(screen.getByText('Codex')).toBeInTheDocument();
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

  it('groups long raw terminal transcript turns as activity', () => {
    const transcriptDump = Array.from({ length: 34 }, (_, index) => (
      `Ran npm test ${index} lines (ctrl + t to view transcript)`
    )).join('\n');

    render(
      <DesktopConversationView
        {...buildProps({
          turns: [
            { role: 'user', content: 'audit this app', ts: 1 },
            { role: 'assistant', content: transcriptDump, ts: 2 }
          ]
        })}
      />
    );

    expect(screen.getByText('audit this app')).toBeInTheDocument();
    expect(screen.getByTestId('tool-call-assistant_activity')).toBeInTheDocument();
  });

  it('renders terminal activity in the right activity window instead of the main thread', () => {
    const transcriptDump = Array.from({ length: 34 }, (_, index) => (
      `Ran npm test ${index} lines (ctrl + t to view transcript)`
    )).join('\n');

    const { container } = render(
      <DesktopConversationView
        {...buildProps({
          turns: [
            { role: 'user', content: 'audit this app', ts: 1 },
            { role: 'assistant', content: transcriptDump, ts: 2 }
          ]
        })}
      />
    );

    const activityWindow = container.querySelector('.desktop-activity-window');
    const mainThread = container.querySelector('.desktop-thread');
    const activityBlock = screen.getByTestId('tool-call-assistant_activity');

    expect(activityWindow).toBeInTheDocument();
    expect(activityWindow).toContainElement(activityBlock);
    expect(mainThread).not.toContainElement(activityBlock);
  });

  it('lifts the latest readable reply out of raw terminal transcript turns', () => {
    const transcriptDump = [
      ...Array.from({ length: 28 }, (_, index) => (
        `Ran npm test ${index} lines (ctrl + t to view transcript)`
      )),
      'Found it. The desktop composer was using stale state when Enter was pressed.',
      'I fixed the submit path so it reads the textarea value directly.'
    ].join('\n');

    render(
      <DesktopConversationView
        {...buildProps({
          turns: [
            { role: 'user', content: 'why does enter need two presses', ts: 1 },
            { role: 'assistant', content: transcriptDump, ts: 2 }
          ]
        })}
      />
    );

    expect(screen.getByTestId('tool-call-assistant')).toHaveTextContent(/stale state when Enter was pressed/i);
    expect(screen.getByTestId('tool-call-assistant_activity')).toBeInTheDocument();
  });

  it('lifts a readable reply from an initial Codex raw history dump', () => {
    const transcriptDump = [
      'OpenAI Codex (v0.110.0)',
      'gpt-5.5 xhigh · 100% left · ~/terminal-v4',
      ...Array.from({ length: 28 }, (_, index) => (
        `Ran rg mobile ${index} lines (ctrl + t to view transcript)`
      )),
      'I found the mobile issue. The segmented control was not sending the selected mode.',
      'I changed the handler so Raw Terminal and Codex UI switch cleanly.',
      'https://127.0.0.1:3020/api/client-build {"buildId":"/assets/index-BDqSkRlS.js"}',
      '/assets/index-BRRr3cFl.js /assets/index-3_XlP7SM.css',
      '… +1 linesndex-[A-Za-z0-9_-]+\\.(js|css)',
      '(no output)/bin/systemctl restart activeemctl is-active terminal-v4.service',
      '200 expect(screen.queryByText(/Ran npm test/i)).not.toBeInTheDocument();'
    ].join('\n');

    render(
      <DesktopConversationView
        {...buildProps({
          turns: [
            { role: 'assistant', content: transcriptDump, ts: 1 }
          ]
        })}
      />
    );

    expect(screen.getByTestId('tool-call-assistant')).toHaveTextContent(/segmented control was not sending/i);
    expect(screen.getByTestId('tool-call-assistant_activity')).toBeInTheDocument();
  });

  it('does not lift patch/source-code fragments as the latest Codex reply', () => {
    const transcriptDump = [
      ...Array.from({ length: 28 }, (_, index) => (
        `Ran npm test ${index} lines (ctrl + t to view transcript)`
      )),
      'I found the broken Codex card. The live pane backfill was showing terminal output instead of the reply.',
      'The fix keeps terminal activity out of the main conversation.',
      '377 +    if (hasCodexCompletionBoundary(stripped)) {',
      '488    flush();',
      '489 +  if (turns.length === 0 && hasCodexSessionEvidence(stripped)) {',
      '490 +    const content = extractContent(combined);'
    ].join('\n');

    render(
      <DesktopConversationView
        {...buildProps({
          turns: [
            { role: 'user', content: 'why does the codex ui look broken', ts: 1 },
            { role: 'assistant', content: transcriptDump, ts: 2 }
          ]
        })}
      />
    );

    expect(screen.getByTestId('tool-call-assistant')).toHaveTextContent(/broken Codex card/i);
    expect(screen.getByTestId('tool-call-assistant')).not.toHaveTextContent(/extractContent\(combined\)/i);
    expect(screen.getByTestId('tool-call-assistant_activity')).toBeInTheDocument();
  });

  it('collapses repeated raw transcript dumps into one visible reply and one activity card', () => {
    const buildTranscriptDump = (extraLine) => [
      ...Array.from({ length: 28 }, (_, index) => (
        `Ran npm test ${index} lines (ctrl + t to view transcript)`
      )),
      'Mobile smoke test confirmed Codex UI -> Raw Terminal -> Codex UI buttons work.',
      extraLine
    ].join('\n');

    render(
      <DesktopConversationView
        {...buildProps({
          turns: [
            { role: 'user', content: 'show me the current mobile state', ts: 1 },
            { role: 'assistant', content: buildTranscriptDump('Read file one'), ts: 2 },
            { role: 'assistant', content: buildTranscriptDump('Read file two'), ts: 3 },
            { role: 'assistant', content: buildTranscriptDump('Read file three'), ts: 4 },
          ]
        })}
      />
    );

    expect(screen.getAllByTestId('tool-call-assistant')).toHaveLength(1);
    expect(screen.getByTestId('tool-call-assistant')).toHaveTextContent(/Mobile smoke test confirmed Codex UI/i);
    expect(screen.getAllByTestId('tool-call-assistant_activity')).toHaveLength(1);
  });

  it('hides wrapped terminal echo fragments that match the latest sent prompt', () => {
    const prompt = '~/screenshots/screenshot-2026-05-28T08-01-46.png thats what i see at the moment';

    render(
      <DesktopConversationView
        {...buildProps({
          turns: [
            { role: 'user', content: prompt, ts: 1 },
            { role: 'assistant', content: '~/sc', ts: 2 },
            { role: 'assistant', content: 'reen', ts: 3 },
            { role: 'assistant', content: 'shot', ts: 4 },
            { role: 'assistant', content: '-202', ts: 5 },
            { role: 'assistant', content: '08-0', ts: 6 },
            { role: 'assistant', content: 'tha', ts: 7 },
            { role: 'assistant', content: 'mom', ts: 8 },
            { role: 'assistant', content: 'I see the screenshot. The prompt echo should not appear in the thread.', ts: 9 }
          ]
        })}
      />
    );

    expect(screen.getByText(prompt)).toBeInTheDocument();
    expect(screen.getByText(/prompt echo should not appear/i)).toBeInTheDocument();
    expect(screen.queryByText('~/sc')).not.toBeInTheDocument();
    expect(screen.queryByText('reen')).not.toBeInTheDocument();
    expect(screen.queryByText('tha')).not.toBeInTheDocument();
  });

  it('shows the latest reply fallback when the only parsed turn is terminal activity', () => {
    const transcriptDump = Array.from({ length: 34 }, (_, index) => (
      `Ran npm test ${index} lines (ctrl + t to view transcript)`
    )).join('\n');

    render(
      <DesktopConversationView
        {...buildProps({
          terminalPreview: [
            'Ran npm test',
            'I found the display issue. Activity-only history was hiding the latest assistant reply.',
            'The fix keeps the readable response visible above the terminal activity.'
          ].join('\n'),
          turns: [
            { role: 'assistant', content: transcriptDump, ts: 1 }
          ]
        })}
      />
    );

    expect(screen.getByText('Latest reply')).toBeInTheDocument();
    expect(screen.getByText(/Activity-only history was hiding/i)).toBeInTheDocument();
    expect(screen.getByTestId('tool-call-assistant_activity')).toBeInTheDocument();
  });

  it('preserves the full Codex final answer block from tmux transcript history', () => {
    const transcriptDump = [
      ...Array.from({ length: 32 }, (_, index) => (
        `Ran npm test ${index} lines (ctrl + t to view transcript)`
      )),
      'm patching the detector to record the submitted prompt before filtering terminal echo, and adding UI guards for already-stored bad history.',
      '• I fixed what your screenshots showed.›Use /skills to list available skillsgpt-5.5 xhigh · ~/terminal-v4Goal achieved (11m)',
      '  The bugs were:',
      '  - Repeated raw transcript chunks were being',
      '    rendered as repeated assistant replies',
      '    plus repeated “Terminal activity” cards.',
      '  - Wrapped terminal echo from your prompt',
      '    was being misread as assistant text,',
      '    which is why you saw fragments like ~/sc,',
      '    reen, shot, tha, mom.',
      '  - If only terminal activity was parsed, the',
      '    UI could hide the latest readable reply.',
      '  Now the Codex UI collapses repeated',
      '  transcript dumps, filters wrapped prompt',
      '  echoes, keeps one activity summary, and',
      '  still shows the latest readable response',
      '  when activity is the only parsed turn.',
      '  Verified:',
      '  - Frontend tests: 102 passed',
      '  - Backend turn-detector tests: 11 passed',
      '  - Build passed',
      '  - Service restarted and healthy',
      '  - Live bundle: /assets/index-D-BdO7u4.js',
      '  - Mobile smoke test: one assistant block,',
      '    one activity card, no wrapped fragments',
      '  Committed and pushed:',
      '  18425f3 Clean Codex transcript rendering',
      '─ Worked for 8m 52s ─────────────────────────',
      '• I fixed what your screenshots showed.',
      '  The bugs were:',
      '  - Repeated raw transcript chunks were being rendered as repeated assistant',
      '  cards.lies plus repeated “Terminal activity”',
      '  Verified:',
      '  - Frontend tests: 102 passed',
      '  Committed and pushed:',
      '  18425f3 Clean Codex transcript rendering',
      '─ Worked for 8m 52s ─────────────────────────',
      'Edited frontend/src/components/DesktopConversationView.jsx (+55 -3)'
    ].join('\n');

    render(
      <DesktopConversationView
        {...buildProps({
          turns: [
            { role: 'assistant', content: transcriptDump, ts: 1 },
            { role: 'user', content: '= 2);', ts: 2 }
          ]
        })}
      />
    );

    const assistant = screen.getByTestId('tool-call-assistant');
    expect(assistant).toHaveTextContent(/I fixed what your screenshots showed/i);
    expect(assistant).toHaveTextContent(/The bugs were:/i);
    expect(assistant).toHaveTextContent(/Frontend tests:\s*102 passed/i);
    expect(assistant).toHaveTextContent(/Backend turn-detector tests:\s*11 passed/i);
    expect(assistant).toHaveTextContent(/18425f3 Clean Codex transcript rendering/i);
    expect(assistant).not.toHaveTextContent(/before filtering terminal echo/i);
    expect(assistant).not.toHaveTextContent(/cards\.lies/i);
    expect(assistant.textContent).toMatch(/no wrapped fragments\nCommitted and pushed:/i);
    expect(screen.queryByTestId('tool-call-user')).not.toBeInTheDocument();
    expect(screen.getByTestId('tool-call-assistant_activity')).toBeInTheDocument();
  });

  it('repairs tmux-overwritten words inside a Codex final answer block', () => {
    const transcriptDump = [
      ...Array.from({ length: 28 }, (_, index) => (
        `Ran npm test ${index} lines (ctrl + t to view transcript)`
      )),
      '• I fixed what your screenshots showed.',
      '  The bugs were:',
      '  - Repeated raw transcript chunks were being rendered as repeated assistant',
      '  cards.lies plus repeated “Terminal activity”',
      '  Verified:',
      '  - Frontend tests: 102 passed',
    ].join('\n');

    render(
      <DesktopConversationView
        {...buildProps({
          turns: [
            { role: 'assistant', content: transcriptDump, ts: 1 }
          ]
        })}
      />
    );

    const assistant = screen.getByTestId('tool-call-assistant');
    expect(assistant).toHaveTextContent(/repeated assistant replies plus repeated/i);
    expect(assistant).toHaveTextContent(/Terminal activity.*cards/i);
    expect(assistant).not.toHaveTextContent(/cards\.lies/i);
  });

  it('does not render an inline composer (V4 status bar composer is the single input)', () => {
    render(<DesktopConversationView {...buildProps()} />);
    expect(screen.queryByPlaceholderText(/Message/i)).not.toBeInTheDocument();
  });

  it('shows launch action and calls handler', () => {
    const onLaunchAgent = vi.fn();
    render(<DesktopConversationView {...buildProps({ onLaunchAgent, aiType: 'claude', launchCommand: 'claude' })} />);

    fireEvent.click(screen.getByRole('button', { name: 'Launch Claude Code' }));
    expect(onLaunchAgent).toHaveBeenCalledTimes(1);
  });

  it('keeps raw terminal preview output out of the agent startup card', () => {
    render(<DesktopConversationView {...buildProps({ terminalPreview: 'line one\nline two' })} />);
    expect(screen.queryByText(/line one/)).not.toBeInTheDocument();
    expect(screen.queryByText(/line two/)).not.toBeInTheDocument();
  });

  it('shows a cleaned latest reply from live terminal output while waiting for turns', () => {
    render(
      <DesktopConversationView
        {...buildProps({
          aiType: 'codex',
          launchCommand: '',
          terminalPreview: [
            '• Ran npm test',
            '  └ passed',
            "name: 'TimeoutError'",
            'Working(10m 46s esc to interrupt) · Use /skills to list available skills · gpt-5.5 xhigh · Goal achieved (11m)',
            'I found the mobile control issue. The mode toggle was not passing its selected target.',
            'The fix makes the status bar switch into raw terminal correctly.',
            '─ Worked for 2m 02s ─'
          ].join('\n')
        })}
      />
    );

    expect(screen.getByText('Latest reply')).toBeInTheDocument();
    expect(screen.getByText(/mode toggle was not passing/i)).toBeInTheDocument();
    expect(screen.queryByText(/Ran npm test/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/TimeoutError/i)).not.toBeInTheDocument();
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

  it('shows a known API provider label and launch filtering', () => {
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

    expect(screen.getByText('DeepSeek')).toBeInTheDocument();
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

  it('renders a live Claude session summary card and keeps prompt issues separate from the prompt text', () => {
    render(
      <DesktopConversationView
        {...buildProps({
          aiType: 'claude',
          showTerminalMirror: true,
          interactivePromptEvent: {
            type: 'prompt_required',
            prompt: 'bypass permissions on (shift+tab to cycle) 1 MCP server failed /mcp',
            actions: ['tab', 'shift_tab']
          },
          terminalScreenSnapshot: [
            'Claude Code v2.1.109',
            'Opus 4.6 (1M context) with high effort · Claude Max',
            'C:\\Users\\conor',
            '> bypass permissions on (shift+tab to cycle)'
          ].join('\n')
        })}
      />
    );

    expect(screen.getByText('Claude Code v2.1.109')).toBeInTheDocument();
    expect(screen.getByText(/Opus 4\.6 \(1M context\) with high effort/i)).toBeInTheDocument();
    expect(screen.getAllByText(/C:\\Users\\conor/i).length).toBeGreaterThan(0);
    expect(screen.getByText('MCP server failed /mcp')).toBeInTheDocument();
    expect(screen.getByText(/^bypass permissions on \(shift\+tab to cycle\)$/i)).toBeInTheDocument();
    expect(screen.queryByText(/bypass permissions on \(shift\+tab to cycle\) 1 MCP server failed \/mcp/i)).not.toBeInTheDocument();
  });

  it('hides duplicated preview output when the live terminal is docked for an interactive prompt', () => {
    render(
      <DesktopConversationView
        {...buildProps({
          aiType: 'claude',
          showTerminalMirror: true,
          isTerminalDockVisible: true,
          terminalPreview: [
            'C:\\Users\\conor',
            'bypass permissions on (shift+tab to cycle)'
          ].join('\n'),
          interactivePromptEvent: {
            type: 'prompt_required',
            prompt: 'bypass permissions on (shift+tab to cycle)',
            actions: ['tab', 'shift_tab']
          },
          terminalScreenSnapshot: [
            'Claude Code v2.1.109',
            'Opus 4.6 (1M context) with high effort · Claude Max',
            'C:\\Users\\conor',
            '> bypass permissions on (shift+tab to cycle)'
          ].join('\n')
        })}
      />
    );

    expect(screen.getByText(/Live terminal prompt is docked below/i)).toBeInTheDocument();
    expect(screen.queryByText(/^C:\\Users\\conor$/i, { selector: 'pre' })).not.toBeInTheDocument();
    expect(screen.queryByText(/^bypass permissions on \(shift\+tab to cycle\)$/i, { selector: 'pre' })).not.toBeInTheDocument();
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
          allowPromptKeyboardCapture: true,
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

  it('keeps browser and modal keys out of a background interactive terminal prompt', () => {
    const onSendRaw = vi.fn();
    const { rerender } = render(<>
      <DesktopConversationView {...buildProps({ allowPromptKeyboardCapture: true, showTerminalMirror: true, onSendRaw, terminalScreenSnapshot: 'Continue anyway? [y/N]' })} />
      <div className="workspace-browser" data-testid="browser-surface" />
    </>);
    fireEvent.keyDown(screen.getByTestId('browser-surface'), { key: 'y', code: 'KeyY' });
    rerender(<>
      <DesktopConversationView {...buildProps({ allowPromptKeyboardCapture: true, showTerminalMirror: true, onSendRaw, terminalScreenSnapshot: 'Continue anyway? [y/N]' })} />
      <div role="dialog" aria-modal="true">Browser panel</div>
    </>);
    fireEvent.keyDown(document.body, { key: 'Enter', code: 'Enter' });
    expect(onSendRaw).not.toHaveBeenCalled();
  });

  it.each(['preview-panel', 'preview-panel-mobile'])('keeps Console log scrolling in %s separate from background terminal input', surface => {
    const onSendRaw = vi.fn(), scrollKey = vi.fn();
    render(<>
      <DesktopConversationView {...buildProps({ allowPromptKeyboardCapture: true, showTerminalMirror: true, onSendRaw, terminalScreenSnapshot: 'Continue anyway? [y/N]' })} />
      <section className={surface}><div role="log" tabIndex={0} aria-label="Console log" onKeyDown={scrollKey} /></section>
    </>);
    fireEvent.keyDown(screen.getByRole('log', { name: 'Console log' }), { key: 'ArrowDown', code: 'ArrowDown' });
    expect(onSendRaw).not.toHaveBeenCalled();
    expect(scrollKey).toHaveBeenCalledOnce();
    expect(scrollKey.mock.calls[0][0].defaultPrevented).toBe(false);
  });

  it('lets browser resize handles receive arrows without forwarding to a raw terminal prompt', () => {
    const onSendRaw = vi.fn(), resize = vi.fn();
    render(<>
      <DesktopConversationView {...buildProps({ allowPromptKeyboardCapture: true, showTerminalMirror: true, onSendRaw, terminalScreenSnapshot: 'Continue anyway? [y/N]' })} />
      <div className="workspace-panel-tools"><div role="separator" tabIndex={0} aria-label="Resize browser panel" onKeyDown={resize} /></div>
    </>);
    fireEvent.keyDown(screen.getByRole('separator', { name: 'Resize browser panel' }), { key: 'ArrowLeft', code: 'ArrowLeft' });
    expect(onSendRaw).not.toHaveBeenCalled();
    expect(resize).toHaveBeenCalledOnce();
    expect(resize.mock.calls[0][0].defaultPrevented).toBe(false);
  });

  it('resizes navigation without forwarding arrows to an interactive terminal prompt', () => {
    localStorage.removeItem('terminal-workspace-navigation-width');
    const onSendRaw = vi.fn();
    render(<>
      <DesktopConversationView {...buildProps({ allowPromptKeyboardCapture: true, showTerminalMirror: true, onSendRaw, terminalScreenSnapshot: 'Continue anyway? [y/N]' })} />
      <WorkspacePanel kind="navigation"><span>Navigation</span></WorkspacePanel>
    </>);
    const handle = screen.getByRole('separator', { name: 'Resize navigation' });
    expect(handle).toHaveAttribute('aria-valuenow', '256');
    fireEvent.keyDown(handle, { key: 'ArrowRight', code: 'ArrowRight' });
    expect({ sent: onSendRaw.mock.calls, width: handle.getAttribute('aria-valuenow') }).toEqual({ sent: [], width: '280' });
    localStorage.removeItem('terminal-workspace-navigation-width');
  });

  it.each(['button', 'select', 'summary', 'a'])('preserves keyboard activation of workspace %s controls during a terminal prompt', tag => {
    const onSendRaw = vi.fn();
    render(<DesktopConversationView {...buildProps({ allowPromptKeyboardCapture: true, showTerminalMirror: true, onSendRaw, terminalScreenSnapshot: 'Continue anyway? [y/N]' })} />);
    const control = document.createElement(tag);
    if (tag === 'a') control.setAttribute('href', '#workspace');
    document.body.append(control);
    const event = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
    control.dispatchEvent(event);
    expect({ sent: onSendRaw.mock.calls, prevented: event.defaultPrevented }).toEqual({ sent: [], prevented: false });
    control.remove();
  });

  it('does not forward raw keyboard controls in mirror mode when direct terminal typing is disabled', () => {
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

    expect(onSendRaw).not.toHaveBeenCalled();
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
          allowPromptKeyboardCapture: true,
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


it('retains a structured approval card while submitting and binds a click to the displayed action', () => {
  const pendingApproval = { seq: 7, toolName: 'Bash', toolInput: { command: 'echo fixture' }, description: 'Run fixture?' };
  const onApprove = vi.fn();
  const { rerender } = render(<DesktopConversationView {...buildProps({ mode: 'structured', pendingApproval, onApprove, isApproving: true })} />);
  expect(screen.getByText('Run fixture?')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Approve' })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Reject' })).toBeDisabled();
  rerender(<DesktopConversationView {...buildProps({ mode: 'structured', pendingApproval, onApprove, actionError: 'Approval not accepted.' })} />);
  expect(screen.getByRole('alert')).toHaveTextContent('Approval not accepted.');
  fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
  expect(onApprove).toHaveBeenCalledWith(true, pendingApproval);
});

it('preserves a structured tool card DOM identity when earlier replayed messages are inserted', () => {
  const tool = { role: 'tool', toolName: 'run_command', toolCallId: 'owned-tool-id', turnId: 'owned-turn-id', result: 'Fixture complete', ts: 20 };
  const { rerender } = render(<DesktopConversationView {...buildProps({ mode: 'structured', structuredMessages: [tool] })} />);
  const card = screen.getByTestId('tool-call-tool_use');
  rerender(<DesktopConversationView {...buildProps({ mode: 'structured', structuredMessages: [{ role: 'user', messageId: 'earlier-user-id', content: 'Earlier replay', ts: 10 }, tool] })} />);
  expect(screen.getByTestId('tool-call-tool_use')).toBe(card);
});


it('offers a structured Stop control and disables decisions while cancellation is pending', () => {
  const onInterrupt = vi.fn(), pendingApproval = { approvalId: 'approval-stop', description: 'Keep this pending action', toolName: 'fixture' };
  const props = buildProps({ mode: 'structured', isStreaming: true, onInterrupt, pendingApproval, onApprove: vi.fn() });
  const { rerender } = render(<DesktopConversationView {...props} />);
  fireEvent.click(screen.getByRole('button', { name: 'Stop response' }));
  expect(onInterrupt).toHaveBeenCalledTimes(1);
  rerender(<DesktopConversationView {...props} isInterrupting={true} />);
  expect(screen.getByRole('button', { name: 'Stop response' })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Approve', exact: true })).toBeDisabled();
  expect(screen.getByText('Keep this pending action')).toBeInTheDocument();
  expect(screen.getByText('Stopping response…')).toBeInTheDocument();
});


it('keeps cancellation recovery visible after streaming ends and disables unresolved decisions until cleanup', () => {
  const onInterrupt = vi.fn();
  render(<DesktopConversationView {...buildProps({ mode: 'structured', isStreaming: false, requiresCleanup: true, onInterrupt, onApprove: vi.fn(), pendingApproval: { approvalId: 'cleanup-action', description: 'Retained exact action', toolName: 'fixture' } })} />);
  fireEvent.click(screen.getByRole('button', { name: 'Retry cancellation' }));
  expect(onInterrupt).toHaveBeenCalledTimes(1);
  expect(screen.getByText('Cleanup required')).toBeInTheDocument();
  expect(screen.getByText('Retained exact action')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Approve', exact: true })).toBeDisabled();
});

it('shows an agent question as a question card and sends the chosen answer with the approval', () => {
  const onApprove = vi.fn();
  const pendingApproval = { approvalId: 'question-1', toolName: 'ask_user', description: 'Codex has a question for you.',
    toolInput: { questions: [{ id: 'colour', question: 'Which accent colour?', options: [{ label: 'Indigo' }, { label: 'Amber' }] }] } };
  render(<DesktopConversationView {...buildProps({ mode: 'structured', pendingApproval, onApprove })} />);
  expect(screen.getByText('Waiting for your answer')).toBeVisible();
  fireEvent.click(screen.getByRole('radio', { name: 'Indigo' }));
  fireEvent.click(screen.getByRole('button', { name: 'Send answers' }));
  expect([screen.queryByRole('button', { name: 'Approve' }), onApprove.mock.calls]).toEqual([null, [[true, pendingApproval, { colour: ['Indigo'] }]]]);
});

it('keeps pending approvals and questions outside the scrolling transcript', () => {
  const pendingApproval = { approvalId: 'question-adjacent', toolName: 'ask_user',
    toolInput: { questions: [{ id: 'colour', question: 'Which colour?', options: [{ label: 'Indigo' }] }] } };
  const { container, rerender } = render(<DesktopConversationView {...buildProps({ mode: 'structured', pendingApproval, onApprove: vi.fn() })} />);
  const rail = screen.getByRole('region', { name: 'Pending requests' });
  expect(rail).toContainElement(screen.getByRole('group', { name: 'Question from the agent' }));
  expect(container.querySelector('.desktop-thread')).not.toContainElement(rail);
  rerender(<DesktopConversationView {...buildProps({ mode: 'structured', pendingApproval: { approvalId: 'run', toolName: 'Bash', description: 'Run it?' }, onApprove: vi.fn() })} />);
  expect(screen.getByRole('region', { name: 'Pending requests' })).toContainElement(screen.getByRole('group', { name: 'Approval required' }));
  expect(screen.getAllByRole('button', { name: 'Approve', exact: true })).toHaveLength(1);
});

it('disables agent question decisions while a browser decision is in flight', () => {
  const onApprove = vi.fn();
  const pendingApproval = { approvalId: 'question-gated', toolName: 'ask_user',
    toolInput: { questions: [{ id: 'colour', question: 'Which colour?', options: [{ label: 'Indigo' }] }] } };
  render(<DesktopConversationView {...buildProps({ mode: 'structured', pendingApproval, onApprove, isBrowserApproving: true })} />);
  expect(screen.getByRole('button', { name: 'Dismiss question' })).toBeDisabled();
  expect(screen.getByRole('radio', { name: 'Indigo' })).toBeDisabled();
  expect(onApprove).not.toHaveBeenCalled();
});

it('offers to allow an action for the rest of the session where the agent supports it', () => {
  const onApprove = vi.fn();
  const pendingApproval = { approvalId: 'run-1', toolName: 'run_command', toolInput: { command: 'npm test' }, description: 'Run the tests?' };
  const view = render(<DesktopConversationView {...buildProps({ mode: 'structured', pendingApproval, onApprove, allowApprovalForSession: true })} />);
  fireEvent.click(screen.getByRole('button', { name: 'Allow for this session' }));
  view.rerender(<DesktopConversationView {...buildProps({ mode: 'structured', pendingApproval, onApprove })} />);
  expect([onApprove.mock.calls, screen.queryByRole('button', { name: 'Allow for this session' })]).toEqual([[[true, pendingApproval, undefined, { forSession: true }]], null]);
});

it('marks plan requests and offers to implement the finished plan', () => {
  const onImplementPlan = vi.fn();
  const onImplementPlanInNewThread = vi.fn();
  const structuredMessages = [
    { role: 'user', content: '[Plan] Add search', messageId: 'u1', ts: 1 },
    { role: 'assistant', content: '1. Index files\n2. Add a search box', messageId: 'a1', ts: 2 },
  ];
  render(<DesktopConversationView {...buildProps({ mode: 'structured', structuredMessages, onImplementPlan, onImplementPlanInNewThread })} />);
  fireEvent.click(screen.getByRole('button', { name: 'Implement plan' }));
  fireEvent.click(screen.getByRole('button', { name: 'Implement in a new thread' }));
  expect([
    screen.queryByText('[Plan] Add search'), screen.getByText('Plan', { selector: '.cc-plan-chip' }).nextSibling?.textContent === 'Add search',
    onImplementPlan.mock.calls, onImplementPlanInNewThread.mock.calls,
  ]).toEqual([null, true, [['1. Index files\n2. Add a search box']], [['1. Index files\n2. Add a search box']]]);
});

it('lets a message be edited as a new message or forked into a new thread', () => {
  const onEditMessage = vi.fn();
  const onForkFromMessage = vi.fn();
  const structuredMessages = [
    { role: 'user', content: 'Add search', messageId: 'u1', ts: 1 },
    { role: 'assistant', content: 'Added it', messageId: 'a1', ts: 2 },
  ];
  render(<DesktopConversationView {...buildProps({ mode: 'structured', structuredMessages, onEditMessage, onForkFromMessage })} />);
  fireEvent.click(screen.getByRole('button', { name: 'Edit as new message' }));
  fireEvent.click(screen.getByRole('button', { name: 'Fork from here' }));
  expect([onEditMessage.mock.calls, onForkFromMessage.mock.calls]).toEqual([
    [['Add search']],
    [['Continue from this earlier conversation:\n\nUser: Add search\n\nAssistant: Added it\n\nPick up from here.']],
  ]);
});
