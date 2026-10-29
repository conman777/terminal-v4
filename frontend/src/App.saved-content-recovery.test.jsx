import { expect, it, vi } from 'vitest';
import { openSidebarApp } from './test/sidebarApps.js';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import App from './App';
import { installSelectionPaneR1Fixture, R1 } from './test/selectionPaneR1Fixture';

it.each(['notes', 'bookmarks'])('exposes %s initial-load failure and retries through the real provider', async kind => {
  const fixture = installSelectionPaneR1Fixture();
  const originalFetch = globalThis.fetch;
  let failed = true;
  const label = kind === 'notes' ? 'Notes' : 'Bookmarks';
  const item = kind === 'notes'
    ? { id: 'recovered-note', title: 'Recovered note', content: 'Synthetic saved content', updatedAt: '2026-10-25T10:00:00Z' }
    : { id: 'recovered-bookmark', name: 'Recovered bookmark', command: 'printf test', category: 'General' };
  vi.stubGlobal('fetch', vi.fn((input, options = {}) => {
    if (new URL(String(input), window.location.origin).pathname === `/api/${kind}` && (!options.method || options.method === 'GET')) {
      return Promise.resolve(new Response(JSON.stringify(failed ? { error: 'Synthetic list unavailable' } : { [kind]: [item] }), { status: failed ? 503 : 200, headers: { 'Content-Type': 'application/json' } }));
    }
    return originalFetch(input, options);
  }));
  try {
    render(<App />);
    fireEvent.change(await screen.findByLabelText('Username'), { target: { value: R1.username } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: R1.password } });
    fireEvent.click(screen.getByRole('button', { name: 'Initialize Session' }));
    fireEvent.click(await openSidebarApp(label));
    expect(await screen.findByRole('alert')).toHaveTextContent(`Could not load ${kind}`);
    failed = false;
    fireEvent.click(screen.getByRole('button', { name: `Retry loading ${kind}`, exact: true }));
    expect(await screen.findByText(kind === 'notes' ? item.title : item.name, { exact: true })).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
    expect(fixture.sendCalls()).toEqual([]);
  } finally { cleanup(); fixture.restore(); }
});
