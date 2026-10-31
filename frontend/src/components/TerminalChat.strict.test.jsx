import { act, render } from '@testing-library/react';
import { useLayoutEffect } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TerminalChat } from './TerminalChat';
import { setActiveEnvironment } from '../utils/remoteEnvironments';

const fx = vi.hoisted(() => ({ terms: [], sockets: [], requests: [], legacy: vi.fn(), restore: vi.fn(), upload: vi.fn(), register: vi.fn(), expired: false }));
vi.mock('@xterm/xterm', () => ({ Terminal: class {
  constructor(options) { this.options = options; this.rows = 24; this.cols = 80; this.unicode = {}; this.text = ''; const active = { baseY: 0, viewportY: 0, cursorX: 0, cursorY: 0, type: 'normal', length: 24, getLine: () => ({ translateToString: () => '' }) }; this.buffer = { active, normal: active }; fx.terms.push(this); }
  open(container) { this.element = document.createElement('div'); this.textarea = document.createElement('textarea'); this.element.append(this.textarea); container.append(this.element); }
  write(text, done) { this.text += text; done?.(); } reset() { this.text = ''; }
  onData(fn) { this.data = fn; return { dispose() {} }; } onResize() { return { dispose() {} }; } onScroll() { return { dispose() {} }; }
  attachCustomKeyEventHandler() {} attachCustomWheelEventHandler() {} loadAddon() {} focus() {} blur() {} refresh() {} resize() {} dispose() {}
  registerLinkProvider() { return { dispose() {} }; } hasSelection() { return false; } getSelection() { return ''; } scrollLines() {} scrollToBottom() {}
} }));
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class { fit() {} proposeDimensions() { return { cols: 80, rows: 24 }; } } }));
vi.mock('@xterm/addon-unicode11', () => ({ Unicode11Addon: class {} }));
vi.mock('@xterm/addon-web-links', () => ({ WebLinksAddon: class {} }));
vi.mock('@xterm/addon-webgl', () => ({ WebglAddon: class { dispose() {} onContextLoss() {} } }));
vi.mock('../contexts/ThemeContext', () => ({ useTheme: () => ({ theme: 'dark' }) }));
vi.mock('../contexts/AutocorrectContext', () => ({ useAutocorrect: () => ({ autocorrectEnabled: false }) }));
vi.mock('../contexts/TerminalSessionContext', () => ({ useTerminalSession: () => ({ activeSessionId: 'strict-terminal', sessions: [], restoreSession: fx.restore, registerTerminalSender: fx.register }) }));
vi.mock('../hooks/useMobileDetect', () => ({ useMobileDetect: () => false }));
vi.mock('../hooks/useIdleDetection', () => ({ useIdleDetection: () => ({ hasUserInputRef: { current: false }, markUserInput() {}, resetUserInput() {}, resetIdleTimer() {}, cleanup() {} }) }));
vi.mock('../hooks/useFaviconFlash', () => ({ useFaviconFlash: () => ({ startFaviconFlash() {}, stopFaviconFlash() {} }) }));
vi.mock('../utils/auth', async original => ({ ...(await original()), getAccessToken: () => { fx.legacy(); return 'legacy-token'; }, isAccessTokenExpired: () => fx.expired, refreshTokens: (...args) => fx.legacy(...args) }));
vi.mock('../utils/api', () => ({ uploadScreenshot: (...args) => fx.upload(...args), apiFetch: async (url, options) => { fx.requests.push({ url, options }); return { ok: true, status: 200, json: async () => ({ history: [], currentCols: 80, currentRows: 24 }) }; } }));
vi.mock('../utils/strictAuthenticatedFetch', () => ({ readStrictResponseMetadata: async response => ({ ok: response.ok, status: response.status }), validateStrictResponse: async () => {} }));

const base = { sessionId: 'strict-terminal', surface: 'desktop', isPrimary: true, fontSize: 14, webglEnabled: false };
const scope = (overrides = {}) => ({ status: 'active', incarnation: 'browser-a', controlRevision: 'control-a', user: { id: 'account-a' }, pair: { owner: 'account-a', session: 'session-a', home: new URL('/', window.location.origin).href, accessToken: 'strict-token' }, ...overrides });
async function tick(ms = 200) { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); }
function open(socket) { act(() => socket.open()); }
function message(socket, data) { act(() => socket.message(data)); }

