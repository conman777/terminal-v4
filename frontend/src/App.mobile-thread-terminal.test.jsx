import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import App from './App';
import { installSelectionPaneR1Fixture, R1 } from './test/selectionPaneR1Fixture';

vi.mock('./components/TerminalChat', () => ({
  TerminalChat: ({ sessionId }) => <div data-testid="companion-terminal" data-session-id={sessionId} />,
}));

it('opens a mobile companion terminal without leaving the conversation or losing its draft', async () => {
  const fixture = installSelectionPaneR1Fixture();
  const fallbackFetch = globalThis.fetch;
  const previousViewport = Object.getOwnPropertyDescriptor(window, 'visualViewport');
  let terminal = null;
  const requests = [];
  const json = body => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
  globalThis.fetch = vi.fn(async (input, options = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.url, window.location.href);
    const method = String(options.method || 'GET').toUpperCase();
    if (url.pathname === '/api/terminal' && method === 'POST') {
      requests.push(JSON.parse(options.body));
      terminal = { id: 'pty-mobile-companion', title: 'Terminal', cwd: R1.cwd, isActive: true };
      return json({ session: terminal });
    }
    if (url.pathname === '/api/terminal' && method === 'GET' && terminal) return json({ sessions: [terminal] });
    if (url.pathname === '/api/terminal/pty-mobile-companion/thread' && method === 'PATCH') {
      terminal = { ...terminal, thread: JSON.parse(options.body) };
      return json({ thread: terminal.thread });
    }
    return fallbackFetch(input, options);
  });
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 390 });
  Object.defineProperty(window, 'visualViewport', { configurable: true, value: { width: 390, height: 844, addEventListener() {}, removeEventListener() {} } });
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  try {
    render(<App />);
    fireEvent.change(await screen.findByLabelText('Username'), { target: { value: R1.username } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: R1.password } });
    fireEvent.click(screen.getByRole('button', { name: 'Initialize Session' }));
    const composer = await screen.findByRole('textbox', { name: 'Command composer' });
    const originalDraft = composer.value;
    expect(originalDraft).toBe(R1.a.text);
    fireEvent.click(await screen.findByRole('button', { name: 'Show thread terminal' }));
    expect(await screen.findByTestId('companion-terminal')).toHaveAttribute('data-session-id', 'pty-mobile-companion');
    expect(requests).toEqual([{ cwd: R1.cwd, title: 'Terminal', requestId: expect.stringMatching(/^[0-9a-f-]{36}$/), companionOf: R1.a.id }]);
    expect(terminal.thread).toEqual({ companionOf: R1.a.id });
    expect(composer).toHaveValue(originalDraft);
    expect(within(screen.getByRole('banner')).getByText(R1.a.topic)).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Hide thread terminal' }));
    await waitFor(() => expect(screen.queryByTestId('companion-terminal')).not.toBeInTheDocument());
    expect(composer).toHaveValue(originalDraft);
  } finally {
    cleanup();
    fixture.restore();
    if (previousViewport) Object.defineProperty(window, 'visualViewport', previousViewport);
  }
});
