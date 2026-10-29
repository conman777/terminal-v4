import { vi } from 'vitest';
import { clearTokens, setAuthInitializing } from '../utils/auth';
import { resolveApiBase, resolveHomeApiUrl, resolveWebSocketUrl } from '../utils/apiBase';
import { getEnvironmentStorage, setActiveEnvironment, setEnvironmentIdentity } from '../utils/remoteEnvironments';

// Proposed target: frontend/src/test/selectionPaneR1Fixture.js.
// These are declared synthetic records, never a real account or workspace.
export const R1 = Object.freeze({
  owner: 'selection-pane-r1-synthetic-owner',
  username: 'selection-pane-r1',
  password: 'synthetic-password-not-a-secret',
  cwd: '/synthetic/selection-pane-r1',
  provider: 'deepseek',
  model: 'deepseek-v4-flash',
  a: Object.freeze({ id: 'ss-selection-pane-r1-a', topic: 'R1 amber notebook', text: 'R1 draft A: amber notebook', revision: 'a1111111-1111-4111-8111-111111111111' }),
  b: Object.freeze({ id: 'ss-selection-pane-r1-b', topic: 'R1 violet notebook', text: 'R1 draft B: violet notebook', revision: 'b2222222-2222-4222-8222-222222222222' }),
});

