import { useState } from 'react';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import App from './App';
import { installSelectionPaneR1Fixture, R1 } from './test/selectionPaneR1Fixture';
import { getEnvironmentStorage } from './utils/remoteEnvironments';
import { useConversationLinks } from './contexts/ConversationLinksContext';

vi.mock('./components/FileManager', () => ({
  FileManager: ({ initialPath, initialLineTarget, onClose }) => {
    const [path, setPath] = useState(initialPath);
    const links = useConversationLinks();
    return <section aria-label="Synthetic Files"><span>{path}</span><span>{initialLineTarget?.path}</span><button onClick={() => links.openFile("src/cited.js", 7)}>Open citation</button><button onClick={() => setPath('/browsed')}>Browse elsewhere</button><button onClick={onClose}>Close Files</button></section>;
  },
}));

let fixture;
afterEach(() => { cleanup(); fixture?.restore(); });

describe('pane project Files action', () => {
  it('opens and retargets Files to the focused pane path, then releases that scope on pane changes', async () => {
    fixture = installSelectionPaneR1Fixture();
    const realFetch = globalThis.fetch;
    vi.stubGlobal('fetch', async (input, options) => {
      const url = new URL(String(input), location.href);
      if (url.pathname.endsWith('/api/structured/sessions') && url.search === '?view=inventory') {
        const sessions = [R1.a, R1.b].map((item, index) => ({
          id: item.id, title: item.topic, provider: R1.provider, model: R1.model, runtime: 'v4', status: 'idle',
          cwd: `/synthetic/project-${index + 1}`, thread: { topic: item.topic, projectPath: `/synthetic/project-${index + 1}` },
          createdAt: '2026-10-17T10:00:00Z', updatedAt: '2026-10-17T10:00:00Z', latestSeq: 0, statusSeq: 0,
        }));
        return new Response(JSON.stringify(sessions), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return realFetch(input, options);
    });
    getEnvironmentStorage().setItem('desktops', JSON.stringify({ activeDesktopId: 'desktop-1', desktops: [{ id: 'desktop-1', name: 'Fixture', ownedSessionIds: [R1.a.id, R1.b.id], paneLayout: { activePaneId: 'pane-a', root: { type: 'split', direction: 'horizontal', children: [{ type: 'pane', id: 'pane-a', sessionId: R1.a.id }, { type: 'pane', id: 'pane-b', sessionId: R1.b.id }] } } }] }));
    const { container } = render(<App />);
    fireEvent.change(await screen.findByLabelText('Username'), { target: { value: R1.username } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: R1.password } });
    fireEvent.click(screen.getByRole('button', { name: 'Initialize Session' }));
    await waitFor(() => expect(screen.getAllByRole('button', { name: 'Open project in Files' })).toHaveLength(2));
    const paneA = container.querySelector('[data-pane-host="pane-a"]');
    const paneB = container.querySelector('[data-pane-host="pane-b"]');
    fireEvent.click(within(paneB).getByRole('button', { name: 'Open project in Files' }));
    expect(await screen.findByRole('region', { name: 'Synthetic Files' })).toHaveTextContent('/synthetic/project-2');
    fireEvent.click(screen.getByRole('button', { name: 'Browse elsewhere' }));
    fireEvent.click(within(paneB).getByRole('button', { name: 'Open project in Files' }));
    expect(screen.getByRole('region', { name: 'Synthetic Files' })).toHaveTextContent('/synthetic/project-2');
    fireEvent.click(screen.getByRole('button', { name: 'Open citation' }));
    expect(screen.getByRole('region', { name: 'Synthetic Files' })).toHaveTextContent('src/cited.js');
    fireEvent.click(paneA.querySelector('.split-terminal-pane'));
    expect(screen.getByRole('region', { name: 'Synthetic Files' })).not.toHaveTextContent('src/cited.js');
    await waitFor(() => expect(screen.getByRole('region', { name: 'Synthetic Files' })).toHaveTextContent('/synthetic/project-1'));
    fireEvent.click(paneB.querySelector('.split-terminal-pane'));
    await waitFor(() => expect(screen.getByRole('region', { name: 'Synthetic Files' })).toHaveTextContent('/synthetic/project-2'));
    expect(screen.getByRole('region', { name: 'Synthetic Files' })).not.toHaveTextContent('src/cited.js');
    fireEvent.click(screen.getByRole('button', { name: 'Browse elsewhere' }));
    fireEvent.click(within(paneA).getByRole('button', { name: 'Open project in Files' }));
    expect(screen.getByRole('region', { name: 'Synthetic Files' })).toHaveTextContent('/synthetic/project-1');
    fireEvent.click(screen.getByRole('button', { name: 'Close Files' }));
    expect(screen.queryByRole('region', { name: 'Synthetic Files' })).not.toBeInTheDocument();
    expect(fixture.sendCalls()).toEqual([]);
  });
});
