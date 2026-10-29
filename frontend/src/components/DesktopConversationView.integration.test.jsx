import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { DesktopConversationView } from './DesktopConversationView';

const messages = [
  { role: 'user', messageId: 'question', content: 'Review the selected change.' },
  { role: 'assistant', messageId: 'answer', content: 'The change is ready.\n\n| Check | Result |\n| --- | --- |\n| Tests | Passed |\n\n```js\nconst ready = true;\n```' },
];

const props = {
  turns: [], mode: 'structured', structuredMessages: messages, aiType: 'codex',
  connectionState: 'online', isSendReady: true, showHeader: false,
};

describe('DesktopConversationView transcript integration', () => {
  it('shows the typing cursor only for terminal threads and labels a partial structured reply', () => {
    const waiting = { ...props, isStreaming: true, structuredMessages: [messages[0]] };
    const view = render(<DesktopConversationView {...waiting} />);
    expect(screen.queryByLabelText('Assistant is responding')).not.toBeInTheDocument();
    view.rerender(<DesktopConversationView {...waiting} mode="terminal" />);
    expect(screen.getByLabelText('Assistant is responding')).toHaveTextContent('▍');
    view.rerender(<DesktopConversationView {...waiting} structuredMessages={[messages[0], { ...messages[1], completionStatus: 'streaming' }]} />);
    expect(screen.getByText('Partial response')).toBeVisible();
  });

  it('shows the agent\'s thinking, plan and a live Working timer, then folds them when the turn ends', async () => {
    vi.useFakeTimers({ now: 20000, toFake: ['Date', 'setInterval', 'clearInterval'] });
    try {
      const plan = JSON.stringify({ explanation: null, steps: [{ step: 'Fix CSS', status: 'completed' }, { step: 'Run tests', status: 'inProgress' }] });
      const working = [
        { role: 'user', messageId: 'ask', content: 'Fix the layout.', ts: 8000 },
        { role: 'reasoning', messageId: 'r1', content: '**Inspecting styles**', ts: 9000, streaming: true },
        { role: 'plan', messageId: 'plan-t', content: plan, ts: 9500 },
      ];
      const view = render(<DesktopConversationView {...props} isStreaming structuredMessages={working} />);
      expect([
        screen.getByText('Thinking').nextSibling.textContent,
        within(screen.getByRole('region', { name: 'Plan' })).getAllByRole('listitem').map(item => item.textContent),
        screen.getAllByRole('status').map(node => node.textContent).filter(text => text.startsWith('Working')),
      ]).toEqual([
        'Inspecting styles',
        ['✓Done: Fix CSS', '●In progress: Run tests'],
        ['Working for 12s'],
      ]);
      act(() => { vi.advanceTimersByTime(2000); });
      expect(screen.getByText('Working for 14s')).toBeVisible();
      view.rerender(<DesktopConversationView {...props} structuredMessages={[...working, { role: 'assistant', messageId: 'done', content: 'Fixed.', ts: 30000 }]} />);
      expect([screen.queryByText('Thinking'), screen.queryByText(/^Working/), screen.getByRole('button', { name: /Worked for 22s/ }).textContent])
        .toEqual([null, null, 'Worked for 22s›']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('folds a finished turn\'s tool work under "Worked for" and keeps the final reply visible', async () => {
    const user = userEvent.setup();
    const turn = [
      { role: 'user', messageId: 'ask', content: 'Fix the layout.', ts: 1000 },
      { role: 'tool', toolName: 'read', toolInput: { path: '/work/app.css' }, toolCallId: 'read-1', result: 'body {}', ts: 2000 },
      { role: 'assistant', messageId: 'interim', content: 'Reading the stylesheet first.', ts: 3000 },
      { role: 'assistant', messageId: 'final', content: 'Layout fixed.', ts: 151000 },
    ];
    render(<DesktopConversationView {...props} structuredMessages={turn} />);
    const work = screen.getByRole('button', { name: 'Worked for 2m 30s' });
    expect([work.getAttribute('aria-expanded'), screen.queryByText('Reading the stylesheet first.'), screen.getByText('Layout fixed.') !== null]).toEqual(['false', null, true]);
    await user.click(work);
    expect([work.getAttribute('aria-expanded'), screen.getByText('Reading the stylesheet first.') !== null]).toEqual(['true', true]);
  });

  it('names each speaker for assistive tech and renders readable content without adding a pane header', () => {
    const { container } = render(<DesktopConversationView {...props} />);
    expect(screen.getByText('You', { selector: '.cc-message-author' })).toHaveClass('cc-sr-only');
    expect(screen.getByText('Codex', { selector: '.cc-message-author' })).toHaveClass('cc-sr-only');
    expect(screen.getByRole('cell', { name: 'Passed' })).toBeVisible();
    expect(container.querySelector('.desktop-conversation-header')).toBeNull();
  });

  it('keeps transcript copy and table navigation isolated from a waiting terminal prompt', async () => {
    const user = userEvent.setup();
    const copy = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue();
    const onSendRaw = vi.fn();
    render(<DesktopConversationView {...props} allowPromptKeyboardCapture showTerminalMirror onSendRaw={onSendRaw} terminalScreenSnapshot="Continue anyway? [y/N]" />);
    const copyButton = screen.getAllByRole('button', { name: 'Copy message' }).at(-1);
    copyButton.focus();
    await user.keyboard('{Enter}');
    expect(copy).toHaveBeenCalledWith(messages[1].content);
    const table = screen.getByRole('region', { name: 'Markdown table' });
    table.focus();
    expect(fireEvent.keyDown(table, { key: 'ArrowRight', code: 'ArrowRight' })).toBe(true);
    const code = screen.getByRole('region', { name: 'js code' });
    code.focus();
    expect(fireEvent.keyDown(code, { key: 'ArrowDown', code: 'ArrowDown' })).toBe(true);
    expect(onSendRaw).not.toHaveBeenCalled();
    copy.mockRestore();
  });

  it('keeps a scrolled-away transcript in place as structured content updates', () => {
    const view = render(<DesktopConversationView {...props} />);
    const thread = view.container.querySelector('.desktop-thread');
    const bottom = thread.lastElementChild;
    bottom.scrollIntoView = vi.fn();
    thread.scrollTo = vi.fn();
    Object.defineProperties(thread, {
      scrollHeight: { configurable: true, value: 1200 },
      clientHeight: { configurable: true, value: 400 },
      scrollTop: { configurable: true, value: 100, writable: true },
    });
    fireEvent.scroll(thread);
    view.rerender(<DesktopConversationView {...props} structuredMessages={[...messages, { role: 'assistant', messageId: 'follow-up', content: 'One more detail.' }]} />);
    expect(thread.scrollTop).toBe(100);
    expect(thread.scrollTo).not.toHaveBeenCalled();
    expect(bottom.scrollIntoView).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Scroll to latest message' }));
    expect(thread.scrollTo).toHaveBeenCalledWith({ top: 800, behavior: 'smooth' });
    expect(bottom.scrollIntoView).not.toHaveBeenCalled();
  });
});