describe('TerminalChat strict socket authentication', () => {
  beforeEach(() => {
    vi.useFakeTimers(); fx.terms = []; fx.sockets = []; fx.requests = []; fx.legacy.mockReset(); fx.restore.mockReset(); fx.upload.mockReset(); fx.register.mockReset(); fx.expired = false;
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ width: 800, height: 600, top: 0, left: 0, bottom: 600, right: 800 });
    vi.spyOn(document, 'hasFocus').mockReturnValue(true); vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible'); vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
    vi.stubGlobal('WebSocket', class {
      static OPEN = 1; static CONNECTING = 0; static CLOSED = 3; static CLOSING = 2;
      constructor(url) { this.url = url; this.readyState = 0; this.sent = []; fx.sockets.push(this); }
      send(data) { this.sent.push(data); } open() { this.readyState = 1; this.onopen?.(); } message(data) { this.onmessage?.({ data }); } close() { this.readyState = 3; this.closed = true; }
    });
  });
  afterEach(() => { setActiveEnvironment(null); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

  it('preserves legacy socket authentication when strict props are absent', async () => {
    render(<TerminalChat {...base} />); await tick(); open(fx.sockets[0]); await tick();
    expect(fx.sockets[0].sent).toContain(JSON.stringify({ type: 'auth', token: 'legacy-token' }));
  });

  it('does not send through a retained legacy terminal callback during a strict-mode commit', async () => {
    let oldSender;
    fx.register.mockImplementation((_id, sender) => { oldSender = sender; });
    function Surface({ strict }) {
      useLayoutEffect(() => { if (strict) oldSender('stale terminal input\r'); }, [strict]);
      return <TerminalChat {...base} {...(strict ? { authLifecycle: undefined, strictReady: false } : {})} />;
    }
    const view = render(<Surface strict={false} />); await tick(); open(fx.sockets[0]); await tick();
    message(fx.sockets[0], JSON.stringify({ type: 'clientId', clientId: '11111111-1111-4111-8111-111111111111' })); await tick();
    expect(oldSender).toBeTypeOf('function');
    view.rerender(<Surface strict />); await tick();
    expect(fx.sockets[0].sent).not.toContain('stale terminal input\r');
    expect(fx.requests.filter(request => request.url.endsWith('/input'))).toEqual([]);
  });

  it('fails closed when strict authority or readiness is unavailable', async () => {
    render(<TerminalChat {...base} authLifecycle={null} strictReady={false} />); await tick();
    expect([fx.sockets.length, fx.legacy.mock.calls.length, fx.requests.length]).toEqual([0, 0, 0]);
  });

  it('does not use legacy credentials when an undefined authority is explicitly supplied', async () => {
    render(<TerminalChat {...base} authLifecycle={undefined} strictReady />); await tick();
    expect([fx.sockets.length, fx.legacy.mock.calls.length, fx.requests.length]).toEqual([0, 0, 0]);
  });

  it('authenticates with the strict token and uses strict HTTP for history and resize', async () => {
    const lifecycle = { read: vi.fn().mockResolvedValue(scope()), refresh: vi.fn() };
    render(<TerminalChat {...base} authLifecycle={lifecycle} strictReady />); await tick(); open(fx.sockets[0]); await tick();
    message(fx.sockets[0], JSON.stringify({ type: 'clientId', clientId: '11111111-1111-4111-8111-111111111111' })); await tick();
    expect(fx.sockets[0].sent).toContain(JSON.stringify({ type: 'auth', token: 'strict-token' }));
    expect(fx.legacy).not.toHaveBeenCalled();
    expect(fx.requests.length).toBeGreaterThan(0);
    expect(fx.requests.every(request => request.options?.authLifecycle === lifecycle)).toBe(true);
  });

  it('never sends old credentials when login changes while the socket is opening', async () => {
    let current = scope(); const lifecycle = { read: vi.fn(async () => current), refresh: vi.fn() };
    render(<TerminalChat {...base} authLifecycle={lifecycle} strictReady />); await tick();
    current = scope({ incarnation: 'browser-b', controlRevision: 'control-b', user: { id: 'account-b' }, pair: { owner: 'account-b', session: 'session-b', home: new URL('/', window.location.origin).href, accessToken: 'new-token' } });
    open(fx.sockets[0]); await tick();
    expect([fx.sockets[0].sent, fx.sockets[0].closed, fx.legacy.mock.calls.length]).toEqual([[], true, 0]);
  });

  it('closes without falling back when sending the strict auth frame fails', async () => {
    const lifecycle = { read: vi.fn().mockResolvedValue(scope()), refresh: vi.fn() };
    render(<TerminalChat {...base} authLifecycle={lifecycle} strictReady />); await tick();
    fx.sockets[0].send = () => { throw new Error('synthetic auth failure'); };
    open(fx.sockets[0]); await tick();
    expect([fx.sockets[0].closed, fx.legacy.mock.calls.length]).toEqual([true, 0]);
  });

  it('drops socket output and input after the originating login changes', async () => {
    let current = scope(); const onOutputChunk = vi.fn(); const lifecycle = { read: vi.fn(async () => current), refresh: vi.fn() };
    render(<TerminalChat {...base} authLifecycle={lifecycle} strictReady onOutputChunk={onOutputChunk} />); await tick(); open(fx.sockets[0]); await tick();
    message(fx.sockets[0], JSON.stringify({ type: 'clientId', clientId: '11111111-1111-4111-8111-111111111111' })); await tick();
    current = scope({ controlRevision: 'control-b' });
    message(fx.sockets[0], 'OLD_PRIVATE_OUTPUT'); act(() => fx.terms[0].data('old input\r')); await tick();
    expect([onOutputChunk.mock.calls.flat().includes('OLD_PRIVATE_OUTPUT'), fx.sockets[0].sent.includes('old input\r'), fx.sockets[0].closed]).toEqual([false, false, true]);
  });

  it('closes rather than retaining oversized terminal output during an authority check', async () => {
    const onOutputChunk = vi.fn();
    const lifecycle = { read: vi.fn().mockResolvedValue(scope()), refresh: vi.fn() };
    render(<TerminalChat {...base} authLifecycle={lifecycle} strictReady onOutputChunk={onOutputChunk} />); await tick(); open(fx.sockets[0]); await tick();
    let release;
    lifecycle.read.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    message(fx.sockets[0], 'X'.repeat(5 * 1024 * 1024));
    expect(fx.sockets[0].closed).toBe(true);
    if (release) await act(async () => release(scope()));
    await tick();
    expect(onOutputChunk).not.toHaveBeenCalled();
  });

  it('bounds total queued terminal output while an authority check is pending', async () => {
    const onOutputChunk = vi.fn();
    const lifecycle = { read: vi.fn().mockResolvedValue(scope()), refresh: vi.fn() };
    render(<TerminalChat {...base} authLifecycle={lifecycle} strictReady onOutputChunk={onOutputChunk} />); await tick(); open(fx.sockets[0]); await tick();
    let release;
    lifecycle.read.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    message(fx.sockets[0], 'X'.repeat(2 * 1024 * 1024));
    message(fx.sockets[0], new Blob([new Uint8Array(4 * 1024 * 1024)]));
    expect(fx.sockets[0].closed).not.toBe(true);
    message(fx.sockets[0], new ArrayBuffer(1));
    expect(fx.sockets[0].closed).toBe(true);
    await act(async () => release(scope())); await tick();
    expect(onOutputChunk).not.toHaveBeenCalled();
  });

  it('keeps terminal input in order while strict checks are asynchronous', async () => {
    const lifecycle = { read: vi.fn().mockResolvedValue(scope()), refresh: vi.fn() };
    render(<TerminalChat {...base} authLifecycle={lifecycle} strictReady />); await tick(); open(fx.sockets[0]); await tick();
    message(fx.sockets[0], JSON.stringify({ type: 'clientId', clientId: '11111111-1111-4111-8111-111111111111' })); await tick();
    const waits = [];
    lifecycle.read.mockImplementation(() => new Promise(resolve => waits.push(resolve)));
    act(() => { fx.terms[0].data('first\r'); fx.terms[0].data('second\r'); }); await tick();
    expect(waits).toHaveLength(1);
    await act(async () => { waits.shift()(scope()); }); await tick();
    expect(waits).toHaveLength(1);
    await act(async () => { waits.shift()(scope()); }); await tick();
    expect(fx.sockets[0].sent.slice(-2)).toEqual(['first\r', 'second\r']);
  });

  it('reports an unconfirmed outcome when the socket throws while sending input', async () => {
    const lifecycle = { read: vi.fn().mockResolvedValue(scope()), refresh: vi.fn() };
    const view = render(<TerminalChat {...base} authLifecycle={lifecycle} strictReady />); await tick(); open(fx.sockets[0]); await tick();
    message(fx.sockets[0], JSON.stringify({ type: 'clientId', clientId: '11111111-1111-4111-8111-111111111111' })); await tick();
    fx.sockets[0].send = () => { throw new Error('synthetic send failure'); };
    act(() => fx.terms[0].data('possibly-sent\r')); await tick();
    expect(view.getByRole('alert').textContent).toMatch(/outcome is unconfirmed/i);
  });

  it('does not fall back to legacy HTTP input while the strict socket is disconnected', async () => {
    const lifecycle = { read: vi.fn().mockResolvedValue(scope()), refresh: vi.fn() };
    const view = render(<TerminalChat {...base} authLifecycle={lifecycle} strictReady />); await tick();
    act(() => fx.terms[0].data('no-fallback\r')); await tick();
    expect(view.getByRole('alert').textContent).toMatch(/authentication is unavailable/i);
    expect(fx.requests.filter(request => request.url.endsWith('/input'))).toEqual([]);
    expect(fx.legacy).not.toHaveBeenCalled();
  });

  it('does not open a socket after the component unmounts during authentication', async () => {
    let release; const lifecycle = { read: vi.fn(() => new Promise(resolve => { release = resolve; })), refresh: vi.fn() };
    const view = render(<TerminalChat {...base} authLifecycle={lifecycle} strictReady />); await tick(); view.unmount();
    await act(async () => { release(scope()); }); await tick(); expect(fx.sockets).toEqual([]);
  });

  it('closes rather than processing a socket message received before authentication', async () => {
    let release; const onOutputChunk = vi.fn();
    const lifecycle = { read: vi.fn().mockResolvedValueOnce(scope()).mockImplementationOnce(() => new Promise(resolve => { release = resolve; })), refresh: vi.fn() };
    render(<TerminalChat {...base} authLifecycle={lifecycle} strictReady onOutputChunk={onOutputChunk} />); await tick(); open(fx.sockets[0]); await tick();
    message(fx.sockets[0], 'UNAUTHENTICATED_OUTPUT'); await act(async () => { release(scope()); }); await tick();
    expect([fx.sockets[0].closed, fx.sockets[0].sent, onOutputChunk.mock.calls.flat().includes('UNAUTHENTICATED_OUTPUT')]).toEqual([true, [], false]);
  });

  it('refreshes only the originating strict login before opening the socket', async () => {
    let current = scope(); fx.expired = true;
    const lifecycle = { read: vi.fn(async () => current), refresh: vi.fn(async () => { current = scope({ pair: { ...scope().pair, accessToken: 'strict-rotated' } }); return { status: 'active' }; }) };
    render(<TerminalChat {...base} authLifecycle={lifecycle} strictReady />); await tick(); open(fx.sockets[0]); await tick();
    expect(lifecycle.refresh).toHaveBeenCalledWith({ incarnation: 'browser-a', owner: 'account-a', session: 'session-a', home: scope().pair.home }, { signal: expect.any(AbortSignal) });
    expect(fx.sockets[0].sent).toContain(JSON.stringify({ type: 'auth', token: 'strict-rotated' }));
    expect(fx.legacy).not.toHaveBeenCalled();
  });

  it('does not open a socket if another login wins while strict refresh is pending', async () => {
    fx.expired = true; let current = scope(); let release;
    const lifecycle = { read: vi.fn(async () => current), refresh: vi.fn(() => new Promise(resolve => { release = resolve; })) };
    render(<TerminalChat {...base} authLifecycle={lifecycle} strictReady />); await tick();
    current = scope({ incarnation: 'browser-b', controlRevision: 'control-b' });
    await act(async () => { release({ status: 'active' }); }); await tick();
    expect([fx.sockets.length, fx.legacy.mock.calls.length]).toEqual([0, 0]);
  });

  it('aborts pending strict authentication and ignores late completion when readiness changes', async () => {
    let release; const lifecycle = { read: vi.fn().mockResolvedValueOnce(scope()).mockImplementationOnce(() => new Promise(resolve => { release = resolve; })), refresh: vi.fn() };
    const view = render(<TerminalChat {...base} authLifecycle={lifecycle} strictReady />); await tick(); open(fx.sockets[0]); await tick();
    view.rerender(<TerminalChat {...base} authLifecycle={lifecycle} strictReady={false} />);
    await act(async () => { release(scope()); }); await tick();
    expect([fx.sockets[0].sent, fx.sockets[0].closed, fx.legacy.mock.calls.length]).toEqual([[], true, 0]);
  });

  it('aborts a pending refresh when the terminal unmounts', async () => {
    fx.expired = true; let signal; let release;
    const lifecycle = { read: vi.fn().mockResolvedValue(scope()), refresh: vi.fn((_scope, options) => { signal = options.signal; return new Promise(resolve => { release = resolve; }); }) };
    const view = render(<TerminalChat {...base} authLifecycle={lifecycle} strictReady />); await tick();
    view.unmount(); expect(signal.aborted).toBe(true);
    await act(async () => { release({ status: 'active' }); }); await tick();
    expect([fx.sockets.length, fx.legacy.mock.calls.length]).toEqual([0, 0]);
  });

  it('closes the originating socket on an environment switch and ignores its late output', async () => {
    const onOutputChunk = vi.fn(); const lifecycle = { read: vi.fn().mockResolvedValue(scope()), refresh: vi.fn() };
    render(<TerminalChat {...base} authLifecycle={lifecycle} strictReady onOutputChunk={onOutputChunk} />); await tick(); open(fx.sockets[0]); await tick();
    act(() => setActiveEnvironment({ id: 'synthetic-remote' })); message(fx.sockets[0], 'STALE_OUTPUT'); await tick();
    expect([fx.sockets[0].closed, onOutputChunk.mock.calls.flat().includes('STALE_OUTPUT'), fx.legacy.mock.calls.length]).toEqual([true, false, 0]);
  });

  it('responds to strict authority notifications and unsubscribes on unmount', async () => {
    let current = scope(); let notify; const unsubscribe = vi.fn();
    const lifecycle = { read: vi.fn(async () => current), refresh: vi.fn(), subscribe: vi.fn(listener => { notify = listener; return unsubscribe; }) };
    const view = render(<TerminalChat {...base} authLifecycle={lifecycle} strictReady />); await tick(); open(fx.sockets[0]); await tick();
    current = scope({ controlRevision: 'changed' });
    act(() => notify({ status: 'changed' })); await tick(); expect(fx.sockets[0].closed).toBe(true);
    view.unmount(); expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('closes the socket if strict authority notifications become unavailable', async () => {
    let notify; const lifecycle = { read: vi.fn().mockResolvedValue(scope()), refresh: vi.fn(), subscribe: vi.fn(listener => { notify = listener; return () => {}; }) };
    render(<TerminalChat {...base} authLifecycle={lifecycle} strictReady />); await tick(); open(fx.sockets[0]); await tick();
    act(() => notify({ status: 'unavailable' })); await tick(); expect(fx.sockets[0].closed).toBe(true);
  });

  it.each([{ code: 4401, reason: 'Unauthorized' }, { code: 4404, reason: 'Terminal session not found' }])('does not use legacy refresh or restoration after close %j', async event => {
    const lifecycle = { read: vi.fn().mockResolvedValue(scope()), refresh: vi.fn() };
    render(<TerminalChat {...base} authLifecycle={lifecycle} strictReady />); await tick(); open(fx.sockets[0]); await tick();
    act(() => { fx.sockets[0].readyState = 3; fx.sockets[0].onclose(event); }); await tick();
    expect([fx.restore.mock.calls.length, fx.legacy.mock.calls.length]).toEqual([0, 0]);
  });

  it('reports unavailable image and history actions instead of invoking legacy consumers', async () => {
    let upload, history; const lifecycle = { read: vi.fn().mockResolvedValue(scope()), refresh: vi.fn() };
    const view = render(<TerminalChat {...base} authLifecycle={lifecycle} strictReady onRegisterImageUpload={fn => { upload = fn; }} onRegisterHistoryPanel={fn => { history = fn; }} />); await tick();
    act(() => upload()); expect(view.getByRole('alert').textContent).toMatch(/image uploads are unavailable/i);
    act(() => history()); expect(view.getByRole('alert').textContent).toMatch(/history panel is unavailable/i);
    expect(fx.upload).not.toHaveBeenCalled();
  });
});
