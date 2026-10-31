import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { readFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { beforeAll, afterAll, describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { createBrowser } = require('../../../rust/crates/api/src/workspace_browser.cjs');
const evidence = resolve(process.cwd(), '../output/overnight-polish-20261025');
let engine, site, server, script, styles;
beforeAll(async () => {
  server = createServer((request, response) => {
    response.setHeader('Content-Type', 'text/html');
    if (request.url === '/mousedown') {
      response.end(`<title>Mouse fixture</title><button style="position:absolute;left:20px;top:80px;width:100px;height:40px" onmousedown="prompt('Continue?')" onclick="document.title='CLICKED'">Open</button>`);
      return;
    }
    if (request.url === '/scroll') {
      response.end('<title>Scroll fixture</title><style>body{height:4000px}</style><button style="position:absolute;top:700px">Scrolled target</button>');
      return;
    }
    if (request.url === '/drag-scroll') {
      response.end('<title>Drag scroll fixture</title><style>body{height:4000px}#handle{position:fixed;top:0;left:0;width:200px;height:300px;background:#ddd}</style><div id="handle" onpointermove="if(event.buttons) window.scrollBy(0,200)">Drag to scroll</div>');
      return;
    }
    if (request.url === '/input-update') {
      response.end('<title>Input fixture</title><style>input,button{position:absolute;left:20px}input{top:20px}button{top:80px}</style><input oninput="document.querySelector(\'button\').textContent=this.value"><button onclick="document.title=this.textContent">Original</button>');
      return;
    }
    if (request.url === '/responsive') {
      response.end(`<title>Responsive fixture</title><style>button{position:absolute;top:80px;transform:translateX(-50%);width:80px;height:36px}#intended{left:50%}#other{left:calc(50% + 105px)}</style><button id="intended" onclick="document.title='INTENDED'">Wanted</button><button id="other" onclick="document.title='WRONG'">Other</button>`);
      return;
    }
    response.end(`<title>${request.url === '/next' ? 'Second fixture page' : 'Synthetic browser fixture'}</title><style>body{font:20px system-ui;background:#eef3f7;color:#152131}input,button,a{font:inherit;position:absolute;left:20px}input{top:20px;width:220px;height:36px}button{top:80px}a{top:140px}</style><label><input aria-label="Fixture name"></label><button onclick="document.title=prompt('Fixture name?',document.querySelector('input').value)||'Cancelled'">Ask name</button><a href="/next">Next page</a>`);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  site = `http://127.0.0.1:${server.address().port}`;
  engine = await createBrowser();
  async function compileFixture() {
    const { build } = require('esbuild');
  const result = await build({
    stdin: { contents: `import React from 'react'; import {createRoot} from 'react-dom/client';import WorkspaceBrowser from './WorkspaceBrowser';const root=createRoot(document.getElementById('root'));window.hideBrowser=()=>root.render(null);window.mountBrowser=()=>root.render(<WorkspaceBrowser onClose={()=>{}} onToggleExpanded={()=>{}}/>);window.mountBrowser();`, resolveDir: process.argv[1], loader: 'jsx' },
    bundle: true, write: false, format: 'iife', jsx: 'automatic', loader: { '.css': 'empty' },
    plugins: [{ name: 'isolated-engine-api', setup(builder) {
      builder.onResolve({ filter: /utils\/api$/ }, () => ({ path: 'fixture-api', namespace: 'fixture' }));
      builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: `export async function apiFetch(path,options={}) {const value=await window.syntheticRequest(path,options.body);return {ok:true,status:200,json:async()=>value};}` }));
    } }],
  });
  process.stdout.write(result.outputFiles[0].text);
  }
  script = execFileSync(process.execPath, ['-e', `(${compileFixture.toString()})()`, resolve(process.cwd(), 'src/components')], { cwd: process.cwd(), encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  styles = (await Promise.all(['styles.css', 'WorkspaceUI.css', 'components/WorkspaceBrowser.css'].map(file => readFile(resolve(process.cwd(), 'src', file), 'utf8')))).join('\n');
  await mkdir(evidence, { recursive: true });
}, 30000);
afterAll(async () => {
  await engine?.close();
  server?.closeAllConnections();
  if (server) await new Promise(done => server.close(done));
});

describe('WorkspaceBrowser with an isolated managed Chromium helper', () => {
  it('rejects a stale pointer after another pane scrolls with PageDown', async () => {
    await engine.command({ type: 'resize', width: 600, height: 500 });
    await engine.command({ type: 'navigate', url: `${site}/scroll`, human: true });
    const before = await engine.command({ type: 'frame' });
    const tab = before.tabs.find(item => item.id === before.activeTabId);
    await engine.command({ type: 'key', key: 'PageDown', human: true });
    const page = engine.browser.contexts().flatMap(context => context.pages()).find(item => item.url() === `${site}/scroll`);
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
    await expect(engine.command({ type: 'pointer', action: 'down', button: 'left', x: 50, y: 50, human: true,
      frame: { tabId: tab.id, documentId: tab.documentId, width: before.width, height: before.height, revision: before.viewRevision } }))
      .rejects.toThrow(/view.*changed/i);
  }, 30000);

  it('discards an old screenshot if its document changes during capture', async () => {
    await engine.command({ type: 'navigate', url: `${site}/responsive`, human: true });
    const page = engine.browser.contexts().flatMap(context => context.pages()).find(item => item.url() === `${site}/responsive`);
    const original = page.screenshot.bind(page);
    let release, captured;
    const gate = new Promise(resolve => { release = resolve; });
    const ready = new Promise(resolve => { captured = resolve; });
    page.screenshot = async options => { const image = await original(options); captured(); await gate; return image; };
    try {
      const pending = engine.command({ type: 'frame' });
      await ready;
      await engine.command({ type: 'navigate', url: `${site}/next`, human: true });
      release();
      const frame = await pending;
      expect({ image: frame.image, title: frame.tabs.find(tab => tab.id === frame.activeTabId)?.title })
        .toEqual({ image: null, title: 'Second fixture page' });
    } finally { release(); page.screenshot = original; }
  }, 30000);

  it('lets different sized panes share a viewport without repeatedly resizing it', async () => {
    await engine.command({ type: 'navigate', url: `${site}/responsive`, human: true });
    let queue = Promise.resolve(), resizes = 0;
    const command = input => {
      const result = queue.then(() => engine.command(input));
      queue = result.catch(() => {});
      return result;
    };
    const contexts = [];
    async function pane(width) {
      const context = await engine.browser.newContext({ viewport: { width: 1280, height: 900 } });
      contexts.push(context);
      const page = await context.newPage();
      await page.exposeFunction('syntheticRequest', async (path, body) => {
        if (path.endsWith('/approvals')) return { requests: [] };
        if (path.endsWith('/sessions')) return { id: 'synthetic-session', state: await command({ type: 'state' }) };
        if (body?.type === 'resize') resizes++;
        return command(body ? { ...body, human: true } : { type: 'frame' });
      });
      await page.setContent(`<html data-theme="light"><style>${styles}body{margin:0}#root{display:flex;width:${width}px;height:800px}</style><div id="root"></div></html>`);
      await page.addScriptTag({ content: script });
      await page.waitForFunction(() => document.querySelector('.workspace-browser-surface img')?.naturalWidth > 0 && document.querySelector('.workspace-browser-surface')?.getAttribute('aria-busy') === 'false');
      return page;
    }
    try {
      const first = await pane(600);
      const second = await pane(390);
      await first.waitForFunction(() => document.querySelector('.workspace-browser-surface img')?.naturalWidth === 390 && document.querySelector('.workspace-browser-surface')?.getAttribute('aria-busy') === 'false');
      await second.waitForFunction(() => document.querySelector('.workspace-browser-surface img')?.naturalWidth === 390 && document.querySelector('.workspace-browser-surface')?.getAttribute('aria-busy') === 'false');
      const settled = resizes;
      await first.waitForTimeout(1000);
      expect(resizes).toBe(settled);
      const frame = await command({ type: 'frame' });
      const surface = await first.getByRole('application', { name: 'Interactive browser page' }).boundingBox();
      const scale = Math.min(surface.width / frame.width, surface.height / frame.height);
      await first.mouse.click(surface.x + (surface.width - frame.width * scale) / 2 + frame.width / 2 * scale,
        surface.y + (surface.height - frame.height * scale) / 2 + 98 * scale);
      await expect.poll(async () => {
        const current = await command({ type: 'state' });
        return current.tabs.find(tab => tab.id === current.activeTabId)?.title;
      }).toBe('INTENDED');
    } finally { await Promise.all(contexts.map(context => context.close())); }
  }, 30000);

  it('rejects a stale pointer after another pane scrolls the shared page', async () => {
    await engine.command({ type: 'resize', width: 600, height: 500 });
    await engine.command({ type: 'navigate', url: `${site}/scroll`, human: true });
    await engine.command({ type: 'pointer', action: 'move', button: 'left', x: 50, y: 50, human: true });
    const before = await engine.command({ type: 'frame' });
    const tab = before.tabs.find(item => item.id === before.activeTabId);
    await engine.command({ type: 'wheel', deltaX: 0, deltaY: 600, human: true });
    const page = engine.browser.contexts().flatMap(context => context.pages()).find(item => item.url() === `${site}/scroll`);
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
    await expect(engine.command({ type: 'pointer', action: 'down', button: 'left', x: 50, y: 50, human: true,
      frame: { tabId: tab.id, documentId: tab.documentId, width: before.width, height: before.height, revision: before.viewRevision } }))
      .rejects.toThrow(/view.*changed/i);
  }, 30000);

  it('continues a wheel gesture without accepting a different pane’s stale input', async () => {
    await engine.command({ type: 'resize', width: 600, height: 500 });
    await engine.command({ type: 'navigate', url: `${site}/scroll`, human: true });
    const before = await engine.command({ type: 'frame' });
    const tab = before.tabs.find(item => item.id === before.activeTabId);
    const frame = { tabId: tab.id, documentId: tab.documentId, width: before.width, height: before.height, revision: before.viewRevision };
    const wheel = { type: 'wheel', deltaX: 0, deltaY: 120, human: true, frame, scrollId: 'scroll-fixture-one' };
    await engine.command(wheel);
    await engine.command(wheel);
    const page = engine.browser.contexts().flatMap(context => context.pages()).find(item => item.url() === `${site}/scroll`);
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThanOrEqual(240);
    await expect(engine.command({ ...wheel, scrollId: 'scroll-fixture-other' })).rejects.toThrow(/view.*changed/i);
    const latest = await engine.command({ type: 'frame' });
    await engine.command({ ...wheel, frame: { ...frame, revision: latest.viewRevision }, scrollId: 'scroll-fixture-other' });
    await expect(engine.command(wheel)).rejects.toThrow(/view.*changed/i);
  }, 30000);

  it('continues repeated scrolling keys only while their view has not been changed by another pane', async () => {
    await engine.command({ type: 'resize', width: 600, height: 500 });
    await engine.command({ type: 'navigate', url: `${site}/scroll`, human: true });
    const before = await engine.command({ type: 'frame' });
    const tab = before.tabs.find(item => item.id === before.activeTabId);
    const frame = { tabId: tab.id, documentId: tab.documentId, width: before.width, height: before.height, revision: before.viewRevision };
    const key = { type: 'key', key: 'PageDown', human: true, frame, scrollId: 'keys-fixture-one' };
    await engine.command(key);
    await engine.command(key);
    const after = await engine.command({ type: 'state' });
    expect(after.tabs.find(item => item.id === after.activeTabId)?.viewRevision).toBe(frame.revision + 2);
    await expect(engine.command({ ...key, scrollId: 'keys-fixture-other' })).rejects.toThrow(/view.*changed/i);
  }, 30000);

  it('rejects stale clicks after typing while allowing the same typing burst to continue', async () => {
    await engine.command({ type: 'resize', width: 600, height: 500 });
    await engine.command({ type: 'navigate', url: `${site}/input-update`, human: true });
    await engine.command({ type: 'pointer', action: 'down', gestureId: 'focus-input', button: 'left', x: 50, y: 30, human: true });
    await engine.command({ type: 'pointer', action: 'up', gestureId: 'focus-input', button: 'left', x: 50, y: 30, human: true });
    const before = await engine.command({ type: 'frame' });
    const tab = before.tabs.find(item => item.id === before.activeTabId);
    const frame = { tabId: tab.id, documentId: tab.documentId, width: before.width, height: before.height, revision: before.viewRevision };
    await engine.command({ type: 'text', text: 'x', inputId: 'typing-fixture', human: true, frame });
    await engine.command({ type: 'text', text: 'y', inputId: 'typing-fixture', human: true, frame });
    const remote = engine.browser.contexts().flatMap(context => context.pages()).find(item => item.url() === `${site}/input-update`);
    expect(await remote.locator('input').inputValue()).toBe('xy');
    await expect(engine.command({ type: 'pointer', action: 'down', gestureId: 'stale-typing-view', button: 'left', x: 50, y: 90, human: true, frame }))
      .rejects.toThrow(/view.*changed/i);
    expect(await remote.title()).toBe('Input fixture');
  }, 30000);

  it('allows typing immediately after the same pane focuses a field', async () => {
    await engine.command({ type: 'resize', width: 600, height: 500 });
    await engine.command({ type: 'navigate', url: `${site}/input-update`, human: true });
    const before = await engine.command({ type: 'frame' });
    const tab = before.tabs.find(item => item.id === before.activeTabId);
    const frame = { tabId: tab.id, documentId: tab.documentId, width: before.width, height: before.height, revision: before.viewRevision };
    const pointer = { type: 'pointer', gestureId: 'focus-and-type', button: 'left', x: 50, y: 30, human: true, frame };
    await engine.command({ ...pointer, action: 'down' });
    await engine.command({ ...pointer, action: 'up' });
    await engine.command({ type: 'text', inputId: 'focus-and-type', text: 'xy', human: true, frame });
    const remote = engine.browser.contexts().flatMap(context => context.pages()).find(item => item.url() === `${site}/input-update`);
    expect(await remote.locator('input').inputValue()).toBe('xy');
  }, 30000);

  it('types immediately after clicking a field through the browser pane', async () => {
    const context = await engine.browser.newContext({ viewport: { width: 1280, height: 900 } });
    try {
      const page = await context.newPage();
      await page.exposeFunction('syntheticRequest', async (path, body) => {
        if (path.endsWith('/approvals')) return { requests: [] };
        if (path.endsWith('/sessions')) return { id: 'synthetic-session', state: await engine.command({ type: 'state' }) };
        return engine.command(body ? { ...body, human: true } : { type: 'frame' });
      });
      await page.setContent(`<html data-theme="light"><style>${styles}body{margin:0}#root{display:flex;width:600px;height:860px}</style><div id="root"></div></html>`);
      await page.addScriptTag({ content: script });
      await page.getByRole('textbox', { name: 'Browser address', exact: true }).fill(`${site}/input-update`);
      await page.getByRole('button', { name: 'Go', exact: true }).click();
      await page.getByRole('tab', { name: 'Input fixture', exact: true }).waitFor();
      let frame;
      await expect.poll(async () => {
        frame = await engine.command({ type: 'frame' });
        const surface = page.getByRole('application', { name: 'Interactive browser page' });
        const image = surface.locator('img');
        return await image.getAttribute('data-view-revision').catch(() => null) === String(frame.viewRevision)
          && await surface.getAttribute('aria-busy') === 'false';
      }).toBe(true);
      const surface = await page.getByRole('application', { name: 'Interactive browser page' }).boundingBox();
      const scale = Math.min(surface.width / frame.width, surface.height / frame.height);
      await page.mouse.click(surface.x + (surface.width - frame.width * scale) / 2 + 50 * scale,
        surface.y + (surface.height - frame.height * scale) / 2 + 30 * scale);
      await page.keyboard.type('xy');
      const remote = engine.browser.contexts().flatMap(item => item.pages()).find(item => item.url() === `${site}/input-update`);
      await expect.poll(() => remote.locator('input').inputValue()).toBe('xy');
      expect(await page.getByRole('alert').count()).toBe(0);
    } finally { await context.close(); }
  }, 30000);

  it('scrolls consecutive wheel events from the pane while the first is still in flight', async () => {
    const context = await engine.browser.newContext({ viewport: { width: 1280, height: 900 } });
    let releaseFirst = () => {}, firstStarted = () => {};
    const firstGate = new Promise(resolve => { releaseFirst = resolve; });
    const started = new Promise(resolve => { firstStarted = resolve; });
    let wheelCount = 0;
    try {
      const page = await context.newPage();
      await page.exposeFunction('syntheticRequest', async (path, body) => {
        if (path.endsWith('/approvals')) return { requests: [] };
        if (path.endsWith('/sessions')) return { id: 'synthetic-session', state: await engine.command({ type: 'state' }) };
        if (body?.type === 'wheel' && ++wheelCount === 1) { firstStarted(); await firstGate; }
        return engine.command(body ? { ...body, human: true } : { type: 'frame' });
      });
      await page.setContent(`<html data-theme="light"><style>${styles}body{margin:0}#root{display:flex;width:600px;height:860px}</style><div id="root"></div></html>`);
      await page.addScriptTag({ content: script });
      await page.getByRole('textbox', { name: 'Browser address', exact: true }).fill(`${site}/scroll`);
      await page.getByRole('button', { name: 'Go', exact: true }).click();
      await page.getByRole('tab', { name: 'Scroll fixture', exact: true }).waitFor();
      await page.waitForFunction(() => document.querySelector('.workspace-browser-surface img')?.naturalWidth === 600 && document.querySelector('.workspace-browser-surface')?.getAttribute('aria-busy') === 'false');
      const surface = await page.getByRole('application', { name: 'Interactive browser page' }).boundingBox();
      await page.mouse.move(surface.x + 100, surface.y + 100);
      await page.mouse.wheel(0, 120);
      await started;
      await page.mouse.wheel(0, 120);
      releaseFirst();
      const remote = engine.browser.contexts().flatMap(item => item.pages()).find(item => item.url() === `${site}/scroll`);
      await expect.poll(() => remote.evaluate(() => window.scrollY)).toBeGreaterThanOrEqual(240);
      expect(wheelCount).toBe(2);
      expect(await page.getByRole('alert').count()).toBe(0);
    } finally { releaseFirst(); await context.close(); }
  }, 30000);

  it('invalidates an older frame during a held pointer drag and still releases its own gesture', async () => {
    await engine.command({ type: 'resize', width: 600, height: 500 });
    await engine.command({ type: 'navigate', url: `${site}/drag-scroll`, human: true });
    const before = await engine.command({ type: 'frame' });
    const tab = before.tabs.find(item => item.id === before.activeTabId);
    const frame = { tabId: tab.id, documentId: tab.documentId, width: before.width, height: before.height, revision: before.viewRevision };
    const drag = { type: 'pointer', gestureId: 'scrollbar-fixture', button: 'left', human: true, frame };
    await engine.command({ ...drag, action: 'down', x: 100, y: 50 });
    await engine.command({ ...drag, action: 'move', x: 100, y: 200 });
    const page = engine.browser.contexts().flatMap(context => context.pages()).find(item => item.url() === `${site}/drag-scroll`);
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
    await expect(engine.command({ type: 'pointer', action: 'down', gestureId: 'stale-pane', button: 'left', x: 100, y: 100, human: true, frame }))
      .rejects.toThrow(/view.*changed/i);
    await engine.command({ ...drag, action: 'up', x: 100, y: 200 });
    const current = await engine.command({ type: 'frame' });
    await engine.command({ type: 'pointer', action: 'down', gestureId: 'fresh-pane', button: 'left', x: 100, y: 100, human: true,
      frame: { ...frame, revision: current.viewRevision } });
    await engine.command({ type: 'pointer', action: 'cancel', gestureId: 'fresh-pane', human: true });
  }, 30000);

  it('cancels a held pointer without clicking if another pane changes the view', async () => {
    await engine.command({ type: 'resize', width: 600, height: 500 });
    await engine.command({ type: 'navigate', url: `${site}/responsive`, human: true });
    const before = await engine.command({ type: 'frame' });
    const tab = before.tabs.find(item => item.id === before.activeTabId);
    const frame = { tabId: tab.id, documentId: tab.documentId, width: before.width, height: before.height, revision: before.viewRevision };
    await engine.command({ type: 'pointer', action: 'down', gestureId: 'interrupted-pointer', button: 'left', x: 300, y: 98, human: true, frame });
    await engine.command({ type: 'wheel', deltaX: 0, deltaY: 100, human: true });
    await expect(engine.command({ type: 'pointer', action: 'up', gestureId: 'interrupted-pointer', button: 'left', x: 300, y: 98, human: true, frame }))
      .rejects.toThrow(/view.*changed/i);
    const current = await engine.command({ type: 'state' });
    expect(current.tabs.find(item => item.id === current.activeTabId)?.title).toBe('Responsive fixture');
    await engine.command({ type: 'pointer', action: 'down', gestureId: 'next-pointer', button: 'left', x: 30, y: 30, human: true });
    await engine.command({ type: 'pointer', action: 'cancel', gestureId: 'next-pointer', human: true });
  }, 30000);

  it('rejects a late pointer-down after its pane cancellation arrived first', async () => {
    await engine.command({ type: 'resize', width: 600, height: 500 });
    await engine.command({ type: 'navigate', url: `${site}/responsive`, human: true });
    await engine.command({ type: 'pointer', action: 'cancel', gestureId: 'cancel-before-down', human: true });
    await expect(engine.command({ type: 'pointer', action: 'down', gestureId: 'cancel-before-down', button: 'left', x: 300, y: 98, human: true }))
      .rejects.toThrow(/cancelled/i);
    const current = await engine.command({ type: 'state' });
    expect(current.tabs.find(tab => tab.id === current.activeTabId)?.title).toBe('Responsive fixture');
  }, 30000);

  it('cancels a held pointer when a mouse-down dialog is dismissed', async () => {
    await engine.command({ type: 'resize', width: 600, height: 500 });
    await engine.command({ type: 'navigate', url: `${site}/mousedown`, human: true });
    await engine.command({ type: 'pointer', action: 'down', gestureId: 'dialog-gesture', button: 'left', x: 70, y: 98, human: true }).catch(() => {});
    const dialog = (await engine.command({ type: 'state' })).dialog;
    await engine.command({ type: 'dialog', dialogId: dialog.id, accept: false, human: true });
    const page = engine.browser.contexts().flatMap(context => context.pages()).find(item => item.url() === `${site}/mousedown`);
    await page.evaluate(() => { window.recordedButtons = []; document.addEventListener('mousemove', event => window.recordedButtons.push(event.buttons)); });
    await engine.command({ type: 'pointer', action: 'move', button: 'left', x: 30, y: 30, human: true });
    expect(await page.evaluate(() => ({ title: document.title, buttons: window.recordedButtons.at(-1) })))
      .toEqual({ title: 'Mouse fixture', buttons: 0 });
  }, 30000);

  it('keeps a human pointer held during a read-only agent screenshot', async () => {
    await engine.command({ type: 'resize', width: 600, height: 500 });
    await engine.command({ type: 'navigate', url: `${site}/responsive`, human: true });
    const before = await engine.command({ type: 'frame' });
    const tab = before.tabs.find(item => item.id === before.activeTabId);
    const page = engine.browser.contexts().flatMap(context => context.pages()).find(item => item.url() === `${site}/responsive`);
    await page.evaluate(() => { window.recordedButtons = []; document.addEventListener('mousemove', event => window.recordedButtons.push(event.buttons)); });
    await engine.command({ type: 'pointer', action: 'down', gestureId: 'human-gesture', button: 'left', x: 300, y: 98, human: true });
    await engine.command({ type: 'agent', name: 'browser_screenshot', input: {}, label: 'fixture-agent', allowedOrigins: [site], humanReading: true, target: { tabId: tab.id, documentId: tab.documentId } });
    await engine.command({ type: 'pointer', action: 'move', gestureId: 'human-gesture', button: 'left', x: 30, y: 30, human: true });
    expect(await page.evaluate(() => window.recordedButtons.at(-1))).toBe(1);
    await engine.command({ type: 'pointer', action: 'cancel', gestureId: 'human-gesture', human: true });
    expect(await page.title()).toBe('Responsive fixture');
  }, 30000);

  it('releases an outstanding pointer without clicking when another pane resizes', async () => {
    await engine.command({ type: 'resize', width: 600, height: 500 });
    await engine.command({ type: 'navigate', url: `${site}/responsive`, human: true });
    const page = engine.browser.contexts().flatMap(context => context.pages()).find(item => item.url() === `${site}/responsive`);
    await page.evaluate(() => { window.recordedButtons = []; document.addEventListener('mousemove', event => window.recordedButtons.push(event.buttons)); });
    await engine.command({ type: 'pointer', action: 'down', button: 'left', x: 300, y: 98, human: true });
    await engine.command({ type: 'resize', width: 390, height: 500 });
    await engine.command({ type: 'pointer', action: 'move', button: 'left', x: 30, y: 30, human: true });
    expect(await page.evaluate(() => ({ title: document.title, buttons: window.recordedButtons.at(-1) })))
      .toEqual({ title: 'Responsive fixture', buttons: 0 });
  }, 30000);

  it('rejects a stale pointer after another pane resizes the shared browser', async () => {
    await engine.command({ type: 'resize', width: 600, height: 500 });
    await engine.command({ type: 'navigate', url: `${site}/responsive`, human: true });
    const previous = await engine.command({ type: 'frame' });
    const tab = previous.tabs.find(item => item.id === previous.activeTabId);
    await engine.command({ type: 'resize', width: 390, height: 500 });
    await expect(engine.command({ type: 'pointer', action: 'down', button: 'left', x: 300, y: 98, human: true,
      frame: { tabId: tab.id, documentId: tab.documentId, width: previous.width, height: previous.height, revision: previous.viewRevision } }))
      .rejects.toThrow(/view.*changed/i);
    await engine.command({ type: 'resize', width: previous.width, height: previous.height });
    await expect(engine.command({ type: 'pointer', action: 'down', button: 'left', x: 300, y: 98, human: true,
      frame: { tabId: tab.id, documentId: tab.documentId, width: previous.width, height: previous.height, revision: previous.viewRevision } }))
      .rejects.toThrow(/view.*changed/i);
    const current = await engine.command({ type: 'state' });
    expect(current.tabs.find(item => item.id === current.activeTabId)?.title).toBe('Responsive fixture');
  }, 30000);

  it('does not send a stale-frame click to a different target during resize', async () => {
    const context = await engine.browser.newContext({ viewport: { width: 1280, height: 900 } });
    let holdFrames = false, releaseFrames = () => {}, frameGate = Promise.resolve();
    let frameWaiting = false, lastFrame, lastResize, pointerCommands = 0, otherInputCommands = 0, pointerCancels = 0;
    let syntheticControl = { owner: 'available' };
    try {
      const page = await context.newPage();
      page.setDefaultTimeout(15000);
      await page.exposeFunction('syntheticRequest', async (path, body) => {
        if (path.endsWith('/approvals')) return { requests: [] };
        if (path.endsWith('/sessions')) return { id: 'synthetic-session', state: { ...await engine.command({ type: 'state' }), control: syntheticControl } };
        if (path.endsWith('/frame') && holdFrames) { frameWaiting = true; await frameGate; }
        if (body?.type === 'pointer' && body.action !== 'move') pointerCommands++;
        if (body?.type === 'pointer' && body.action === 'cancel') pointerCancels++;
        if (['wheel', 'key', 'text'].includes(body?.type)) otherInputCommands++;
        const result = await engine.command(body ? { ...body, human: true } : { type: 'frame' });
        if (body?.type === 'control') syntheticControl = { owner: body.owner };
        if (path.endsWith('/frame') && result.image) lastFrame = { width: result.width, height: result.height };
        if (body?.type === 'resize') lastResize = { width: body.width, height: body.height };
        return { ...result, control: syntheticControl };
      });
      await page.setContent(`<html data-theme="light"><style>${styles}body{margin:0}#root{display:flex;width:600px;height:860px}</style><div id="root"></div></html>`);
      await page.addScriptTag({ content: script });
      await page.getByRole('textbox', { name: 'Browser address', exact: true }).fill(`${site}/responsive`);
      await page.getByRole('button', { name: 'Go', exact: true }).click();
      await page.getByRole('tab', { name: 'Responsive fixture', exact: true }).waitFor();
      await expect.poll(() => lastResize?.width).toBe(600);
      await expect.poll(() => lastFrame?.width).toBe(600);
      await page.waitForFunction(() => document.querySelector('.workspace-browser-surface img')?.naturalWidth === 600);
      await page.getByRole('button', { name: 'Show typing controls' }).click();
      const typing = page.getByRole('textbox', { name: 'Type into browser page' });
      await typing.fill('unsent typing');
      await expect.poll(() => page.getByRole('button', { name: 'Type', exact: true }).isEnabled()).toBe(true);
      await expect.poll(async () => {
        const surface = page.getByRole('application', { name: 'Interactive browser page' });
        const image = await surface.locator('img').evaluate(node => [node.naturalWidth, node.naturalHeight]).catch(() => []);
        return (await surface.getAttribute('aria-busy')) === 'false' && image[0] === lastResize?.width && image[1] === lastResize?.height;
      }).toBe(true);
      holdFrames = true;
      frameGate = new Promise(resolve => { releaseFrames = resolve; });
      await expect.poll(() => frameWaiting).toBe(true);
      await page.locator('#root').evaluate(root => { root.style.width = '390px'; });
      await expect.poll(() => lastResize?.width).toBe(390);
      await page.getByRole('heading', { name: 'Resizing browser…' }).waitFor();
      expect(await page.getByRole('status').filter({ hasText: 'You can edit your draft' }).count()).toBe(1);
      expect(await typing.isEnabled()).toBe(true);
      expect(await page.getByRole('button', { name: 'Type', exact: true }).isDisabled()).toBe(true);
      expect(await typing.inputValue()).toBe('unsent typing');
      await typing.fill('unsent typing while resizing');
      await typing.press('Enter');
      const surface = await page.getByRole('application', { name: 'Interactive browser page' }).boundingBox();
      const scale = Math.min(surface.width / lastFrame.width, surface.height / lastFrame.height);
      await page.mouse.click(surface.x + (surface.width - lastFrame.width * scale) / 2 + 300 * scale,
        surface.y + (surface.height - lastFrame.height * scale) / 2 + 98 * scale);
      await page.getByRole('application', { name: 'Interactive browser page' }).focus();
      await page.keyboard.type('x');
      await page.mouse.wheel(0, 80);
      await page.getByRole('application', { name: 'Interactive browser page' }).dispatchEvent('pointerdown', { pointerType: 'touch', clientX: surface.x + 30, clientY: surface.y + 30 });
      await page.getByRole('application', { name: 'Interactive browser page' }).dispatchEvent('pointerup', { pointerType: 'touch', clientX: surface.x + 30, clientY: surface.y + 30 });
      await page.waitForTimeout(300);
      const browserState = await engine.command({ type: 'state' });
      expect({ pointerCommands, otherInputCommands, title: browserState.tabs.find(tab => tab.id === browserState.activeTabId)?.title })
        .toEqual({ pointerCommands: 0, otherInputCommands: 0, title: 'Responsive fixture' });
      holdFrames = false;
      releaseFrames();
      await page.waitForFunction(() => document.querySelector('.workspace-browser-surface img')?.naturalWidth === 390);
      expect(await typing.isEnabled()).toBe(true);
      expect(await typing.inputValue()).toBe('unsent typing while resizing');
      const freshSurface = await page.getByRole('application', { name: 'Interactive browser page' }).boundingBox();
      const freshScale = Math.min(freshSurface.width / lastFrame.width, freshSurface.height / lastFrame.height);
      await page.mouse.click(freshSurface.x + (freshSurface.width - lastFrame.width * freshScale) / 2 + 195 * freshScale,
        freshSurface.y + (freshSurface.height - lastFrame.height * freshScale) / 2 + 98 * freshScale);
      await expect.poll(async () => {
        const current = await engine.command({ type: 'state' });
        return current.tabs.find(tab => tab.id === current.activeTabId)?.title;
      }).toBe('INTENDED');
      await expect.poll(async () => {
        const current = await engine.command({ type: 'state' });
        const displayed = await page.locator('.workspace-browser-surface img').getAttribute('data-view-revision');
        return displayed === String(current.tabs.find(tab => tab.id === current.activeTabId)?.viewRevision);
      }).toBe(true);
      const remote = engine.browser.contexts().flatMap(item => item.pages()).find(item => item.url() === `${site}/responsive`);
      await remote.evaluate(() => { document.title = 'DRAG_WAIT'; });
      const beforeDrag = pointerCommands;
      await page.mouse.move(freshSurface.x + (freshSurface.width - lastFrame.width * freshScale) / 2 + 195 * freshScale,
        freshSurface.y + (freshSurface.height - lastFrame.height * freshScale) / 2 + 98 * freshScale);
      await page.mouse.down();
      await expect.poll(() => pointerCommands).toBe(beforeDrag + 1);
      await page.locator('#root').evaluate(root => { root.style.width = '600px'; });
      await expect.poll(() => page.getByRole('application', { name: 'Interactive browser page' }).getAttribute('aria-busy')).toBe('true');
      await expect.poll(() => pointerCancels).toBe(1);
      await expect.poll(() => lastResize?.width).toBe(600);
      const resizedSurface = await page.getByRole('application', { name: 'Interactive browser page' }).boundingBox();
      const oldScale = Math.min(resizedSurface.width / lastFrame.width, resizedSurface.height / lastFrame.height);
      await page.mouse.move(resizedSurface.x + (resizedSurface.width - lastFrame.width * oldScale) / 2 + 300 * oldScale,
        resizedSurface.y + (resizedSurface.height - lastFrame.height * oldScale) / 2 + 98 * oldScale);
      await page.mouse.up();
      await expect.poll(() => pointerCommands).toBe(beforeDrag + 2);
      expect(await remote.title()).toBe('DRAG_WAIT');
      await page.waitForFunction(() => document.querySelector('.workspace-browser-surface img')?.naturalWidth === 600);
      await remote.evaluate(() => { document.title = 'HELD'; });
      const latestSurface = await page.getByRole('application', { name: 'Interactive browser page' }).boundingBox();
      const latestScale = Math.min(latestSurface.width / lastFrame.width, latestSurface.height / lastFrame.height);
      await page.mouse.move(latestSurface.x + (latestSurface.width - lastFrame.width * latestScale) / 2 + 300 * latestScale,
        latestSurface.y + (latestSurface.height - lastFrame.height * latestScale) / 2 + 98 * latestScale);
      const beforeTakeover = pointerCommands;
      await page.mouse.down();
      await expect.poll(() => pointerCommands).toBe(beforeTakeover + 1);
      syntheticControl = { owner: 'agent', label: 'Fixture agent' };
      await page.getByRole('button', { name: 'Take control' }).waitFor();
      await page.mouse.up();
      await page.getByRole('button', { name: 'Take control' }).click();
      await expect.poll(() => pointerCancels).toBe(2);
      await page.waitForFunction(() => document.querySelector('.workspace-browser-surface img')?.naturalWidth === 600);
      expect(await remote.title()).toBe('HELD');
      await remote.evaluate(() => { document.title = 'CANCEL_WAIT'; });
      await page.mouse.move(latestSurface.x + (latestSurface.width - lastFrame.width * latestScale) / 2 + 300 * latestScale,
        latestSurface.y + (latestSurface.height - lastFrame.height * latestScale) / 2 + 98 * latestScale);
      const beforeCancellation = pointerCommands;
      await page.mouse.down();
      await expect.poll(() => pointerCommands).toBe(beforeCancellation + 1);
      await page.getByRole('application', { name: 'Interactive browser page' }).dispatchEvent('pointercancel', { pointerType: 'mouse' });
      await expect.poll(() => pointerCancels).toBe(3);
      await page.mouse.up();
      expect(await remote.title()).toBe('CANCEL_WAIT');
    } finally { releaseFrames(); await context.close(); }
  }, 30000);

  it('navigates, types, resolves a default prompt, follows history and retains tabs across pane remount', async () => {
    const context = await engine.browser.newContext({ viewport: { width: 1280, height: 900 } });
    let commandQueue = Promise.resolve();
    const command = input => {
      const result = commandQueue.then(() => engine.command(input));
      commandQueue = result.catch(() => {});
      return result;
    };
    try {
      const page = await context.newPage();
      page.setDefaultTimeout(15000);
      console.info('flow: new synthetic UI page');
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.exposeFunction('syntheticRequest', async (path, body) => {
        if (path.endsWith('/approvals')) return { requests: [] };
        if (path.endsWith('/sessions')) return { id: 'synthetic-session', state: await command({ type: 'state' }) };
        return command(body ? { ...body, human: true } : { type: 'frame' });
      });
      await page.setContent(`<html data-theme="light"><style>${styles}body{margin:0}#root{display:flex;width:600px;height:860px}</style><div id="root"></div></html>`);
      await page.addScriptTag({ content: script });
      console.info('flow: mounted');
      await page.getByRole('button', { name: 'New browser tab' }).waitFor();
      await page.getByRole('textbox', { name: 'Browser address', exact: true }).fill(site);
      await page.getByRole('button', { name: 'Go', exact: true }).click();
      await page.getByRole('tab', { name: 'Synthetic browser fixture', exact: true }).waitFor();
      console.info('flow: navigated');
      await page.waitForFunction(() => document.querySelector('.workspace-browser-surface img')?.naturalWidth > 0);
      const remoteClick = async (x, y) => {
        const surfaceElement = page.getByRole('application', { name: 'Interactive browser page' });
        let frame;
        await expect.poll(async () => {
          frame = await command({ type: 'frame' });
          const layout = await surfaceElement.evaluate(surface => {
            const rect = surface.getBoundingClientRect(), image = surface.querySelector('img');
            const width = Math.min(1920, Math.max(320, Math.floor(rect.width)));
            const height = Math.min(1200, Math.max(240, Math.floor(rect.height)));
            return { width, height, tab: image?.getAttribute('data-view-tab'), document: image?.getAttribute('data-view-document'), revision: image?.getAttribute('data-view-revision'), ready: surface.getAttribute('aria-busy') === 'false' && image?.naturalWidth === width && image?.naturalHeight === height };
          });
          const activeTab = frame.tabs.find(tab => tab.id === frame.activeTabId);
          return layout.ready && frame.width === layout.width && frame.height === layout.height && layout.tab === activeTab?.id && layout.document === activeTab?.documentId && layout.revision === String(frame.viewRevision) && Boolean(frame.image);
        }).toBe(true);
        const surface = await surfaceElement.boundingBox();
        const scale = Math.min(surface.width / frame.width, surface.height / frame.height);
        await page.mouse.click(surface.x + (surface.width - frame.width * scale) / 2 + x * scale, surface.y + (surface.height - frame.height * scale) / 2 + y * scale);
      };
      console.info('flow: frame ready');
      await remoteClick(80, 38);
      await page.getByRole('button', { name: 'Show typing controls' }).click();
      await page.getByRole('textbox', { name: 'Type into browser page' }).fill('SYNTHETIC_TYPED_NAME');
      await page.getByRole('button', { name: 'Type', exact: true }).click();
      await expect.poll(() => page.getByRole('textbox', { name: 'Type into browser page' }).inputValue()).toBe('');
      console.info('flow: typed');
      await remoteClick(70, 95);
      await page.getByRole('textbox', { name: 'Browser dialog response' }).waitFor();
      await page.waitForTimeout(350);
      expect(await page.getByRole('alert').count()).toBe(0);
      expect(await page.getByRole('textbox', { name: 'Browser dialog response' }).inputValue()).toBe('SYNTHETIC_TYPED_NAME');
      await page.getByRole('textbox', { name: 'Browser dialog response' }).fill('SYNTHETIC_PROMPT_OK');
      await page.getByRole('button', { name: 'OK', exact: true }).click();
      await page.getByRole('tab', { name: 'SYNTHETIC_PROMPT_OK', exact: true }).waitFor();
      console.info('flow: prompt resolved');
      await remoteClick(70, 150);
      await page.getByRole('tab', { name: 'Second fixture page', exact: true }).waitFor();
      await page.getByRole('button', { name: 'Browser back', exact: true }).click();
      await page.getByRole('tab', { name: 'Synthetic browser fixture', exact: true }).waitFor();
      await page.getByRole('button', { name: 'Browser forward', exact: true }).click();
      await page.getByRole('tab', { name: 'Second fixture page', exact: true }).waitFor();
      console.info('flow: history verified');
      await page.getByRole('button', { name: 'New browser tab', exact: true }).click();
      await expect.poll(() => page.getByRole('textbox', { name: 'Browser address', exact: true }).evaluate(input => document.activeElement === input)).toBe(true);
      await page.getByRole('textbox', { name: 'Browser address', exact: true }).fill(`${site}/responsive`);
      await page.getByRole('button', { name: 'Go', exact: true }).click();
      await page.getByRole('tab', { name: 'Responsive fixture', exact: true }).waitFor();
      const intendedTabs = page.getByRole('tab', { name: 'INTENDED', exact: true });
      await expect.poll(async () => {
        if (await intendedTabs.count() === 0) await remoteClick(300, 98);
        return intendedTabs.count();
      }, { timeout: 25000, intervals: [1500] }).toBeGreaterThan(0);
      await page.getByRole('tab', { name: 'Second fixture page', exact: true }).click();
      await page.waitForFunction(() => document.querySelector('.workspace-browser-surface img')?.naturalWidth > 0);
      await page.evaluate(() => window.hideBrowser());
      await page.getByRole('tab', { name: 'Second fixture page', exact: true }).waitFor({ state: 'hidden' });
      await page.evaluate(() => window.mountBrowser());
      await page.getByRole('tab', { name: 'Second fixture page', exact: true }).waitFor();
      await page.waitForFunction(() => document.querySelector('.workspace-browser-surface img')?.naturalWidth > 0);
      await page.screenshot({ path: resolve(evidence, 'browser-synthetic-desktop.png') });
      await page.setViewportSize({ width: 390, height: 844 });
      await page.locator('#root').evaluate(root => { root.style.width = '390px'; root.style.height = '844px'; });
      await page.waitForFunction(() => document.querySelector('.workspace-browser-input')?.hidden === false);
      const bounds = await page.evaluate(() => ({ width: document.body.scrollWidth, surface: document.querySelector('.workspace-browser-surface').getBoundingClientRect().width }));
      expect(bounds.width).toBe(390);
      expect(bounds.surface).toBe(390);
      await page.screenshot({ path: resolve(evidence, 'browser-synthetic-mobile.png') });
      expect(errors).toEqual([]);
      expect((await command({ type: 'state' })).tabs).toHaveLength(2);
    } finally { await context.close(); }
  }, 30000);
});
