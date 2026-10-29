import { act, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TerminalChat } from './TerminalChat';

const fx = vi.hoisted(() => ({ terms: [], sockets: [], requests: [], writes: [], inspect: vi.fn(), upload: vi.fn(), failOlder: false }));
vi.mock('@xterm/xterm', () => ({ Terminal: class {
  constructor(options) {
    this.options = options; this.rows = 24; this.cols = 80; this.unicode = {}; this.text = '';
    const active = { baseY: 0, viewportY: 0, cursorX: 0, cursorY: 0, type: 'normal', length: 24, getLine: () => ({ translateToString: () => '' }) };
    this.buffer = { active, normal: active }; fx.terms.push(this);
  }
  open(container) {
    this.element = document.createElement('div'); this.textarea = document.createElement('textarea');
    this.element.append(this.textarea); container.append(this.element);
    this.textarea.addEventListener('paste', event => { if (!event.defaultPrevented) this.data?.(event.clipboardData.getData('text/plain')); });
  }
  write(text, done) { this.text += text; done?.(); }
  reset() { this.text = ''; }
  onData(fn) { this.data = fn; return { dispose() {} }; }
  onResize() { return { dispose() {} }; }
  onScroll(fn) { this.scroll = fn; return { dispose() {} }; }
  attachCustomKeyEventHandler() {}
  attachCustomWheelEventHandler(fn) { this.wheel = fn; }
  loadAddon() {} focus() {} blur() {} refresh() {} resize() {} dispose() {}
  hasSelection() { return false; }
  getSelection() { return ''; }
  scrollLines() {} scrollToBottom() {} scrollToTop() {}
} }));
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class { fit() {} proposeDimensions() { return { cols: 80, rows: 24 }; } } }));
vi.mock('@xterm/addon-unicode11', () => ({ Unicode11Addon: class {} }));
vi.mock('@xterm/addon-web-links', () => ({ WebLinksAddon: class {} }));
vi.mock('@xterm/addon-webgl', () => ({ WebglAddon: class { dispose() {} onContextLoss() { return { dispose() {} }; } } }));
vi.mock('../contexts/ThemeContext', () => ({ useTheme: () => ({ theme: 'dark' }) }));
vi.mock('../contexts/AutocorrectContext', () => ({ useAutocorrect: () => ({ autocorrectEnabled: false }) }));
vi.mock('../contexts/TerminalSessionContext', () => ({ useTerminalSession: () => ({ activeSessionId: 'synthetic-ui', sessions: [] }) }));
vi.mock('../hooks/useMobileDetect', () => ({ useMobileDetect: () => false }));
vi.mock('../hooks/useIdleDetection', () => ({ useIdleDetection: () => ({ hasUserInputRef: { current: false }, markUserInput() {}, resetUserInput() {}, resetIdleTimer() {}, cleanup() {} }) }));
vi.mock('../hooks/useFaviconFlash', () => ({ useFaviconFlash: () => ({ startFaviconFlash() {}, stopFaviconFlash() {} }) }));
vi.mock('../utils/auth', () => ({ getAccessToken: () => 'synthetic', isAccessTokenExpired: () => false, refreshTokens: async () => ({ accessToken: 'synthetic' }) }));
vi.mock('../utils/clipboardImage', async original => ({ ...(await original()), getImageFileFromDataTransfer: (...args) => fx.inspect(...args) }));
vi.mock('../utils/api', () => ({ uploadScreenshot: (...args) => fx.upload(...args), apiFetch: async url => {
  fx.requests.push(url); const u = new URL(url, 'http://localhost');
  if (!u.pathname.endsWith('/history')) return { ok: true, json: async () => ({}) };
  if (u.searchParams.has('beforeSeq') && fx.failOlder) { fx.failOlder = false; return { ok: false, status: 503 }; }
  const history = u.searchParams.has('beforeSeq')
    ? u.searchParams.get('beforeSeq') === '2' ? [{ seq: 1, ts: 1000, text: 'OLDER_MARKER\r\n' }] : []
    : u.searchParams.get('afterSeq') === '2' ? [] : [{ seq: 2, ts: 2000, text: 'CURRENT_MARKER\r\n' }];
  return { ok: true, json: async () => ({ history, currentCols: 80, currentRows: 24 }) };
} }));

async function tick(ms = 200) { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); }
const props = { sessionId: 'synthetic-ui', surface: 'desktop', isPrimary: true, fontSize: 14, webglEnabled: false };
async function mount() { const view = render(<TerminalChat {...props} />); await tick(); return { ...view, term: fx.terms[0] }; }
function paste(term, text) {
  const event = new Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'clipboardData', { value: { getData: () => text, files: [], items: [] } });
  fireEvent(term.textarea, event); return event;
}
function older(term) { act(() => term.wheel({ deltaY: -48, deltaMode: 0, preventDefault() {} })); }

