import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { TerminalAddToChat, useTerminalAddToChat } from './TerminalAddToChat';
import { splitContext } from './composerContext';
import { getComposerDraftStore } from '../../utils/composerDraftStore';
import { setActiveEnvironment } from '../../utils/remoteEnvironments';

function fakeTerminal(sessionId) {
  const listeners = new Set();
  const terminal = { text: '', cleared: 0 };
  terminal.actions = {
    sessionId,
    hasSelection: () => Boolean(terminal.text),
    copySelection: () => true,
    getSelectionText: () => terminal.text,
    clearSelection: () => { terminal.cleared += 1; terminal.text = ''; listeners.forEach(listener => listener()); },
    subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener); },
  };
  terminal.select = text => { terminal.text = text; listeners.forEach(listener => listener()); };
  return terminal;
}

function Harness({ terminalId, owner, terminals }) {
  const addToChat = useTerminalAddToChat({ terminalId, owner, label: 'Thread terminal' });
  return <>
    <button type="button" onClick={() => addToChat.register(terminals[terminalId]?.actions || null)}>mount</button>
    <button type="button" onClick={() => addToChat.register(null)}>unmount</button>
    <TerminalAddToChat state={addToChat} />
  </>;
}
const draft = id => splitContext(getComposerDraftStore(id).getSnapshot().text);
const ownerA = { threadId: 'ss-a', title: 'Alpha' };
const ownerB = { threadId: 'ss-b', title: 'Bravo' };

beforeEach(() => { localStorage.clear(); setActiveEnvironment(null); });

describe('TerminalAddToChat', () => {
  it('renders nothing until text is selected and then adds a chip to the owning thread only', async () => {
    const user = userEvent.setup();
    const terminals = { 'pty-1': fakeTerminal('pty-1') };
    render(<Harness terminalId="pty-1" owner={ownerA} terminals={terminals} />);
    await user.click(screen.getByText('mount'));
    expect(screen.queryByRole('button', { name: /Add to chat/ })).not.toBeInTheDocument();
    act(() => terminals['pty-1'].select('npm test\nFAIL auth'));
    const button = screen.getByRole('button', { name: 'Add to chat: Alpha' });
    expect(button).toHaveAttribute('aria-disabled', 'false');
    await user.click(button);
    expect(draft('ss-a').chips).toEqual([expect.objectContaining({ kind: 'terminal', label: 'Thread terminal · lines 1-2', body: 'npm test\nFAIL auth' })]);
    expect(draft('ss-b').chips).toEqual([]);
    expect(terminals['pty-1'].cleared).toBe(1);
    expect(screen.queryByRole('button', { name: /Add to chat/ })).not.toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Added to Alpha');
  });

  it('is reachable and activated from the keyboard', async () => {
    const user = userEvent.setup();
    const terminals = { 'pty-2': fakeTerminal('pty-2') };
    render(<Harness terminalId="pty-2" owner={ownerA} terminals={terminals} />);
    await user.click(screen.getByText('mount'));
    act(() => terminals['pty-2'].select('ls -la'));
    await user.tab();
    await user.tab();
    expect(screen.getByRole('button', { name: 'Add to chat: Alpha' })).toHaveFocus();
    await user.keyboard('{Enter}');
    expect(draft('ss-a').chips).toHaveLength(1);
  });

  it('stays disabled and explains a blank selection without changing the draft', async () => {
    const user = userEvent.setup();
    const terminals = { 'pty-3': fakeTerminal('pty-3') };
    render(<Harness terminalId="pty-3" owner={ownerA} terminals={terminals} />);
    await user.click(screen.getByText('mount'));
    act(() => terminals['pty-3'].select('   \n  '));
    const button = screen.getByRole('button', { name: 'Add to chat: Alpha' });
    expect(button).toHaveAttribute('aria-disabled', 'true');
    expect(button).toHaveAccessibleDescription('The selection is blank.');
    await user.click(button);
    expect(getComposerDraftStore('ss-a').getSnapshot().text).toBe('');
  });

  it('stays disabled with an honest reason when no thread owns the terminal', async () => {
    const user = userEvent.setup();
    const terminals = { 'pty-4': fakeTerminal('pty-4') };
    render(<Harness terminalId="pty-4" owner={null} terminals={terminals} />);
    await user.click(screen.getByText('mount'));
    act(() => terminals['pty-4'].select('make build'));
    const button = screen.getByRole('button', { name: 'Add to chat' });
    expect(button).toHaveAttribute('aria-disabled', 'true');
    expect(button).toHaveAccessibleDescription('Open this terminal from a thread to add its output to that thread’s chat.');
    await user.click(button);
    expect(getComposerDraftStore('ss-a').getSnapshot().text).toBe('');
  });

  it('follows the current owner when the thread changes mid-selection and never uses the previous one', async () => {
    const user = userEvent.setup();
    const terminals = { 'pty-5': fakeTerminal('pty-5') };
    const view = render(<Harness terminalId="pty-5" owner={ownerA} terminals={terminals} />);
    await user.click(screen.getByText('mount'));
    act(() => terminals['pty-5'].select('first output'));
    view.rerender(<Harness terminalId="pty-5" owner={ownerB} terminals={terminals} />);
    await user.click(screen.getByRole('button', { name: 'Add to chat: Bravo' }));
    expect(draft('ss-b').chips).toHaveLength(1);
    expect(draft('ss-a').chips).toEqual([]);
  });

  it('ignores a selection that belongs to a different terminal than the one shown', async () => {
    const user = userEvent.setup();
    const terminals = { 'pty-old': fakeTerminal('pty-old'), 'pty-new': fakeTerminal('pty-new') };
    const view = render(<Harness terminalId="pty-old" owner={ownerA} terminals={terminals} />);
    await user.click(screen.getByText('mount'));
    act(() => terminals['pty-old'].select('stale selection'));
    view.rerender(<Harness terminalId="pty-new" owner={ownerB} terminals={terminals} />);
    expect(screen.queryByRole('button', { name: /Add to chat/ })).not.toBeInTheDocument();
  });

  it('hides when the selection is cleared and when the terminal unregisters', async () => {
    const user = userEvent.setup();
    const terminals = { 'pty-6': fakeTerminal('pty-6') };
    render(<Harness terminalId="pty-6" owner={ownerA} terminals={terminals} />);
    await user.click(screen.getByText('mount'));
    act(() => terminals['pty-6'].select('abc'));
    act(() => terminals['pty-6'].select(''));
    expect(screen.queryByRole('button', { name: /Add to chat/ })).not.toBeInTheDocument();
    act(() => terminals['pty-6'].select('abc'));
    await user.click(screen.getByText('unmount'));
    expect(screen.queryByRole('button', { name: /Add to chat/ })).not.toBeInTheDocument();
  });

  it('exposes menu items for the mobile selection menu', async () => {
    const terminals = { 'pty-7': fakeTerminal('pty-7') };
    let captured;
    function Probe() {
      captured = useTerminalAddToChat({ terminalId: 'pty-7', owner: ownerA, label: 'Terminal' });
      return <button type="button" onClick={() => captured.register(terminals['pty-7'].actions)}>mount</button>;
    }
    render(<Probe />);
    await userEvent.click(screen.getByText('mount'));
    act(() => terminals['pty-7'].select('abc'));
    expect(captured.menuItems.map(item => [item.label, Boolean(item.disabled)])).toEqual([['Copy selection', false], ['Add to chat: Alpha', false]]);
    act(() => { captured.menuItems[1].onClick(); });
    expect(draft('ss-a').chips).toHaveLength(1);
  });
});
