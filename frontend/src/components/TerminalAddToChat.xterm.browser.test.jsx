import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { chromium } from '@playwright/test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { managedChromiumPath } from '../test/managedChromium';

const root = process.cwd();
let browser, server, origin;

const contextModule = `
const noop = () => Promise.resolve({});
const api = { sessions: [], activeSessionId: 'ss-a', listSessionGitBranches: () => Promise.resolve({ branches: [], currentBranch: null }),
  checkoutSessionGitBranch: noop, createSession: noop, sendToSession: noop, sendRawToSession: noop,
  updateThreadMetadata: (_id, patch) => Promise.resolve({ ...patch }), renameSession: noop, restoreSession: () => Promise.resolve({ restored: true }),
  refreshSessionGitStats: noop, updateStructuredSessionSelection: noop, updateStructuredSessionAccess: noop,
  registerTerminalSender: () => {}, unregisterTerminalSender: () => {}, updateSessionTopic: () => {}, syncSessionThread: () => {} };
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
import { getComposerDraftStore } from './src/utils/composerDraftStore';
window.fixtureDraft = (id, text) => { const store = getComposerDraftStore(id); if (text !== undefined) store.setText(text); return store.getSnapshot().text; };
const thread = { id: 'ss-a', title: 'Alpha', aiType: 'claude', runtime: 'codex', cwd: '/repo/current', isActive: true };
const sessions = [thread, { id: 'pty-drawer', isActive: true, cwd: '/repo/current', thread: { companionOf: 'ss-a' } }];
const noop = () => {};
const desktop = { pane: { id: 'pane-1', sessionId: 'ss-a' }, isActive: true, isFullscreen: false, sessions, canSplit: false, canClose: false,
  onSessionSelect: noop, onSplit: noop, onClose: noop, onFocus: noop, onFullscreen: noop, showPreview: false, keybarOpen: false,
  viewportHeight: 800, fontSize: 14, webglEnabled: false, sessionActivity: {}, projectInfo: { cwd: '/repo/current' }, sessionAiTypes: {},
  customAiProviders: [], onSetSessionAiType: noop, onAddCustomAiProvider: noop, desktopAllowTerminalInput: true, currentDesktopId: 'd1', fitSignal: 0 };
function App() { return <AutocorrectProvider><ThemeProvider>{location.hash === '#mobile'
  ? <div style={{ height: '100vh', display: 'flex', flexDirection: 'column' }}><MobileShell visible sessions={sessions} terminalSessions={sessions}
    activeSessionId="ss-a" mobileView="terminal" threadTerminalOpen onSelectSession={noop} onCreateSession={noop} onSessionBusyChange={noop}
    projectInfo={{ cwd: '/repo/current' }} sessionActivity={{}} fontSize={14} viewportHeight={800} onViewChange={noop} onChatModeChange={noop}
    onAccessoryToggle={noop} onAccessoryHeightChange={noop} onRegisterFocusTerminal={noop} onUrlDetected={noop} sessionAiTypes={{}}
    customAiProviders={[]} onSetSessionAiType={noop} onAddCustomAiProvider={noop} /></div>
  : <div className="environment-shell environment-workspace" style={{ height: '100vh', display: 'flex' }}><TerminalPane {...desktop} /></div>}
  </ThemeProvider></AutocorrectProvider>; }
createRoot(document.getElementById('root')).render(<App />);`;