describe('TerminalChat paste and retained history', () => {
  beforeEach(() => {
    vi.useFakeTimers(); localStorage.clear(); fx.terms = []; fx.sockets = []; fx.requests = []; fx.writes = []; fx.failOlder = false;
    fx.inspect.mockReset().mockResolvedValue(null); fx.upload.mockReset().mockResolvedValue('/synthetic/image.png');
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ width: 800, height: 600, top: 0, left: 0, bottom: 600, right: 800 });
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
    vi.stubGlobal('WebSocket', class {
      static OPEN = 1; static CONNECTING = 0; static CLOSED = 3; static CLOSING = 2;
      constructor() { this.readyState = 0; fx.sockets.push(this); setTimeout(() => { this.readyState = 1; this.onopen?.(); this.onmessage?.({ data: JSON.stringify({ type: 'clientId', clientId: '11111111-1111-4111-8111-111111111111' }) }); }, 5); }
      send(text) { if (!text.startsWith('{')) fx.writes.push(text); }
      close() { this.readyState = 3; }
    });
    vi.stubGlobal('navigator', { platform: 'MacIntel', userAgent: 'Synthetic Mac browser', maxTouchPoints: 0, onLine: true, clipboard: { readText: vi.fn(() => { throw new Error('Unexpected clipboard read'); }) } });
  });
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

  it('takes keyboard focus when it opens as the primary terminal and nothing else has focus', async () => {
    const elsewhere = document.body.appendChild(document.createElement('input'));
    elsewhere.focus();
    const busy = await mount();
    const keptFocus = document.activeElement === elsewhere;
    busy.unmount(); elsewhere.remove(); fx.terms.length = 0;
    const { term } = await mount();
    expect([keptFocus, document.activeElement === term.textarea]).toEqual([true, true]);
  });

  it('announces history loading without putting terminal output in a live region', async () => {
    const view = render(<TerminalChat {...props} />);
    expect(view.getByRole('status')).toHaveTextContent('Loading history...');
    expect(view.container.querySelector('[data-terminal]')).not.toHaveAttribute('aria-live');
    await tick();
    expect(view.queryByText('Loading history...')).not.toBeInTheDocument();
    expect(fx.terms[0].text).toBe('CURRENT_MARKER\r\n');
  });

  it('cancels native paste synchronously and delivers one accepted paste after inspection', async () => {
    const { term } = await mount(); let resolve;
    fx.inspect.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    const event = paste(term, 'synthetic_paste');
    expect(event.defaultPrevented).toBe(true);
    await tick(); expect(fx.writes).toEqual([]);
    await act(async () => { resolve(null); }); await tick();
    expect(fx.writes).toEqual(['\x1b[200~synthetic_paste\x1b[201~']);
  });

  it('never delivers a cancelled large paste, including after async image inspection', async () => {
    const { term } = await mount(); let resolve;
    fx.inspect.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    paste(term, 'x'.repeat(5001)); await tick();
    await act(async () => { resolve(null); }); await tick();
    expect({ writes: fx.writes, confirmations: confirm.mock.calls.length }).toEqual({ writes: [], confirmations: 1 });
  });

  it('drops pending clipboard inspection after unmount without uploading or sending', async () => {
    const view = await mount(); let resolve;
    fx.inspect.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    const event = paste(view.term, '');
    view.unmount();
    await act(async () => { resolve(new File(['synthetic'], 'synthetic.png', { type: 'image/png' })); }); await tick();
    expect({ cancelled: event.defaultPrevented, uploads: fx.upload.mock.calls, writes: fx.writes }).toEqual({ cancelled: true, uploads: [], writes: [] });
  });

  it.each([{ fontSize: 15 }, { webglEnabled: true }])('preserves history and sequence cursor through live display change %j', async change => {
    const view = await mount(); expect(view.term.text).toBe('CURRENT_MARKER\r\n');
    view.rerender(<TerminalChat {...props} {...change} />);
    await tick(1600); fireEvent(document, new Event('visibilitychange')); await tick();
    expect({ instances: fx.terms.length, text: view.term.text, after: fx.requests.filter(url => url.includes('afterSeq=')) }).toEqual({
      instances: 1, text: 'CURRENT_MARKER\r\n', after: [expect.stringContaining('afterSeq=2')],
    });
  });

  it('retries a failed older page and exhausts only after a successful empty page', async () => {
    const { term } = await mount(); await tick(1600); fx.failOlder = true; older(term); await tick();
    await tick(1600); older(term); await tick();
    expect({ requests: fx.requests.filter(url => url.includes('beforeSeq=2')).length, text: term.text }).toEqual({ requests: 2, text: 'OLDER_MARKER\r\nCURRENT_MARKER\r\n' });
    await tick(1600); older(term); await tick();
    const count = fx.requests.length;
    await tick(1600); older(term); await tick();
    expect(fx.requests.length).toBe(count);
  });

  it('rejects unsupported API aliases in raw xterm input without an unhandled callback', async () => {
    const view = await mount();
    expect(() => { act(() => view.term.data('/deepseek\r')); }).not.toThrow();
    await tick();
    expect(view.getByRole('alert').textContent).toMatch(/agent picker/i);
    expect(fx.writes).toEqual([]);
  });
});
