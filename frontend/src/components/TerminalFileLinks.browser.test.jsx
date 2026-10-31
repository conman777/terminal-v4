import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { chromium } from '@playwright/test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { managedChromiumPath } from '../test/managedChromium';

const root = process.cwd();
let browser, server, origin;
let historyText = '/repo/current/src/app.js:2';

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
import { setUser } from './src/utils/auth';
import { setActiveEnvironment } from './src/utils/remoteEnvironments';
window.fixtureSetUser = setUser;
window.fixtureSetEnvironment = setActiveEnvironment;
window.fixtureDraft = (id, text) => { const store = getComposerDraftStore(id); if (text !== undefined) store.setText(text); return store.getSnapshot().text; };
const thread = { id: 'ss-a', title: 'Alpha', aiType: 'claude', runtime: 'codex', cwd: '/repo/current', isActive: true };
const sessions = [thread, { id: 'pty-drawer', isActive: true, cwd: '/repo/current', thread: { companionOf: 'ss-a' } }];
const noop = () => {};
const desktop = { pane: { id: 'pane-1', sessionId: 'ss-a' }, isActive: true, isFullscreen: false, sessions, canSplit: false, canClose: false,
  onSessionSelect: noop, onSplit: noop, onClose: noop, onFocus: noop, onFullscreen: noop, showPreview: false, keybarOpen: false,
  viewportHeight: 800, fontSize: 14, webglEnabled: false, sessionActivity: {}, projectInfo: { cwd: '/repo/current' }, sessionAiTypes: {},
  customAiProviders: [], onSetSessionAiType: noop, onAddCustomAiProvider: noop, desktopAllowTerminalInput: true, currentDesktopId: 'd1', fitSignal: 0 };