beforeAll(async () => {
  const output = execFileSync(process.execPath, ['src/test/bundleFixture.mjs'], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
    input: JSON.stringify({ entry, root, virtual: { 'contexts/TerminalSessionContext$': contextModule } }) });
  const bundle = JSON.parse(output);
  server = createServer((req, res) => {
    const url = new URL(req.url, 'http://fixture');
    const send = (body, type = 'application/json') => { res.setHeader('Content-Type', type); res.end(typeof body === 'string' ? body : JSON.stringify(body)); };
    if (url.pathname === '/fixture.js') return send(bundle.find(file => file.path.endsWith('.js')).text, 'text/javascript');
    if (url.pathname === '/fixture.css') return send(bundle.find(file => file.path.endsWith('.css')).text, 'text/css');
    if (/^\/api\/terminal\/[^/]+\/history$/.test(url.pathname)) return send({ history: [{ text: 'FAIL auth\r\n', seq: 1 }], nextSeq: 2 });
    if (url.pathname === '/api/workspace/git/status') return send({ branch: 'feature', files: [] });
    if (url.pathname === '/api/thread-lineage') return send({ links: [] });
    if (url.pathname.startsWith('/api/')) return send([]);
    return send('<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/fixture.css"><div id="root"></div><script src="/fixture.js"></script>', 'text/html');
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

async function preparePage(context, mobile) {
  await context.addInitScript(() => {
    localStorage.setItem('terminal_access_token', `fixture.${btoa(JSON.stringify({ exp: 4102444800 }))}.fixture`);
    localStorage.setItem('terminal_user', JSON.stringify({ id: 'fixture-user' }));
    class FixtureSocket {
      static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3;
      readyState = FixtureSocket.CONNECTING;
      constructor() { setTimeout(() => { this.readyState = FixtureSocket.OPEN; this.onopen?.(); }, 0); }
      send() {}
      close() { this.readyState = FixtureSocket.CLOSED; this.onclose?.({ code: 1000 }); }
    }
    window.WebSocket = FixtureSocket;
  });
  const page = await context.newPage();
  page.setDefaultTimeout(8000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${origin}${mobile ? '/#mobile' : '/'}`);
  if (!mobile) await page.getByRole('button', { name: 'Toggle terminal drawer' }).click();
  const drawer = page.getByRole('region', { name: 'Thread terminal' });
  await drawer.locator('.xterm-rows').getByText('FAIL auth', { exact: true }).waitFor();
  return { page, drawer, errors };
}

async function selectTerminalText(page, drawer) {
  const row = drawer.locator('.xterm-rows').getByText('FAIL auth', { exact: true });
  let box;
  await expect.poll(async () => {
    box = await row.boundingBox();
    return Boolean(box && box.width > 0 && box.height > 0);
  }).toBe(true);
  await page.mouse.move(box.x + 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + Math.min(box.width - 2, 74), box.y + box.height / 2, { steps: 8 });
  await page.mouse.up();
}

describe('terminal selection with real xterm', () => {
  it.each([320, 390])('selects terminal output with a touch long press at %ipx', async width => {
    const context = await browser.newContext({ viewport: { width, height: 800 }, hasTouch: true, isMobile: true });
    try {
      const { page, drawer, errors } = await preparePage(context, true);
      await page.evaluate(() => { window.fixtureDraft('ss-a', 'Keep touch draft'); window.fixtureDraft('ss-b', 'Other draft'); });
      const box = await drawer.locator('.xterm-rows').getByText('FAIL auth', { exact: true }).boundingBox();
      const cdp = await context.newCDPSession(page);
      const point = { x: Math.round(box.x + 15), y: Math.round(box.y + box.height / 2) };
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] });
      await page.waitForTimeout(700);
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await page.getByRole('group', { name: 'Context actions' }).getByRole('button', { name: 'Add to chat: Alpha' }).tap({ timeout: 2000 });
      await expect.poll(() => page.evaluate(() => window.fixtureDraft('ss-a'))).toContain('FAIL auth');
      expect(await page.evaluate(() => window.fixtureDraft('ss-a'))).toContain('Keep touch draft');
      expect(await page.evaluate(() => window.fixtureDraft('ss-b'))).toBe('Other draft');
      expect(errors).toEqual([]);
    } finally { await context.close(); }
  }, 90000);

  it('adds a real desktop selection to its owning thread and keeps the existing draft', async () => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    try {
      const { page, drawer, errors } = await preparePage(context, false);
      const composer = page.getByRole('textbox', { name: 'Command composer' });
      await composer.fill('Keep this draft');
      await page.evaluate(() => window.fixtureDraft('ss-b', 'Another thread draft'));
      await selectTerminalText(page, drawer);
      await drawer.getByRole('button', { name: 'Add to chat: Alpha' }).click();
      await expect.poll(() => composer.inputValue()).toContain('Keep this draft');
      await expect.poll(() => page.evaluate(() => Object.entries(localStorage).filter(([key]) => key.endsWith(':ss-a')).map(([, value]) => JSON.parse(value).text).join(''))).toContain('FAIL auth');
      expect(await page.evaluate(() => window.fixtureDraft('ss-b'))).toBe('Another thread draft');
      await page.reload();
      await expect.poll(() => page.evaluate(() => window.fixtureDraft('ss-a'))).toContain('FAIL auth');
      expect(await page.evaluate(() => window.fixtureDraft('ss-a'))).toContain('Keep this draft');
      expect(errors).toEqual([]);
    } finally { await context.close(); }
  }, 90000);

  it.each([320, 390])('adds mouse-selected xterm text via the mobile touch menu at %ipx', async width => {
    const context = await browser.newContext({ viewport: { width, height: 800 }, hasTouch: true, isMobile: true });
    try {
      const { page, drawer, errors } = await preparePage(context, true);
      await page.evaluate(() => { window.fixtureDraft('ss-a', 'Keep mobile draft'); window.fixtureDraft('ss-b', 'Another thread draft'); });
      await selectTerminalText(page, drawer);
      const box = await drawer.locator('.xterm').boundingBox();
      const cdp = await context.newCDPSession(page);
      const point = { x: Math.round(box.x + 30), y: Math.round(box.y + 20) };
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] });
      await page.waitForTimeout(700);
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await page.getByRole('group', { name: 'Context actions' }).getByRole('button', { name: 'Add to chat: Alpha' }).tap();
      await expect.poll(() => page.evaluate(() => Object.entries(localStorage).filter(([key]) => key.endsWith(':ss-a')).map(([, value]) => JSON.parse(value).text).join(''))).toContain('FAIL auth');
      expect(await page.evaluate(() => window.fixtureDraft('ss-a'))).toContain('Keep mobile draft');
      expect(await page.evaluate(() => window.fixtureDraft('ss-b'))).toBe('Another thread draft');
      await page.reload();
      await expect.poll(() => page.evaluate(() => window.fixtureDraft('ss-a'))).toContain('FAIL auth');
      expect(await page.evaluate(() => window.fixtureDraft('ss-a'))).toContain('Keep mobile draft');
      expect(errors).toEqual([]);
    } finally { await context.close(); }
  }, 90000);
});
