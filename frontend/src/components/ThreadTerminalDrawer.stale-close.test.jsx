import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { setUser } from '../utils/auth';
import { ThreadTerminalDrawer } from './ThreadTerminalDrawer';

vi.mock('./LazyTerminalChat', () => ({ LazyTerminalChat: ({ sessionId }) => <div data-testid="terminal-chat" data-session-id={sessionId} /> }));

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

function Drawer({ threadId, gate, onRequestReopen }) {
  const drawer = {
    terminals: [{ id: 'pty-1' }], terminalId: 'pty-1', error: '', createError: '', closeError: '',
    select: () => {}, dismissCloseError: () => {}, addTerminal: async () => null, closeTerminal: () => gate.promise,
  };
  return <ThreadTerminalDrawer threadId={threadId} drawer={drawer} terminalInputAllowed sessionCwd="/project" fontSize={13} webglEnabled={false}
    isActive fitSignal={0} onRequestClose={() => {}} onRequestReopen={onRequestReopen} />;
}

function requestCloseOfTheLastTerminal() {
  fireEvent.click(screen.getByRole('button', { name: 'Close Terminal 1' }));
  const confirm = screen.queryByRole('group', { name: 'Confirm closing Terminal 1' });
  if (confirm) fireEvent.click(within(confirm).getByRole('button', { name: 'Close Terminal 1' }));
}

beforeEach(() => { localStorage.clear(); setUser({ id: 'drawer-user' }); });

describe('closing the last terminal while a response is pending', () => {
  it('reopens the drawer when the close fails and the same thread is still shown', async () => {
    const gate = deferred();
    const onRequestReopen = vi.fn();
    render(<Drawer threadId="ss-a" gate={gate} onRequestReopen={onRequestReopen} />);
    requestCloseOfTheLastTerminal();
    await act(async () => { gate.resolve(false); });
    expect(onRequestReopen).toHaveBeenCalledTimes(1);
  });

  it('does not reopen the drawer for another thread when a failed close answers after switching threads', async () => {
    const gate = deferred();
    const onRequestReopen = vi.fn();
    const view = render(<Drawer threadId="ss-a" gate={gate} onRequestReopen={onRequestReopen} />);
    requestCloseOfTheLastTerminal();
    view.rerender(<Drawer threadId="ss-b" gate={deferred()} onRequestReopen={onRequestReopen} />);
    await act(async () => { gate.resolve(false); });
    expect(onRequestReopen).not.toHaveBeenCalled();
  });

  it('does not reopen the drawer after the component was removed before the answer arrived', async () => {
    const gate = deferred();
    const onRequestReopen = vi.fn();
    const view = render(<Drawer threadId="ss-a" gate={gate} onRequestReopen={onRequestReopen} />);
    requestCloseOfTheLastTerminal();
    view.unmount();
    await act(async () => { gate.resolve(false); });
    expect(onRequestReopen).not.toHaveBeenCalled();
  });
});
