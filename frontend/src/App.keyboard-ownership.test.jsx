import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import App from './App.jsx';
import { installSelectionPaneR1Fixture, R1 } from './test/selectionPaneR1Fixture.js';
import { getEnvironmentStorage } from './utils/remoteEnvironments.js';
let fixture;
afterEach(() => { cleanup(); fixture?.restore(); vi.restoreAllMocks(); });
async function openWorkspace(split = false) {
  fixture = installSelectionPaneR1Fixture();
  vi.spyOn(navigator, 'platform', 'get').mockReturnValue('MacIntel');
  Object.defineProperty(window, 'visualViewport', { configurable: true, value: { width: 1440, height: 900, addEventListener() {}, removeEventListener() {} } });
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  if (split) getEnvironmentStorage().setItem('desktops', JSON.stringify({ activeDesktopId: 'desktop-1', desktops: [{ id:'desktop-1', name:'Synthetic desktop', ownedSessionIds: [R1.a.id, R1.b.id], paneLayout: { activePaneId: 'pane-1', root: { type: 'split', direction: 'horizontal', sizes:[.5,.5], children: [{type:'pane', id:'pane-1', sessionId:R1.a.id}, {type:'pane', id:'pane-2', sessionId:R1.b.id}] } } }] }));
  const view = render(<App />);
  fireEvent.change(await screen.findByLabelText('Username'), { target: { value: R1.username } });
  fireEvent.change(screen.getByLabelText('Password'), { target: { value: R1.password } });
  fireEvent.click(screen.getByRole('button', { name: 'Initialize Session' }));
  await screen.findAllByRole('textbox', { name: 'Command composer' });
  return view;
}
it('Cmd+T opens the explicit terminal launcher just like the New terminal button', async () => {
  await openWorkspace();
  fireEvent.keyDown(document.body, { key:'t', metaKey:true });
  await screen.findByRole('dialog');
  expect(screen.getByRole('dialog')).toHaveAccessibleName('New terminal');
});
it('Cmd+2 while fullscreen keeps selected session and visible pane aligned', async () => {
  const view = await openWorkspace(true);
  fireEvent.click(screen.getAllByRole('button', { name: 'Fullscreen', exact:true })[0]);
  await screen.findByRole('button', { name: 'Exit fullscreen', exact:true });
  fireEvent.keyDown(document.body, { key:'2', metaKey:true });
  await waitFor(() => expect(getEnvironmentStorage().getItem('lastActiveSession')).toBe(R1.b.id));
  const hosts = [...view.container.querySelectorAll('[data-pane-host]')].filter(host => host.style.display !== 'none');
  const visibleDrafts = hosts.map(host => host.querySelector('textarea.status-composer-input')?.value);
  expect(visibleDrafts, 'The globally selected B must be the visible fullscreen conversation').toContain(R1.b.text);
});
it('sidebar selection changes the visible fullscreen pane along with the selected conversation', async () => {
  const view = await openWorkspace(true);
  fireEvent.click(screen.getAllByRole('button', { name: 'Fullscreen', exact: true })[0]);
  fireEvent.click(screen.getByRole('button', { name: `Select ${R1.b.topic}`, exact: true }));
  await waitFor(() => expect(getEnvironmentStorage().getItem('lastActiveSession')).toBe(R1.b.id));
  const visibleHost = [...view.container.querySelectorAll('[data-pane-host]')].find(host => host.style.display !== 'none');
  expect(visibleHost.querySelector('textarea.status-composer-input')).toHaveValue(R1.b.text);
});
it('fullscreening an inactive pane also selects its conversation', async () => {
  const view = await openWorkspace(true);
  fireEvent.click(view.container.querySelector('[data-pane-host="pane-2"] [aria-label="Fullscreen"]'));
  await waitFor(() => expect(getEnvironmentStorage().getItem('lastActiveSession')).toBe(R1.b.id));
  expect(view.container.querySelector('[data-pane-host="pane-2"] textarea.status-composer-input')).toHaveValue(R1.b.text);
});
it('does not close a hidden conversation while the new-thread start surface is displayed', async () => {
  await openWorkspace(true);
  fireEvent.click(screen.getByRole('button', { name: 'Terminal v4 home', exact: true }));
  await screen.findByRole('region', { name: 'Workspace start' });
  fireEvent.keyDown(document.body, { key: 'w', metaKey: true });
  expect(fixture.fetchCalls.filter(call => call.method === 'DELETE')).toEqual([]);
});
it('Escape dismisses the pane session menu without exiting fullscreen', async () => {
  const view = await openWorkspace(true);
  fireEvent.click(screen.getAllByRole('button', { name: 'Fullscreen', exact:true })[0]);
  await screen.findByRole('button', { name: 'Exit fullscreen', exact:true });
  const visibleHost = view.container.querySelector('[data-pane-host="pane-1"]');
  fireEvent.click(visibleHost.querySelector('.ph-session-btn'));
  const action = visibleHost.querySelector('.ph-menu-item');
  action.focus();
  fireEvent.keyDown(action, { key:'Escape' });
  expect(visibleHost.querySelector('.ph-session-menu')).toBeNull();
  expect(screen.getByRole('button', { name:'Exit fullscreen', exact:true })).toBeInTheDocument();
});
it('Cmd+W after fullscreen pane selection closes the displayed conversation', async () => {
  const view = await openWorkspace(true);
  fireEvent.click(screen.getAllByRole('button', { name: 'Fullscreen', exact:true })[0]);
  await screen.findByRole('button', { name: 'Exit fullscreen', exact:true });
  fireEvent.keyDown(document.body, { key:'2', metaKey:true });
  await waitFor(() => expect(getEnvironmentStorage().getItem('lastActiveSession')).toBe(R1.b.id));
  const visibleHost = [...view.container.querySelectorAll('[data-pane-host]')].find(host => host.style.display !== 'none');
  expect(visibleHost.querySelector('textarea.status-composer-input')).toHaveValue(R1.b.text);
  fireEvent.keyDown(document.body, { key:'w', metaKey:true });
  await waitFor(() => expect(fixture.fetchCalls.some(call => call.method === 'DELETE')).toBe(true));
  expect(fixture.fetchCalls.filter(call => call.method === 'DELETE').map(call => call.path)).toEqual([`/api/structured/sessions/${R1.b.id}`]);
});
