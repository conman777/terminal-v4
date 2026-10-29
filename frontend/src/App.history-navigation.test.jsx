import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import App from './App';
import { installSelectionPaneR1Fixture, R1 } from './test/selectionPaneR1Fixture';

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

describe('saved conversation result navigation', () => {
  let fixture, sockets, restorePatch, row, scrollIntoView, originalScrollIntoView;
  beforeEach(() => {
    fixture = installSelectionPaneR1Fixture();
    originalScrollIntoView = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollIntoView');
    scrollIntoView = vi.fn();
    Object.defineProperty(Element.prototype, 'scrollIntoView', { configurable: true, value: scrollIntoView });
    restorePatch = null;
    sockets = [];
    const Socket = globalThis.WebSocket;
    vi.stubGlobal('WebSocket', class extends Socket {
      constructor(url) { super(url); sockets.push(this); }
    });
    row = { sessionId: R1.b.id, title: 'Search result', snippet: 'needle', matchType: 'message', anchor: { type: 'message', messageId: 'id"] [data-bad="', role: 'assistant' } };
    const fetch = globalThis.fetch;
    vi.stubGlobal('fetch', (input, options = {}) => {
      const url = new URL(String(input), location.href);
      if (url.pathname.endsWith('/api/workspace/history')) return Promise.resolve(json([row]));
      if (options.method === 'PATCH' && url.pathname.endsWith(`/api/structured/sessions/${R1.b.id}/thread`)) {
        return restorePatch ? restorePatch() : Promise.resolve(json({ thread: { topic: R1.b.topic, projectPath: R1.cwd, archived: false } }));
      }
      return fetch(input, options);
    });
  });
  afterEach(() => {
    cleanup();
    fixture.restore();
    if (originalScrollIntoView) Object.defineProperty(Element.prototype, 'scrollIntoView', originalScrollIntoView);
    else delete Element.prototype.scrollIntoView;
  });

  async function start() {
    render(<App />);
    fireEvent.change(await screen.findByLabelText('Username'), { target: { value: R1.username } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: R1.password } });
    fireEvent.click(screen.getByRole('button', { name: 'Initialize Session' }));
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Command composer' })).toHaveValue(R1.a.text));
    fireEvent.change(screen.getByRole('textbox', { name: 'Search threads' }), { target: { value: 'needle' } });
    const result = await screen.findByRole('button', { name: /Search result.*needle/ });
    fireEvent.pointerDown(result);
    fireEvent.click(result);
  }

  it('waits for the exact rendered message and preserves both drafts', async () => {
    await start();
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Command composer' })).toHaveValue(R1.b.text));
    expect(screen.getByText('Finding the matching message…')).toBeVisible();
    const socket = sockets.find(item => item.url.includes(encodeURIComponent(R1.b.id)) && item.readyState === 1);
    expect(socket).toBeDefined();
    act(() => socket.deliver('message', { data: JSON.stringify({ __terminal_meta: true, type: 'structured_event', event: { type: 'message_completed', seq: 1, role: 'assistant', messageId: row.anchor.messageId, content: 'The exact needle', ts: 1 } }) }));
    await screen.findByText('Matching message located.');
    const target = screen.getByText('The exact needle').closest('[data-message-id]');
    expect(target).toHaveClass('history-search-highlight');
    expect(target).toHaveFocus();
    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'center', behavior: 'smooth' });
    expect(screen.getByRole('textbox', { name: 'Command composer' })).toHaveValue(R1.b.text);
    fireEvent.click(screen.getByRole('button', { name: 'Clear search' }));
    fireEvent.click(screen.getByRole('button', { name: `Select ${R1.a.topic}` }));
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Command composer' })).toHaveValue(R1.a.text));
    expect(fixture.sendCalls()).toEqual([]);
  });

  it('opens the folded work group before focusing its matching message', async () => {
    await start();
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Command composer' })).toHaveValue(R1.b.text));
    const socket = sockets.find(item => item.url.includes(encodeURIComponent(R1.b.id)) && item.readyState === 1);
    const events = [
      { type: 'message_completed', role: 'user', messageId: 'question', content: 'Question' },
      { type: 'message_completed', role: 'assistant', messageId: row.anchor.messageId, content: 'Folded needle' },
      { type: 'message_completed', role: 'reasoning', messageId: 'thinking', content: 'Thinking' },
      { type: 'message_completed', role: 'assistant', messageId: 'final', content: 'Final answer' },
    ];
    act(() => events.forEach((event, index) => socket.deliver('message', { data: JSON.stringify({ __terminal_meta: true, type: 'structured_event', event: { ...event, seq: index + 1, ts: index + 1 } }) })));
    expect(await screen.findByText('Matching message located.')).toBeVisible();
    expect(screen.getByRole('button', { name: /Worked/ })).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('Folded needle').closest('[data-message-id]')).toHaveFocus();
  });

  it('reports a vanished conversation when reopen fails', async () => {
    restorePatch = () => Promise.resolve(json({ error: 'Missing' }, 404));
    await start();
    expect(await screen.findByText('Could not open this conversation. It may no longer be available.')).toBeVisible();
    expect(screen.queryByText('Matching message located.')).not.toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Command composer' })).toHaveValue(R1.a.text);
  });

  it('reports a message that never appears without claiming a jump', async () => {
    await start();
    expect(await screen.findByText('The matching message could not be located in this conversation.', {}, { timeout: 10000 })).toBeVisible();
    expect(screen.queryByText('Matching message located.')).not.toBeInTheDocument();
  }, 12000);

  it('does not override a newer selection when reopening is delayed', async () => {
    let resolve;
    restorePatch = () => new Promise(done => { resolve = done; });
    await start();
    await waitFor(() => expect(resolve).toBeTypeOf('function'));
    fireEvent.click(screen.getByRole('button', { name: 'Clear search' }));
    fireEvent.click(screen.getByRole('button', { name: `Select ${R1.a.topic}` }));
    await act(async () => resolve(json({ thread: { topic: R1.b.topic, projectPath: R1.cwd, archived: false } })));
    expect(screen.getByRole('textbox', { name: 'Command composer' })).toHaveValue(R1.a.text);
    expect(screen.queryByText('Matching message located.')).not.toBeInTheDocument();
    expect(fixture.sendCalls()).toEqual([]);
  });

  it.each(['typing', 'input', 'search typing', 'clear', 'navigation'])('cancels a delayed reopen on %s without losing the draft', async action => {
    let resolve;
    restorePatch = () => new Promise(done => { resolve = done; });
    await start();
    await waitFor(() => expect(resolve).toBeTypeOf('function'));
    const composer = screen.getByRole('textbox', { name: 'Command composer' });
    if (action === 'typing') {
      fireEvent.keyDown(composer, { key: 'x' });
      fireEvent.change(composer, { target: { value: `${R1.a.text}x` } });
    } else if (action === 'input') {
      fireEvent.input(composer, { target: { value: `${R1.a.text}x` } });
    } else if (action === 'search typing') {
      const search = screen.getByRole('textbox', { name: 'Search threads' });
      fireEvent.keyDown(search, { key: 'x' });
      fireEvent.change(search, { target: { value: 'needlex' } });
    } else if (action === 'clear') {
      const clear = screen.getByRole('button', { name: 'Clear search' });
      fireEvent.pointerDown(clear);
      fireEvent.click(clear);
    } else {
      fireEvent.keyDown(composer, { key: 'ArrowLeft' });
    }
    await act(async () => resolve(json({ thread: { topic: R1.b.topic, projectPath: R1.cwd, archived: false } })));
    expect(screen.getByRole('textbox', { name: 'Command composer' })).toHaveValue(['typing', 'input'].includes(action) ? `${R1.a.text}x` : R1.a.text);
    expect(screen.queryByText('Matching message located.')).not.toBeInTheDocument();
    expect(fixture.sendCalls()).toEqual([]);
  });

  it('does not focus a late message after the user selects another session', async () => {
    await start();
    await waitFor(() => expect(screen.getByText('Finding the matching message…')).toBeVisible());
    const socket = sockets.find(item => item.url.includes(encodeURIComponent(R1.b.id)) && item.readyState === 1);
    fireEvent.click(screen.getByRole('button', { name: 'Clear search' }));
    fireEvent.click(screen.getByRole('button', { name: `Select ${R1.a.topic}` }));
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Command composer' })).toHaveValue(R1.a.text));
    act(() => socket.deliver('message', { data: JSON.stringify({ __terminal_meta: true, type: 'structured_event', event: { type: 'message_completed', seq: 1, role: 'assistant', messageId: row.anchor.messageId, content: 'Late needle' } }) }));
    expect(screen.getByRole('textbox', { name: 'Command composer' })).toHaveValue(R1.a.text);
    expect(screen.queryByText('Matching message located.')).not.toBeInTheDocument();
    expect(document.activeElement?.getAttribute('data-message-id')).not.toBe(row.anchor.messageId);
  });

  it('explains when a result has no exact anchor', async () => {
    row = { ...row, matchType: 'terminal_output', anchor: null };
    await start();
    expect(await screen.findByText('Conversation opened. An exact message location is not available for this result.')).toBeVisible();
    expect(screen.getByRole('textbox', { name: 'Command composer' })).toHaveValue(R1.b.text);
  });

  it.each([true, false])('opens a mobile saved result with an exact anchor=%s', async hasAnchor => {
    if (!hasAnchor) row = { ...row, matchType: 'terminal_output', anchor: null };
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 390 });
    vi.stubGlobal('visualViewport', { width: 390, height: 844, addEventListener() {}, removeEventListener() {} });
    render(<App />);
    fireEvent.change(await screen.findByLabelText('Username'), { target: { value: R1.username } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: R1.password } });
    fireEvent.click(screen.getByRole('button', { name: 'Initialize Session' }));
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Command composer' })).toHaveValue(R1.a.text));
    fireEvent.click(screen.getByRole('button', { name: 'Menu' }));
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search threads' }), { target: { value: 'needle' } });
    fireEvent.click(await screen.findByRole('button', { name: /Search result.*needle/ }));
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Command composer' })).toHaveValue(R1.b.text));
    if (hasAnchor) {
      const socket = sockets.find(item => item.url.includes(encodeURIComponent(R1.b.id)) && item.readyState === 1);
      expect(socket).toBeDefined();
      act(() => socket.deliver('message', { data: JSON.stringify({ __terminal_meta: true, type: 'structured_event', event: { type: 'message_completed', seq: 1, role: 'assistant', messageId: row.anchor.messageId, content: 'Mobile exact needle', ts: 1 } }) }));
      expect(await screen.findByText('Matching message located.')).toBeVisible();
      expect(screen.getByText('Mobile exact needle').closest('[data-message-id]')).toHaveFocus();
    } else {
      expect(await screen.findByText('Conversation opened. An exact message location is not available for this result.')).toBeVisible();
      expect(screen.queryByText('Matching message located.')).not.toBeInTheDocument();
    }
    expect(fixture.sendCalls()).toEqual([]);
  });
});
