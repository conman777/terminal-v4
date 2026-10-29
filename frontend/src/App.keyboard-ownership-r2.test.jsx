import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import App from './App.jsx';
import { installSelectionPaneR1Fixture, R1 } from './test/selectionPaneR1Fixture.js';
import { getEnvironmentStorage } from './utils/remoteEnvironments.js';
let fixture;
afterEach(() => { cleanup(); fixture?.restore(); vi.restoreAllMocks(); });
async function openWorkspace(split = false) {
  fixture = installSelectionPaneR1Fixture();
  const boundaryFetch = globalThis.fetch;
  vi.stubGlobal('fetch', vi.fn(async (input, options = {}) => {
    const url = new URL(String(input), window.location.href);
    if (options.method === 'DELETE' && [R1.a, R1.b].some(item => url.pathname === `/api/structured/sessions/${item.id}`)) {
      fixture.fetchCalls.push({method:'DELETE', url:url.href, path:url.pathname, body:options.body});
      return new Response('{}', {status:200, headers:{'Content-Type':'application/json'}});
    }
    return boundaryFetch(input, options);
  }));
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

it('retains the actual structured conversation and composer nodes across fullscreen transfer and exit', async () => {
  const view = await openWorkspace(true);
  await waitFor(() => expect(view.container.querySelectorAll('.desktop-conversation-view')).toHaveLength(2));
  const nodes = [1,2].map(index => {
    const host = view.container.querySelector(`[data-pane-host="pane-${index}"]`);
    return {host, input:host.querySelector('textarea.status-composer-input'), conversation:host.querySelector('.desktop-conversation-view')};
  });
  expect(nodes.every(node => node.conversation)).toBe(true);
  fireEvent.click(nodes[0].host.querySelector('[aria-label="Fullscreen"]'));
  fireEvent.keyDown(document.body, {key:'2', metaKey:true});
  fireEvent.keyDown(document.body, {key:'Escape'});
  expect(nodes.map(({host,input,conversation}) => ({hostRetained:host.isConnected, inputRetained:host.querySelector('textarea.status-composer-input') === input, conversationRetained:host.querySelector('.desktop-conversation-view') === conversation, draft:input.value}))).toEqual([R1.a,R1.b].map(item => ({hostRetained:true,inputRetained:true,conversationRetained:true,draft:item.text})));
  expect({sent:fixture.sendCalls(), socketWrites:fixture.socketWrites}).toEqual({sent:[],socketWrites:[]});
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

it('keyboard focus in pane B makes Close target B', async () => {
  const view = await openWorkspace(true);
  const button = view.container.querySelector('[data-pane-host="pane-2"] [aria-label="Reconnect terminal"]');
  button.focus();
  expect(button).toHaveFocus();
  fireEvent.keyDown(button, { key:'w', metaKey:true });
  await waitFor(() => expect(fixture.fetchCalls.some(call => call.method === 'DELETE')).toBe(true));
  expect(fixture.fetchCalls.filter(call => call.method === 'DELETE').map(call => call.path)).toEqual([`/api/structured/sessions/${R1.b.id}`]);
});

it('a pending history reopen cannot restore focus to a closed pane', async () => {
  const view = await openWorkspace(true);
  const previousFetch = globalThis.fetch;
  const json = body => new Response(JSON.stringify(body), {status:200, headers:{'Content-Type':'application/json'}});
  let resolveThread;
  globalThis.fetch = vi.fn((input, options = {}) => {
    const url = new URL(String(input), window.location.href);
    if (url.pathname === '/api/workspace/history') return Promise.resolve(json([{sessionId:R1.b.id, title:'Synthetic saved B', kind:'structured', updatedAt:'2026-10-17T10:00:00Z'}]));
    if (url.pathname === '/api/workspace/native-history/imports') return Promise.resolve(json([]));
    if (url.pathname === '/api/workspace/git/status') return Promise.resolve(json({}));
    if (url.pathname === `/api/structured/sessions/${R1.b.id}/thread` && options.method === 'PATCH') return new Promise(resolve => { resolveThread = () => resolve(json({thread:{archived:false}})); });
    return previousFetch(input, options);
  });
  fireEvent.keyDown(document.body, {key:'2', metaKey:true});
  fireEvent.click(screen.getByRole('button', {name:'Project tools', exact:true}));
  fireEvent.click(screen.getByRole('tab', {name:'History', exact:true}));
  fireEvent.click(await screen.findByRole('button', {name:/Synthetic saved B/}));
  await waitFor(() => expect(resolveThread).toBeTypeOf('function'));
  fireEvent.click(screen.getByRole('button', {name:'Close workspace tools', exact:true}));
  fireEvent.click(view.container.querySelector('[data-pane-host="pane-2"] [aria-label="Close pane"]'));
  expect(view.container.querySelector('[data-pane-host="pane-2"]')).toBeNull();
  await act(async () => { resolveThread(); });
  const saved = JSON.parse(getEnvironmentStorage().getItem('desktops'));
  const layout = saved.desktops.find(item => item.id === saved.activeDesktopId).paneLayout;
  const visibleDrafts = [...view.container.querySelectorAll('[data-pane-host]')].filter(host => host.style.display !== 'none').map(host => host.querySelector('textarea.status-composer-input')?.value);
  fireEvent.keyDown(document.body, {key:'\\', metaKey:true});
  const observed = {activePaneId:layout.activePaneId, root:layout.root, selectedSessionId:getEnvironmentStorage().getItem('lastActiveSession'), visibleDrafts, fullscreenControlPresent:Boolean(screen.queryByRole('button', {name:'Exit fullscreen', exact:true}))};
  console.info('R2 delayed-history observation', JSON.stringify(observed));
  expect(observed).toMatchObject({activePaneId:'pane-1', visibleDrafts:[R1.b.text], fullscreenControlPresent:true});
});

it('Close from System Resources does not delete the covered conversation', async () => {
  const view = await openWorkspace(true);
  fireEvent.click(screen.getByRole('button', {name:'Settings', exact:true}));
  fireEvent.click(await screen.findByRole('button', {name:'Processes', exact:true}));
  fireEvent.click(screen.getByRole('button', {name:'Open System Resources', exact:true}));
  const resources = await screen.findByRole('region', {name:'System Resources', exact:true});
  expect(view.container.querySelector('main.main-content')).toHaveAttribute('inert');
  resources.focus();
  fireEvent.keyDown(resources, {key:'w', metaKey:true});
  expect(fixture.fetchCalls.filter(call => call.method === 'DELETE')).toEqual([]);
});
