import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { chromium } from '@playwright/test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { managedChromiumPath } from '../test/managedChromium';

let browser, server, origin;
beforeAll(async () => {
  const fixture = `
    import React, { useState } from 'react';
    import { createRoot } from 'react-dom/client';
    import './src/styles.css';
    import './src/WorkspaceUI.css';
    import './src/ProUI.css';
    import { AutocorrectProvider } from './src/contexts/AutocorrectContext';
    import { DesktopStatusBar } from './src/components/DesktopStatusBar';
    import { DesktopConversationView } from './src/components/DesktopConversationView';
    import { SettingsModal } from './src/components/SettingsModal';
    import { ModelSettingsPopover } from './src/components/ModelSettingsPopover';
    const messages = Array.from({length: 24}, (_, index) => ({ role: index % 2 ? 'assistant' : 'user', messageId: String(index), content: 'Conversation message ' + index + ': ' + 'This is a synthetic conversation for checking the composer layout. '.repeat(3) }));
    function App() {
      const [draft, setDraft] = useState('A draft to keep');
      const [modelOpens, setModelOpens] = useState(0);
      const [settingsOpen, setSettingsOpen] = useState(false);
      const narrow = location.search.includes('narrow');
      const crowded = location.search.includes('crowded');
      return <AutocorrectProvider><main style={{width:narrow?'min(600px,100%)':'min(900px,100%)',height:'100dvh',margin:'auto',display:'flex',flexDirection:'column'}} className="desktop-terminal-stack">
        <div className="desktop-conversation-surface" style={{flex:1,minHeight:0,display:'flex',overflow:'hidden'}}><DesktopConversationView turns={[]} mode="structured" structuredMessages={messages} aiType="codex" sessionId="synthetic" connectionState="online" isSendReady showHeader={false} /></div>
        <DesktopStatusBar sessionId="synthetic" compactConversation compactInputOptions={innerWidth <= 768} composerValue={draft} onComposerChange={setDraft} onComposerSubmit={() => {}} showTopRow={false} showMicButtons={false} showAiSelector={false} composerPrimaryAction={<><ModelSettingsPopover label="Model settings" modelLabel="Synthetic model"><button type="button" onClick={() => setModelOpens(value => value + 1)}>Choose synthetic model</button></ModelSettingsPopover>{crowded && Array.from({length:8}, (_, index) => <button type="button" key={index} style={{minWidth:120}}>Extra {index}</button>)}</>} />
        <output data-testid="model-opens">{modelOpens}</output>
        <button type="button" aria-label="Open settings" style={{position:'fixed',top:0,right:0,zIndex:20}} onClick={() => setSettingsOpen(true)}>Settings</button>
        <SettingsModal isOpen={settingsOpen} onClose={() => setSettingsOpen(false)} sessionId="synthetic" sessionTitle="Synthetic" currentCwd="" recentFolders={[]} />
      </main></AutocorrectProvider>;
    }
    createRoot(document.getElementById('root')).render(<App />);
  `;
  const output = execFileSync(process.execPath, ['-e', `require('esbuild').build({stdin:{contents:process.argv[1],resolveDir:process.cwd(),loader:'jsx'},bundle:true,write:false,outdir:'out',format:'iife',jsx:'automatic',loader:{'.css':'css','.svg':'dataurl','.png':'dataurl','.woff2':'dataurl','.woff':'dataurl','.ttf':'dataurl'},define:{'import.meta.env.VITE_API_URL':'""','import.meta.env.DEV':'false','import.meta.env.MODE':'"test"','import.meta.env.BASE_URL':'"/"','import.meta.env.PROD':'true'},logLevel:'error'}).then(r=>process.stdout.write(JSON.stringify(r.outputFiles.map(f=>({path:f.path,text:f.text})))))`, fixture], { cwd: process.cwd(), encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const bundle = JSON.parse(output);
  server = createServer((req, res) => {
    if (req.url === '/fixture.js') { res.setHeader('Content-Type', 'text/javascript'); res.end(bundle.find(f => f.path.endsWith('.js')).text); return; }
    if (req.url === '/fixture.css') { res.setHeader('Content-Type', 'text/css'); res.end(bundle.find(f => f.path.endsWith('.css')).text); return; }
    if (req.url.startsWith('/api/')) { res.statusCode = 404; res.end('{}'); return; }
    res.setHeader('Content-Type', 'text/html');
    res.end('<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/fixture.css"><div id="root"></div><script src="/fixture.js"></script>');
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

describe('composer while reading the timeline', () => {
  it.each([320, 390])('keeps the setting usable at %ipx on a touch viewport', async width => {
    const context = await browser.newContext({ viewport: { width, height: 800 }, hasTouch: true, isMobile: true });
    try {
      const page = await context.newPage();
      page.setDefaultTimeout(3000);
      await page.goto(origin);
      await page.getByRole('button', { name: 'Open settings' }).click();
      await page.getByRole('button', { name: 'Interface' }).click();
      const option = page.getByRole('button', { name: 'Keep composer expanded' });
      await option.scrollIntoViewIfNeeded();
      const bounds = await option.boundingBox();
      expect(bounds.width).toBeGreaterThanOrEqual(44);
      expect(bounds.height).toBeGreaterThanOrEqual(44);
      expect(bounds.x).toBeGreaterThanOrEqual(0);
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
      await option.click();
      expect(await option.getAttribute('aria-pressed')).toBe('true');
      expect(await option.evaluate(node => node.classList.contains('active'))).toBe(true);
      await page.waitForTimeout(250);
      if (process.env.V4_COMPOSER_SCROLL_SCREENSHOTS) await page.screenshot({ path: `${process.env.V4_COMPOSER_SCROLL_SCREENSHOTS}/settings-${width}.png` });
    } finally { await context.close(); }
  }, 15000);

  it('applies the saved preference in open tabs and after reload', async () => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    try {
      const first = await context.newPage();
      const second = await context.newPage();
      await Promise.all([first.goto(origin), second.goto(origin)]);
      await first.getByRole('button', { name: 'Open settings' }).click();
      await first.getByRole('button', { name: 'Interface' }).click();
      await first.getByRole('button', { name: 'Keep composer expanded' }).click();
      expect(await first.getByRole('button', { name: 'Keep composer expanded' }).getAttribute('aria-pressed')).toBe('true');
      await first.getByRole('button', { name: 'Close', exact: true }).click();
      const scroll = async page => {
        const thread = page.locator('.desktop-thread');
        await thread.evaluate(node => { node.scrollTop = 600; });
        await thread.hover();
        await page.mouse.wheel(0, -50);
        await page.waitForTimeout(250);
        return page.locator('.status-composer-shell').evaluate(node => node.classList.contains('scroll-compact'));
      };
      expect(await scroll(first)).toBe(false);
      expect(await scroll(second)).toBe(false);
      await second.reload();
      expect(await scroll(second)).toBe(false);
      await first.getByRole('button', { name: 'Open settings' }).click();
      await first.getByRole('button', { name: 'Interface' }).click();
      await first.getByRole('button', { name: 'Compact composer while scrolling' }).click();
      await first.getByRole('button', { name: 'Close', exact: true }).click();
      expect(await scroll(second)).toBe(true);
      expect(await second.getByRole('textbox', { name: 'Command composer' }).inputValue()).toBe('A draft to keep');
    } finally { await context.close(); }
  });

  it.each([[1280, '', true], [1280, '?narrow', false], [1280, '?crowded', false], [390, '', false]])('keeps editing usable at %ipx %s', async (width, query, shouldCompact) => {
    const context = await browser.newContext({ viewport: { width, height: 800 }, hasTouch: width < 500 });
    try {
      const page = await context.newPage();
      await page.goto(`${origin}/${query}`);
      const thread = page.locator('.desktop-thread');
      const shell = page.locator('.status-composer-shell');
      const input = page.getByRole('textbox', { name: 'Command composer' });
      await thread.evaluate(node => { node.scrollTop = 600; });
      const before = await shell.boundingBox();
      await thread.hover();
      await page.mouse.wheel(0, -50);
      if (shouldCompact) {
        try { await page.waitForFunction(() => document.querySelector('.status-composer-shell')?.classList.contains('scroll-compact'), null, { timeout: 2000 }); }
        catch {
          const details = await page.evaluate(() => {
            const thread = document.querySelector('.desktop-thread');
            const shell = document.querySelector('.status-composer-shell');
            const rect = thread.getBoundingClientRect();
            return { top: thread.scrollTop, height: thread.scrollHeight, client: thread.clientHeight, shellWidth: shell.getBoundingClientRect().width, children: [...shell.children].map(node => node.className), hit: document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)?.outerHTML.slice(0, 300) };
          });
          throw new Error(`Composer did not compact: ${JSON.stringify(details)}`);
        }
      }
      else await page.waitForTimeout(250);
      expect(await shell.evaluate(node => node.classList.contains('scroll-compact'))).toBe(shouldCompact);
      const after = await shell.boundingBox();
      if (shouldCompact) expect(after.height).toBeLessThan(before.height - 10);
      expect(await input.inputValue()).toBe('A draft to keep');
      expect(await page.getByRole('button', { name: 'Model settings' }).isVisible()).toBe(true);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      if (process.env.V4_COMPOSER_SCROLL_SCREENSHOTS) await page.screenshot({ path: `${process.env.V4_COMPOSER_SCROLL_SCREENSHOTS}/composer-${width}${query ? '-narrow' : ''}.png` });
      const [inputBox, modelBox] = await Promise.all([input.boundingBox(), page.getByRole('button', { name: 'Model settings' }).boundingBox()]);
      if (shouldCompact) {
        expect(inputBox.x + inputBox.width).toBeLessThanOrEqual(modelBox.x);
        expect(modelBox.x + modelBox.width).toBeLessThanOrEqual(after.x + after.width);
      }
      await page.getByRole('button', { name: 'Model settings' }).click();
      const dialog = page.getByRole('dialog', { name: 'Conversation model settings' });
      expect(await dialog.isVisible()).toBe(true);
      const dialogBox = await dialog.boundingBox();
      expect(dialogBox.x).toBeGreaterThanOrEqual(0);
      expect(dialogBox.x + dialogBox.width).toBeLessThanOrEqual(width);
      expect(dialogBox.y).toBeGreaterThanOrEqual(0);
      expect(dialogBox.y + dialogBox.height).toBeLessThanOrEqual(800);
      if (process.env.V4_COMPOSER_SCROLL_SCREENSHOTS && !query) await page.screenshot({ path: `${process.env.V4_COMPOSER_SCROLL_SCREENSHOTS}/model-${width}.png` });
      await page.getByRole('button', { name: 'Choose synthetic model' }).click();
      expect(await page.getByTestId('model-opens').textContent()).toBe('1');
      await page.getByRole('button', { name: 'Close model settings' }).click();
      expect(await shell.evaluate(node => node.classList.contains('scroll-compact'))).toBe(false);
      await input.click();
      expect(await shell.evaluate(node => node.classList.contains('scroll-compact'))).toBe(false);
      await input.fill('A draft to keep\nSecond line');
      expect(await input.inputValue()).toBe('A draft to keep\nSecond line');
      if (shouldCompact) {
        const longDraft = 'Keep the whole draft visible. '.repeat(50);
        await input.fill(longDraft);
        await input.blur();
        await thread.evaluate(node => { node.scrollTop = 600; });
        await thread.hover();
        await page.mouse.wheel(0, -50);
        await page.waitForTimeout(250);
        expect(await shell.evaluate(node => node.classList.contains('scroll-compact'))).toBe(false);
        expect(await input.inputValue()).toBe(longDraft);
      }
    } finally { await context.close(); }
  });
});
