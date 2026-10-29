import { expect, it, vi } from 'vitest';
import { openSidebarApp } from './test/sidebarApps.js';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import App from './App';
import { installSelectionPaneR1Fixture, R1 } from './test/selectionPaneR1Fixture';

it.each([1440, 390])('opens an empty Preview and its explicit terminal launcher at %ipx', async width => {
  const fixture = installSelectionPaneR1Fixture();
  const previousViewport = Object.getOwnPropertyDescriptor(window, 'visualViewport');
  const baseFetch = globalThis.fetch;
  vi.stubGlobal('fetch', async (input, options) => {
    const url = new URL(String(input), location.href);
    const response = await baseFetch(input, options);
    if (url.pathname === '/api/structured/sessions' && url.searchParams.get('view') === 'inventory') {
      return new Response('[]', { headers: { 'Content-Type': 'application/json' } });
    }
    if (url.pathname === '/api/state') {
      const data = await response.json();
      return new Response(JSON.stringify({ ...data, sessions: [], activeSessionId: null, projectInfo: { cwd: R1.cwd, projectType: 'unknown' } }), { headers: { 'Content-Type': 'application/json' } });
    }
    return response;
  });
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: width });
  Object.defineProperty(window, 'visualViewport', { configurable: true, value: { width, height: 844, addEventListener() {}, removeEventListener() {} } });
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  try {
    const view = render(<App />);
    fireEvent.change(await screen.findByLabelText('Username'), { target: { value: R1.username } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: R1.password } });
    fireEvent.click(screen.getByRole('button', { name: 'Initialize Session' }));
    const start = await screen.findByRole('region', { name: 'Workspace start' });
    const composer = within(start).getByRole('textbox', { name: 'Command composer' });
    fireEvent.change(composer, { target: { value: 'Keep this unsent project prompt' } });
    if (width <= 768) fireEvent.click(screen.getByRole('button', { name: 'Menu', exact: true }));
    fireEvent.click(width <= 768 ? await screen.findByRole('button', { name: 'Preview', exact: true }) : await openSidebarApp('Preview'));
    const openTerminal = await screen.findByRole('button', { name: 'Open terminal', exact: true });
    expect(view.container.querySelector('.browser-terminal-section')).toBeNull();
    fireEvent.click(openTerminal);
    const dialog = await screen.findByRole('dialog', { name: 'New terminal', exact: true });
    expect(within(dialog).getByRole('button', { name: 'Open terminal', exact: true })).toBeInTheDocument();
    expect(dialog.querySelector('#folder-browser-ai-select')).toBeNull();
    expect(composer.isConnected).toBe(true);
    expect(composer).toHaveValue('Keep this unsent project prompt');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel', exact: true }));
    expect(composer).toBeVisible();
    expect(fixture.sendCalls()).toEqual([]);
    expect(fixture.fetchCalls.filter(call => call.method === 'POST' && /\/api\/(terminal|structured\/sessions)$/.test(call.path))).toEqual([]);
  } finally {
    cleanup(); fixture.restore(); vi.unstubAllGlobals();
    if (previousViewport) Object.defineProperty(window, 'visualViewport', previousViewport);
  }
});

it('keeps agent chats out of the Preview terminal split', async () => {
  const fixture = installSelectionPaneR1Fixture();
  const baseFetch = globalThis.fetch;
  vi.stubGlobal('fetch', async (input, options) => {
    const url = new URL(String(input), location.href);
    const response = await baseFetch(input, options);
    if (url.pathname === '/api/state') {
      const data = await response.json();
      return new Response(JSON.stringify({ ...data, sessions: [], activeSessionId: null, projectInfo: { cwd: R1.cwd, projectType: 'unknown' } }), { headers: { 'Content-Type': 'application/json' } });
    }
    return response;
  });
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1440 });
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  try {
    const view = render(<App />);
    fireEvent.change(await screen.findByLabelText('Username'), { target: { value: R1.username } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: R1.password } });
    fireEvent.click(screen.getByRole('button', { name: 'Initialize Session' }));
    await screen.findAllByRole('button', { name: /^Select / });
    fireEvent.click(await openSidebarApp('Preview'));
    expect(await screen.findByRole('button', { name: 'Open terminal', exact: true })).toBeInTheDocument();
    expect([view.container.querySelector('.browser-terminal-section'), fixture.fetchCalls.filter(call => /\/api\/terminal\/[^/]+\/history/.test(call.path))]).toEqual([null, []]);
  } finally {
    cleanup(); fixture.restore(); vi.unstubAllGlobals();
  }
});
