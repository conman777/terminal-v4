import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import ToolCallBlock, { describeShellCommand, getToolDisplayInfo } from './ToolCallBlock';
import userEvent from '@testing-library/user-event';

describe('getToolDisplayInfo browser tools', () => {
  it.each([
    ['browser_open', {}, 'Open browser tab'],
    ['browser_navigate', { url: 'https://example.test/path' }, 'Navigate browser tab'],
    ['browser_snapshot', {}, 'Read browser page'],
    ['browser_get_images', {}, 'List page images'],
    ['browser_click', { ref: 'element-2' }, 'Click browser element'],
    ['browser_type', { text: '', clear: true }, 'Type in browser'],
    ['browser_select', { value: 'publish' }, 'Select browser option'],
    ['browser_scroll', { deltaY: 100 }, 'Scroll browser page'],
    ['browser_wait', { text: 'Ready' }, 'Wait for browser page'],
    ['browser_back', {}, 'Go back in browser'],
    ['browser_forward', {}, 'Go forward in browser'],
    ['browser_screenshot', {}, 'Capture browser screenshot'],
    ['browser_evaluate', { script: 'window.exact = true;' }, 'Run JavaScript in browser'],
    ['browser_tabs', {}, 'View open browser tabs'],
    ['browser_tabs', { tabId: 'target-tab' }, 'Switch browser tab'],
    ['browser_close', {}, 'Close browser session'],
    ['browser_close', { tabId: 'target-tab' }, 'Close browser tab'],
    ['browser_release_control', {}, 'Release browser control'],
  ])('maps %s deterministically in owned and native names', (name, toolInput, title) => {
    for (const tool of [name, `terminal_v4_browser.${name}`, `mcp__terminal_v4_browser__${name}`]) {
      const info = getToolDisplayInfo({ tool, toolInput });
      expect(info).toMatchObject({ title, browserTool: name, rawTool: tool, input: Object.keys(toolInput).length ? JSON.stringify(toolInput, null, 2) : '' });
    }
  });

  it.each(['unknown_tool', 'other_browser.browser_tabs', 'mcp__other__browser_tabs', 'browser_future'])('keeps unknown tools unchanged: %s', tool => {
    expect(getToolDisplayInfo({ tool, toolInput: { description: 'Custom action' } })).toEqual({ kind: 'other', title: tool, detail: 'Custom action', input: '{\n  "description": "Custom action"\n}', inputLabel: 'Input' });
  });
});

describe('describeShellCommand', () => {
  it.each([
    'cat source.txt>destination.txt',
    'cat source.txt>>destination.txt',
    'cat source.txt 2>destination.txt',
    'cat source.txt> destination.txt',
    'cat "source.txt">"destination.txt"',
    'cat source.txt\\>literal>destination.txt',
    'cat source.txt>|destination.txt',
    'cat source.txt<>destination.txt',
    'cat source.txt>&destination.txt',
    'cat source.txt&>destination.txt',
    'cat source.txt&>>destination.txt',
    'cat source.txt>/dev/null>destination.txt',
    'cat source.txt>"/dev/nu\\ll"',
    'cat source.txt | head>destination.txt',
    'cat source.txt&&cat other.txt>destination.txt',
    "/bin/zsh -lc 'cat source.txt>destination.txt'",
    'cat source.txt&touch destination.txt',
    'cat source.txt>',
    'cat source.txt 2>&',
    'cat source.txt>"destination.txt',
  ])('keeps writing or unsupported operator syntax neutral: %s', command => {
    expect(describeShellCommand(command)).toBeNull();
  });

  it.each([
    ['cat source.txt', ['source.txt']],
    ['head -n 5 source.txt', ['source.txt']],
    ['cat "source>destination.txt"', ['source>destination.txt']],
    ["cat 'source>>destination.txt'", ['source>>destination.txt']],
    ['cat source\\>destination.txt', ['source>destination.txt']],
    ['cat "source"\\>destination.txt', ['source>destination.txt']],
    ['cat "source\\>destination.txt"', ['source\\>destination.txt']],
    ["cat '>destination.txt'", ['>destination.txt']],
    ['cat \\>destination.txt', ['>destination.txt']],
    ["cat '<source.txt'", ['<source.txt']],
    ['cat source.txt>/dev/null', ['source.txt']],
    ['cat source.txt 2>>/dev/null', ['source.txt']],
    ['cat source.txt 2>&1', ['source.txt']],
    ['cat source.txt 12>&10', ['source.txt']],
    ['cat source.txt</dev/null', ['source.txt']],
    ['cat source.txt 0<other.txt', ['source.txt']],
    ['cat "2">/dev/null', ['2']],
    ['cat \\2>/dev/null', ['2']],
  ])('preserves read arguments and harmless redirects: %s', (command, files) => {
    expect(describeShellCommand(command)).toEqual({ kind: 'read', files });
  });
});

