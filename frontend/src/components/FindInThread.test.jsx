import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { FindInThread } from './FindInThread';
import { DesktopConversationView } from './DesktopConversationView';

describe('FindInThread', () => {
  it('counts and steps through matching messages, then clears its marks', () => {
    Element.prototype.scrollIntoView = vi.fn();
    const onClose = vi.fn();
    const view = render(<div>
      <div className="cc-transcript-message">Fix the login page</div>
      <div className="cc-transcript-message">Unrelated</div>
      <div className="cc-transcript-message">Login works now</div>
      <FindInThread open onClose={onClose} />
    </div>);
    fireEvent.change(screen.getByRole('searchbox', { name: 'Find in thread' }), { target: { value: 'login' } });
    const first = [screen.getByText('1 of 2').textContent, view.container.querySelector('.cc-find-current').textContent];
    fireEvent.keyDown(screen.getByRole('searchbox', { name: 'Find in thread' }), { key: 'Enter' });
    const second = view.container.querySelector('.cc-find-current').textContent;
    fireEvent.keyDown(screen.getByRole('searchbox', { name: 'Find in thread' }), { key: 'Escape' });
    view.rerender(<div><div className="cc-transcript-message">Fix the login page</div><FindInThread open={false} onClose={onClose} /></div>);
    expect([first, second, onClose.mock.calls.length, view.container.querySelectorAll('.cc-find-match').length])
      .toEqual([['1 of 2', 'Fix the login page'], 'Login works now', 1, 0]);
  });

  it('searches only the active pane and follows a pane change', async () => {
    const view = render(<div>
      <div className="split-terminal-pane active"><div className="desktop-conversation-view"><div className="cc-transcript-message">First login</div></div></div>
      <div className="split-terminal-pane"><div className="desktop-conversation-view"><div className="cc-transcript-message">Second login</div></div></div>
      <FindInThread open />
    </div>);
    fireEvent.change(screen.getByRole('searchbox', { name: 'Find in thread' }), { target: { value: 'login' } });
    expect(screen.getByText('1 of 1')).toBeVisible();
    expect(view.container.querySelector('.cc-find-current')).toHaveTextContent('First login');
    const panes = view.container.querySelectorAll('.split-terminal-pane');
    panes[0].classList.remove('active');
    panes[1].classList.add('active');
    await waitFor(() => expect(view.container.querySelector('.cc-find-current')).toHaveTextContent('Second login'));
    expect(screen.getByText('1 of 1')).toBeVisible();
  });

  it('refreshes matches as the active conversation receives or changes messages', async () => {
    const view = render(<div><div className="desktop-conversation-view"><div className="cc-transcript-message">First login</div></div><FindInThread open /></div>);
    fireEvent.change(screen.getByRole('searchbox', { name: 'Find in thread' }), { target: { value: 'login' } });
    const conversation = view.container.querySelector('.desktop-conversation-view');
    const message = document.createElement('div');
    message.className = 'cc-transcript-message';
    message.textContent = 'Second login';
    conversation.append(message);
    await screen.findByText('1 of 2');
    message.textContent = 'Updated';
    await screen.findByText('1 of 1');
  });

  it('finds streaming tool output in the active conversation and updates as it changes', async () => {
    const conversation = result => <DesktopConversationView mode="structured" sessionId="ss-active" aiType="codex"
      connectionState="online" isSendReady isStreaming structuredMessages={[]}
      structuredToolCalls={[{ toolCallId: 'call-1', toolName: 'Bash', toolInput: { command: 'check' }, result }]} />;
    const panes = result => <div><div className="split-terminal-pane active">{conversation(result)}</div>
      <div className="split-terminal-pane">{conversation('A needle in another pane')}</div><FindInThread open /></div>;
    const view = render(panes('Starting check'));
    fireEvent.change(screen.getByRole('searchbox', { name: 'Find in thread' }), { target: { value: 'needle' } });
    expect(screen.getByText('No matches')).toBeVisible();
    view.rerender(panes('Found needle in output'));
    await screen.findByText('1 of 1');
    expect(view.container.querySelector('.cc-find-current')).toHaveTextContent('Found needle in output');
    view.rerender(panes('Output finished'));
    await screen.findByText('No matches');
  });

  it('finds a proposed edit in collapsed work without searching its hidden success output', async () => {
    const messages = [
      { role: 'user', messageId: 'prompt', content: 'Update the file' },
      { role: 'tool', toolCallId: 'edit', toolName: 'replace_text', toolInput: { path: 'app.js', old_string: 'old value', new_string: 'new needle value' }, result: 'hidden-success-marker' },
      { role: 'assistant', messageId: 'answer', content: 'Done' },
    ];
    const view = render(<div className="split-terminal-pane active"><DesktopConversationView mode="structured" sessionId="ss-active" aiType="codex"
      connectionState="online" isSendReady structuredMessages={messages} structuredToolCalls={[]} /><FindInThread open /></div>);
    const search = screen.getByRole('searchbox', { name: 'Find in thread' });
    fireEvent.change(search, { target: { value: 'new needle' } });
    await screen.findByText('+new needle value');
    expect(view.container.querySelector('.cc-find-current')).toHaveTextContent('+new needle value');
    expect(screen.getByText('1 of 1')).toBeVisible();
    fireEvent.change(search, { target: { value: 'hidden-success-marker' } });
    await screen.findByText('No matches');
  });

  it('finds an edit error and the no-change message when those are displayed', async () => {
    const messages = [
      { role: 'user', messageId: 'prompt', content: 'Update the file' },
      { role: 'tool', toolCallId: 'edit', toolName: 'replace_text', toolInput: { path: 'app.js', old_string: 'unchanged', new_string: 'unchanged' }, isError: true, result: 'Could not apply the edit' },
      { role: 'assistant', messageId: 'answer', content: 'Done' },
    ];
    const view = render(<div className="split-terminal-pane active"><DesktopConversationView mode="structured" sessionId="ss-active" aiType="codex"
      connectionState="online" isSendReady structuredMessages={messages} structuredToolCalls={[]} /><FindInThread open /></div>);
    const search = screen.getByRole('searchbox', { name: 'Find in thread' });
    fireEvent.change(search, { target: { value: 'no changes' } });
    await screen.findByText('No changes');
    expect(view.container.querySelector('.cc-find-current')).toHaveTextContent('No changes');
    fireEvent.change(search, { target: { value: 'could not apply' } });
    await waitFor(() => expect(view.container.querySelector('.cc-find-current')).toHaveTextContent('Could not apply the edit'));
    fireEvent.change(search, { target: { value: 'unchanged' } });
    await screen.findByText('No matches');
  });

  it('keeps the current match and reading position when another match arrives', async () => {
    Element.prototype.scrollIntoView = vi.fn();
    const view = render(<div><div className="desktop-conversation-view">
      <div className="cc-transcript-message">First login</div><div className="cc-transcript-message">Second login</div>
    </div><FindInThread open /></div>);
    fireEvent.change(screen.getByRole('searchbox', { name: 'Find in thread' }), { target: { value: 'login' } });
    fireEvent.click(screen.getByRole('button', { name: 'Next match' }));
    expect(screen.getByText('2 of 2')).toBeVisible();
    Element.prototype.scrollIntoView.mockClear();
    const message = document.createElement('div');
    message.className = 'cc-transcript-message';
    message.textContent = 'Third login';
    view.container.querySelector('.desktop-conversation-view').append(message);
    await screen.findByText('2 of 3');
    expect(view.container.querySelector('.cc-find-current')).toHaveTextContent('Second login');
    expect(Element.prototype.scrollIntoView).not.toHaveBeenCalled();
  });

  it('matches message text rather than controls such as Copy', () => {
    render(<div className="desktop-conversation-view">
      <div className="cc-transcript-message"><div className="cc-assistant-content">A useful reply</div><button type="button">Copy</button></div>
      <FindInThread open />
    </div>);
    fireEvent.change(screen.getByRole('searchbox', { name: 'Find in thread' }), { target: { value: 'copy' } });
    expect(screen.getByText('No matches')).toBeVisible();
  });

  it('opens only the active work group containing a hidden message and keeps search focus', async () => {
    const messages = [
      { role: 'user', messageId: 'prompt-1', content: 'First prompt', ts: 1 },
      { role: 'assistant', messageId: 'hidden-1', content: 'A hidden needle here', ts: 2 },
      { role: 'tool', toolCallId: 'tool-1', toolName: 'read', result: 'Done', ts: 3 },
      { role: 'assistant', messageId: 'final-1', content: 'First result', ts: 4 },
      { role: 'user', messageId: 'prompt-2', content: 'Second prompt', ts: 5 },
      { role: 'assistant', messageId: 'hidden-2', content: 'Other hidden detail', ts: 6 },
      { role: 'tool', toolCallId: 'tool-2', toolName: 'read', result: 'Done', ts: 7 },
      { role: 'assistant', messageId: 'final-2', content: 'Second result', ts: 8 },
    ];
    const view = render(<div className="split-terminal-pane active"><DesktopConversationView mode="structured" sessionId="ss-active" aiType="codex"
      connectionState="online" isSendReady structuredMessages={messages} structuredToolCalls={[]} /><FindInThread open /></div>);
    const groups = view.container.querySelectorAll('.conversation-work-toggle');
    expect([...groups].map(group => group.getAttribute('aria-expanded'))).toEqual(['false', 'false']);
    expect(view.container).not.toHaveTextContent('A hidden needle here');
    const input = screen.getByRole('searchbox', { name: 'Find in thread' });
    fireEvent.change(input, { target: { value: 'hidden needle' } });
    await screen.findByText('A hidden needle here');
    expect([...groups].map(group => group.getAttribute('aria-expanded'))).toEqual(['true', 'false']);
    expect(view.container.querySelector('.cc-find-current')).toHaveTextContent('A hidden needle here');
    expect(input).toHaveFocus();
    expect(screen.getByText('1 of 1')).toBeVisible();
  });

  it('finds folded reasoning and visible plan text in order without searching plan metadata', async () => {
    const messages = [
      { role: 'user', messageId: 'prompt', content: 'Prompt' },
      { role: 'reasoning', messageId: 'thought', content: 'First **needle** reasoning' },
      { role: 'plan', messageId: 'plan', content: JSON.stringify({ explanation: 'Second needle plan', privateMetadata: 'secret-key', steps: [{ step: 'Third needle step', status: 'pending' }] }) },
      { role: 'assistant', messageId: 'final', content: 'Done' },
    ];
    const conversation = id => <DesktopConversationView mode="structured" sessionId={id} aiType="codex"
      connectionState="online" isSendReady structuredMessages={messages} structuredToolCalls={[]} />;
    const view = render(<div><div className="split-terminal-pane active">{conversation('active')}</div>
      <div className="split-terminal-pane">{conversation('inactive')}</div><FindInThread open /></div>);
    const input = screen.getByRole('searchbox', { name: 'Find in thread' });
    fireEvent.change(input, { target: { value: 'needle' } });
    await waitFor(() => expect(view.container.querySelector('.cc-find-current')).toHaveTextContent('First needle reasoning'));
    expect(screen.getByText('1 of 2')).toBeVisible();
    expect(input).toHaveFocus();
    expect(view.container.querySelectorAll('.conversation-work-toggle')[1]).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(screen.getByRole('button', { name: 'Next match' }));
    expect(view.container.querySelector('.cc-find-current')).toHaveTextContent('Second needle plan');
    expect(screen.getByText('2 of 2')).toBeVisible();
    const toggle = view.container.querySelector('.conversation-work-toggle');
    fireEvent.click(toggle);
    await waitFor(() => expect(toggle).toHaveAttribute('aria-expanded', 'false'));
    fireEvent.click(screen.getByRole('button', { name: 'Next match' }));
    await waitFor(() => expect(toggle).toHaveAttribute('aria-expanded', 'true'));
    fireEvent.change(input, { target: { value: 'secret-key' } });
    expect(screen.getByText('No matches')).toBeVisible();
  });

  it('reveals the matching tool output through nested disclosures and preserves manual collapse', async () => {
    const output = Array.from({ length: 14 }, (_, index) => index === 13 ? 'deep output needle' : `line ${index}`).join('\n');
    const messages = [
      { role: 'user', messageId: 'prompt', content: 'Prompt' },
      { role: 'tool', toolCallId: 'first', toolName: 'read', result: 'unrelated output', toolInput: { path: 'private-input-only' } },
      { role: 'tool', toolCallId: 'second', toolName: 'read', result: output },
      { role: 'assistant', messageId: 'final', content: 'Done' },
    ];
    const view = render(<div className="split-terminal-pane active"><DesktopConversationView mode="structured" sessionId="active" aiType="codex"
      connectionState="online" isSendReady structuredMessages={messages} structuredToolCalls={[]} /><FindInThread open /></div>);
    const input = screen.getByRole('searchbox', { name: 'Find in thread' });
    fireEvent.change(input, { target: { value: 'deep output needle' } });
    await waitFor(() => expect(view.container.querySelector('.cc-find-current')).toHaveTextContent('deep output needle'));
    expect(input).toHaveFocus();
    expect([...view.container.querySelectorAll('.cc-tool-header')].map(node => node.getAttribute('aria-expanded'))).toEqual(['false', 'true']);
    const tool = view.container.querySelectorAll('.cc-tool-header')[1];
    fireEvent.click(tool);
    await waitFor(() => expect(tool).toHaveAttribute('aria-expanded', 'false'));
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(tool).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(screen.getByRole('button', { name: 'Next match' }));
    await waitFor(() => expect(view.container.querySelector('.cc-find-current')).toHaveTextContent('deep output needle'));
    const toggle = view.container.querySelector('.conversation-work-toggle');
    fireEvent.click(toggle);
    await waitFor(() => expect(toggle).toHaveAttribute('aria-expanded', 'false'));
    fireEvent.click(screen.getByRole('button', { name: 'Next match' }));
    await waitFor(() => expect(view.container.querySelector('.cc-find-current')).toHaveTextContent('deep output needle'));
    fireEvent.change(input, { target: { value: 'private-input-only' } });
    expect(screen.getByText('No matches')).toBeVisible();
  });

  it('finds task text in the formatted result and opens the raw result only for raw-only matches', async () => {
    const messages = [
      { role: 'user', messageId: 'prompt', content: 'Prompt' },
      { role: 'tool', toolCallId: 'todo', toolName: 'todo_list', result: JSON.stringify({ todos: [{ id: 'one', content: 'Check the "layout"', status: 'pending' }], revision: 27 }) },
      { role: 'assistant', messageId: 'final', content: 'Done' },
    ];
    const view = render(<div className="split-terminal-pane active"><DesktopConversationView mode="structured" sessionId="active" aiType="codex"
      connectionState="online" isSendReady structuredMessages={messages} structuredToolCalls={[]} /><FindInThread open /></div>);
    const input = screen.getByRole('searchbox', { name: 'Find in thread' });
    fireEvent.change(input, { target: { value: 'check the "layout"' } });
    await waitFor(() => expect(view.container.querySelector('.cc-find-current')).toHaveTextContent('Check the "layout"'));
    const details = screen.getByText('Raw result').closest('details');
    expect(details).not.toHaveAttribute('open');
    fireEvent.change(input, { target: { value: '"revision":27' } });
    await waitFor(() => expect(details).toHaveAttribute('open'));
    expect(view.container.querySelector('.cc-find-current')).toHaveTextContent('"revision":27');
    expect(input).toHaveFocus();
    fireEvent.click(screen.getByText('Raw result'));
    await waitFor(() => expect(details).not.toHaveAttribute('open'));
    fireEvent.click(screen.getByRole('button', { name: 'Next match' }));
    await waitFor(() => expect(details).toHaveAttribute('open'));
  });

  it('does not open a matching folded group in an inactive pane', async () => {
    const messages = [
      { role: 'user', messageId: 'prompt', content: 'Prompt' },
      { role: 'assistant', messageId: 'hidden', content: 'Hidden needle' },
      { role: 'tool', toolCallId: 'tool', toolName: 'read', result: 'Done' },
      { role: 'assistant', messageId: 'final', content: 'Done' },
    ];
    const conversation = id => <DesktopConversationView mode="structured" sessionId={id} aiType="codex"
      connectionState="online" isSendReady structuredMessages={messages} structuredToolCalls={[]} />;
    const view = render(<div>
      <div className="split-terminal-pane active">{conversation('ss-active')}</div>
      <div className="split-terminal-pane">{conversation('ss-inactive')}</div>
      <FindInThread open />
    </div>);
    fireEvent.change(screen.getByRole('searchbox', { name: 'Find in thread' }), { target: { value: 'hidden needle' } });
    await waitFor(() => expect(view.container.querySelectorAll('.conversation-work-toggle')[0]).toHaveAttribute('aria-expanded', 'true'));
    expect(view.container.querySelectorAll('.conversation-work-toggle')[1]).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByText('1 of 1')).toBeVisible();
  });

  it('keeps an explicitly collapsed selected group closed until the next search navigation', async () => {
    const messages = [
      { role: 'user', messageId: 'prompt', content: 'Prompt' },
      { role: 'assistant', content: 'Hidden legacy needle' },
      { role: 'tool', toolCallId: 'tool', toolName: 'read', result: 'Done' },
      { role: 'assistant', messageId: 'final', content: 'Done' },
    ];
    const view = render(<div className="split-terminal-pane active"><DesktopConversationView mode="structured" sessionId="ss-active" aiType="codex"
      connectionState="online" isSendReady structuredMessages={messages} structuredToolCalls={[]} /><FindInThread open /></div>);
    fireEvent.change(screen.getByRole('searchbox', { name: 'Find in thread' }), { target: { value: 'legacy needle' } });
    const toggle = view.container.querySelector('.conversation-work-toggle');
    await waitFor(() => expect(toggle).toHaveAttribute('aria-expanded', 'true'));
    expect(view.container.querySelector('.cc-find-current')).toHaveTextContent('Hidden legacy needle');
    fireEvent.change(screen.getByRole('searchbox', { name: 'Find in thread' }), { target: { value: 'legacy' } });
    await act(async () => { fireEvent.click(toggle); await Promise.resolve(); });
    await waitFor(() => expect(toggle).toHaveAttribute('aria-expanded', 'false'));
    expect(screen.getByText('1 of 1')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Next match' }));
    await waitFor(() => expect(toggle).toHaveAttribute('aria-expanded', 'true'));
    expect(view.container.querySelector('.cc-find-current')).toHaveTextContent('Hidden legacy needle');
  });

  it('updates closed-group search data when an existing message changes', async () => {
    const messages = hidden => [
      { role: 'user', messageId: 'prompt', content: 'Prompt' },
      { role: 'assistant', messageId: 'hidden', content: hidden },
      { role: 'tool', toolCallId: 'tool', toolName: 'read', result: 'Done' },
      { role: 'assistant', messageId: 'final', content: 'Done' },
    ];
    const renderConversation = hidden => <div className="split-terminal-pane active"><DesktopConversationView mode="structured" sessionId="ss-active" aiType="codex"
      connectionState="online" isSendReady structuredMessages={messages(hidden)} structuredToolCalls={[]} /><FindInThread open /></div>;
    const view = render(renderConversation('Earlier content'));
    fireEvent.change(screen.getByRole('searchbox', { name: 'Find in thread' }), { target: { value: 'new needle' } });
    expect(screen.getByText('No matches')).toBeVisible();
    view.rerender(renderConversation('New needle inside work'));
    await screen.findByText('New needle inside work');
    expect(view.container.querySelector('.cc-find-current')).toHaveTextContent('New needle inside work');
  });

  it('keeps match order and selection when a hidden result is expanded', async () => {
    const messages = [
      { role: 'user', messageId: 'prompt', content: 'First needle' },
      { role: 'assistant', messageId: 'hidden', content: 'Second needle' },
      { role: 'tool', toolCallId: 'tool', toolName: 'read', result: 'Done' },
      { role: 'assistant', messageId: 'final', content: 'Third needle' },
    ];
    const view = render(<div className="split-terminal-pane active"><DesktopConversationView mode="structured" sessionId="ss-active" aiType="codex"
      connectionState="online" isSendReady structuredMessages={messages} structuredToolCalls={[]} /><FindInThread open /></div>);
    fireEvent.change(screen.getByRole('searchbox', { name: 'Find in thread' }), { target: { value: 'needle' } });
    expect(screen.getByText('1 of 3')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Next match' }));
    await screen.findByText('Second needle');
    expect(screen.getByText('2 of 3')).toBeVisible();
    expect(view.container.querySelector('.cc-find-current')).toHaveTextContent('Second needle');
    fireEvent.click(screen.getByRole('button', { name: 'Next match' }));
    expect(screen.getByText('3 of 3')).toBeVisible();
    expect(view.container.querySelector('.cc-find-current')).toHaveTextContent('Third needle');
  });

  it('keeps the selected legacy message when another message is inserted before it', async () => {
    const first = { role: 'assistant', content: 'First legacy needle' };
    const second = { role: 'assistant', content: 'Second legacy needle' };
    const messages = extra => [
      { role: 'user', messageId: 'prompt', content: 'Prompt' },
      ...extra, first, second,
      { role: 'tool', toolCallId: 'tool', toolName: 'read', result: 'Done' },
      { role: 'assistant', messageId: 'final', content: 'Done' },
    ];
    const renderConversation = extra => <div className="split-terminal-pane active"><DesktopConversationView mode="structured" sessionId="ss-active" aiType="codex"
      connectionState="online" isSendReady structuredMessages={messages(extra)} structuredToolCalls={[]} /><FindInThread open /></div>;
    const view = render(renderConversation([]));
    fireEvent.change(screen.getByRole('searchbox', { name: 'Find in thread' }), { target: { value: 'legacy needle' } });
    await screen.findByText('First legacy needle');
    fireEvent.click(screen.getByRole('button', { name: 'Next match' }));
    expect(view.container.querySelector('.cc-find-current')).toHaveTextContent('Second legacy needle');
    view.rerender(renderConversation([{ role: 'assistant', content: 'New legacy needle' }]));
    await screen.findByText('3 of 3');
    expect(view.container.querySelector('.cc-find-current')).toHaveTextContent('Second legacy needle');
  });

  it('keeps a folded source-text match selected after rendering its Markdown', async () => {
    const messages = [
      { role: 'user', messageId: 'prompt', content: 'Prompt' },
      { role: 'assistant', messageId: 'hidden', content: 'See [details](https://example.test/docs).' },
      { role: 'tool', toolCallId: 'tool', toolName: 'read', result: 'Done' },
      { role: 'assistant', messageId: 'final', content: 'Done' },
    ];
    const view = render(<div className="split-terminal-pane active"><DesktopConversationView mode="structured" sessionId="ss-active" aiType="codex"
      connectionState="online" isSendReady structuredMessages={messages} structuredToolCalls={[]} /><FindInThread open /></div>);
    fireEvent.change(screen.getByRole('searchbox', { name: 'Find in thread' }), { target: { value: 'example.test' } });
    await screen.findByRole('link', { name: 'details' });
    await waitFor(() => expect(view.container.querySelector('.cc-find-current')).toContainElement(screen.getByRole('link', { name: 'details' })));
    expect(screen.getByText('1 of 1')).toBeVisible();
  });

  it('finds rendered words across Markdown formatting inside collapsed work', async () => {
    const messages = [
      { role: 'user', messageId: 'prompt', content: 'Prompt' },
      { role: 'assistant', messageId: 'hidden', content: 'Please **check** [the results](https://example.test/docs).' },
      { role: 'tool', toolCallId: 'tool', toolName: 'read', result: 'Done' },
      { role: 'assistant', messageId: 'final', content: 'Done' },
    ];
    const view = render(<div className="split-terminal-pane active"><DesktopConversationView mode="structured" sessionId="ss-active" aiType="codex"
      connectionState="online" isSendReady structuredMessages={messages} structuredToolCalls={[]} /><FindInThread open /></div>);
    fireEvent.change(screen.getByRole('searchbox', { name: 'Find in thread' }), { target: { value: 'check the results' } });
    await screen.findByRole('link', { name: 'the results' });
    expect(view.container.querySelector('.cc-find-current')).toHaveTextContent('Please check the results.');
    expect(screen.getByText('1 of 1')).toBeVisible();
  });

  it('ignores an inert or hidden mobile conversation and restores focus on close', async () => {
    const view = render(<div>
      <button type="button">Open find</button>
      <div className="mobile-workspace-surface" inert=""><div className="desktop-conversation-view"><div className="cc-transcript-message">Hidden login</div></div></div>
      <div className="mobile-workspace-surface"><div className="desktop-conversation-view"><div className="cc-transcript-message">Visible login</div></div></div>
      <FindInThread open={false} />
    </div>);
    const opener = screen.getByRole('button', { name: 'Open find' });
    opener.focus();
    view.rerender(<div>
      <button type="button">Open find</button>
      <div className="mobile-workspace-surface" inert=""><div className="desktop-conversation-view"><div className="cc-transcript-message">Hidden login</div></div></div>
      <div className="mobile-workspace-surface"><div className="desktop-conversation-view"><div className="cc-transcript-message">Visible login</div></div></div>
      <FindInThread open />
    </div>);
    fireEvent.change(screen.getByRole('searchbox', { name: 'Find in thread' }), { target: { value: 'login' } });
    expect(screen.getByText('1 of 1')).toBeVisible();
    expect(view.container.querySelector('.cc-find-current')).toHaveTextContent('Visible login');
    view.rerender(<div><button type="button">Open find</button><FindInThread open={false} /></div>);
    await waitFor(() => expect(opener).toHaveFocus());
  });

  it('refocuses Find for a new opener and restores the most recent opener', async () => {
    const view = render(<div><button>First pane</button><button>Second pane</button><FindInThread open={false} /></div>);
    const first = screen.getByRole('button', { name: 'First pane' });
    const second = screen.getByRole('button', { name: 'Second pane' });
    first.focus();
    view.rerender(<div><button>First pane</button><button>Second pane</button><FindInThread open focusRequest={{ opener: first }} /></div>);
    expect(screen.getByRole('searchbox', { name: 'Find in thread' })).toHaveFocus();
    second.focus();
    view.rerender(<div><button>First pane</button><button>Second pane</button><FindInThread open focusRequest={{ opener: second }} /></div>);
    expect(screen.getByRole('searchbox', { name: 'Find in thread' })).toHaveFocus();
    view.rerender(<div><button>First pane</button><button>Second pane</button><FindInThread open={false} /></div>);
    await waitFor(() => expect(second).toHaveFocus());
  });

  it('does not restore a find opener after the user has focused elsewhere', async () => {
    const view = render(<div><button>Open find</button><button>Other control</button><FindInThread open={false} /></div>);
    const opener = screen.getByRole('button', { name: 'Open find' });
    const other = screen.getByRole('button', { name: 'Other control' });
    opener.focus();
    view.rerender(<div><button>Open find</button><button>Other control</button><FindInThread open /></div>);
    other.focus();
    view.rerender(<div><button>Open find</button><button>Other control</button><FindInThread open={false} /></div>);
    await waitFor(() => expect(other).toHaveFocus());
  });
});
