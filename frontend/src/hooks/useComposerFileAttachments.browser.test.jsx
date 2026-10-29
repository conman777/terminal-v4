import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { chromium } from '@playwright/test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

let browser, server, origin;

beforeAll(async () => {
  const fixture = `
    import React, { useState } from 'react';
    import { createRoot } from 'react-dom/client';
    import { setEnvironmentIdentity } from './src/utils/remoteEnvironments';
    import { useComposerFileAttachments } from './src/hooks/useComposerFileAttachments';
    import AttachmentDraftStatus from './src/components/AttachmentDraftStatus';
    setEnvironmentIdentity('fixture-owner', location.origin);
    function App() {
      const [items, setItems, error, retry, restored, conflict, useSaved, validate] = useComposerFileAttachments('fixture-thread');
      const [message, setMessage] = useState('');
      const add = (name) => setItems(current => [...current, {name, path: '/fixture/' + name, bytes: 'not persisted'}]);
      return <main><textarea aria-label="Draft" value={message} onChange={event => setMessage(event.target.value)} />
        <button onClick={() => add('mine.txt')}>Add mine</button><button onClick={() => add('theirs.txt')}>Add theirs</button><button onClick={() => add('later.txt')}>Add later</button>
        <output aria-label="Current files">{items.map(item => item.name).join(', ')}</output>
        <output aria-label="Restored">{String(restored)}</output>
        {error && <AttachmentDraftStatus error={error} conflict={conflict} onRetry={retry} onUseSaved={useSaved} />}
        <button disabled={Boolean(error)} onClick={() => validate()}>Send</button></main>;
    }
    createRoot(document.getElementById('root')).render(<App />);
  `;
  const script = execFileSync(process.execPath, ['-e', `require('esbuild').build({stdin:{contents:process.argv[1],resolveDir:process.cwd(),loader:'jsx'},bundle:true,write:false,format:'iife',jsx:'automatic',loader:{'.css':'empty'},define:{'import.meta.env.VITE_API_URL':'""'}}).then(result=>process.stdout.write(result.outputFiles[0].text))`, fixture], { cwd: process.cwd(), encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  server = createServer((req, res) => {
    if (req.url === '/fixture.js') { res.setHeader('Content-Type', 'text/javascript'); res.end(script); return; }
    res.setHeader('Content-Type', 'text/html');
    res.end(`<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1"><style>
      :root { --bg-surface:#fff; --border-subtle:#bbb; --text-secondary:#222; --error:#961a1a; --font-ui:system-ui }
      body { margin:0; font:16px system-ui } main { padding:12px; box-sizing:border-box } textarea { display:block; width:100%; box-sizing:border-box; font:16px system-ui }
      .remote-readonly-notice { padding:8px; overflow-wrap:anywhere } .attachment-draft-status p { margin:0 0 6px } .attachment-draft-status button { min-height:44px }
      .attachment-draft-review ul { max-height:30vh; overflow:auto; padding-left:20px } .attachment-draft-review-actions { display:flex; flex-wrap:wrap; gap:8px }
      </style><script>if (!localStorage.getItem('terminal_user')) localStorage.setItem('terminal_user', JSON.stringify({id:'fixture-owner'}));</script><div id="root"></div><script src="/fixture.js"></script>`);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ headless: true, ...(process.env.E2E_LOCAL_BROWSER ? { executablePath: process.env.E2E_LOCAL_BROWSER } : {}) });
}, 30000);

afterAll(async () => {
  await browser?.close();
  server?.closeAllConnections();
  if (server) await new Promise(resolve => server.close(resolve));
});

describe.each([320, 1200])('attachment conflict recovery at %ipx', width => {
  it('reviews a real second-tab change and rejects a stale review without losing local work', async () => {
    const context = await browser.newContext({ viewport: { width, height: 800 } });
    context.setDefaultTimeout(3000);
    try {
      const first = await context.newPage(), second = await context.newPage();
      await first.addInitScript(() => {
        window.blockAttachmentEvents = false;
        window.addEventListener('storage', event => {
          if (window.blockAttachmentEvents && event.key?.includes('composerFiles:')) event.stopImmediatePropagation();
        }, true);
      });
      await first.goto(origin);
      await second.goto(origin);
      await first.getByLabel('Draft').fill('Keep this message.');
      await first.getByRole('button', { name: 'Add mine' }).click();
      await second.getByRole('button', { name: 'Review saved files' }).click();
      await second.getByRole('button', { name: 'Use saved files' }).click();
      await second.getByRole('button', { name: 'Add theirs' }).click();
      await first.getByRole('button', { name: 'Review saved files' }).click();
      expect(await first.getByRole('group', { name: 'Saved file selections' }).textContent()).toContain('theirs.txt');
      expect(await first.getByRole('button', { name: 'Send' }).isDisabled()).toBe(true);
      await first.evaluate(() => { window.blockAttachmentEvents = true; });
      await second.getByRole('button', { name: 'Add later' }).click();
      await first.getByRole('button', { name: 'Use saved files' }).click();
      expect(await first.getByLabel('Current files').textContent()).toBe('mine.txt');
      expect(await first.getByRole('button', { name: 'Use saved files' }).count()).toBe(0);
      await first.getByRole('button', { name: 'Review saved files' }).click();
      const group = first.getByRole('group', { name: 'Saved file selections' });
      expect(await group.textContent()).toContain('later.txt');
      const button = first.getByRole('button', { name: 'Use saved files' });
      expect((await button.boundingBox()).height).toBeGreaterThanOrEqual(44);
      const before = await second.evaluate(() => Object.entries(localStorage).find(([key]) => key.includes('composerFiles:'))[1]);
      await button.click();
      expect(await first.getByLabel('Current files').textContent()).toBe('mine.txt, theirs.txt, later.txt');
      expect(await first.getByLabel('Draft').inputValue()).toBe('Keep this message.');
      expect(await first.getByLabel('Restored').textContent()).toBe('true');
      expect(await first.getByRole('button', { name: 'Send' }).isEnabled()).toBe(true);
      expect(await second.evaluate(() => Object.entries(localStorage).find(([key]) => key.includes('composerFiles:'))[1])).toBe(before);
      expect(before).not.toContain('not persisted');
      expect(await first.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
    } finally { await context.close(); }
  }, 15000);
});
