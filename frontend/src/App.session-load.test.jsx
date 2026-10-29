import { expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import App from './App';
import { installSelectionPaneR1Fixture, R1 } from './test/selectionPaneR1Fixture';

it('shows a session loading failure and retries without discarding the workspace', async () => {
  const fixture = installSelectionPaneR1Fixture();
  const originalFetch = globalThis.fetch;
  let unavailable = true;
  vi.stubGlobal('fetch', vi.fn((input, options = {}) => {
    const url = new URL(String(input), window.location.origin);
    if (url.pathname === '/api/structured/sessions' && url.search === '?view=inventory' && (!options.method || options.method === 'GET') && unavailable) {
      return Promise.resolve(new Response(JSON.stringify({ error: 'Synthetic unavailable' }), { status: 503, headers: { 'Content-Type': 'application/json' } }));
    }
    return originalFetch(input, options);
  }));
  try {
    render(<App />);
    fireEvent.change(await screen.findByLabelText('Username'), { target: { value: R1.username } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: R1.password } });
    fireEvent.click(screen.getByRole('button', { name: 'Initialize Session' }));
    expect(await screen.findByText('Could not load your sessions.')).toHaveAttribute('role', 'alert');
    expect(screen.getByText('Thread list may be incomplete')).toBeInTheDocument();
    expect(screen.queryByText('No threads yet')).not.toBeInTheDocument();
    unavailable = false;
    fireEvent.click(screen.getByRole('button', { name: 'Retry loading sessions' }));
    await waitFor(() => expect(screen.queryByText('Could not load your sessions.')).not.toBeInTheDocument());
    expect(fixture.sendCalls()).toEqual([]);
  } finally { cleanup(); fixture.restore(); }
});