const snapshot = item => ({
  id: item.id, title: item.topic, provider: R1.provider, model: R1.model,
  runtime: 'v4', status: 'idle', cwd: R1.cwd,
  createdAt: '2026-10-17T10:00:00Z', updatedAt: '2026-10-17T10:00:00Z',
  thread: { topic: item.topic, projectPath: R1.cwd, pinned: false, archived: false },
  latestSeq: 0, statusSeq: 0,
});
const inventory = [snapshot(R1.a), snapshot(R1.b)];
const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { 'Content-Type': 'application/json' },
});
const jwt = () => ['eyJhbGciOiJub25lIn0', btoa(JSON.stringify({ sub: R1.owner, exp: 4102444800 })).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_'), 'synthetic'].join('.');
const readStorage = storage => Array.from({ length: storage.length }, (_, index) => {
  const key = storage.key(index); return [key, storage.getItem(key)];
});
const restoreStorage = (storage, entries) => { storage.clear(); for (const [key, value] of entries) storage.setItem(key, value); };

export function installSelectionPaneR1Fixture() {
  const savedLocal = readStorage(localStorage), savedSession = readStorage(sessionStorage);
  const priorWidth = Object.getOwnPropertyDescriptor(window, 'innerWidth');
  const priorHtmlAttributes = [...document.documentElement.attributes].map(attribute => [attribute.name, attribute.value]);
  const fetchCalls = [], socketWrites = [], unexpected = [], sockets = new Set();
  let disposed = false;
  const urlFor = path => new URL(resolveHomeApiUrl(path), window.location.href);
  const apiRoot = urlFor('/');
  const user = { id: R1.owner, username: R1.username };
  const settings = {
    terminalFontSize: 14, terminalWebglEnabled: false, desktopAllowTerminalInput: false,
    sidebarCollapsed: false, recentFolders: [R1.cwd], pinnedFolders: [],
    sidebarProjects: [{ path: R1.cwd, name: 'selection-pane-r1' }], previewUrl: null,
  };

  localStorage.clear(); sessionStorage.clear(); clearTokens(true); setAuthInitializing(false);
  setEnvironmentIdentity(R1.owner, new URL(resolveApiBase() || window.location.origin, window.location.origin).origin);
  setActiveEnvironment(null);
  const storage = getEnvironmentStorage();
  const draftHome = new URL(resolveHomeApiUrl('/'), window.location.origin).href.replace(/\/$/, '');
  for (const item of [R1.a, R1.b]) {
    storage.setItem(`composerDraft:v1:${encodeURIComponent(draftHome)}:${item.id}`, JSON.stringify({
      version: 1, home: draftHome, sessionId: item.id, text: item.text, revision: item.revision, pending: null,
    }));
  }
  storage.setItem('lastActiveSession', R1.a.id);
  storage.setItem('tabOrder', JSON.stringify([R1.a.id, R1.b.id]));
  storage.setItem('recentFolders', JSON.stringify([R1.cwd]));
  // Avoid unrelated dictionary I/O; neither draft contains an edit in this test.
  localStorage.setItem('autocorrectEnabled', 'false');
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1440 });
  const focusSpy = vi.spyOn(document, 'hasFocus').mockReturnValue(true);
  const hiddenSpy = vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
  const visibilitySpy = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');

  // Explicit unavailable native storage boundary. The real facade preserves its
  // seeded raw text and renders its real storage error. No persistence proof.
  vi.stubGlobal('indexedDB', undefined);
  vi.stubGlobal('BroadcastChannel', undefined);

  vi.stubGlobal('fetch', vi.fn(async (input, options = {}) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url, window.location.href);
    const method = String(options.method || input?.method || 'GET').toUpperCase();
    const call = { method, url: url.href, path: url.pathname, body: options.body };
    fetchCalls.push(call);
    if (options.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    if (url.origin !== apiRoot.origin || !url.pathname.startsWith(apiRoot.pathname)) {
      unexpected.push(call); throw new Error(`R1 blocked unlisted network boundary: ${method} ${url.href}`);
    }
    const route = '/' + url.pathname.slice(apiRoot.pathname.length);
    if (method === 'POST' && route === '/api/auth/login') {
      const body = JSON.parse(options.body);
      if (body.username !== R1.username || body.password !== R1.password) return json({ error: 'Synthetic login mismatch' }, 401);
      return json({ user, tokens: { accessToken: jwt(), refreshToken: 'synthetic-r1-refresh' } });
    }
    if (method === 'POST' && route === '/api/preview/session') return json({});
    if (method === 'GET' && route === '/api/auth/me') return json(user);
    if (method === 'GET' && route === '/api/auth/mode') return json({mode:'password'});
    if (method === 'GET' && route === '/api/environments') return json({ environments: [] });
    if (method === 'GET' && route === '/api/terminal') return json({ sessions: [] });
    if (method === 'GET' && route === '/api/structured/input-capabilities' && !url.search) return json({ error: 'Not found' }, 404);
    if (method === 'GET' && route === '/api/structured/owner-cleanup' && !url.search) return json({ error: 'Not found' }, 404);
    if (method === 'GET' && /^\/api\/structured\/sessions\/[^/]+\/input-capabilities$/.test(route) && !url.search) return json({ error: 'Not found' }, 404);
    if (method === 'GET' && route === '/api/structured/sessions' && url.search === '?view=inventory') return json(inventory);
    if (method === 'GET' && route === '/api/thread-order' && !url.search) return json({ revision: 0, projects: {} });
    if (method === 'GET' && route === '/api/state') return json({ sessions: [], projectInfo: null });
    if (method === 'GET' && route === '/api/settings') return json(settings);
    if (method === 'PATCH' && route === '/api/settings') return json({});
    if (method === 'GET' && route === '/api/projects/scan') return json({ projects: [] });
    if (method === 'GET' && route === '/api/notes') return json({ notes: [] });
    if (method === 'GET' && route === '/api/workspace-browser/approvals') return json({ requests: [] });
    if (method === 'GET' && route === '/api/bookmarks') return json({ bookmarks: [] });
    if (method === 'GET' && route === '/api/preview/active-ports') return json({ ports: [] });
    if (method === 'GET' && route === '/api/system/preview-config') return json({ preferPathBased: true, defaultMode: 'path-first' });
    if (method === 'POST' && route === '/api/workspace/git/branches') return json({ branches: {} });
    if (method === 'GET' && route === '/api/system/editors') return json({ editors: [] });
    if (method === 'GET' && route === '/api/workspace/skills') return json({ skills: [], warnings: [] });
    if (method === 'GET' && route === '/api/system/doctor') return json({ ready: true, agentReady: true, checks: [] });
    if (method === 'GET' && route === '/api/workspace/git/status') return json({ branch: 'main', files: [] });
    if (method === 'GET' && route === '/api/workspace/git/pull-request') return json({ pullRequest: null });
    if (method === 'GET' && /^\/api\/structured\/sessions\/[^/]+\/turn-changes$/.test(route)) return json({ turns: {} });
    if (method === 'GET' && route === '/api/agent/catalog') return json({ agents: [{
      id: R1.provider, runtime: 'v4', available: true,
      models: [{ id: R1.model, label: R1.model, default: true, imageInput: true }],
    }] });
    unexpected.push(call);
    throw new Error(`R1 unlisted API boundary: ${method} ${route}`);
  }));

  class R1Socket {
    static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3;
    constructor(url) {
      this.url = String(url); this.readyState = R1Socket.CONNECTING;
      this.listeners = new Map();
      const actual = new URL(this.url);
      const expected = [R1.a, R1.b].map(item => new URL(resolveWebSocketUrl(`/api/structured/sessions/${item.id}/ws`)));
      if (!expected.some(value => value.origin === actual.origin && value.pathname === actual.pathname)) {
        unexpected.push({ method: 'WebSocket', url: this.url });
        throw new Error(`R1 unlisted WebSocket boundary: ${this.url}`);
      }
      sockets.add(this);
      // Network-port delivery only; no React scheduling hook, timer or delay.
      queueMicrotask(() => {
        if (disposed || this.readyState !== R1Socket.CONNECTING) return;
        this.readyState = R1Socket.OPEN; this.deliver('open', new Event('open'));
      });
    }
    addEventListener(type, listener) { const list = this.listeners.get(type) || new Set(); list.add(listener); this.listeners.set(type, list); }
    removeEventListener(type, listener) { this.listeners.get(type)?.delete(listener); }
    deliver(type, event) { this[`on${type}`]?.(event); for (const listener of this.listeners.get(type) || []) listener(event); }
    send(data) { if (this.readyState !== R1Socket.OPEN) throw new Error('Synthetic socket is not open'); socketWrites.push({ url: this.url, data }); }
    close() {
      if (this.readyState === R1Socket.CLOSED) return;
      this.readyState = R1Socket.CLOSED; sockets.delete(this);
      this.deliver('close', { code: 1000, wasClean: true });
    }
  }
  vi.stubGlobal('WebSocket', R1Socket);

  return {
    fetchCalls, socketWrites, unexpected,
    sendCalls: () => fetchCalls.filter(call => call.method === 'POST' && /\/(?:input|attachments\/send|attachments)$/.test(call.path)),
    restore() {
      disposed = true;
      for (const socket of [...sockets]) socket.close();
      // Caller must unmount the real App first, so cleanup cannot notify it.
      setActiveEnvironment(null); setEnvironmentIdentity(null); clearTokens(true); setAuthInitializing(false);
      focusSpy.mockRestore(); hiddenSpy.mockRestore(); visibilitySpy.mockRestore(); vi.unstubAllGlobals();
      if (priorWidth) Object.defineProperty(window, 'innerWidth', priorWidth); else delete window.innerWidth;
      for (const attribute of [...document.documentElement.attributes]) document.documentElement.removeAttribute(attribute.name);
      for (const [name, value] of priorHtmlAttributes) document.documentElement.setAttribute(name, value);
      restoreStorage(localStorage, savedLocal); restoreStorage(sessionStorage, savedSession);
    },
  };
}
