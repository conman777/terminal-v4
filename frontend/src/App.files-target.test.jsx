import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import App from './App';
import { installSelectionPaneR1Fixture, R1 } from './test/selectionPaneR1Fixture';

vi.mock('./components/SplitPaneContainer', () => ({
  SplitPaneContainer: ({ onOpenFiles }) => <button onClick={() => onOpenFiles('/synthetic/live-terminal-directory')}>Open supplied pane path</button>,
}));
vi.mock('./components/FileManager', () => ({
  FileManager: ({ initialPath, sessionId }) => <section aria-label="Synthetic Files" data-session-id={sessionId}>{initialPath}</section>,
}));

let fixture;
afterEach(() => { cleanup(); fixture?.restore(); });

it('uses the supplied terminal directory instead of the selected session project path', async () => {
  fixture = installSelectionPaneR1Fixture();
  render(<App />);
  fireEvent.change(await screen.findByLabelText('Username'), { target: { value: R1.username } });
  fireEvent.change(screen.getByLabelText('Password'), { target: { value: R1.password } });
  fireEvent.click(screen.getByRole('button', { name: 'Initialize Session' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Open supplied pane path' }));
  await waitFor(() => expect(screen.getByRole('region', { name: 'Synthetic Files' })).toHaveTextContent('/synthetic/live-terminal-directory'));
  expect(screen.getByRole('region', { name: 'Synthetic Files' })).toHaveAttribute('data-session-id', R1.a.id);
  expect(fixture.sendCalls()).toEqual([]);
});
