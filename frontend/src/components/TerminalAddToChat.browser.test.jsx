import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { chromium } from '@playwright/test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { managedChromiumPath } from '../test/managedChromium';

const root = process.cwd();
let browser, server, origin, bundle;
const lineage = [];

const fakeTerminal = `
import { useEffect, useRef } from 'react';
export function TerminalChat(props) {
  const ref = useRef(null);
  useEffect(() => {
    const root = ref.current;
    const text = () => { const sel = window.getSelection(); return sel && sel.rangeCount && root.contains(sel.anchorNode) ? sel.toString() : ''; };
    const listeners = new Set();
    const onSelection = () => listeners.forEach(listener => listener());
    document.addEventListener('selectionchange', onSelection);
    props.onRegisterSelectionActions?.({ sessionId: props.sessionId, hasSelection: () => Boolean(text()), copySelection: () => true, getSelectionText: text,
      clearSelection: () => window.getSelection()?.removeAllRanges(), subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener); } });
    return () => { document.removeEventListener('selectionchange', onSelection); props.onRegisterSelectionActions?.(null); };
  }, [props.sessionId, props.onRegisterSelectionActions]);
  return <div ref={ref} className="fake-terminal" data-session-id={props.sessionId} style={{ flex: '1 1 auto', minHeight: 90, padding: 8, font: '13px monospace', whiteSpace: 'pre', overflow: 'hidden' }}>
    <div className="line-command">$ npm test</div><div className="line-fail">FAIL auth</div><div className="line-blank">{'          '}</div>
  </div>;
}`;
const fakeContext = `
const noop = () => Promise.resolve({});
const api = { listSessionGitBranches: () => Promise.resolve({ branches: [], currentBranch: null }), checkoutSessionGitBranch: noop, createSession: noop, sendToSession: noop, sendRawToSession: noop,
  updateThreadMetadata: (_id, patch) => Promise.resolve({ ...patch }), renameSession: noop, restoreSession: () => Promise.resolve({ restored: true }), refreshSessionGitStats: noop,
  updateStructuredSessionSelection: noop, updateStructuredSessionAccess: noop, activeSessionId: 'ss-a' };
export const useTerminalSession = () => api;
export const TerminalSessionProvider = ({ children }) => children;`;
const entry = `
import React from 'react';
import { createRoot } from 'react-dom/client';
import './src/styles.css';
import './src/WorkspaceUI.css';
import './src/ProUI.css';
import { ThemeProvider } from './src/contexts/ThemeContext';
import { AutocorrectProvider } from './src/contexts/AutocorrectContext';
import { TerminalPane } from './src/components/TerminalPane';
import { MobileShell } from './src/components/MobileShell';
const thread = (id, title) => ({ id, title, aiType: 'claude', runtime: 'codex', cwd: '/repo/current', isActive: true });
const sessions = [thread('ss-a', 'Alpha'), thread('ss-b', 'Bravo'), { id: 'pty-drawer', isActive: true, cwd: '/repo/current', thread: { companionOf: 'ss-a' } }];
const noop = () => {};
const mobile = location.hash === '#mobile';
const desktopProps = { pane: { id: 'pane-1', sessionId: 'ss-a' }, isActive: true, isFullscreen: false, sessions, canSplit: false, canClose: false, onSessionSelect: noop, onSplit: noop, onClose: noop,
  onFocus: noop, onFullscreen: noop, showPreview: false, keybarOpen: false, viewportHeight: 800, fontSize: 14, webglEnabled: false, sessionActivity: {}, projectInfo: { cwd: '/repo/current' },
  sessionAiTypes: {}, customAiProviders: [], onSetSessionAiType: noop, onAddCustomAiProvider: noop, desktopAllowTerminalInput: true, currentDesktopId: 'd1', fitSignal: 0 };
function App() {
  return <AutocorrectProvider><ThemeProvider>{mobile
    ? <div style={{ height: '100vh', display: 'flex', flexDirection: 'column' }}><MobileShell visible sessions={sessions} terminalSessions={sessions} activeSessionId="ss-a" mobileView="terminal" threadTerminalOpen
        onSelectSession={noop} onCreateSession={noop} onSessionBusyChange={noop} projectInfo={{ cwd: '/repo/current' }} sessionActivity={{}} fontSize={14} viewportHeight={800}
        onViewChange={noop} onChatModeChange={noop} onAccessoryToggle={noop} onAccessoryHeightChange={noop} onRegisterFocusTerminal={noop} onUrlDetected={noop}
        sessionAiTypes={{}} customAiProviders={[]} onSetSessionAiType={noop} onAddCustomAiProvider={noop} /></div>
    : <div className="environment-shell environment-workspace" style={{ height: '100vh', display: 'flex' }}><TerminalPane {...desktopProps} /></div>}</ThemeProvider></AutocorrectProvider>;
}
createRoot(document.getElementById('root')).render(<App />);`;

