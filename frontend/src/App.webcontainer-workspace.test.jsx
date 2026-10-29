import { expect, it, vi } from 'vitest';
import { openSidebarApp } from './test/sidebarApps.js';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import App from './App';
import { installSelectionPaneR1Fixture, R1 } from './test/selectionPaneR1Fixture';
import { getEnvironmentStorage } from './utils/remoteEnvironments';

it.each([false, true])('launches the selected workspace without a session, preserving active-session priority (%s)', async activeSession => {
  const fixture = installSelectionPaneR1Fixture();
  const selected = '/synthetic/selected-node-project';
  const storage = getEnvironmentStorage();
  if (!activeSession) {
    storage.removeItem('tabOrder'); storage.removeItem('lastActiveSession'); storage.removeItem('recentFolders');
  }
  const originalFetch = globalThis.fetch;
  const json = value => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
  vi.stubGlobal('fetch', async (input, options) => {
    const url = new URL(String(input), location.href);
    if (!activeSession && url.pathname.endsWith('/api/structured/sessions') && url.search === '?view=inventory') return json([]);
    if (!activeSession && url.pathname.endsWith('/api/settings') && (!options?.method || options.method === 'GET')) return json({ recentFolders: [], sidebarProjects: [], terminalWebglEnabled: false });
    if (url.pathname.endsWith('/api/workspace/profile') && url.searchParams.get('path') === selected) return json({});
    if (url.pathname.endsWith('/api/fs/list')) {
      const path = url.searchParams.get('path');
      return json({ path: path === selected ? selected : '/synthetic', parent: '/', folders: path === selected ? [] : ['selected-node-project'] });
    }
    return originalFetch(input, options);
  });
  vi.stubGlobal('isSecureContext', true);
  const originalUserAgent = Object.getOwnPropertyDescriptor(navigator, 'userAgent');
  Object.defineProperty(navigator, 'userAgent', { configurable: true, value: 'Chrome/156' });
  const originalLocks = Object.getOwnPropertyDescriptor(navigator, 'locks');
  Object.defineProperty(navigator, 'locks', { configurable: true, value: { request: async (_name, _options, callback) => callback() } });
  const open = vi.spyOn(window, 'open').mockReturnValue(null);
  try {
    render(<App />);
    fireEvent.change(await screen.findByLabelText('Username'), { target: { value: R1.username } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: R1.password } });
    fireEvent.click(screen.getByRole('button', { name: 'Initialize Session' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Add Project', exact: true }));
    const dialog = await screen.findByRole('dialog', { name: 'Choose project' });
    fireEvent.click(await within(dialog).findByRole('button', { name: 'selected-node-project', exact: true }));
    await waitFor(() => expect(within(dialog).queryByRole('button', { name: 'selected-node-project', exact: true })).not.toBeInTheDocument());
    fireEvent.click(within(dialog).getByRole('button', { name: 'Open here', exact: true }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Choose project' })).not.toBeInTheDocument());
    await waitFor(() => expect(JSON.parse(getEnvironmentStorage().getItem('recentFolders'))[0]).toBe(selected));
    fireEvent.click(await openSidebarApp('Preview'));
    fireEvent.click(await screen.findByRole('button', { name: 'More browser tools', exact: true }));
    const launcher = screen.getByRole('button', { name: 'Open WebContainer window', exact: true });
    expect(launcher).toBeEnabled();
    fireEvent.click(launcher);
    await waitFor(() => expect(open).toHaveBeenCalledTimes(1));
    const records = Object.values(JSON.parse(localStorage.getItem('terminal_webcontainer_launches_v1')));
    expect(records.map(record => ({ projectPath: record.projectPath, startCommand: record.startCommand }))).toEqual([{ projectPath: activeSession ? R1.cwd : selected, startCommand: 'npm run dev' }]);
    expect(fixture.sendCalls()).toEqual([]);
    expect(fixture.fetchCalls.filter(call => call.method === 'POST' && /\/api\/(terminal|structured\/sessions)$/.test(call.path))).toEqual([]);
    expect(fixture.unexpected).toEqual([]);
  } finally {
    cleanup(); open.mockRestore();
    if (originalLocks) Object.defineProperty(navigator, 'locks', originalLocks); else delete navigator.locks;
    if (originalUserAgent) Object.defineProperty(navigator, 'userAgent', originalUserAgent); else delete navigator.userAgent;
    fixture.restore();
  }
});
