import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { chromium } from '@playwright/test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { managedChromiumPath } from '../test/managedChromium';

let browser, server, origin;
const uploads = [];
const uploadedBodies = [];
beforeAll(async () => {
  const fixture = `
    import React, { useState } from 'react';
    import { createRoot } from 'react-dom/client';
    import './src/styles.css';
    import './src/WorkspaceUI.css';
    import './src/ProUI.css';
    import { AutocorrectProvider } from './src/contexts/AutocorrectContext';
    import { DesktopStatusBar } from './src/components/DesktopStatusBar';
    import { withAttachedFiles } from './src/utils/attachedFiles';
    import { useComposerFileAttachments } from './src/hooks/useComposerFileAttachments';
    import { useComposerDraft } from './src/hooks/useComposerDraft';
    import { getComposerDraftStore } from './src/utils/composerDraftStore';
    import { setUser } from './src/utils/auth';
    import { captureAuthScope } from './src/utils/auth';
    import { setEnvironmentIdentity, getEnvironmentCacheScope, getEnvironmentSignal } from './src/utils/remoteEnvironments';
    import { createLargePasteRecovery } from './src/utils/largePasteRecovery';
    const persisted = new URLSearchParams(location.search).has('persisted');
    if (persisted) { setUser({ id: 'synthetic-owner' }); setEnvironmentIdentity('synthetic-owner', location.origin); }
    window.switchFixtureOwner = id => { setUser({ id }); setEnvironmentIdentity(id, location.origin); };
    const fixtureSessionId = new URLSearchParams(location.search).get('session') || 'synthetic';
    if (persisted && !getComposerDraftStore(fixtureSessionId).getSnapshot().text) getComposerDraftStore(fixtureSessionId).setText('Keep this draft');
    window.fixtureRecovery = () => {
      const auth = captureAuthScope(), environment = getEnvironmentCacheScope();
      return createLargePasteRecovery({ scope: [auth.userId, auth.home, JSON.stringify([environment.identity, environment.environment]), fixtureSessionId], signal: getEnvironmentSignal(), isCurrent: () => true });
    };
    function App() {
      const [sessionId, setSessionId] = useState(fixtureSessionId);
      window.switchFixtureSession = setSessionId;
      const [temporaryDraft, setTemporaryDraft] = useState('Keep this draft');
      const savedDraft = useComposerDraft(sessionId);
      const draft = persisted ? savedDraft.value : temporaryDraft;
      const setDraft = persisted ? savedDraft.setValue : setTemporaryDraft;
      const [temporaryAttachments, setTemporaryAttachments] = useState([]);
      const [savedAttachments, setSavedAttachments, , , , , , , , , , , waitForSaves] = useComposerFileAttachments(sessionId);
      const attachments = persisted ? savedAttachments : temporaryAttachments;
      const setAttachments = persisted ? setSavedAttachments : setTemporaryAttachments;
      const [sent, setSent] = useState('');
      return <AutocorrectProvider><main style={{width:'min(900px,100%)',margin:'auto'}}>
        <DesktopStatusBar sessionId={sessionId} compactConversation={!new URLSearchParams(location.search).has('start')} compactInputOptions={innerWidth <= 768 && !new URLSearchParams(location.search).has('start')} allowAnyFile composerValue={draft} composerDraftStore={persisted ? savedDraft.store : undefined} onComposerChange={setDraft} composerAttachments={attachments} waitForAttachmentPersistence={persisted ? waitForSaves : undefined} onComposerAttachmentAdd={item => setAttachments(previous => [...previous, item])} onComposerAttachmentRemove={path => setAttachments(previous => previous.filter(item => item.path !== path))} onComposerSubmit={text => setSent(withAttachedFiles(text, attachments.map(item => item.path)))} composerSubmitLabel="Send message" showTopRow={false} showMicButtons={false} showAiSelector={false} />
        <output data-testid="sent">{sent}</output>
      </main></AutocorrectProvider>;
    }
    if (!new URLSearchParams(location.search).has('writer')) createRoot(document.getElementById('root')).render(<App />);
  `;
  const output = execFileSync(process.execPath, ['-e', `require('esbuild').build({stdin:{contents:process.argv[1],resolveDir:process.cwd(),loader:'jsx'},bundle:true,write:false,outdir:'out',format:'iife',jsx:'automatic',loader:{'.css':'css','.svg':'dataurl','.png':'dataurl','.woff2':'dataurl','.woff':'dataurl','.ttf':'dataurl'},define:{'import.meta.env.VITE_API_URL':'""','import.meta.env.DEV':'false','import.meta.env.MODE':'"test"','import.meta.env.BASE_URL':'"/"','import.meta.env.PROD':'true'},logLevel:'error'}).then(r=>process.stdout.write(JSON.stringify(r.outputFiles.map(f=>({path:f.path,text:f.text})))))`, fixture], { cwd: process.cwd(), encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const bundle = JSON.parse(output);
  server = createServer((req, res) => {
    if (req.url === '/fixture.js') { res.setHeader('Content-Type', 'text/javascript'); res.end(bundle.find(file => file.path.endsWith('.js')).text); return; }
    if (req.url === '/fixture.css') { res.setHeader('Content-Type', 'text/css'); res.end(bundle.find(file => file.path.endsWith('.css')).text); return; }
    if (req.url === '/api/files/attachment' && req.method === 'POST') {
      const chunks = [];
      req.on('data', chunk => chunks.push(chunk));
      req.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        uploadedBodies.push(body.slice(0, 100_000));
        const name = body.match(/filename="([^"\r\n]+)"/)?.[1] || 'unknown';
        uploads.push(name);
        setTimeout(() => {
          res.setHeader('Content-Type', 'application/json');
          if (name === 'bad.txt') { res.statusCode = 400; res.end(JSON.stringify({ error: 'Synthetic upload failed' })); }
          else res.end(JSON.stringify({ path: `/synthetic/${name}` }));
        }, name === 'slow.txt' || name === 'pasted-text.txt' ? 1200 : 120);
      });
      return;
    }
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

describe('file attachments in a browser', () => {
  it('discovers an orphaned source written by another open tab', async () => {
    const context = await browser.newContext({ viewport: { width: 390, height: 800 }, hasTouch: true });
    try {
      const first = await context.newPage(), writer = await context.newPage();
      await first.goto(`${origin}/?persisted=1`);
      await expect.poll(() => first.getByRole('button', { name: 'Send message' }).isEnabled()).toBe(true);
      await writer.goto(`${origin}/?persisted=1&writer=1`);
      await writer.evaluate(async () => {
        const store = window.fixtureRecovery();
        await store.save({ id: '11111111-1111-4111-8111-111111111111', blob: new Blob(['saved source'], { type: 'text/plain' }), original: 'Keep this draft', prefix: '', suffix: '', revision: 'synthetic' });
        store.close();
      });
      await first.getByText(/saved large paste needs review/i).waitFor({ timeout: 5000 });
      expect(await first.getByRole('button', { name: 'Send message' }).isDisabled()).toBe(true);
      expect(await first.evaluate(() => Object.keys(localStorage).some(key => key.startsWith('tv4:file-transfer-review:v1:')))).toBe(true);
    } finally { await context.close(); }
  }, 15000);
  it('discovers a saved paste after its review marker is lost and the page reloads', async () => {
    const context = await browser.newContext({ viewport: { width: 390, height: 800 }, hasTouch: true });
    try {
      const page = await context.newPage();
      await page.goto(`${origin}/?persisted=1`);
      const request = page.waitForRequest(req => req.url().endsWith('/api/files/attachment'));
      await page.getByRole('textbox', { name: 'Command composer' }).evaluate(node => {
        const transfer = new DataTransfer(); transfer.setData('text/plain', 'x'.repeat(1_000_000));
        node.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: transfer }));
      });
      await request;
      await page.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith('tv4:file-transfer-review:v1:')).forEach(key => localStorage.removeItem(key)));
      await page.reload();
      await page.getByText(/saved large paste needs review/i).waitFor({ timeout: 5000 });
      expect(await page.getByRole('button', { name: 'Send message' }).isDisabled()).toBe(true);
      expect(await page.evaluate(() => Object.keys(localStorage).some(key => key.startsWith('tv4:file-transfer-review:v1:')))).toBe(true);
    } finally { await context.close(); }
  }, 15000);

  it('holds sending when an orphaned paste cannot be checked on reopening', async () => {
    const context = await browser.newContext({ viewport: { width: 390, height: 800 }, hasTouch: true });
    try {
      await context.addInitScript(() => {
        const original = indexedDB.open.bind(indexedDB);
        indexedDB.open = (name, version) => {
          if (name === 'terminal-v4-large-paste-recovery' && sessionStorage.getItem('synthetic-block-recovery') === 'yes') throw new Error('Synthetic storage failure');
          return original(name, version);
        };
      });
      const page = await context.newPage();
      await page.goto(`${origin}/?persisted=1`);
      const request = page.waitForRequest(req => req.url().endsWith('/api/files/attachment'));
      await page.getByRole('textbox', { name: 'Command composer' }).evaluate(node => {
        const transfer = new DataTransfer(); transfer.setData('text/plain', 'x'.repeat(1_000_000));
        node.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: transfer }));
      });
      await request;
      await page.evaluate(() => {
        Object.keys(localStorage).filter(key => key.startsWith('tv4:file-transfer-review:v1:')).forEach(key => localStorage.removeItem(key));
        sessionStorage.setItem('synthetic-block-recovery', 'yes');
      });
      await page.reload();
      await page.getByText(/saved paste recovery is unavailable/i).waitFor({ timeout: 5000 });
      expect(await page.getByRole('button', { name: 'Send message' }).isDisabled()).toBe(true);
    } finally { await context.close(); }
  }, 15000);

  it('holds sending if IndexedDB disappears after a paste was saved and its marker is lost', async () => {
    const context = await browser.newContext({ viewport: { width: 390, height: 800 }, hasTouch: true });
    try {
      await context.addInitScript(() => {
        if (sessionStorage.getItem('synthetic-hide-recovery') === 'yes') Object.defineProperty(window, 'indexedDB', { configurable: true, value: undefined });
      });
      const page = await context.newPage();
      await page.goto(`${origin}/?persisted=1`);
      const request = page.waitForRequest(req => req.url().endsWith('/api/files/attachment'));
      await page.getByRole('textbox', { name: 'Command composer' }).evaluate(node => {
        const transfer = new DataTransfer(); transfer.setData('text/plain', 'x'.repeat(1_000_000));
        node.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: transfer }));
      });
      await request;
      await page.evaluate(() => {
        Object.keys(localStorage).filter(key => key.startsWith('tv4:file-transfer-review:v1:')).forEach(key => localStorage.removeItem(key));
        sessionStorage.setItem('synthetic-hide-recovery', 'yes');
      });
      await page.reload();
      await page.getByText(/saved paste recovery is unavailable/i).waitFor({ timeout: 5000 });
      expect(await page.getByRole('button', { name: 'Send message' }).isDisabled()).toBe(true);
    } finally { await context.close(); }
  }, 15000);

  it('allows ordinary text when IndexedDB was never used and is unavailable', async () => {
    const context = await browser.newContext({ viewport: { width: 390, height: 800 }, hasTouch: true });
    try {
      await context.addInitScript(() => { Object.defineProperty(window, 'indexedDB', { configurable: true, value: undefined }); });
      const page = await context.newPage();
      await page.goto(`${origin}/?persisted=1`);
      expect(await page.getByRole('button', { name: 'Send message' }).isEnabled()).toBe(true);
      expect(await page.getByText(/saved paste recovery is unavailable/i).count()).toBe(0);
    } finally { await context.close(); }
  }, 10000);

  it('still exposes an orphaned paste when review-marker storage is at capacity', async () => {
    const context = await browser.newContext({ viewport: { width: 390, height: 800 }, hasTouch: true });
    try {
      const page = await context.newPage();
      await page.goto(`${origin}/?persisted=1`);
      const request = page.waitForRequest(req => req.url().endsWith('/api/files/attachment'));
      await page.getByRole('textbox', { name: 'Command composer' }).evaluate(node => {
        const transfer = new DataTransfer(); transfer.setData('text/plain', 'x'.repeat(1_000_000));
        node.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: transfer }));
      });
      await request;
      await page.evaluate(() => {
        const marker = Object.keys(localStorage).find(key => key.startsWith('tv4:file-transfer-review:v1:'));
        const prefix = marker.slice(0, marker.lastIndexOf(':') + 1);
        localStorage.removeItem(marker);
        for (let index = 0; index < 100; index++) localStorage.setItem(`${prefix}aaaaaaaa-aaaa-4aaa-8aaa-${String(index).padStart(12, '0')}`, '1');
      });
      await page.reload();
      await page.getByText(/saved large paste needs review/i).waitFor({ timeout: 5000 });
      expect(await page.getByRole('button', { name: 'Restore saved text' }).isVisible()).toBe(true);
      expect(await page.getByRole('button', { name: 'Send message' }).isDisabled()).toBe(true);
      await page.getByRole('button', { name: 'Restore saved text' }).click();
      await page.waitForFunction(() => document.querySelector('[aria-label="Command composer"]')?.value.length >= 1_000_000);
    } finally { await context.close(); }
  }, 15000);

  it('keeps an orphaned paste in its original account after an account switch', async () => {
    const context = await browser.newContext({ viewport: { width: 390, height: 800 }, hasTouch: true });
    try {
      const page = await context.newPage();
      await page.goto(`${origin}/?persisted=1`);
      const request = page.waitForRequest(req => req.url().endsWith('/api/files/attachment'));
      await page.getByRole('textbox', { name: 'Command composer' }).evaluate(node => {
        const transfer = new DataTransfer(); transfer.setData('text/plain', 'x'.repeat(1_000_000));
        node.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: transfer }));
      });
      await request;
      await page.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith('tv4:file-transfer-review:v1:')).forEach(key => localStorage.removeItem(key)));
      await page.evaluate(() => window.switchFixtureOwner('other-owner'));
      await page.waitForFunction(() => document.querySelector('[aria-label="Command composer"]')?.value === '');
      await page.getByRole('textbox', { name: 'Command composer' }).fill('other owner draft');
      await page.waitForFunction(() => !document.querySelector('.status-large-paste-review'));
      expect(await page.getByText(/saved large paste needs review/i).count()).toBe(0);
      await page.evaluate(() => window.switchFixtureOwner('synthetic-owner'));
      await page.getByText(/saved large paste needs review/i).waitFor({ timeout: 5000 });
      expect(await page.getByRole('textbox', { name: 'Command composer' }).inputValue()).toBe('Keep this draft');
    } finally { await context.close(); }
  }, 15000);
  it('keeps an oversized pasted source recoverable when the page reloads mid-upload', async () => {
    const context = await browser.newContext({ viewport: { width: 390, height: 800 }, hasTouch: true });
    try {
      const page = await context.newPage();
      await page.goto(`${origin}/?persisted=1`);
      const input = page.getByRole('textbox', { name: 'Command composer' });
      const request = page.waitForRequest(req => req.url().endsWith('/api/files/attachment'), { timeout: 5000 });
      await input.evaluate(node => {
        node.setSelectionRange(0, 4);
        const transfer = new DataTransfer();
        transfer.setData('text/plain', 'x'.repeat(1_000_000));
        node.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: transfer }));
      });
      await request;
      await page.reload();
      await page.getByText(/saved large paste needs review/i).waitFor();
      expect(await page.getByRole('button', { name: 'Restore saved text' }).isVisible()).toBe(true);
      expect(await page.getByRole('button', { name: 'Send message' }).isDisabled()).toBe(true);
      await input.fill('newer draft');
      await page.getByRole('button', { name: 'Restore saved text' }).click();
      await page.waitForFunction(() => document.querySelector('[aria-label="Command composer"]')?.value.length === 1_000_013);
      expect((await input.inputValue()) === `newer draft\n\n${'x'.repeat(1_000_000)}`).toBe(true);
      await page.getByRole('button', { name: 'I checked other tabs' }).click();
      const discard = page.getByRole('button', { name: 'Discard saved paste' });
      await discard.waitFor();
      expect(await discard.isDisabled()).toBe(true);
      await input.fill('newer draft');
      expect(await discard.isEnabled()).toBe(true);
      await page.reload();
      await page.getByText(/saved large paste needs review/i).waitFor();
      expect(await input.inputValue()).toBe('newer draft');
    } finally { await context.close(); }
  }, 15000);

  it('converts an oversized paste after saving its recovery source and attachment', async () => {
    const context = await browser.newContext({ viewport: { width: 390, height: 800 }, hasTouch: true });
    try {
      const page = await context.newPage();
      await page.goto(`${origin}/?persisted=1`);
      const input = page.getByRole('textbox', { name: 'Command composer' });
      const request = page.waitForRequest(req => req.url().endsWith('/api/files/attachment'));
      await input.evaluate(node => {
        node.setSelectionRange(0, 4);
        const transfer = new DataTransfer();
        transfer.setData('text/plain', 'x'.repeat(1_000_000));
        node.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: transfer }));
      });
      await request;
      expect((await input.inputValue()) === 'Keep this draft').toBe(true);
      expect(await input.isEnabled()).toBe(true);
      await page.getByRole('button', { name: 'Remove pasted-text.txt' }).waitFor({ timeout: 5000 });
      await page.waitForFunction(() => !Object.keys(localStorage).some(key => key.startsWith('tv4:file-transfer-review:v1:')));
      expect(await input.inputValue()).toBe(' this draft');
      await page.reload();
      await page.getByRole('button', { name: 'Remove pasted-text.txt' }).waitFor();
      expect(await input.inputValue()).toBe(' this draft');
      expect(await page.getByRole('button', { name: 'Send message' }).isEnabled()).toBe(true);
    } finally { await context.close(); }
  }, 15000);

  it('uploads a 25 MiB text paste without filling the composer with its contents', async () => {
    const context = await browser.newContext({ viewport: { width: 390, height: 800 }, hasTouch: true });
    try {
      const page = await context.newPage();
      await page.goto(`${origin}/?persisted=1`);
      const input = page.getByRole('textbox', { name: 'Command composer' });
      const request = page.waitForRequest(req => req.url().endsWith('/api/files/attachment'), { timeout: 15000 });
      await input.evaluate(node => {
        node.setSelectionRange(0, 4);
        const transfer = new DataTransfer(); transfer.setData('text/plain', 'x'.repeat(25 * 1024 * 1024));
        node.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: transfer }));
      });
      await request;
      expect(await input.inputValue()).toBe('Keep this draft');
      await page.getByRole('button', { name: 'Remove pasted-text.txt' }).waitFor({ timeout: 15000 });
      await page.waitForFunction(() => !Object.keys(localStorage).some(key => key.startsWith('tv4:file-transfer-review:v1:')));
      expect(await input.inputValue()).toBe(' this draft');
    } finally { await context.close(); }
  }, 30000);

  it('keeps an oversized paste in the tab and does not upload when recovery storage is unavailable', async () => {
    uploads.length = 0;
    const context = await browser.newContext({ viewport: { width: 390, height: 800 }, hasTouch: true });
    try {
      await context.addInitScript(() => {
        const original = indexedDB.open.bind(indexedDB);
        indexedDB.open = (name, version) => {
          if (name === 'terminal-v4-large-paste-recovery') throw new Error('Synthetic storage failure');
          return original(name, version);
        };
      });
      const page = await context.newPage();
      await page.goto(`${origin}/?persisted=1`);
      const input = page.getByRole('textbox', { name: 'Command composer' });
      await page.getByText(/saved paste recovery is unavailable/i).waitFor();
      const allowed = await input.evaluate(node => {
        const transfer = new DataTransfer(); transfer.setData('text/plain', 'x'.repeat(1_000_000));
        return node.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: transfer }));
      });
      expect(allowed).toBe(true);
      await input.fill('x'.repeat(1_000_000));
      expect((await input.inputValue()).length).toBe(1_000_000);
      expect(uploads).toEqual([]);
      expect(await page.getByRole('button', { name: 'Send message' }).isDisabled()).toBe(true);
    } finally { await context.close(); }
  }, 15000);

  it('fences a late upload after another tab marks its claim uncertain', async () => {
    const context = await browser.newContext({ viewport: { width: 390, height: 800 }, hasTouch: true });
    try {
      const first = await context.newPage(), second = await context.newPage();
      await first.goto(`${origin}/?persisted=1`);
      const request = first.waitForRequest(req => req.url().endsWith('/api/files/attachment'));
      await first.getByRole('textbox', { name: 'Command composer' }).evaluate(node => {
        node.setSelectionRange(0, 4);
        const transfer = new DataTransfer(); transfer.setData('text/plain', 'x'.repeat(1_000_000));
        node.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: transfer }));
      });
      await request;
      await second.goto(`${origin}/?persisted=1`);
      await second.getByRole('button', { name: 'I checked other tabs' }).click();
      await second.getByRole('button', { name: 'Discard saved paste' }).waitFor();
      await first.getByText(/saved paste upload changed in another tab/i).waitFor({ timeout: 5000 });
      expect(await first.getByRole('button', { name: 'Remove pasted-text.txt' }).count()).toBe(0);
      expect(await first.getByRole('textbox', { name: 'Command composer' }).inputValue()).toBe('Keep this draft');
      expect(await first.getByRole('button', { name: 'Send message' }).isDisabled()).toBe(true);
    } finally { await context.close(); }
  }, 15000);

  it('keeps newer typing and the saved paste if the draft changes during upload', async () => {
    const context = await browser.newContext({ viewport: { width: 390, height: 800 }, hasTouch: true });
    try {
      const page = await context.newPage();
      await page.goto(`${origin}/?persisted=1`);
      const input = page.getByRole('textbox', { name: 'Command composer' });
      const request = page.waitForRequest(req => req.url().endsWith('/api/files/attachment'));
      await input.evaluate(node => {
        const transfer = new DataTransfer(); transfer.setData('text/plain', 'x'.repeat(1_000_000));
        node.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: transfer }));
      });
      await request;
      await input.fill('newer draft');
      await page.getByText(/saved large paste needs review/i).waitFor({ timeout: 5000 });
      expect(await input.inputValue()).toBe('newer draft');
      expect(await page.getByRole('button', { name: 'Remove pasted-text.txt' }).isVisible()).toBe(true);
      expect(await page.getByRole('button', { name: 'Send message' }).isDisabled()).toBe(true);
      await page.reload();
      await page.getByText(/saved large paste needs review/i).waitFor();
      expect(await input.inputValue()).toBe('newer draft');
    } finally { await context.close(); }
  }, 15000);

  it('keeps an oversized paste scoped to its original thread when switching during upload', async () => {
    const context = await browser.newContext({ viewport: { width: 390, height: 800 }, hasTouch: true });
    try {
      const page = await context.newPage();
      await page.goto(`${origin}/?persisted=1`);
      const request = page.waitForRequest(req => req.url().endsWith('/api/files/attachment'));
      await page.getByRole('textbox', { name: 'Command composer' }).evaluate(node => {
        const transfer = new DataTransfer(); transfer.setData('text/plain', 'x'.repeat(1_000_000));
        node.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: transfer }));
      });
      await request;
      await page.evaluate(() => window.switchFixtureSession('different-thread'));
      const input = page.getByRole('textbox', { name: 'Command composer' });
      await input.fill('other draft');
      await page.evaluate(() => window.switchFixtureSession('synthetic'));
      await page.getByText(/saved large paste needs review/i).waitFor();
      expect(await input.inputValue()).toBe('Keep this draft');
      expect(await page.getByRole('button', { name: 'Send message' }).isDisabled()).toBe(true);
      await page.evaluate(() => window.switchFixtureSession('different-thread'));
      expect(await input.inputValue()).toBe('other draft');
      expect(await page.getByText(/saved large paste needs review/i).count()).toBe(0);
    } finally { await context.close(); }
  }, 15000);

  it('requires explicit review before discarding an interrupted saved paste', async () => {
    const context = await browser.newContext({ viewport: { width: 320, height: 800 }, hasTouch: true });
    try {
      const page = await context.newPage();
      await page.goto(`${origin}/?persisted=1`);
      const request = page.waitForRequest(req => req.url().endsWith('/api/files/attachment'));
      await page.getByRole('textbox', { name: 'Command composer' }).evaluate(node => {
        const transfer = new DataTransfer(); transfer.setData('text/plain', 'x'.repeat(1_000_000));
        node.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: transfer }));
      });
      await request;
      await page.reload();
      await page.getByText(/saved large paste needs review/i).waitFor();
      expect(await page.getByRole('button', { name: 'Discard saved paste' }).count()).toBe(0);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      expect((await page.getByRole('button', { name: 'Restore saved text' }).boundingBox()).height).toBeGreaterThanOrEqual(44);
      if (process.env.V4_FILE_DROP_SCREENSHOTS) await page.screenshot({ path: `${process.env.V4_FILE_DROP_SCREENSHOTS}/large-recovery-320.png` });
      await page.getByRole('button', { name: 'I checked other tabs' }).click();
      await page.getByRole('button', { name: 'Discard saved paste' }).click();
      await page.getByText(/saved large paste needs review/i).waitFor({ state: 'detached' });
      expect(await page.getByRole('button', { name: 'Send message' }).isEnabled()).toBe(true);
    } finally { await context.close(); }
  }, 15000);

  it('retries an interrupted paste without replacing a newer draft', async () => {
    const context = await browser.newContext({ viewport: { width: 390, height: 800 }, hasTouch: true });
    try {
      const page = await context.newPage();
      await page.goto(`${origin}/?persisted=1`);
      const request = page.waitForRequest(req => req.url().endsWith('/api/files/attachment'));
      await page.getByRole('textbox', { name: 'Command composer' }).evaluate(node => {
        const transfer = new DataTransfer(); transfer.setData('text/plain', 'x'.repeat(1_000_000));
        node.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: transfer }));
      });
      await request;
      await page.reload();
      await page.getByRole('button', { name: 'I checked other tabs' }).click();
      const input = page.getByRole('textbox', { name: 'Command composer' });
      await input.fill('newer draft');
      await page.getByRole('button', { name: 'Retry saved paste upload' }).click();
      await page.getByRole('button', { name: 'Remove pasted-text.txt' }).waitFor({ timeout: 5000 });
      await page.waitForFunction(() => !Object.keys(localStorage).some(key => key.startsWith('tv4:file-transfer-review:v1:')));
      expect(await input.inputValue()).toBe('newer draft');
      await page.reload();
      await page.getByRole('button', { name: 'Remove pasted-text.txt' }).waitFor();
      expect(await input.inputValue()).toBe('newer draft');
    } finally { await context.close(); }
  }, 15000);
  it('offers one-time text paste from the phone start composer', async () => {
    uploads.length = 0;
    const context = await browser.newContext({ viewport: { width: 320, height: 800 }, hasTouch: true });
    try {
      const page = await context.newPage();
      await page.goto(`${origin}/?persisted=1&start=1`);
      await page.getByLabel('More composer actions').click({ timeout: 3000 });
      const option = page.getByRole('button', { name: 'Paste next as text' });
      expect((await option.boundingBox()).height).toBeGreaterThanOrEqual(44);
      await option.click();
      await page.getByText('Next paste will stay as text.').waitFor();
      expect((await page.getByRole('button', { name: 'Cancel' }).boundingBox()).height).toBeGreaterThanOrEqual(44);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      if (process.env.V4_FILE_DROP_SCREENSHOTS) await page.screenshot({ path: `${process.env.V4_FILE_DROP_SCREENSHOTS}/paste-as-text-320.png` });
      const allowed = await page.getByRole('textbox', { name: 'Command composer' }).evaluate(node => {
        const transfer = new DataTransfer();
        transfer.setData('text/plain', 'large-'.repeat(5500));
        return node.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: transfer }));
      });
      expect(allowed).toBe(true);
      expect(uploads).toEqual([]);
      expect(await page.getByText('Next paste will stay as text.').count()).toBe(0);
    } finally { await context.close(); }
  }, 10000);
  it.each([320, 390])('restores a large pasted draft if the tab reloads during upload at %ipx', async width => {
    uploadedBodies.length = 0;
    const context = await browser.newContext({ viewport: { width, height: 800 }, hasTouch: true });
    try {
      const page = await context.newPage();
      await page.goto(`${origin}/?persisted=1`);
      const input = page.getByRole('textbox', { name: 'Command composer' });
      const request = page.waitForRequest(req => req.url().endsWith('/api/files/attachment'));
      await input.evaluate(node => {
        node.setSelectionRange(0, 4);
        const transfer = new DataTransfer();
        transfer.setData('text/plain', 'large-'.repeat(5500));
        node.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: transfer }));
      });
      await request;
      await expect.poll(() => uploadedBodies.some(body => body.includes('large-'.repeat(5500)))).toBe(true);
      expect(await input.inputValue()).toBe(`${'large-'.repeat(5500)} this draft`);
      await page.reload();
      await page.getByText(/previous file selection did not finish/i).waitFor();
      expect(await input.inputValue()).toBe(`${'large-'.repeat(5500)} this draft`);
      expect(await page.getByRole('button', { name: 'Send message' }).isDisabled()).toBe(true);
    } finally { await context.close(); }
  }, 15000);

  it.each([320, 390])('restores the attached file and remaining text after a successful large paste at %ipx', async width => {
    const context = await browser.newContext({ viewport: { width, height: 800 }, hasTouch: true });
    try {
      const page = await context.newPage();
      await page.goto(`${origin}/?persisted=1`);
      const input = page.getByRole('textbox', { name: 'Command composer' });
      await input.evaluate(node => {
        node.setSelectionRange(0, 4);
        const transfer = new DataTransfer();
        transfer.setData('text/plain', 'large-'.repeat(5500));
        node.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: transfer }));
      });
      await page.getByRole('button', { name: 'Remove pasted-text.txt' }).waitFor();
      await page.waitForFunction(() => !Object.keys(localStorage).some(key => key.startsWith('tv4:file-transfer-review:v1:')));
      expect(await input.inputValue()).toBe(' this draft');
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      if (process.env.V4_FILE_DROP_SCREENSHOTS) await page.screenshot({ path: `${process.env.V4_FILE_DROP_SCREENSHOTS}/large-paste-${width}.png` });
      await page.reload();
      await page.getByRole('button', { name: 'Remove pasted-text.txt' }).waitFor();
      expect(await input.inputValue()).toBe(' this draft');
      expect(await page.getByRole('button', { name: 'Send message' }).isEnabled()).toBe(true);
    } finally { await context.close(); }
  }, 15000);
  it('retains saved selections across reload after clearing the upload review record', async () => {
    const context = await browser.newContext({ viewport: { width: 390, height: 800 }, hasTouch: true });
    try {
      const page = await context.newPage();
      await page.goto(`${origin}/?persisted=1`);
      await page.locator('.status-composer-shell').evaluate(node => {
        const transfer = new DataTransfer();
        transfer.items.add(new File(['one'], 'one.txt', { type: 'text/plain' }));
        transfer.items.add(new File(['two'], 'two.txt', { type: 'text/plain' }));
        node.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer }));
      });
      await page.getByRole('button', { name: /Remove one.txt/ }).waitFor();
      await page.getByRole('button', { name: /Remove two.txt/ }).waitFor();
      await page.waitForFunction(() => !Object.keys(localStorage).some(key => key.startsWith('tv4:file-transfer-review:v1:')));
      await page.reload();
      await page.getByRole('button', { name: /Remove one.txt/ }).waitFor();
      await page.getByRole('button', { name: /Remove two.txt/ }).waitFor();
      expect(await page.getByRole('button', { name: 'Send message' }).isEnabled()).toBe(true);
    } finally { await context.close(); }
  }, 15000);

  it('does not start an upload if the review record cannot be saved', async () => {
    uploads.length = 0;
    const context = await browser.newContext({ viewport: { width: 320, height: 700 }, hasTouch: true });
    try {
      await context.addInitScript(() => {
        const original = Storage.prototype.setItem;
        Storage.prototype.setItem = function (key, value) {
          if (key.startsWith('tv4:file-transfer-review:v1:')) throw new Error('Synthetic storage failure');
          return original.call(this, key, value);
        };
      });
      const page = await context.newPage();
      await page.goto(origin);
      await page.locator('.status-composer-shell').evaluate(node => {
        const transfer = new DataTransfer();
        transfer.items.add(new File(['one'], 'one.txt', { type: 'text/plain' }));
        node.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer }));
      });
      await page.getByText(/could not save or read the review warning/i).waitFor();
      expect(uploads).toEqual([]);
      expect(await page.getByRole('button', { name: 'Send message' }).isDisabled()).toBe(true);
    } finally { await context.close(); }
  }, 15000);
  it.each([320, 390])('holds a file selection for review after reload at %ipx', async width => {
    uploads.length = 0;
    const context = await browser.newContext({ viewport: { width, height: 800 }, hasTouch: true });
    try {
      const page = await context.newPage();
      await page.goto(origin);
      const request = page.waitForRequest(req => req.url().endsWith('/api/files/attachment'));
      await page.locator('.status-composer-shell').evaluate(node => {
        const transfer = new DataTransfer();
        transfer.items.add(new File(['x'], 'slow.txt', { type: 'text/plain' }));
        node.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer }));
      });
      await request;
      await page.reload();
      await page.getByText(/previous file selection did not finish/i).waitFor({ timeout: 3000 });
      expect(await page.getByRole('button', { name: 'Send message' }).isDisabled()).toBe(true);
      expect(await page.getByRole('textbox', { name: 'Command composer' }).inputValue()).toBe('Keep this draft');
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      const review = await page.getByRole('button', { name: 'Continue with current files' }).boundingBox();
      expect(review.height).toBeGreaterThanOrEqual(44);
      if (process.env.V4_FILE_DROP_SCREENSHOTS) await page.screenshot({ path: `${process.env.V4_FILE_DROP_SCREENSHOTS}/review-${width}.png` });
    } finally { await context.close(); }
  }, 15000);

  it('does not attach a late upload after another tab clears its review marker', async () => {
    uploads.length = 0;
    const context = await browser.newContext({ viewport: { width: 390, height: 800 }, hasTouch: true });
    try {
      const first = await context.newPage(), second = await context.newPage();
      await Promise.all([first.goto(origin), second.goto(origin)]);
      const request = first.waitForRequest(req => req.url().endsWith('/api/files/attachment'));
      await first.locator('.status-composer-shell').evaluate(node => {
        const transfer = new DataTransfer();
        transfer.items.add(new File(['x'], 'slow.txt', { type: 'text/plain' }));
        node.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer }));
      });
      await request;
      await second.getByText(/previous file selection did not finish/i).waitFor({ timeout: 3000 });
      await second.getByRole('button', { name: 'Continue with current files' }).click();
      await first.getByText(/selection.*changed|review.*changed/i).waitFor({ timeout: 4000 });
      expect(await first.locator('.status-composer-attachment-name').count()).toBe(0);
      expect(await first.getByRole('button', { name: 'Send message' }).isDisabled()).toBe(true);
    } finally { await context.close(); }
  }, 15000);

  it('restores a failed-selection hold after reload and synchronizes it only with the same session', async () => {
    uploads.length = 0;
    const context = await browser.newContext({ viewport: { width: 390, height: 800 }, hasTouch: true });
    try {
      const first = await context.newPage(), second = await context.newPage(), other = await context.newPage();
      await Promise.all([first.goto(origin), second.goto(origin), other.goto(`${origin}/?session=other`)]);
      await first.locator('.status-composer-shell').evaluate(node => {
        const transfer = new DataTransfer();
        transfer.items.add(new File(['x'], 'bad.txt', { type: 'text/plain' }));
        node.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer }));
      });
      await first.getByRole('alert').waitFor();
      await second.getByText(/previous file selection did not finish/i).waitFor();
      expect(await second.getByRole('button', { name: 'Send message' }).isDisabled()).toBe(true);
      expect(await other.getByRole('button', { name: 'Send message' }).isEnabled()).toBe(true);
      const records = await first.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith('tv4:file-transfer-review:v1:')).map(key => [key, localStorage.getItem(key)]));
      expect(records).toHaveLength(1);
      expect(JSON.stringify(records)).not.toContain('bad.txt');
      await first.reload();
      await first.getByText(/previous file selection did not finish/i).waitFor();
      expect(await first.getByRole('button', { name: 'Send message' }).isDisabled()).toBe(true);
      await second.getByRole('button', { name: 'Continue with current files' }).click();
      await first.waitForFunction(() => !document.querySelector('.status-transfer-review'));
      expect(await first.getByRole('button', { name: 'Send message' }).isEnabled()).toBe(true);
    } finally { await context.close(); }
  }, 15000);

  it.each([320, 390, 1280])('uploads dropped files in order and keeps the draft at %ipx', async width => {
    uploads.length = 0;
    const context = await browser.newContext({ viewport: { width, height: 800 }, hasTouch: width < 500 });
    try {
      const page = await context.newPage();
      await page.goto(origin);
      const shell = page.locator('.status-composer-shell');
      const request = page.waitForRequest(req => req.url().endsWith('/api/files/attachment'));
      await shell.evaluate(node => {
        const transfer = new DataTransfer();
        transfer.items.add(new File(['one'], 'one.txt', { type: 'text/plain' }));
        transfer.items.add(new File(['two'], 'two.pdf', { type: 'application/pdf' }));
        node.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer }));
      });
      await request;
      expect(await page.getByRole('button', { name: 'Send message' }).isDisabled()).toBe(true);
      await page.waitForFunction(() => document.querySelectorAll('.status-composer-attachment-name').length === 2);
      await page.waitForFunction(() => !Object.keys(localStorage).some(key => key.startsWith('tv4:file-transfer-review:v1:')));
      expect(uploads).toEqual(['one.txt', 'two.pdf']);
      expect(await page.locator('.status-composer-attachment-name').allTextContents()).toEqual(['one.txt', 'two.pdf']);
      if (width < 500) {
        const remove = await page.getByRole('button', { name: 'Remove one.txt' }).boundingBox();
        expect(remove.width).toBeGreaterThanOrEqual(44);
        expect(remove.height).toBeGreaterThanOrEqual(44);
      }
      expect(await page.getByRole('textbox', { name: 'Command composer' }).inputValue()).toBe('Keep this draft');
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      if (process.env.V4_FILE_DROP_SCREENSHOTS) await page.screenshot({ path: `${process.env.V4_FILE_DROP_SCREENSHOTS}/files-${width}.png` });
      await page.getByRole('button', { name: 'Send message' }).click();
      expect(await page.getByTestId('sent').textContent()).toBe('Keep this draft\n\nAttached files:\n- /synthetic/one.txt\n- /synthetic/two.pdf');
    } finally { await context.close(); }
  });

  it('accepts multiple files from the system file picker', async () => {
    uploads.length = 0;
    const context = await browser.newContext({ viewport: { width: 390, height: 800 }, hasTouch: true });
    try {
      const page = await context.newPage();
      await page.goto(origin);
      const chooserPromise = page.waitForEvent('filechooser');
      await page.getByRole('button', { name: 'Attach file' }).click();
      const chooser = await chooserPromise;
      expect(chooser.isMultiple()).toBe(true);
      await chooser.setFiles([{ name: 'first.txt', mimeType: 'text/plain', buffer: Buffer.from('one') }, { name: 'second.txt', mimeType: 'text/plain', buffer: Buffer.from('two') }]);
      await page.waitForFunction(() => document.querySelectorAll('.status-composer-attachment-name').length === 2);
      expect(uploads).toEqual(['first.txt', 'second.txt']);
      expect(await page.getByRole('textbox', { name: 'Command composer' }).inputValue()).toBe('Keep this draft');
    } finally { await context.close(); }
  });

  it('pastes files and text without losing the selected draft text', async () => {
    uploads.length = 0;
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    try {
      const page = await context.newPage();
      await page.goto(origin);
      const input = page.getByRole('textbox', { name: 'Command composer' });
      await input.focus();
      await input.evaluate(node => {
        node.setSelectionRange(5, 9);
        const transfer = new DataTransfer();
        transfer.setData('text/plain', 'pasted');
        transfer.items.add(new File(['one'], 'paste.txt', { type: 'text/plain' }));
        node.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: transfer }));
      });
      await page.waitForFunction(() => document.querySelectorAll('.status-composer-attachment-name').length === 1);
      expect(uploads).toEqual(['paste.txt']);
      expect(await input.inputValue()).toBe('Keep pasted draft');
    } finally { await context.close(); }
  });

  it('shows the partial result when a file fails on a phone viewport', async () => {
    uploads.length = 0;
    const context = await browser.newContext({ viewport: { width: 320, height: 800 }, hasTouch: true });
    try {
      const page = await context.newPage();
      await page.goto(origin);
      await page.locator('.status-composer-shell').evaluate(node => {
        const transfer = new DataTransfer();
        for (const name of ['one.txt', 'bad.txt', 'three.txt']) transfer.items.add(new File(['x'], name, { type: 'text/plain' }));
        node.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer }));
      });
      const alert = page.getByRole('alert');
      await alert.waitFor();
      expect(await alert.textContent()).toMatch(/Synthetic upload failed.*1 file was already attached/i);
      expect(uploads).toEqual(['one.txt', 'bad.txt']);
      expect(await page.locator('.status-composer-attachment-name').allTextContents()).toEqual(['one.txt']);
      expect(await page.getByRole('textbox', { name: 'Command composer' }).inputValue()).toBe('Keep this draft');
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      expect(await page.getByRole('button', { name: 'Send message' }).isDisabled()).toBe(true);
      const acknowledge = page.getByRole('button', { name: 'Continue with current files' });
      expect((await acknowledge.boundingBox()).height).toBeGreaterThanOrEqual(44);
      if (process.env.V4_FILE_DROP_SCREENSHOTS) await page.screenshot({ path: `${process.env.V4_FILE_DROP_SCREENSHOTS}/files-error-320.png` });
      await acknowledge.click();
      expect(await page.getByRole('button', { name: 'Send message' }).isEnabled()).toBe(true);
      await page.getByRole('button', { name: 'Send message' }).click();
      expect(await page.getByTestId('sent').textContent()).toBe('Keep this draft\n\nAttached files:\n- /synthetic/one.txt');
    } finally { await context.close(); }
  });
});
