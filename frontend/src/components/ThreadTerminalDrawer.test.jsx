import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { setUser } from '../utils/auth';
import { ThreadTerminalDrawer } from './ThreadTerminalDrawer';

vi.mock('./LazyTerminalChat', () => ({ LazyTerminalChat: ({ sessionId }) => <div data-testid="terminal-chat" data-session-id={sessionId} /> }));

function Harness({ initial = ['pty-1'], onRequestClose = vi.fn(), calls = {} }) {
  const [terminals, setTerminals] = useState(initial.map(id => ({ id })));
  const [selected, setSelected] = useState(initial[0]);
  let counter = terminals.length;
  const drawer = {
    terminals, terminalId: terminals.some(item => item.id === selected) ? selected : terminals[0]?.id || null, error: '', createError: '', closeError: '',
    select: setSelected, dismissCloseError: () => {},
    addTerminal: async options => { counter += 1; const id = `pty-${counter}`; calls.add?.(options); setTerminals(list => [...list, { id }]); if (options?.select !== false) setSelected(id); return id; },
    closeTerminal: async id => { calls.close?.(id); setTerminals(list => list.filter(item => item.id !== id)); setSelected(current => current === id ? null : current); return true; },
  };
  return <ThreadTerminalDrawer threadId="ss-1" drawer={drawer} terminalInputAllowed sessionCwd="/project" fontSize={13} webglEnabled={false} isActive fitSignal={0}
    onRequestClose={onRequestClose} onRequestReopen={() => {}} />;
}
const chats = () => screen.getAllByTestId('terminal-chat').map(node => node.dataset.sessionId);

beforeEach(() => { localStorage.clear(); setUser({ id: 'drawer-user' }); });

