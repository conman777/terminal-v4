import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import App from './App.jsx';
import { installSelectionPaneR1Fixture, R1 } from './test/selectionPaneR1Fixture.js';
import { getEnvironmentStorage } from './utils/remoteEnvironments.js';
const observedLayout = vi.hoisted(() => ({ current: null }));
vi.mock('./contexts/PaneLayoutContext.jsx', async importOriginal => {
  const original = await importOriginal();
  return { ...original, usePaneLayout: (...args) => {
    const value = original.usePaneLayout(...args);
    observedLayout.current = value;
    return value;
  } };
});
let fixture;
afterEach(() => { cleanup(); fixture?.restore(); vi.restoreAllMocks(); });
async function openWorkspace(split = false) {
  fixture = installSelectionPaneR1Fixture();
  const boundaryFetch = globalThis.fetch;
  const BoundarySocket = globalThis.WebSocket;
  function ReviewSocket(url) {
    if (new URL(url).pathname === '/api/latency/ws') return { readyState: 0, close() {}, send() {}, addEventListener() {}, removeEventListener() {} };
    return new BoundarySocket(url);
  }
  Object.assign(ReviewSocket, { CONNECTING:0, OPEN:1, CLOSING:2, CLOSED:3 });
  vi.stubGlobal('WebSocket', ReviewSocket);
  vi.stubGlobal('fetch', vi.fn(async (input, options = {}) => {
    const url = new URL(String(input), window.location.href);
    const json = body => new Response(JSON.stringify(body), {status:200, headers:{'Content-Type':'application/json'}});
    if (url.pathname === '/api/system/stats/history') return json([]);
    if (url.pathname === '/api/system/stats') return json({stats:null});
    if (url.pathname === '/api/health') return json({status:'synthetic'});
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
function layoutSnapshot() {
  const state = JSON.parse(getEnvironmentStorage().getItem('desktops'));
  return state.desktops.find(item => item.id === state.activeDesktopId).paneLayout;
}
function deletedIds() {
  return fixture.fetchCalls.filter(call => call.method === 'DELETE').map(call => call.path);
}
it('same-task native focus in B followed by fullscreen shows B', async () => {
  const view = await openWorkspace(true);
  const button = view.container.querySelector('[data-pane-host="pane-2"] [aria-label="Reconnect terminal"]');
  act(() => {
    button.focus();
    button.dispatchEvent(new KeyboardEvent('keydown', {key:'\\', metaKey:true, bubbles:true, cancelable:true}));
  });
  expect(observedLayout.current.fullscreenPaneId).toBe('pane-2');
});
it('Escape from foreground Resources preserves background fullscreen ownership', async () => {
  const view = await openWorkspace(true);
  fireEvent.click(view.container.querySelector('[data-pane-host="pane-2"] [aria-label="Fullscreen"]'));
  expect(observedLayout.current.fullscreenPaneId).toBe('pane-2');
  fireEvent.click(screen.getByRole('button',{name:'Settings',exact:true}));
  fireEvent.click(await screen.findByRole('button',{name:'Processes',exact:true}));
  fireEvent.click(screen.getByRole('button',{name:'Open System Resources',exact:true}));
  const resources=await screen.findByRole('region',{name:'System Resources',exact:true});
  act(()=>resources.focus());
  fireEvent.keyDown(resources,{key:'Escape'});
  expect({resourcesPresent:resources.isConnected,fullscreen:observedLayout.current.fullscreenPaneId,deleted:deletedIds()}).toEqual({resourcesPresent:true,fullscreen:'pane-2',deleted:[]});
});
