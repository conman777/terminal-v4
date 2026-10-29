import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { chromium } from '@playwright/test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { managedChromiumPath } from '../test/managedChromium';

let browser, server, origin, bundle;
let state = { revision: 0, projects: {} };

beforeAll(async () => {
  const fixture = `
    import React, { useState } from 'react';
    import { createRoot } from 'react-dom/client';
    import './src/styles.css';
    import './src/WorkspaceUI.css';
    import './src/ProUI.css';
    import { ThemeProvider } from './src/contexts/ThemeContext';
    import ThreadsSidebar from './src/components/ThreadsSidebar';
    import { MobileDrawer } from './src/components/MobileDrawer';
    const t = (id, topic, extra = {}) => ({ id, title: topic, cwd: '/repo', updatedAt: '2026-03-05T18:00:00.000Z', thread: { topic, projectPath: '/repo', ...extra } });
    const sessions = [t('a', 'Alpha conversation about layout'), t('b', 'Bravo fork of alpha'), t('c', 'Charlie delegated child task')];
    const groups = [{ projectName: 'Repo', projectPath: '/repo', sessions }];
    const noop = () => {};
    const mobile = location.hash === '#mobile';
    function App() {
      const [selected, setSelected] = useState('');
      return mobile
        ? <MobileDrawer isOpen onClose={noop} onCreateSession={noop} projects={[]} activeSessions={sessions} archivedSessions={[]} activeSessionId={selected} sessionActivity={{}} onSelectSession={setSelected} onViewChange={noop} sessionsGroupedByProject={groups} />
        : <ThemeProvider><div style={{ width: 300, height: '100vh' }}><ThreadsSidebar isCollapsed={false} workspacePath="/repo" onToggle={noop} projects={[]} sessionsGroupedByProject={groups} pinnedSessions={[]} archivedSessions={[]} activeSessionId={selected} sessionActivity={{}} onSelectSession={setSelected} onPinSession={noop} onUnpinSession={noop} onArchiveSession={noop} onUnarchiveSession={noop} onTopicChange={noop} onCloseSession={noop} onCreateSession={noop} onCloseProject={noop} onAddProject={noop} onOpenSettings={noop} onOpenBookmarks={noop} onOpenNotes={noop} onTogglePreview={noop} onToggleFileManager={noop} logout={noop} /></div></ThemeProvider>;
    }
    createRoot(document.getElementById('root')).render(<App />);
  `;
  const out = execFileSync(process.execPath, ['-e', `require('esbuild').build({stdin:{contents:process.argv[1],resolveDir:process.cwd(),loader:'jsx'},bundle:true,write:false,outdir:'out',format:'iife',jsx:'automatic',loader:{'.css':'css','.svg':'dataurl','.png':'dataurl','.woff2':'dataurl','.woff':'dataurl','.ttf':'dataurl'},define:{'import.meta.env.VITE_API_URL':'""','import.meta.env.DEV':'false','import.meta.env.MODE':'"test"','import.meta.env.BASE_URL':'"/"','import.meta.env.PROD':'true'},logLevel:'error'}).then(r=>process.stdout.write(JSON.stringify(r.outputFiles.map(f=>({path:f.path,text:f.text})))))`, fixture], { cwd: process.cwd(), encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  bundle = JSON.parse(out);
  server = createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const send = (code, body, type = 'application/json') => { res.statusCode = code; res.setHeader('Content-Type', type); res.end(typeof body === 'string' ? body : JSON.stringify(body)); };
    if (url.pathname === '/fixture.js') return send(200, bundle.find(f => f.path.endsWith('.js')).text, 'text/javascript');
    if (url.pathname === '/fixture.css') return send(200, bundle.find(f => f.path.endsWith('.css')).text, 'text/css');
    if (url.pathname === '/api/thread-order' && req.method === 'GET') return send(200, state);
    if (url.pathname === '/api/thread-order' && req.method === 'PUT') {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        const input = JSON.parse(body);
        if (input.expectedRevision !== state.revision) return send(409, { error: 'stale', current: state });
        state = { revision: state.revision + 1, projects: { ...state.projects, [input.projectPath]: input.order } };
        send(200, state);
      });
      return;
    }
    if (url.pathname === '/api/thread-lineage') return send(200, { links: [{ childId: 'b', parentId: 'a', kind: 'fork' }] });
    if (url.pathname === '/api/workspace/tasks') return send(200, { tasks: [{ id: 't', parentSessionId: 'a', childSessionId: 'c' }], schedules: [] });
    if (url.pathname.startsWith('/api/')) return send(200, []);
    send(200, '<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/fixture.css"><div id="root"></div><script src="/fixture.js"></script>', 'text/html');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ executablePath: await managedChromiumPath(), headless: true });
}, 60000);

afterAll(async () => {
  await browser?.close();
  server?.closeAllConnections();
  if (server) await new Promise(resolve => server.close(resolve));
});

const titles = page => page.locator('.threads-recent .threads-session-topic').allTextContents();
const mobileTitles = page => page.locator('.md-thread-row .thread-item-title-modern').allTextContents();
const noOverflow = page => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1);