describe('ThreadTerminalDrawer', () => {
  it('switches a live split to stacked panes, resizes it, and restores that layout', async () => {
    const view = render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: 'Split terminal' }));
    const separator = await screen.findByRole('separator', { name: 'Resize terminal split' });
    const originalTerminals = screen.getAllByTestId('terminal-chat');
    fireEvent.click(screen.getByRole('button', { name: 'Stack terminals' }));
    expect(separator).toHaveAttribute('aria-orientation', 'horizontal');
    expect(separator.parentElement).toHaveClass('thread-terminal-panes-stacked');
    expect(screen.getByRole('region', { name: 'Thread terminal' })).toHaveStyle({ flexBasis: '360px' });
    expect(screen.getAllByTestId('terminal-chat')).toEqual(originalTerminals);
    fireEvent.keyDown(separator, { key: 'ArrowDown' });
    expect(separator).toHaveAttribute('aria-valuenow', '55');
    separator.parentElement.getBoundingClientRect = () => ({ left: 0, width: 400, right: 400, top: 100, bottom: 500, height: 400 });
    fireEvent.pointerDown(separator, { pointerId: 1, button: 0 });
    fireEvent.pointerMove(separator, { pointerId: 1, clientY: 220 });
    fireEvent.pointerUp(separator, { pointerId: 1 });
    expect(separator).toHaveAttribute('aria-valuenow', '30');
    view.unmount();
    render(<Harness initial={['pty-1', 'pty-2']} />);
    const restored = screen.getByRole('separator', { name: 'Resize terminal split' });
    expect(restored).toHaveAttribute('aria-orientation', 'horizontal');
    expect(restored).toHaveAttribute('aria-valuenow', '30');
    fireEvent.click(screen.getByRole('button', { name: 'Show terminals side by side' }));
    expect(restored).toHaveAttribute('aria-orientation', 'vertical');
    expect(screen.getAllByTestId('terminal-chat')).toHaveLength(2);
  });

  it('splits the drawer by creating a second terminal without moving focus away from the first', async () => {
    const calls = { add: vi.fn() };
    render(<Harness calls={calls} />);
    fireEvent.click(screen.getByRole('button', { name: 'Split terminal' }));
    await waitFor(() => expect(chats()).toEqual(['pty-1', 'pty-2']));
    expect(calls.add).toHaveBeenCalledWith({ select: false });
    expect(screen.getByRole('separator', { name: 'Resize terminal split' })).toHaveAttribute('aria-valuenow', '50');
    expect(screen.queryByRole('button', { name: 'Split terminal' })).toBeNull();
    expect(screen.getByRole('tab', { name: 'Terminal 1', selected: true })).toBeVisible();
  });

  it('resizes the split from the keyboard within its bounds and remembers it for the thread', async () => {
    const view = render(<Harness initial={['pty-1', 'pty-2']} />);
    fireEvent.click(screen.getByRole('button', { name: 'Split terminal' }));
    const separator = await screen.findByRole('separator', { name: 'Resize terminal split' });
    separator.focus();
    fireEvent.keyDown(separator, { key: 'ArrowRight' });
    fireEvent.keyDown(separator, { key: 'ArrowRight', shiftKey: true });
    expect(separator).toHaveAttribute('aria-valuenow', '65');
    expect(separator).toHaveAttribute('aria-valuetext', '65% and 35%');
    fireEvent.keyDown(separator, { key: 'End' });
    expect(separator).toHaveAttribute('aria-valuenow', '80');
    fireEvent.keyDown(separator, { key: 'ArrowRight' });
    expect(separator).toHaveAttribute('aria-valuenow', '80');
    fireEvent.keyDown(separator, { key: 'Home' });
    expect(separator).toHaveAttribute('aria-valuenow', '20');
    view.unmount();
    expect(JSON.parse(localStorage.getItem(Object.keys(localStorage).find(key => key.includes('threadDrawerLayout'))))).toMatchObject({ ratio: 0.2, splitId: 'pty-3' });
  });

  it('follows a pointer drag on the divider', async () => {
    render(<Harness initial={['pty-1', 'pty-2']} />);
    fireEvent.click(screen.getByRole('button', { name: 'Split terminal' }));
    const separator = await screen.findByRole('separator', { name: 'Resize terminal split' });
    separator.parentElement.getBoundingClientRect = () => ({ left: 100, width: 1000, right: 1100, top: 0, bottom: 200, height: 200 });
    fireEvent.pointerDown(separator, { pointerId: 1, button: 0 });
    fireEvent.pointerMove(separator, { pointerId: 1, clientX: 400 });
    expect(separator).toHaveAttribute('aria-valuenow', '30');
    fireEvent.pointerMove(separator, { pointerId: 1, clientX: 5000 });
    expect(separator).toHaveAttribute('aria-valuenow', '80');
    fireEvent.pointerUp(separator, { pointerId: 1 });
    fireEvent.pointerMove(separator, { pointerId: 1, clientX: 300 });
    expect(separator).toHaveAttribute('aria-valuenow', '80');
  });

  it('asks before closing a split pane, then promotes the other terminal to the whole drawer', async () => {
    const calls = { close: vi.fn() };
    render(<Harness calls={calls} />);
    fireEvent.click(screen.getByRole('button', { name: 'Split terminal' }));
    await screen.findByRole('separator', { name: 'Resize terminal split' });
    fireEvent.click(screen.getByRole('button', { name: 'Close Terminal 2' }));
    const confirm = screen.getByRole('group', { name: 'Confirm closing Terminal 2' });
    expect(within(confirm).getByRole('button', { name: 'Keep open' })).toHaveFocus();
    fireEvent.click(within(confirm).getByRole('button', { name: 'Keep open' }));
    expect(calls.close).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Close Terminal 2' }));
    fireEvent.click(within(screen.getByRole('group', { name: 'Confirm closing Terminal 2' })).getByRole('button', { name: 'Close Terminal 2' }));
    await waitFor(() => expect(calls.close).toHaveBeenCalledWith('pty-2'));
    await waitFor(() => expect(screen.queryByRole('separator', { name: 'Resize terminal split' })).toBeNull());
    expect(chats()).toEqual(['pty-1']);
  });

  it('closing the first split pane leaves the second terminal selected on its own', async () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: 'Split terminal' }));
    await screen.findByRole('separator', { name: 'Resize terminal split' });
    fireEvent.click(screen.getByRole('button', { name: 'Close Terminal 1' }));
    fireEvent.click(within(screen.getByRole('group', { name: 'Confirm closing Terminal 1' })).getByRole('button', { name: 'Close Terminal 1' }));
    await waitFor(() => expect(chats()).toEqual(['pty-2']));
    expect(screen.getByRole('tab', { name: 'Terminal 1', selected: true })).toBeVisible();
  });

  it('shows one pane alone without closing the other terminal', async () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: 'Split terminal' }));
    await screen.findByRole('separator', { name: 'Resize terminal split' });
    fireEvent.click(screen.getByRole('button', { name: 'Show Terminal 2 alone' }));
    expect(chats()).toEqual(['pty-2']);
    expect(screen.getAllByRole('tab').map(tab => tab.textContent)).toEqual(['Terminal 1', 'Terminal 2']);
  });

  it('asks the owner to collapse the drawer before closing the last terminal', async () => {
    const onRequestClose = vi.fn();
    render(<Harness onRequestClose={onRequestClose} />);
    fireEvent.click(screen.getByRole('button', { name: 'Close Terminal 1' }));
    fireEvent.click(within(screen.getByRole('group', { name: 'Confirm closing Terminal 1' })).getByRole('button', { name: 'Close Terminal 1' }));
    expect(onRequestClose).toHaveBeenCalledTimes(1);
  });

  it('moves between terminal tabs with arrow keys and keeps one tab stop', () => {
    render(<Harness initial={['pty-1', 'pty-2', 'pty-3']} />);
    const first = screen.getByRole('tab', { name: 'Terminal 1' });
    first.focus();
    fireEvent.keyDown(first, { key: 'ArrowRight' });
    expect(screen.getByRole('tab', { name: 'Terminal 2', selected: true })).toHaveFocus();
    fireEvent.keyDown(screen.getByRole('tab', { name: 'Terminal 2' }), { key: 'End' });
    expect(screen.getByRole('tab', { name: 'Terminal 3', selected: true })).toHaveFocus();
    fireEvent.keyDown(screen.getByRole('tab', { name: 'Terminal 3' }), { key: 'ArrowRight' });
    expect(screen.getByRole('tab', { name: 'Terminal 1', selected: true })).toHaveFocus();
    expect(screen.getAllByRole('tab').map(tab => tab.tabIndex)).toEqual([0, -1, -1]);
    expect(screen.getByRole('tabpanel')).toHaveAttribute('aria-labelledby', screen.getByRole('tab', { name: 'Terminal 1' }).id);
  });

  it('resizes the drawer height from the keyboard with a minimum', () => {
    render(<Harness />);
    const separator = screen.getByRole('separator', { name: 'Resize terminal drawer' });
    expect(separator).toHaveAttribute('aria-orientation', 'horizontal');
    expect(separator).toHaveAttribute('aria-valuenow', '260');
    fireEvent.keyDown(separator, { key: 'ArrowUp' });
    expect(separator).toHaveAttribute('aria-valuenow', '284');
    fireEvent.keyDown(separator, { key: 'Home' });
    expect(separator).toHaveAttribute('aria-valuenow', '180');
    fireEvent.keyDown(separator, { key: 'ArrowDown' });
    expect(separator).toHaveAttribute('aria-valuenow', '180');
    expect(screen.getByRole('region', { name: 'Thread terminal' })).toHaveStyle({ flexBasis: '180px' });
  });
});
