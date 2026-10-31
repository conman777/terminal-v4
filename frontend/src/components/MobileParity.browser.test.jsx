import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { chromium } from '@playwright/test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { managedChromiumPath } from '../test/managedChromium';

const root = process.cwd();
let browser, server, origin, bundle;

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
    let timer;
    const onTouch = () => { clearTimeout(timer); timer = setTimeout(() => {
      const range = document.createRange(); range.selectNodeContents(root.querySelector('.line-wrapped'));
      const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
    }, 560); };
    root.addEventListener('touchstart', onTouch, { passive: true });
    return () => { clearTimeout(timer); root.removeEventListener('touchstart', onTouch); document.removeEventListener('selectionchange', onSelection); props.onRegisterSelectionActions?.(null); };
  }, [props.sessionId, props.onRegisterSelectionActions]);
  return <div ref={ref} className="fake-terminal" style={{ flex: '1 1 auto', minHeight: 90, padding: 8, font: '13px monospace', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
    <div className="line-wrapped">{'FAIL packages/auth/login.test.js expected redirect to /home but received /login after a very long wrapped first row'}</div>
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
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import './src/styles.css';
import './src/WorkspaceUI.css';
import './src/ProUI.css';
import { ThemeProvider } from './src/contexts/ThemeContext';
import { AutocorrectProvider } from './src/contexts/AutocorrectContext';
import { setEnvironmentIdentity } from './src/utils/remoteEnvironments';
import { MobileShell } from './src/components/MobileShell';
import { MobileDrawer } from './src/components/MobileDrawer';
import { WorkspaceGitPanel } from './src/components/WorkspaceGitPanel';
setEnvironmentIdentity('fixture-user');
const thread = (id, title, extra = {}) => ({ id, title, aiType: 'claude', runtime: 'codex', cwd: '/repo/current', isActive: true, thread: { topic: title, projectPath: '/repo', ...extra } });
const sessions = [thread('ss-a', 'Alpha'), thread('ss-b', 'Bravo', { pinned: true }), { id: 'pty-drawer', isActive: true, cwd: '/repo/current', thread: { companionOf: 'ss-a' } }];
const noop = () => {};
const view = location.hash.slice(1);
function Drawer() {
  const [open, setOpen] = useState(true);
  return <><button type="button" onClick={() => setOpen(true)}>Open menu</button>
    <MobileDrawer isOpen={open} onClose={() => setOpen(false)} onCreateSession={noop} projects={[]} activeSessions={sessions.slice(0, 2)} archivedSessions={[]} activeSessionId="ss-a" sessionActivity={{}}
      onSelectSession={noop} onViewChange={noop} sessionsGroupedByProject={[{ projectName: 'Repo', projectPath: '/repo', sessions: sessions.slice(0, 2) }]} /></>;
}
function App() {
  return <AutocorrectProvider><ThemeProvider>{view === 'git'
    ? <div style={{ padding: 16 }}><WorkspaceGitPanel workspacePath="/repo/current" /></div>
    : view === 'drawer' ? <Drawer />
    : <div style={{ height: '100vh', display: 'flex', flexDirection: 'column' }}><MobileShell visible sessions={sessions} terminalSessions={sessions} activeSessionId="ss-a" mobileView="terminal" threadTerminalOpen
        onSelectSession={noop} onCreateSession={noop} onSessionBusyChange={noop} projectInfo={{ cwd: '/repo/current' }} sessionActivity={{}} fontSize={14} viewportHeight={800}
        onViewChange={noop} onChatModeChange={noop} onAccessoryToggle={noop} onAccessoryHeightChange={noop} onRegisterFocusTerminal={noop} onUrlDetected={noop}
        sessionAiTypes={{}} customAiProviders={[]} onSetSessionAiType={noop} onAddCustomAiProvider={noop} /></div>}</ThemeProvider></AutocorrectProvider>;
}
createRoot(document.getElementById('root')).render(<App />);`;

const SHA = 'c'.repeat(40);
const pull = { number: 7, headSha: SHA, url: 'https://github.com/acme/app/pull/7', state: 'OPEN', isDraft: false, mergeable: 'MERGEABLE', review: 'APPROVED', checks: { passed: 2, failed: 0, pending: 0 } };

beforeAll(async () => {
  const out = execFileSync(process.execPath, ['src/test/bundleFixture.mjs'], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
    input: JSON.stringify({ entry, root, virtual: { '/TerminalChat$': fakeTerminal, 'contexts/TerminalSessionContext$': fakeContext } }) });
  bundle = JSON.parse(out);
  server = createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const send = (code, body, type = 'application/json') => { res.statusCode = code; res.setHeader('Content-Type', type); res.end(typeof body === 'string' ? body : JSON.stringify(body)); };
    if (url.pathname === '/fixture.js') return send(200, bundle.find(file => file.path.endsWith('.js')).text, 'text/javascript');
    if (url.pathname === '/fixture.css') return send(200, bundle.find(file => file.path.endsWith('.css')).text, 'text/css');
    if (url.pathname === '/api/workspace/git/pull-request') return send(200, { pullRequest: pull, availability: 'ok', repository: '/repo/current' });
    if (url.pathname === '/api/workspace/git/status') return send(200, { branch: 'feature', files: [{ path: 'a.js', status: ' M', added: 1, removed: 0 }] });
    if (url.pathname === '/api/thread-lineage') return send(200, { links: [] });
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

const noOverflow = page => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1);
const tall = async locator => (await locator.boundingBox()).height >= 43.5;
const mobileContext = width => browser.newContext({ viewport: { width, height: 800 }, hasTouch: true, isMobile: true });

describe.each([320, 390])('mobile parity in a real browser at %ipx', width => {
  it('stashes and restores a draft from the composer actions with 44px targets', async () => {
    const context = await mobileContext(width);
    try {
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.goto(`${origin}/#shell`);
      const composer = page.locator('textarea').first();
      await composer.fill('Draft to park');
      await page.locator('summary[aria-label="More composer actions"]').tap();
      const toggle = page.getByRole('button', { name: 'Stash', exact: true });
      expect(await tall(toggle)).toBe(true);
      await toggle.tap();
      const stash = page.getByRole('button', { name: 'Stash this draft' });
      expect(await tall(stash)).toBe(true);
      await stash.tap();
      expect(await composer.inputValue()).toBe('');
      const restore = page.getByRole('button', { name: /Restore draft: Draft to park/ });
      expect(await tall(restore)).toBe(true);
      expect(await noOverflow(page)).toBe(true);
      await restore.tap();
      expect(await composer.inputValue()).toBe('Draft to park');
      expect(errors).toEqual([]);
    } finally { await context.close(); }
  }, 90000);

  it('opens the selection menu when a long press lands on a wrapped first row', async () => {
    const context = await mobileContext(width);
    try {
      const page = await context.newPage();
      await page.goto(`${origin}/#shell`);
      const terminal = page.getByRole('region', { name: 'Thread terminal' }).locator('.fake-terminal');
      await terminal.waitFor();
      const box = await terminal.boundingBox();
      const cdp = await context.newCDPSession(page);
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: Math.round(box.x + 30), y: Math.round(box.y + 14) }] });
      await page.waitForTimeout(800);
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      const menu = page.getByRole('group', { name: 'Context actions' });
      await menu.waitFor();
      expect(await tall(menu.getByRole('button', { name: 'Copy selection' }))).toBe(true);
      expect(await noOverflow(page)).toBe(true);
    } finally { await context.close(); }
  }, 90000);

  it('shows the pull request row and Commit, push & PR in the Git panel, confirmation bound to the head commit', async () => {
    const context = await mobileContext(width);
    try {
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.goto(`${origin}/#git`);
      const row = page.getByRole('link', { name: /PR #7/ });
      await row.waitFor();
      expect(await tall(row)).toBe(true);
      const ship = page.getByRole('button', { name: 'Commit, push & PR' });
      expect(await tall(ship)).toBe(true);
      await ship.tap();
      expect(await tall(page.getByRole('button', { name: 'Commit' , exact: true }))).toBe(true);
      const merge = page.getByRole('button', { name: 'Merge', exact: true });
      expect(await tall(merge)).toBe(true);
      await merge.tap();
      await page.getByText(/Reviewed commit ccccccc/).waitFor();
      expect(await tall(page.getByRole('button', { name: 'Confirm merge #7' }))).toBe(true);
      expect(await noOverflow(page)).toBe(true);
      expect(errors).toEqual([]);
    } finally { await context.close(); }
  }, 90000);

  it('clears the drawer search on Escape and keeps pinned threads first when reopened', async () => {
    const context = await mobileContext(width);
    try {
      const page = await context.newPage();
      await page.goto(`${origin}/#drawer`);
      const search = page.getByRole('searchbox', { name: 'Search threads' });
      await search.fill('Alpha');
      await page.keyboard.press('Escape');
      await page.getByRole('dialog').waitFor({ state: 'hidden', timeout: 5000 }).catch(() => {});
      await page.getByRole('button', { name: 'Open menu' }).click({ force: true });
      await page.waitForFunction(() => document.querySelector('.mobile-drawer-modern.open'));
      expect(await search.inputValue()).toBe('');
      const titles = await page.locator('.mobile-drawer-project-sessions-modern .thread-item-title-modern').allTextContents();
      expect(titles).toEqual(['Bravo', 'Alpha']);
      expect(await noOverflow(page)).toBe(true);
    } finally { await context.close(); }
  }, 90000);
});
