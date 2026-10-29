import { act, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TerminalChat } from './TerminalChat';
import { setActiveEnvironment } from '../utils/remoteEnvironments';

const fx = vi.hoisted(() => ({ terms: [], observers: [], requests: [], inputs: [], pendingAcks: [], deferResize: false, box: { width: 1390, height: 920, visible: true } }));
const clientId = '11111111-1111-4111-8111-111111111111';

vi.mock('@xterm/xterm', () => ({ Terminal: class {
  constructor(options) {
    this.options = options; this.cols = options.cols; this.rows = 24; this.unicode = {};
    const active = { baseY: 0, viewportY: 0, cursorX: 0, cursorY: 0, type: 'normal', length: 24, getLine: () => ({ translateToString: () => '' }) };
    this.buffer = { active, normal: active }; fx.terms.push(this);
  }
  open(container) {
    this.element = document.createElement('div'); this.textarea = document.createElement('textarea');
    this.element.append(this.textarea); container.append(this.element);
  }
  write(text, done) { done?.(); }
  reset() {}
  onData(fn) { this.data = fn; return { dispose() {} }; }
  onResize(fn) { this.resizeListener = fn; return { dispose() {} }; }
  onScroll() { return { dispose() {} }; }
  attachCustomKeyEventHandler() {} attachCustomWheelEventHandler() {}
  loadAddon(addon) { addon.activate?.(this); }
  resize(cols, rows) { this.cols = cols; this.rows = rows; this.resizeListener?.({ cols, rows }); }
  dispose() { this.disposed = true; }
  focus() {} blur() {} refresh() {} scrollToBottom() {}
  hasSelection() { return false; }
} }));
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class {
  activate(term) { this.term = term; }
  proposeDimensions() {
    const box = this.term?.element?.parentElement.getBoundingClientRect();
    return box ? { cols: Math.floor(box.width / 10), rows: Math.floor(box.height / 20) } : undefined;
  }
  fit() { const dims = this.proposeDimensions(); if (dims) this.term.resize(dims.cols, dims.rows); }
} }));
vi.mock('@xterm/addon-unicode11', () => ({ Unicode11Addon: class {} }));
vi.mock('@xterm/addon-web-links', () => ({ WebLinksAddon: class {} }));
vi.mock('@xterm/addon-webgl', () => ({ WebglAddon: class {} }));
vi.mock('../contexts/ThemeContext', () => ({ useTheme: () => ({ theme: 'dark' }) }));
vi.mock('../contexts/AutocorrectContext', () => ({ useAutocorrect: () => ({ autocorrectEnabled: false }) }));
vi.mock('../contexts/TerminalSessionContext', () => ({ useTerminalSession: () => ({ activeSessionId: 'owned-fit-fixture', sessions: [] }) }));
vi.mock('../hooks/useMobileDetect', () => ({ useMobileDetect: () => false }));
vi.mock('../hooks/useIdleDetection', () => ({ useIdleDetection: () => ({ hasUserInputRef: { current: false }, markUserInput() {}, resetUserInput() {}, resetIdleTimer() {}, cleanup() {} }) }));
vi.mock('../hooks/useFaviconFlash', () => ({ useFaviconFlash: () => ({ startFaviconFlash() {}, stopFaviconFlash() {} }) }));
vi.mock('../utils/auth', () => ({ getAccessToken: () => 'synthetic', isAccessTokenExpired: () => false, refreshTokens: async () => ({ accessToken: 'synthetic' }) }));
vi.mock('../utils/api', () => ({ uploadScreenshot: vi.fn(), apiFetch: async (url, options = {}) => {
  fx.requests.push({ url, ...options });
  if (url.endsWith('/resize')) return { ok: true, json: async () => {
    const ack = { isOwner: true, ownerClientId: '11111111-1111-4111-8111-111111111111', appliedCols: options.body.cols, appliedRows: options.body.rows };
    return fx.deferResize ? new Promise(resolve => fx.pendingAcks.push(() => resolve(ack))) : ack;
  } };
  return { ok: true, json: async () => ({ history: [], currentCols: 139, currentRows: 46 }) };
} }));

