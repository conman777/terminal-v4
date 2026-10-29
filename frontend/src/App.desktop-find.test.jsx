import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import App from './App';
import { installSelectionPaneR1Fixture, R1 } from './test/selectionPaneR1Fixture';
import { getEnvironmentStorage } from './utils/remoteEnvironments';

let fixture;
afterEach(() => { cleanup(); fixture?.restore(); vi.restoreAllMocks(); });

async function openSplit() {
  fixture = installSelectionPaneR1Fixture();
  getEnvironmentStorage().setItem('desktops', JSON.stringify({ activeDesktopId: 'desktop-1', desktops: [{ id: 'desktop-1', name: 'Fixture', ownedSessionIds: [R1.a.id, R1.b.id], paneLayout: { activePaneId: 'pane-a', root: { type: 'split', direction: 'horizontal', children: [{ type: 'pane', id: 'pane-a', sessionId: R1.a.id }, { type: 'pane', id: 'pane-b', sessionId: R1.b.id }] } } }] }));
  const view = render(<App />);
  fireEvent.change(await screen.findByLabelText('Username'), { target: { value: R1.username } });
  fireEvent.change(screen.getByLabelText('Password'), { target: { value: R1.password } });
  fireEvent.click(screen.getByRole('button', { name: 'Initialize Session' }));
  await screen.findAllByRole('textbox', { name: 'Command composer' });
  const panes = ['pane-a', 'pane-b'].map(id => view.container.querySelector(`[data-pane-host="${id}"]`));
  await waitFor(() => expect(panes.every(pane => pane?.querySelector('.desktop-conversation-view'))).toBe(true));
  panes.forEach((pane, index) => {
    const message = document.createElement('div');
    message.className = 'cc-transcript-message';
    message.textContent = index ? 'Synthetic violet needle' : 'Synthetic amber needle';
    pane.querySelector('.desktop-conversation-view').appendChild(message);
  });
  return { ...view, panes };
}

it('opens Find for the clicked pane, switches targets while open, and restores the latest trigger', async () => {
  const { panes: [first, second] } = await openSplit();
  const secondTrigger = within(second).getByRole('button', { name: 'Find in thread', exact: true });
  secondTrigger.focus();
  fireEvent.click(secondTrigger);
  const search = await screen.findByRole('searchbox', { name: 'Find in thread' });
  await waitFor(() => expect(second.querySelector('.split-terminal-pane')).toHaveClass('active'));
  expect(search).toHaveFocus();
  fireEvent.change(search, { target: { value: 'needle' } });
  await waitFor(() => expect(second.querySelector('.cc-find-current')).toHaveTextContent('Synthetic violet needle'));
  expect(first.querySelector('.cc-find-current')).toBeNull();
  const firstTrigger = within(first).getByRole('button', { name: 'Find in thread', exact: true });
  firstTrigger.focus();
  fireEvent.click(firstTrigger);
  await waitFor(() => expect(first.querySelector('.split-terminal-pane')).toHaveClass('active'));
  await waitFor(() => expect(first.querySelector('.cc-find-current')).toHaveTextContent('Synthetic amber needle'));
  expect(search).toHaveFocus();
  fireEvent.keyDown(search, { key: 'Escape' });
  await waitFor(() => expect(firstTrigger).toHaveFocus());
  expect(fixture.sendCalls()).toEqual([]);
});

it('does not open Find for a pane after the user focuses a different pane in the same interaction', async () => {
  const { panes: [first, second] } = await openSplit();
  const firstComposer = within(first).getByRole('textbox', { name: 'Command composer' });
  const secondTrigger = within(second).getByRole('button', { name: 'Find in thread', exact: true });
  act(() => {
    secondTrigger.focus();
    fireEvent.click(secondTrigger);
    firstComposer.focus();
    fireEvent.click(firstComposer);
  });
  await waitFor(() => expect(first.querySelector('.split-terminal-pane')).toHaveClass('active'));
  expect(screen.queryByRole('searchbox', { name: 'Find in thread' })).not.toBeInTheDocument();
  expect(firstComposer).toHaveFocus();
});