beforeAll(async () => {
  const out = execFileSync(process.execPath, ['src/test/bundleFixture.mjs'], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
    input: JSON.stringify({ entry, root, virtual: { '/TerminalChat$': fakeTerminal, 'contexts/TerminalSessionContext$': fakeContext } }) });
  bundle = JSON.parse(out);
  server = createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const send = (code, body, type = 'application/json') => { res.statusCode = code; res.setHeader('Content-Type', type); res.end(typeof body === 'string' ? body : JSON.stringify(body)); };
    if (url.pathname === '/fixture.js') return send(200, bundle.find(file => file.path.endsWith('.js')).text, 'text/javascript');
    if (url.pathname === '/fixture.css') return send(200, bundle.find(file => file.path.endsWith('.css')).text, 'text/css');
    if (url.pathname === '/api/workspace/git/pull-request') return send(200, { pullRequest: { number: 7, title: 'Fix login', url: 'https://github.com/acme/app/pull/7', state: 'OPEN' } });
    if (url.pathname === '/api/thread-lineage') return send(200, { links: lineage });
    if (url.pathname === '/api/workspace/git/status') return send(200, { branch: 'feature', files: [] });
    if (url.pathname.startsWith('/api/')) return send(200, []);
    send(200, '<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/fixture.css"><div id="root"></div><script src="/fixture.js"></script>', 'text/html');
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ executablePath: await managedChromiumPath(), headless: true });
}, 120000);

afterAll(async () => {
  await browser?.close();
  server?.closeAllConnections();
  if (server) await new Promise(done => server.close(done));
});

const draftText = page => page.evaluate(() => Object.entries(localStorage).filter(([key]) => key.endsWith(':ss-a')).map(([, value]) => JSON.parse(value).text).join(''));
const selectLine = (page, selector) => page.evaluate(sel => {
  const node = document.querySelector(sel);
  const range = document.createRange();
  range.selectNodeContents(node);
  const selection = window.getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
}, selector);
const inViewport = (page, locator) => locator.boundingBox().then(box => box.x >= 0 && box.x + box.width <= page.viewportSize().width && box.y >= 0 && box.y + box.height <= page.viewportSize().height);
const noOverflow = page => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1);

describe('terminal add to chat in a real browser', () => {
  it('desktop 1280: the drawer control adds a chip to the owning thread, by keyboard, and it survives reload', async () => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    try {
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.goto(origin);
      await page.getByRole('button', { name: 'Toggle terminal drawer' }).click();
      const drawer = page.getByRole('region', { name: 'Thread terminal' });
      await drawer.locator('.fake-terminal').waitFor();
      expect(await drawer.getByRole('button', { name: /Add to chat/ }).count()).toBe(0);

      await selectLine(page, '.thread-terminal-drawer .line-blank');
      const blank = drawer.getByRole('button', { name: 'Add to chat: Alpha' });
      await blank.waitFor();
      expect(await blank.getAttribute('aria-disabled')).toBe('true');
      expect(await drawer.getByText('The selection is blank.').isVisible()).toBe(true);
      await blank.click({ force: true });
      expect(await draftText(page)).toBe('');

      await selectLine(page, '.thread-terminal-drawer .line-fail');
      const add = drawer.getByRole('button', { name: 'Add to chat: Alpha' });
      await page.waitForFunction(() => document.querySelector('.terminal-add-to-chat button')?.getAttribute('aria-disabled') === 'false');
      expect(await inViewport(page, add)).toBe(true);
      await add.focus();
      await page.keyboard.press('Enter');
      await page.waitForFunction(() => document.querySelector('.composer-context-chip'));
      expect(await draftText(page)).toContain('FAIL auth');
      expect(await noOverflow(page)).toBe(true);

      await page.reload();
      await page.waitForFunction(() => document.querySelector('.composer-context-chip'));
      expect(await draftText(page)).toContain('FAIL auth');
      expect(errors).toEqual([]);
    } finally { await context.close(); }
  }, 90000);

  it.each([320, 390])('mobile %ipx: the long-press menu adds to the owning thread and fits the screen', async width => {
    const context = await browser.newContext({ viewport: { width, height: 800 }, hasTouch: true, isMobile: true });
    try {
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.goto(`${origin}/#mobile`);
      const drawer = page.getByRole('region', { name: 'Thread terminal' });
      await drawer.locator('.fake-terminal').waitFor();
      await selectLine(page, '.mobile-thread-terminal .line-fail');
      const box = await drawer.locator('.fake-terminal').boundingBox();
      const cdp = await context.newCDPSession(page);
      const point = { x: Math.round(box.x + 30), y: Math.round(box.y + 20) };
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] });
      await page.waitForTimeout(700);
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      const menu = page.getByRole('group', { name: 'Context actions' });
      await menu.waitFor();
      expect(await inViewport(page, menu)).toBe(true);
      const item = menu.getByRole('button', { name: 'Add to chat: Alpha' });
      expect((await item.boundingBox()).height).toBeGreaterThanOrEqual(40);
      expect(await noOverflow(page)).toBe(true);
      await item.tap();
      await page.waitForFunction(() => document.querySelector('.composer-context-chip'));
      expect(await draftText(page)).toContain('FAIL auth');
      await page.reload();
      await page.waitForFunction(() => document.querySelector('.composer-context-chip'));
      expect(await draftText(page)).toContain('FAIL auth');
      expect(errors).toEqual([]);
    } finally { await context.close(); }
  }, 90000);
});