const props = { sessionId: 'owned-fit-fixture', surface: 'desktop', isPrimary: true, fontSize: 14, webglEnabled: false };
async function tick(ms = 500) { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); }
function deliverResize() {
  for (const observer of fx.observers) if (!observer.stopped) observer.callback([]);
}
function resizeRequests() { return fx.requests.filter(({ url }) => url.endsWith('/resize')); }

describe('TerminalChat retained visible pane fitting', () => {
  beforeEach(() => {
    vi.useFakeTimers(); localStorage.clear(); setActiveEnvironment(null);
    fx.terms = []; fx.observers = []; fx.requests = []; fx.inputs = []; fx.pendingAcks = []; fx.deferResize = false;
    fx.box = { width: 1390, height: 920, visible: true };
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(() => ({
      width: fx.box.visible ? fx.box.width : 0, height: fx.box.visible ? fx.box.height : 0, left: 0, top: 0,
    }));
    vi.spyOn(HTMLElement.prototype, 'getClientRects').mockImplementation(() => fx.box.visible ? [fx.box] : []);
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
    vi.stubGlobal('ResizeObserver', class {
      constructor(callback) { this.callback = callback; fx.observers.push(this); }
      observe(host) { this.host = host; this.callback([]); }
      disconnect() { this.stopped = true; }
    });
    vi.stubGlobal('WebSocket', class {
      static OPEN = 1; static CONNECTING = 0; static CLOSED = 3; static CLOSING = 2;
      constructor() {
        this.readyState = 0;
        setTimeout(() => {
          this.readyState = 1; this.onopen?.();
          this.onmessage?.({ data: JSON.stringify({ type: 'clientId', clientId: '11111111-1111-4111-8111-111111111111' }) });
        }, 5);
      }
      send(text) { if (!text.startsWith('{')) fx.inputs.push(text); }
      close() { this.readyState = 3; }
    });
    vi.stubGlobal('navigator', { platform: 'MacIntel', userAgent: 'Synthetic Mac browser', maxTouchPoints: 0, onLine: true });
  });
  afterEach(() => {
    setActiveEnvironment(null);
    vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers();
  });

  it.each([
    { axis: 'horizontal', width: 680, height: 920, cols: 68, rows: 46 },
    { axis: 'vertical', width: 1390, height: 360, cols: 139, rows: 18 },
  ])('restores the $axis PTY size when fullscreen returns the retained terminal as a visible inactive pane', async ({ width, height, cols, rows }) => {
    const view = render(<TerminalChat {...props} />);
    await tick();
    const term = fx.terms[0];
    const host = view.container.querySelector('[data-terminal]');
    const renderer = term.element;
    expect({ cols: term.cols, rows: term.rows }).toEqual({ cols: 139, rows: 46 });
    fx.box = { width, height, visible: true }; deliverResize(); await tick();
    expect({ cols: term.cols, rows: term.rows }).toEqual({ cols, rows });
    fx.box = { width: 1390, height: 920, visible: true }; deliverResize(); await tick();
    expect({ cols: term.cols, rows: term.rows }).toEqual({ cols: 139, rows: 46 });
    fx.box.visible = false;
    view.rerender(<TerminalChat {...props} isPrimary={false} />);
    await tick();
    const hiddenRequests = resizeRequests().length;
    deliverResize(); await tick();
    expect(resizeRequests()).toHaveLength(hiddenRequests);
    fx.box = { width, height, visible: true }; deliverResize(); await tick();
    expect(resizeRequests().at(-1)?.body).toEqual({ cols, rows, clientId });
    expect({ cols: term.cols, rows: term.rows }).toEqual({ cols, rows });
    expect(view.container.querySelector('[data-terminal]')).toBe(host);
    expect(term.element).toBe(renderer);
    expect(renderer.isConnected).toBe(true);
    expect({ instances: fx.terms.length, disposed: term.disposed, inputs: fx.inputs }).toEqual({ instances: 1, disposed: undefined, inputs: [] });
    const unchanged = resizeRequests().length;
    deliverResize(); deliverResize(); deliverResize(); await tick();
    expect(resizeRequests()).toHaveLength(unchanged);
  });

  it('honors an external fit signal for a visible inactive terminal without claiming primary ownership', async () => {
    const view = render(<TerminalChat {...props} isPrimary={false} fitSignal={0} />);
    await tick();
    fx.box.width = 680;
    view.rerender(<TerminalChat {...props} isPrimary={false} fitSignal={1} />);
    await tick();
    expect(resizeRequests().at(-1)?.body).toEqual({ cols: 68, rows: 46, clientId });
    expect(fx.terms).toHaveLength(1);
  });

  it('does not publish a queued xterm resize after its pane becomes hidden', async () => {
    const view = render(<TerminalChat {...props} />);
    await tick();
    const before = resizeRequests().length;
    act(() => fx.terms[0].resize(80, 24));
    fx.box.visible = false;
    view.rerender(<TerminalChat {...props} isPrimary={false} />);
    deliverResize(); await tick();
    expect(resizeRequests()).toHaveLength(before);
  });

  it('rejects resize publication from an inert covered workspace before its DOM geometry shrinks', async () => {
    const view = render(<div><TerminalChat {...props} /></div>);
    await tick();
    const before = resizeRequests().length;
    act(() => fx.terms[0].resize(80, 24));
    view.rerender(<div inert="" aria-hidden="true"><TerminalChat {...props} /></div>);
    fx.box.width = 680; deliverResize(); await tick();
    expect(resizeRequests()).toHaveLength(before);
    view.rerender(<div><TerminalChat {...props} fitSignal={1} /></div>);
    await tick();
    expect(resizeRequests().at(-1)?.body).toEqual({ cols: 68, rows: 46, clientId, priority: true });
    expect(fx.terms).toHaveLength(1);
  });

  it('fits a visible inactive read-only surface locally without publishing PTY sizes or enabling input', async () => {
    setActiveEnvironment({ id: 'readonly-owned-fixture', capabilities: { terminalInput: false } });
    render(<TerminalChat {...props} isPrimary={false} />);
    await tick();
    fx.box.width = 680; deliverResize(); await tick();
    expect({ cols: fx.terms[0].cols, rows: fx.terms[0].rows, inputDisabled: fx.terms[0].options.disableStdin }).toEqual({ cols: 68, rows: 46, inputDisabled: true });
    expect({ resizeRequests: resizeRequests(), inputs: fx.inputs }).toEqual({ resizeRequests: [], inputs: [] });
  });

  it('ignores an old resize acknowledgment after a newer geometry has already been applied', async () => {
    render(<TerminalChat {...props} />);
    await tick(); fx.deferResize = true;
    fx.box.width = 800; deliverResize(); await tick();
    fx.box.width = 680; deliverResize(); await tick();
    expect(fx.pendingAcks).toHaveLength(2);
    await act(async () => fx.pendingAcks[1]()); await tick();
    expect(fx.terms[0].cols).toBe(68);
    await act(async () => fx.pendingAcks[0]()); await tick();
    expect(fx.terms[0].cols).toBe(68);
  });

  it('does not publish a queued resize after the environment changes', async () => {
    render(<TerminalChat {...props} />);
    await tick();
    const before = resizeRequests().length;
    act(() => {
      fx.terms[0].resize(80, 24);
      setActiveEnvironment({ id: 'other-owned-fixture', capabilities: { terminalInput: true } });
    });
    fx.box.width = 680; deliverResize(); await tick();
    expect(resizeRequests()).toHaveLength(before);
  });

  it('cancels queued host and xterm resize work when an old desktop terminal unmounts', async () => {
    const view = render(<TerminalChat {...props} />);
    await tick();
    const before = resizeRequests().length;
    act(() => fx.terms[0].resize(80, 24));
    fx.box.width = 680; deliverResize(); view.unmount();
    await tick();
    expect(resizeRequests()).toHaveLength(before);
    expect(fx.terms[0].disposed).toBe(true);
    expect(fx.observers.every(observer => observer.stopped)).toBe(true);
  });
});