describe('thread reordering in a real browser', () => {
  it('desktop 1280: keyboard and drag reordering persist across reload', async () => {
    state = { revision: 0, projects: {} };
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    try {
      const page = await context.newPage();
      await page.goto(origin);
      await page.locator('.threads-recent .threads-session-topic').first().waitFor();
      expect(await titles(page)).toEqual(['Alpha conversation about layout', 'Bravo fork of alpha', 'Charlie delegated child task']);
      await page.getByRole('button', { name: 'Select Alpha conversation about layout' }).focus();
      await page.keyboard.press('Alt+ArrowDown');
      await page.waitForFunction(() => document.querySelector('.threads-recent .threads-session-topic').textContent.startsWith('Bravo'));
      expect(await page.evaluate(() => document.activeElement.getAttribute('aria-label'))).toBe('Select Alpha conversation about layout');
      await page.locator('[data-thread-id="c"]').dragTo(page.locator('[data-thread-id="b"]'), { targetPosition: { x: 20, y: 2 } });
      await page.waitForFunction(() => document.querySelector('.threads-recent .threads-session-topic').textContent.startsWith('Charlie'));
      expect(state.projects['/repo']).toEqual(['c', 'b', 'a']);
      await page.reload();
      await page.locator('.threads-recent .threads-session-topic').first().waitFor();
      await page.waitForFunction(() => document.querySelector('.threads-recent .threads-session-topic').textContent.startsWith('Charlie'));
      expect((await titles(page)).map(title => title.split(' ')[0])).toEqual(['Charlie', 'Bravo', 'Alpha']);
      await page.getByRole('button', { name: 'Thread actions for Bravo fork of alpha' }).click();
      await page.getByRole('menuitem', { name: 'Related threads' }).click();
      const dialog = page.getByRole('dialog', { name: /Related threads for Bravo/ });
      await dialog.getByRole('button', { name: /Alpha conversation/ }).waitFor();
      const box = await dialog.boundingBox();
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(1280);
      expect(await noOverflow(page)).toBe(true);
    } finally { await context.close(); }
  }, 60000);

  it.each([320, 390])('mobile %ipx: options, long-press drag and related threads fit and persist', async width => {
    state = { revision: 0, projects: {} };
    const context = await browser.newContext({ viewport: { width, height: 800 }, hasTouch: true, isMobile: true });
    try {
      const page = await context.newPage();
      await page.goto(`${origin}/#mobile`);
      await page.locator('.md-thread-row').first().waitFor();
      expect(await noOverflow(page)).toBe(true);
      const options = page.locator('[data-reorder-id="a"]').getByRole('button', { name: 'Thread options' });
      const optionsBox = await options.boundingBox();
      expect(optionsBox.width).toBeGreaterThanOrEqual(44);
      expect(optionsBox.height).toBeGreaterThanOrEqual(44);
      await options.tap();
      const bar = page.locator('[data-reorder-id="a"]').getByRole('group', { name: /Organize/ });
      const barBox = await bar.boundingBox();
      expect(barBox.x + barBox.width).toBeLessThanOrEqual(width);
      for (const button of await bar.getByRole('button').all()) expect((await button.boundingBox()).height).toBeGreaterThanOrEqual(44);
      await bar.getByRole('button', { name: 'Move down' }).tap();
      await page.waitForFunction(() => document.querySelector('.md-thread-row .thread-item-title-modern').textContent.startsWith('Bravo'));

      const session = await context.newCDPSession(page);
      const rowBox = await page.locator('[data-reorder-id="c"]').boundingBox();
      const targetBox = await page.locator('[data-reorder-id="b"]').boundingBox();
      const point = (x, y) => ({ x: Math.round(x), y: Math.round(y) });
      const start = point(rowBox.x + 30, rowBox.y + 20);
      await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [start] });
      await page.waitForTimeout(700);
      await session.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [point(start.x, (start.y + targetBox.y) / 2)] });
      await session.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [point(start.x, targetBox.y + 4)] });
      await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await page.waitForFunction(() => document.querySelector('.md-thread-row').dataset.reorderId === 'c' || document.querySelectorAll('.md-thread-row')[1].dataset.reorderId === 'c');
      const saved = state.projects['/repo'];
      expect(saved.indexOf('c')).toBeLessThan(saved.indexOf('b'));
      await page.reload();
      await page.locator('.md-thread-row').first().waitFor();
      await page.waitForFunction(expected => [...document.querySelectorAll('.md-thread-row')].map(row => row.dataset.reorderId).join() === expected, saved.join());

      const related = page.locator('[data-reorder-id="b"]');
      await related.getByRole('button', { name: 'Thread options' }).tap();
      await related.getByRole('button', { name: 'Related threads' }).tap();
      const dialog = page.getByRole('dialog', { name: /Related threads for Bravo/ });
      await dialog.getByRole('button', { name: /Alpha conversation/ }).waitFor();
      const dialogBox = await dialog.boundingBox();
      expect(dialogBox.x).toBeGreaterThanOrEqual(0);
      expect(dialogBox.x + dialogBox.width).toBeLessThanOrEqual(width);
      expect((await dialog.getByRole('button', { name: /Alpha conversation/ }).boundingBox()).height).toBeGreaterThanOrEqual(44);
      expect(await noOverflow(page)).toBe(true);
    } finally { await context.close(); }
  }, 60000);
});
