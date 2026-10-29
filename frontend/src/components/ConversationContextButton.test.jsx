import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { ConversationContextButton } from './ConversationContextButton';
import { setEnvironmentIdentity } from '../utils/remoteEnvironments';
const panelMount = vi.hoisted(() => vi.fn());
vi.mock('./ConversationContextPanel', () => ({ ConversationContextPanel: props => { panelMount(props); return <section><button onClick={props.onClose}>Close context</button><textarea aria-label="Fixture instructions" /></section>; } }));
afterEach(() => { panelMount.mockClear(); setEnvironmentIdentity(null); });
it('makes the workspace inert while context is open and restores it on dismissal', () => {
  render(<div id="root"><ConversationContextButton sessionId="ss-context-fixture" /></div>);
  const root = document.getElementById('root');
  const previous = root.inert;
  fireEvent.click(screen.getByRole('button', { name: 'Open conversation context' }));
  expect(root.inert).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'Close context' }));
  expect(root.inert).toBe(previous);
});
it('does not mount/fetch the context panel until a user opens it, traps focus and returns focus on Escape', () => {
  render(<ConversationContextButton sessionId="ss-00000000000000000000000000000031" />);
  const trigger = screen.getByRole('button', { name: 'Open conversation context' }); expect(panelMount).not.toHaveBeenCalled();
  fireEvent.click(trigger); const dialog = screen.getByRole('dialog', { name: 'Conversation context' }); expect(dialog).toHaveFocus();
  fireEvent.keyDown(dialog, { key: 'Tab', shiftKey: true }); expect(screen.getByLabelText('Fixture instructions')).toHaveFocus();
  fireEvent.keyDown(dialog, { key: 'Tab' }); expect(screen.getByRole('button', { name: 'Close context' })).toHaveFocus();
  fireEvent.keyDown(dialog, { key: 'Escape' }); expect(screen.queryByRole('dialog')).not.toBeInTheDocument(); expect(trigger).toHaveFocus();
});
it('closes on account/session change and does not reopen an old session during ABA navigation', () => {
  const view = render(<ConversationContextButton sessionId="ss-00000000000000000000000000000031" />);
  fireEvent.click(screen.getByRole('button', { name: 'Open conversation context' }));
  act(() => setEnvironmentIdentity('new-context-owner', 'https://context.example'));
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Open conversation context' }));
  view.rerender(<ConversationContextButton sessionId="ss-00000000000000000000000000000032" />);
  view.rerender(<ConversationContextButton sessionId="ss-00000000000000000000000000000031" />);
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
});
it('passes the shared Stop and bounded canonical controls through unchanged without invoking Stop on unmount', () => {
  const stop = vi.fn(), controls = { sessionId: 'ss-fixture', generation: 2, latestSeq: 10, events: [], truncated: false };
  const view = render(<ConversationContextButton sessionId="ss-fixture" onStopConversation={stop} controlState={controls} requiresCleanup={true} stopError="Unconfirmed" />);
  fireEvent.click(screen.getByRole('button', { name: 'Open conversation context' }));
  expect(panelMount.mock.calls.at(-1)[0]).toMatchObject({ onStopConversation: stop, controlState: controls, requiresCleanup: true, stopError: 'Unconfirmed' });
  view.unmount(); expect(stop).not.toHaveBeenCalled();
});