function App() {
  const [root, setRoot] = React.useState('/repo/current');
  const [active, setActive] = React.useState('ss-a');
  window.fixtureSetRoot = setRoot;
  window.fixtureSetThread = setActive;
  const mobileSessions = [{ ...thread, cwd: root }, { ...thread, id: 'ss-b', title: 'Beta', cwd: root }, sessions[1]];
  return <AutocorrectProvider><ThemeProvider>{location.hash === '#mobile'
  ? <div style={{ height: '100vh', display: 'flex', flexDirection: 'column' }}><MobileShell visible sessions={mobileSessions} terminalSessions={mobileSessions}
    activeSessionId={active} mobileView="terminal" threadTerminalOpen onSelectSession={noop} onCreateSession={noop} onSessionBusyChange={noop}
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
    if (/^\/api\/terminal\/[^/]+\/history$/.test(url.pathname)) return send({ history: [{ text: `${historyText}\r\n`, seq: 1 }], nextSeq: 2 });
    if (url.pathname === '/api/workspace/files/read-content') return send({ root: '/repo/current', path: 'src/app.js', line: 2, totalLines: 2, lines: [{ line: 1, text: 'first', truncated: false }, { line: 2, text: 'target', truncated: false }] });
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

async function preparePage(context, mobile, text = '/repo/current/src/app.js:2') {
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
  await drawer.locator('.xterm-rows').getByText(text, { exact: true }).waitFor();
  return { page, drawer, errors };
}

async function terminalTextBox(drawer, text) {
  const row = drawer.locator('.xterm-rows').getByText(text, { exact: true });
  let box;
  await expect.poll(async () => { box = await row.boundingBox(); return Boolean(box && box.width && box.height); }).toBe(true);
  return box;
}

describe('terminal file links in xterm', () => {
  it('lets keyboard users move focus out without intercepting Control+Alt+M', async () => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    try {
      const { page, drawer } = await preparePage(context, false);
      const input = drawer.locator('.xterm-helper-textarea');
      await input.focus();
      await page.keyboard.press('Control+Alt+m');
      expect(await input.getAttribute('aria-description')).toMatch(/Tab is sent to the shell/);
      await page.keyboard.press('Control+m');
      expect(await input.getAttribute('aria-description')).toMatch(/Tab moves focus/);
      await page.keyboard.press('Tab');
      expect(await input.evaluate(element => document.activeElement === element)).toBe(false);
    } finally { await context.close(); }
  }, 90000);

  it.each([320, 390])('opens a selected file by touch at %ipx without a modifier', async width => {
    const context = await browser.newContext({ viewport: { width, height: 800 }, hasTouch: true, isMobile: true });
    try {
      const { page, drawer, errors } = await preparePage(context, true);
      const requests = [];
      page.on('request', request => { if (request.url().includes('/api/workspace/files/read-content')) requests.push(request.url()); });
      const box = await terminalTextBox(drawer, '/repo/current/src/app.js:2');
      const cdp = await context.newCDPSession(page);
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: Math.round(box.x + 15), y: Math.round(box.y + box.height / 2) }] });
      await page.waitForTimeout(700);
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      const menu = page.getByRole('group', { name: 'Context actions' });
      await menu.getByRole('button', { name: 'Add to chat: Alpha' }).waitFor();
      await menu.getByRole('button', { name: 'Open file' }).tap();
      await page.getByRole('dialog', { name: 'File preview: src/app.js, line 2' }).waitFor();
      await expect.poll(() => requests.length).toBe(1);
      const params = new URL(requests[0]).searchParams;
      expect([params.get('sessionId'), params.get('root'), params.get('path'), params.get('line')]).toEqual(['ss-a', '/repo/current', 'src/app.js', '2']);
      expect(errors).toEqual([]);
    } finally { await context.close(); }
  }, 90000);

  it.each(['/outside/file.js:2', '/repo/current/a.js:1 /repo/current/b.js:2', 'https://example.com/file.js'])('does not offer Open file for %s', async text => {
    historyText = text;
    const context = await browser.newContext({ viewport: { width: 390, height: 800 }, hasTouch: true, isMobile: true });
    try {
      const { page, drawer } = await preparePage(context, true, text);
      const box = await terminalTextBox(drawer, text);
      const cdp = await context.newCDPSession(page);
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: Math.round(box.x + 15), y: Math.round(box.y + box.height / 2) }] });
      await page.waitForTimeout(700);
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      const menu = page.getByRole('group', { name: 'Context actions' });
      await menu.getByRole('button', { name: 'Add to chat: Alpha' }).waitFor();
      expect(await menu.getByRole('button', { name: 'Open file' }).count()).toBe(0);
    } finally { historyText = '/repo/current/src/app.js:2'; await context.close(); }
  }, 90000);

  it('does not open a file after the selection changes while the menu is open', async () => {
    const context = await browser.newContext({ viewport: { width: 390, height: 800 }, hasTouch: true, isMobile: true });
    try {
      const { page, drawer } = await preparePage(context, true);
      const requests = [];
      page.on('request', request => { if (request.url().includes('/api/workspace/files/read-content')) requests.push(request.url()); });
      const box = await terminalTextBox(drawer, '/repo/current/src/app.js:2');
      const cdp = await context.newCDPSession(page);
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: Math.round(box.x + 15), y: Math.round(box.y + box.height / 2) }] });
      await page.waitForTimeout(700);
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      const button = page.getByRole('group', { name: 'Context actions' }).getByRole('button', { name: 'Open file' });
      await button.waitFor();
      await page.mouse.move(box.x + 2, box.y + box.height / 2);
      await page.mouse.down();
      await page.mouse.move(box.x + 40, box.y + box.height / 2, { steps: 5 });
      await page.mouse.up();
      if (await button.isVisible()) await button.tap();
      expect(requests).toEqual([]);
      expect(await page.getByRole('dialog', { name: /File preview/ }).count()).toBe(0);
    } finally { await context.close(); }
  }, 90000);

  it('rejects a menu action after its workspace changes and returns', async () => {
    const context = await browser.newContext({ viewport: { width: 390, height: 800 }, hasTouch: true, isMobile: true });
    try {
      const { page, drawer } = await preparePage(context, true);
      const requests = [];
      page.on('request', request => { if (request.url().includes('/api/workspace/files/read-content')) requests.push(request.url()); });
      const box = await terminalTextBox(drawer, '/repo/current/src/app.js:2');
      const cdp = await context.newCDPSession(page);
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: Math.round(box.x + 15), y: Math.round(box.y + box.height / 2) }] });
      await page.waitForTimeout(700);
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      const button = page.getByRole('group', { name: 'Context actions' }).getByRole('button', { name: 'Open file' });
      await button.waitFor();
      await page.evaluate(() => window.fixtureSetRoot('/repo/other'));
      await page.waitForTimeout(100);
      await page.evaluate(() => window.fixtureSetRoot('/repo/current'));
      await page.waitForTimeout(100);
      if (await button.isVisible()) await button.tap();
      expect(requests).toEqual([]);
      expect(await page.getByRole('dialog', { name: /File preview/ }).count()).toBe(0);
    } finally { await context.close(); }
  }, 90000);

  it('dismisses a menu when the originating thread changes', async () => {
    const context = await browser.newContext({ viewport: { width: 390, height: 800 }, hasTouch: true, isMobile: true });
    try {
      const { page, drawer } = await preparePage(context, true);
      const box = await terminalTextBox(drawer, '/repo/current/src/app.js:2');
      const cdp = await context.newCDPSession(page);
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: Math.round(box.x + 15), y: Math.round(box.y + box.height / 2) }] });
      await page.waitForTimeout(700);
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      const menu = page.getByRole('group', { name: 'Context actions' });
      await menu.getByRole('button', { name: 'Open file' }).waitFor();
      await page.evaluate(() => window.fixtureSetThread('ss-b'));
      await menu.waitFor({ state: 'detached' });
      expect(await page.getByRole('dialog', { name: /File preview/ }).count()).toBe(0);
    } finally { await context.close(); }
  }, 90000);

  it.each(['account', 'environment'])('rejects an action after the %s changes and returns', async scope => {
    const context = await browser.newContext({ viewport: { width: 390, height: 800 }, hasTouch: true, isMobile: true });
    try {
      const { page, drawer } = await preparePage(context, true);
      const requests = [];
      page.on('request', request => { if (request.url().includes('/api/workspace/files/read-content')) requests.push(request.url()); });
      const box = await terminalTextBox(drawer, '/repo/current/src/app.js:2');
      const cdp = await context.newCDPSession(page);
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: Math.round(box.x + 15), y: Math.round(box.y + box.height / 2) }] });
      await page.waitForTimeout(700);
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      const button = page.getByRole('group', { name: 'Context actions' }).getByRole('button', { name: 'Open file' });
      await button.waitFor();
      await page.evaluate(kind => {
        const open = [...document.querySelectorAll('button')].find(element => element.textContent === 'Open file');
        if (kind === 'account') { window.fixtureSetUser({ id: 'other' }); window.fixtureSetUser({ id: 'fixture-user' }); }
        else { window.fixtureSetEnvironment({ id: 'other' }); window.fixtureSetEnvironment(null); }
        open.click();
      }, scope);
      expect(requests).toEqual([]);
      expect(await page.getByRole('dialog', { name: /File preview/ }).count()).toBe(0);
    } finally { await context.close(); }
  }, 90000);

  it.each([false, true])('opens and dismisses the owning thread preview (mobile: %s)', async mobile => {
    const context = await browser.newContext({ viewport: { width: mobile ? 390 : 1280, height: 800 }, hasTouch: mobile, isMobile: mobile });
    try {
      const { page, drawer, errors } = await preparePage(context, mobile);
      const requests = [];
      page.on('request', request => { if (request.url().includes('/api/workspace/files/read-content')) requests.push(request.url()); });
      const row = drawer.locator('.xterm-rows').getByText('/repo/current/src/app.js:2', { exact: true });
      let box;
      await expect.poll(async () => { box = await row.boundingBox(); return Boolean(box && box.width && box.height); }).toBe(true);
      await page.mouse.click(box.x + 20, box.y + box.height / 2);
      expect(requests).toEqual([]);
      const modifier = await page.evaluate(() => /Mac|iPhone|iPad|iPod/.test(navigator.platform) ? 'Meta' : 'Control');
      await page.keyboard.down(modifier);
      await page.mouse.move(box.x + 20, box.y + box.height / 2);
      await page.mouse.click(box.x + 20, box.y + box.height / 2);
      await page.keyboard.up(modifier);
      await page.getByRole('dialog', { name: 'File preview: src/app.js, line 2' }).waitFor();
      await expect.poll(() => requests.length).toBe(1);
      const params = new URL(requests[0]).searchParams;
      expect([params.get('sessionId'), params.get('root'), params.get('path'), params.get('line')]).toEqual(['ss-a', '/repo/current', 'src/app.js', '2']);
      await page.getByRole('button', { name: 'Close file preview' }).click();
      expect(await page.getByRole('dialog', { name: /File preview/ }).count()).toBe(0);
      expect(errors).toEqual([]);
    } finally { await context.close(); }
  }, 90000);
});