describe('ToolCallBlock', () => {
  it('shows a readable label and URL for an extracted web page', () => {
    render(<ToolCallBlock item={{ type: 'tool_use', tool: 'web_extract', toolInput: { url: 'https://example.test/article' }, result: { toolResult: 'Page content' } }} />);
    fireEvent.click(screen.getByRole('button', { name: /Fetch page/ }));
    expect(screen.getAllByText('https://example.test/article').length).toBeGreaterThan(0);
    expect(screen.getByText('Page content')).toBeVisible();
  });

  it('describes a web search without counting JSON lines as search results', () => {
    render(<ToolCallBlock item={{ type: 'tool_use', tool: 'web_search', toolInput: { query: 'example query' }, result: { toolResult: JSON.stringify({ results: [{ title: 'One' }, { title: 'Two' }] }) } }} />);
    expect(screen.getByRole('button', { name: /Web search.*Searched/ })).toBeVisible();
    expect(screen.queryByText('1 lines')).not.toBeInTheDocument();
  });

  it('shows scheduled task activity with a readable name', () => {
    render(<ToolCallBlock item={{ type: 'tool_use', tool: 'create_schedule', toolInput: { name: 'Daily review', prompt: 'Review the project' }, result: { toolResult: '{"id":"schedule-1"}' } }} />);
    fireEvent.click(screen.getByRole('button', { name: /Create schedule.*Daily review/ }));
    expect(screen.getByLabelText('Schedule details')).toHaveTextContent('Review the project');
  });

  it('labels schedule-listing activity clearly', () => {
    render(<ToolCallBlock item={{ type: 'tool_use', tool: 'list_schedules', toolInput: {}, result: { toolResult: '{"schedules":[]}' } }} />);
    expect(screen.getByRole('button', { name: /List schedules.*Done/ })).toBeVisible();
  });

  it('labels schedule management with its reviewed action', () => {
    render(<ToolCallBlock item={{ type: 'tool_use', tool: 'manage_schedule', toolInput: { action: 'pause', scheduleId: 'schedule-1' }, result: { toolResult: '{"enabled":false}' } }} />);
    expect(screen.getByRole('button', { name: /Manage schedule.*Pause/ })).toBeVisible();
  });

  it('labels a reviewed schedule edit', () => {
    render(<ToolCallBlock item={{ type: 'tool_use', tool: 'manage_schedule', toolInput: { action: 'edit', scheduleId: 'schedule-1' }, result: { toolResult: '{}' } }} />);
    expect(screen.getByRole('button', { name: /Manage schedule.*Edit/ })).toBeVisible();
  });

  it('shows read-only delegated investigation activity with its task', () => {
    render(<ToolCallBlock item={{ type: 'tool_use', tool: 'delegate_task', toolInput: { prompt: 'Inspect the project' }, result: { toolResult: 'Investigation complete' } }} />);
    fireEvent.click(screen.getByRole('button', { name: /Read-only investigation.*Inspect the project/ }));
    expect(screen.getByLabelText('Task')).toHaveTextContent('Inspect the project');
  });

  it('shows a background investigation as started without claiming the child has completed', async () => {
    const user = userEvent.setup();
    const output = JSON.stringify({ status: 'running', taskId: 'internal-task', childSessionId: 'internal-child', delivery: 'The result will enter the parent follow-up queue and run when the conversation is idle.' });
    render(<ToolCallBlock item={{ type: 'tool_use', tool: 'delegate_task_background', toolInput: { prompt: 'Inspect the project' }, result: { toolResult: output } }} />);
    const card = screen.getByRole('button', { name: /Background investigation.*Inspect the project.*Started/ });
    expect(card).not.toHaveTextContent('Completed');
    await user.click(card);
    expect(screen.getByLabelText('Task')).toHaveTextContent('Inspect the project');
    expect(screen.getByText('The result will enter the parent follow-up queue and run when the conversation is idle.')).toBeVisible();
    expect(screen.getByText(/internal-task/)).not.toBeVisible();
    await user.click(screen.getByText('Raw result'));
    expect(screen.getByText(/internal-task/)).toBeVisible();
  });
  it('does not describe a rejected background investigation as started', () => {
    render(<ToolCallBlock item={{ type: 'tool_use', tool: 'delegate_task_background', toolInput: { prompt: 'Inspect the project' }, result: { toolResult: 'User denied this action', isError: true } }} />);
    expect(screen.getByRole('button', { name: /Background investigation.*Failed/ })).not.toHaveTextContent('Started');
  });

  it('shows parallel read-only investigations and their tasks', () => {
    render(<ToolCallBlock item={{ type: 'tool_use', tool: 'delegate_tasks', toolInput: { prompts: ['Inspect alpha', 'Inspect beta'] }, result: { toolResult: JSON.stringify({ results: [{ status: 'completed', result: 'Alpha evidence' }, { status: 'failed', error: 'Provider unavailable' }] }) } }} />);
    fireEvent.click(screen.getByRole('button', { name: /Read-only investigations.*2 tasks/ }));
    expect(screen.getByLabelText('Tasks')).toHaveTextContent('Inspect alpha');
    expect(screen.getByLabelText('Tasks')).toHaveTextContent('Inspect beta');
    expect(screen.getByRole('button', { name: /1 completed, 1 failed/ })).toBeVisible();
    expect(screen.getByText('Alpha evidence')).toBeVisible();
    expect(screen.getByText('Provider unavailable')).toBeVisible();
  });

  it('renders an unrecognized schedule action without treating object properties as labels', () => {
    render(<ToolCallBlock item={{ type: 'tool_use', tool: 'manage_schedule', toolInput: { action: '__proto__' }, result: { toolResult: 'Rejected' } }} />);
    expect(screen.getByRole('button', { name: /Manage schedule/ })).toBeVisible();
  });

  it('renders your message as a bubble whose copy action sits beneath it', async () => {
    const user = userEvent.setup();
    const copy = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue();
    const { container } = render(<ToolCallBlock item={{ type: 'user', content: 'Ship it' }} />);
    const bubble = container.querySelector('.cc-user-bubble');
    expect([bubble.querySelector('.cc-user-content').textContent, bubble.nextElementSibling?.classList.contains('cc-message-actions')]).toEqual(['Ship it', true]);
    await user.click(screen.getByRole('button', { name: 'Copy message' }));
    expect(copy).toHaveBeenLastCalledWith('Ship it');
    copy.mockRestore();
  });

  it('identifies the speaker and copies assistant messages and code with feedback', async () => {
    const user = userEvent.setup();
    const copy = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue();
    const content = 'Review this change.\n\n```js\nconst ready = true;\n```';
    render(<ToolCallBlock item={{ type: 'assistant', content, roleLabel: 'Codex' }} />);
    expect(screen.getByText('Codex', { selector: '.cc-message-author' })).toHaveClass('cc-sr-only');
    await user.click(screen.getByRole('button', { name: 'Copy message' }));
    expect(copy).toHaveBeenLastCalledWith(content);
    expect(screen.getByRole('button', { name: 'Copy message' })).toHaveTextContent('Copied');
    await user.click(screen.getByRole('button', { name: 'Copy code' }));
    expect(copy).toHaveBeenLastCalledWith('const ready = true;');
    copy.mockRestore();
  });

  it('shows clipboard failures and allows retry', async () => {
    const user = userEvent.setup();
    const copy = vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValueOnce(new Error('Unavailable')).mockResolvedValue();
    render(<ToolCallBlock item={{ type: 'assistant', content: 'Answer' }} />);
    const button = screen.getByRole('button', { name: 'Copy message' });
    await user.click(button);
    expect(screen.getByRole('status')).toHaveTextContent('Could not copy. Try again.');
    await user.click(button);
    expect(button).toHaveTextContent('Copied');
    copy.mockRestore();
  });

  it('clears copied feedback when the visible message changes', async () => {
    const user = userEvent.setup();
    const copy = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue();
    const view = render(<ToolCallBlock item={{ type: 'assistant', content: 'First draft' }} />);
    await user.click(screen.getByRole('button', { name: 'Copy message' }));
    view.rerender(<ToolCallBlock item={{ type: 'assistant', content: 'Updated draft' }} />);
    expect(screen.getByRole('button', { name: 'Copy message' })).toHaveTextContent('Copy');
    expect(screen.getByRole('button', { name: 'Copy message' })).not.toHaveTextContent('Copied');
    copy.mockRestore();
  });

  it('copies full output while the visible preview is truncated, and preserves file navigation', async () => {
    const user = userEvent.setup();
    const copy = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue();
    const onFileClick = vi.fn();
    const output = ['src/app.jsx:7', ...Array.from({ length: 14 }, (_, index) => `Output ${index + 1}`)].join('\n');
    render(<ToolCallBlock onFileClick={onFileClick} item={{ type: 'tool_use', tool: 'Bash', toolInput: { command: 'check' }, result: { toolResult: output } }} />);
    await user.click(screen.getByRole('button', { name: /Run command/ }));
    expect(screen.queryByText('Output 14')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Copy output' }));
    expect(copy).toHaveBeenLastCalledWith(output);
    await user.click(screen.getByRole('button', { name: 'src/app.jsx:7' }));
    expect(onFileClick).toHaveBeenCalledWith('src/app.jsx', 7);
    await user.click(screen.getByRole('button', { name: 'Show 3 more lines' }));
    expect(screen.getByText('Output 14')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Show less' }));
    expect(screen.queryByText('Output 14')).not.toBeInTheDocument();
    copy.mockRestore();
  });

  it('preserves original whitespace in the raw activity transcript', () => {
    const content = 'Ran check\n  indented detail\n\nlast line';
    render(<ToolCallBlock item={{ type: 'assistant_activity', content }} />);
    fireEvent.click(screen.getByRole('button', { name: 'Raw' }));
    expect(screen.getByLabelText('Raw terminal transcript').textContent).toBe(content);
  });

  it.each([['', 'new line', '+new line'], ['old line', '', '-old line']])('shows empty-sided edits without losing the proposed change', (oldString, newString, line) => {
    render(<ToolCallBlock item={{ type: 'tool_use', tool: 'Edit', toolInput: { file_path: 'app.js', old_string: oldString, new_string: newString }, result: { toolResult: 'Applied' } }} />);
    fireEvent.click(screen.getByRole('button', { name: /Edit/ }));
    expect(screen.getByText(line)).toBeVisible();
  });

  it('shows a textual TodoWrite result and each task status', () => {
    render(<ToolCallBlock item={{ type: 'tool_use', tool: 'TodoWrite', toolInput: { todos: [{ content: 'Review layout', status: 'in_progress' }] }, result: { isError: true, toolResult: 'Task list could not be saved' } }} />);
    fireEvent.click(screen.getByRole('button', { name: /Update Todos.*Failed/ }));
    expect(screen.getByText('In progress')).toBeVisible();
    expect(screen.getByText('Task list could not be saved')).toBeVisible();
  });

  it('shows the confirmed todo_list result with nested items and all statuses', () => {
    const todos = [
      { id: 'child', parent: 'parent', content: 'Verify child', status: 'pending' },
      { id: 'parent', content: 'Inspect parent', status: 'in_progress' },
      { id: 'done', content: 'Finished task', status: 'completed' },
      { id: 'cancelled', content: 'Cancelled task', status: 'cancelled' },
    ];
    render(<ToolCallBlock item={{ type: 'tool_use', tool: 'todo_list', toolInput: { todos: [{ id: 'unconfirmed', content: 'Unconfirmed input', status: 'pending' }] }, result: { toolResult: JSON.stringify({ todos, revision: 2 }) } }} />);
    fireEvent.click(screen.getByRole('button', { name: /Task list.*Completed/ }));
    const list = screen.getByRole('list', { name: 'Session tasks' });
    expect(list).toHaveTextContent('Inspect parent');
    expect(list.querySelector('ul')).toHaveTextContent('Verify child');
    expect(list).toHaveTextContent('Pending');
    expect(list).toHaveTextContent('In progress');
    expect(list).toHaveTextContent('Completed');
    expect(list).toHaveTextContent('Cancelled');
    expect(list).not.toHaveTextContent('Unconfirmed input');
    expect(screen.getByText('Raw result').closest('details')).not.toHaveAttribute('open');
    fireEvent.click(screen.getByText('Raw result'));
    expect(screen.getByRole('region', { name: 'Output' })).toHaveTextContent('"revision":2');
  });

  it('does not show rejected, pending or malformed todo_list input as a confirmed task list', () => {
    const requested = { todos: [{ id: '1', content: 'Rejected input', status: 'completed' }] };
    const view = render(<ToolCallBlock item={{ type: 'tool_use', tool: 'todo_list', toolInput: requested, result: { isError: true, toolResult: 'Task list could not be saved' } }} />);
    fireEvent.click(screen.getByRole('button', { name: /Task list.*Failed/ }));
    expect(screen.queryByRole('list', { name: 'Session tasks' })).not.toBeInTheDocument();
    expect(screen.getByText('Task list could not be saved')).toBeVisible();
    view.rerender(<ToolCallBlock item={{ type: 'tool_use', tool: 'todo_list', toolInput: requested }} />);
    expect(screen.queryByRole('list', { name: 'Session tasks' })).not.toBeInTheDocument();
    view.rerender(<ToolCallBlock item={{ type: 'tool_use', tool: 'todo_list', toolInput: requested, result: { toolResult: 'not json' } }} />);
    expect(screen.queryByRole('list', { name: 'Session tasks' })).not.toBeInTheDocument();
    expect(screen.getByText('not json')).toBeVisible();
  });

  it('shows an explicitly empty confirmed todo_list', () => {
    render(<ToolCallBlock item={{ type: 'tool_use', tool: 'todo_list', toolInput: {}, result: { toolResult: JSON.stringify({ todos: [], revision: 0 }) } }} />);
    fireEvent.click(screen.getByRole('button', { name: /Task list.*Completed/ }));
    expect(screen.getByText('No tasks yet')).toBeVisible();
  });

  it('shows malformed parent references safely and does not confuse unknown states with pending', () => {
    const todos = [
      { id: 'a', parent: 'b', content: 'First cycle item', status: 'toString' },
      { id: 'b', parent: 'a', content: 'Second cycle item', status: 'pending' },
      { id: 'c', parent: 'missing', content: 'Orphan item', status: 'cancelled' },
    ];
    render(<ToolCallBlock item={{ type: 'tool_use', tool: 'todo_list', result: { toolResult: JSON.stringify({ todos }) } }} />);
    fireEvent.click(screen.getByRole('button', { name: /Task list.*Completed/ }));
    const list = screen.getByRole('list', { name: 'Session tasks' });
    expect([...list.querySelectorAll('.cc-session-todo-content')].map(node => node.textContent)).toEqual(['First cycle item', 'Second cycle item', 'Orphan item']);
    expect(list).toHaveTextContent('Unknown');
  });

  it('renders the maximum supported nesting without omitting tasks', () => {
    const todos = Array.from({ length: 256 }, (_, index) => ({ id: String(index), ...(index ? { parent: String(index - 1) } : {}), content: `Step ${index}`, status: 'pending' }));
    render(<ToolCallBlock item={{ type: 'tool_use', tool: 'todo_list', result: { toolResult: JSON.stringify({ todos }) } }} />);
    fireEvent.click(screen.getByRole('button', { name: /Task list.*Completed/ }));
    const list = screen.getByRole('list', { name: 'Session tasks' });
    expect(list.querySelectorAll('.cc-session-todo-content')).toHaveLength(256);
    expect(list).toHaveTextContent('Step 255');
  }, 20000);
  it('shows an Edit failure reason alongside its proposed diff', async () => {
    const user = userEvent.setup();
    const failure = 'Old text occurs twice; select a unique match.';
    render(<ToolCallBlock item={{ type: 'tool_use', tool: 'Edit', toolInput: { file_path: '/synthetic/app.js', old_string: 'oldValue', new_string: 'newValue' }, result: { isError: true, toolResult: failure } }} />);
    await user.click(screen.getByRole('button', { name: /Edit/ }));
    expect(screen.getByText('Error output')).toBeVisible();
    expect(screen.getByText(failure)).toBeVisible();
    expect(screen.getByText('-oldValue')).toBeVisible();
    expect(screen.getByText('+newValue')).toBeVisible();
  });

  it('opens and closes TodoWrite details with the keyboard', async () => {
    const user = userEvent.setup();
    render(<ToolCallBlock item={{ type: 'tool_use', tool: 'TodoWrite', toolInput: { todos: [{ content: 'Synthetic next step', status: 'pending', activeForm: 'Checking synthetic step' }] }, result: { toolResult: 'Todos updated' } }} />);
    const toggle = screen.getByRole('button', { name: /Update Todos/ });
    await user.tab();
    expect(toggle).toHaveFocus();
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await user.keyboard('{Enter}');
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('Synthetic next step')).toBeVisible();
    await user.keyboard(' ');
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('Synthetic next step')).not.toBeInTheDocument();
  });

  it('shows a readable command and status with keyboard-accessible output details', () => {
    const command = 'rg --files frontend/src/components';
    render(<ToolCallBlock item={{ type: 'tool_use', tool: 'run_command', toolInput: { command }, result: { toolResult: 'App.jsx\nTerminalPane.jsx' } }} />);
    const toggle = screen.getByRole('button', { name: /List files/ });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByText(command)).toBeInTheDocument();
    expect(screen.getByText('Completed')).toBeInTheDocument();
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('TerminalPane.jsx')).toBeVisible();
  });

  it('labels a shell-wrapped read by file name and keeps the original command under expansion', () => {
    const command = "/bin/zsh -lc 'cat /Users/me/.codex/skills/review/SKILL.md'";
    render(<ToolCallBlock item={{ type: 'tool_use', tool: 'run_command', toolInput: { command, cwd: '/work' }, result: { toolResult: 'Skill body' } }} />);
    const toggle = screen.getByRole('button', { name: /Read/ });
    expect(screen.getByText('SKILL.md')).toBeInTheDocument();
    expect(screen.queryByText(command)).not.toBeInTheDocument();
    fireEvent.click(toggle);
    expect(screen.getByText(command)).toBeVisible();
    expect(screen.getByText('in /work')).toBeVisible();
    expect(screen.getByText('Skill body')).toBeVisible();
  });

  it.each([
    ["/bin/zsh -lc 'git status --short && cat notes.md'", 'Run command', 'git status --short && cat notes.md'],
    ["/bin/zsh -lc 'cat a.md > b.md'", 'Run command', 'cat a.md > b.md'],
    ['grep -n TODO src/App.jsx', 'Search', 'TODO'],
    ['npm --prefix frontend test -- --run', 'Run tests', 'npm --prefix frontend test -- --run'],
  ])('describes %s without guessing beyond recognisable patterns', (command, title, detail) => {
    render(<ToolCallBlock item={{ type: 'tool_use', tool: 'run_command', toolInput: { command }, result: { toolResult: '' } }} />);
    expect(screen.getByText(title, { selector: '.cc-tool-name' })).toBeInTheDocument();
    expect(screen.getByText(detail, { selector: '.cc-tool-path' })).toBeInTheDocument();
  });

  it('prefers an explicit tool description over a derived label', () => {
    render(<ToolCallBlock item={{ type: 'tool_use', tool: 'Bash', toolInput: { command: 'cat a.md', description: 'Show release notes' }, result: { toolResult: 'notes' } }} />);
    expect(screen.getByText('Show release notes', { selector: '.cc-tool-name' })).toBeInTheDocument();
  });

  it.each(['cat source.txt>destination.txt', 'cat source.txt | head>>destination.txt'])('renders a redirecting command as a command rather than a file read: %s', command => {
    render(<ToolCallBlock item={{ type: 'tool_use', tool: 'run_command', toolInput: { command }, result: { toolResult: '' } }} />);
    const toggle = screen.getByRole('button', { name: /Run command/ });
    expect(screen.queryByText('Read', { selector: '.cc-tool-name' })).not.toBeInTheDocument();
    fireEvent.click(toggle);
    expect(screen.getByLabelText('Command')).toHaveTextContent(command);
  });

  it('renders assistant activity as grouped events with raw transcript details', () => {
    render(
      <ToolCallBlock
        item={{
          type: 'assistant_activity',
          content: [
            '• Ran npm --prefix frontend test -- --run (ctrl + t to view transcript)',
            '• Read frontend/src/styles.css +120 lines',
            '• Opened screenshot-2026-05-27T19-03-56.png in browser',
            '• Started Vite dev server on http://127.0.0.1:5173',
            '• Ran git status -sb',
          ].join('\n'),
        }}
      />
    );

    expect(screen.getByText('Terminal activity')).toBeInTheDocument();
    expect(screen.getByText('Tests & Build')).toBeInTheDocument();
    expect(screen.getByText('Files')).toBeInTheDocument();
    expect(screen.getByText('Browser Check')).toBeInTheDocument();
    expect(screen.getByText('Server')).toBeInTheDocument();
    expect(screen.getByText('Git')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Raw' }));

    expect(screen.getByLabelText('Raw terminal transcript')).toHaveTextContent(
      'Ran npm --prefix frontend test -- --run'
    );
  });
});

describe('ToolCallBlock message actions', () => {
  it('offers copy and the conversation\'s message actions beneath a message', () => {
    const onClick = vi.fn();
    render(<ToolCallBlock item={{ type: 'user', content: <b>Rich</b>, copyText: 'Rich', actions: [{ label: 'Edit as new message', onClick }] }} />);
    fireEvent.click(screen.getByRole('button', { name: 'Edit as new message' }));
    expect([screen.getByRole('button', { name: 'Copy message' }) !== null, onClick.mock.calls.length]).toEqual([true, 1]);
  });
});
