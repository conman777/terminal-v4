import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { chromium } from '@playwright/test';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

let server, browser, context, page, origin;
beforeAll(async () => {
  server = createServer(async (req, res) => {
    if (req.url?.startsWith('/noble/')) {
      res.setHeader('Content-Type', 'text/javascript');
      res.end(await readFile(new URL('../../node_modules/@noble/hashes/esm/' + req.url.slice('/noble/'.length), import.meta.url), 'utf8'));
      return;
    }
    if (['/userImageDraftStore.js', '/userImageInput.js', '/createUuid.js', '/sha256.js'].includes(req.url)) {
      res.setHeader('Content-Type', 'text/javascript');
      const source = await readFile(new URL('.' + req.url, import.meta.url), 'utf8');
      res.end(source.replace("from './userImageInput'", "from '/userImageInput.js'")
        .replace("from './createUuid'", "from '/createUuid.js'").replace("from './sha256'", "from '/sha256.js'"));
      return;
    }
    res.setHeader('Content-Type', 'text/html');
    res.end('<title>Synthetic native image expiry</title><script type="importmap">{"imports":{"@noble/hashes/sha2":"/noble/sha2.js","@noble/hashes/crypto":"/noble/crypto.js"}}</script><script type="module">import {createUserImageDraftStore} from "/userImageDraftStore.js";window.createStore=createUserImageDraftStore;</script>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ executablePath: process.env.E2E_LOCAL_BROWSER || (process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : undefined), headless: true });
});
afterAll(async () => { await browser?.close(); server?.closeAllConnections(); await new Promise(resolve => server?.close(resolve)); });
beforeEach(async () => {
  context = await browser.newContext(); page = await context.newPage();
  await page.goto(origin); await page.waitForFunction(() => window.createStore);
  await page.evaluate(async () => {
    let marker = null; window.alive = true;
    window.options = { scope: ['synthetic-owner', location.origin + '/', 'home', 'ss-expiry'], isCurrent: () => window.alive,
      legacy: { readRaw: () => marker, writeMarker: value => { marker = value; } } };
    window.store = createStore(options); await store.hydrate(); await store.promoteLegacy();
    const data = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGMQNI0GAAD8AKKX/vJMAAAAAElFTkSuQmCC'), value => value.charCodeAt(0));
    await store.addFiles([new File([data], 'original.png', { type: 'image/png' })], { expectedRevision: store.getSnapshot().revision });
    window.localId = store.getSnapshot().localIds[0]; window.ticket = await store.beginUpload(localId);
    window.receipt = (ticket, expiresAt) => ({ status: 'ready', expiresAt, attachment: {
      attachmentId: ticket.uploadId, artifactId: ticket.artifactId, mimeType: ticket.mimeType, bytes: ticket.bytes, name: ticket.name,
    } });
    window.prepare = () => { const s = store.getSnapshot(); return store.prepareIntent({ text: s.text,
      attachments: s.items.map(item => item.descriptor), draftRevision: s.revision, localIds: s.localIds }); };
  });
});
afterEach(async () => { await page?.evaluate(() => store.close()); await context?.close(); });

describe('native image draft receipt expiry', () => {
  it('refreshes readiness on foreground after a wall-clock jump', async () => {
    const value = await page.evaluate(async () => {
      const deadline = Date.now() + 72 * 3600000; await store.completeUpload(ticket, receipt(ticket, deadline));
      const oldNow = Date.now; Date.now = () => deadline;
      window.dispatchEvent(new Event('focus'));
      const state = store.getSnapshot().items[0].uploadState; Date.now = oldNow;
      return state;
    });
    expect(value).toBe('expired');
  });
  it('publishes the live deadline without a render, then reopens expired with retained bytes', async () => {
    const expiresAt = await page.evaluate(async () => {
      const deadline = Date.now() + 250; await store.completeUpload(ticket, receipt(ticket, deadline));
      window.expiredPublications = 0;
      store.subscribe(() => { if (store.getSnapshot().items[0]?.uploadState === 'expired') window.expiredPublications++; });
      return deadline;
    });
    await page.waitForFunction(() => expiredPublications > 0);
    const value = await page.evaluate(async () => {
      store.close(); window.store = createStore(options); await store.hydrate();
      const item = store.getSnapshot().items[0], source = await store.getBlob(localId);
      return { expiresAt: item.expiresAt, state: item.uploadState, bytes: source.blob.size, sameUpload: item.uploadId === ticket.uploadId };
    });
    expect(value).toEqual({ expiresAt, state: 'expired', bytes: 69, sameUpload: true });
  });

  it('uses a fresh UUID at the exact 72-hour boundary and fences an old completion', async () => {
    const value = await page.evaluate(async () => {
      const deadline = Date.now() + 72 * 3600000; await store.completeUpload(ticket, receipt(ticket, deadline));
      const pendingTicket = await store.beginUpload(localId);
      const oldNow = Date.now; Date.now = () => deadline;
      const fresh = await store.beginUpload(localId);
      const staleApplied = (await store.completeUpload(pendingTicket, receipt(pendingTicket, deadline + 1000))).applied;
      await store.completeUpload(fresh, receipt(fresh, deadline + 1000));
      const staleAfterReady = (await store.completeUpload(pendingTicket, receipt(pendingTicket, deadline + 1000))).applied;
      const item = store.getSnapshot().items[0], bytes = await store.getBlob(localId); Date.now = oldNow;
      return { rotated: fresh.uploadId !== ticket.uploadId, retainedLocalId: fresh.localId === ticket.localId, artifactPreserved: fresh.artifactId === ticket.artifactId,
        staleApplied, staleAfterReady, currentId: item.descriptor.attachmentId === fresh.uploadId, byteCount: bytes.blob.size };
    });
    expect(value).toEqual({ rotated: true, retainedLocalId: true, artifactPreserved: true, staleApplied: false, staleAfterReady: false, currentId: true, byteCount: 69 });
  });

  it('keeps nonexpired retry identity and immutable pending pins after expiry', async () => {
    const value = await page.evaluate(async () => {
      const deadline = Date.now() + 10000; await store.completeUpload(ticket, receipt(ticket, deadline));
      const retry = await store.beginUpload(localId); await store.completeUpload(retry, receipt(retry, deadline));
      const pending = await prepare(), before = JSON.stringify(store.getPendingIntent());
      const oldNow = Date.now; Date.now = () => deadline;
      let blocked; try { await store.beginUpload(localId); } catch (error) { blocked = error.code; }
      const reused = await prepare(); Date.now = oldNow;
      return { sameUpload: retry.uploadId === ticket.uploadId, blocked, pinUnchanged: JSON.stringify(store.getPendingIntent()) === before,
        sameRequest: reused.requestId === pending.requestId, sameBody: reused.serializedBody === pending.serializedBody, reused: reused.reused };
    });
    expect(value).toEqual({ sameUpload: true, blocked: 'pending', pinUnchanged: true, sameRequest: true, sameBody: true, reused: true });
  });

  it('refuses mutation and completion after the owning scope retires', async () => {
    const value = await page.evaluate(async () => {
      const before = store.getSnapshot().items[0].uploadId; window.alive = false;
      const failures = [];
      for (const action of [() => store.beginUpload(localId), () => store.completeUpload(ticket, receipt(ticket, Date.now() + 10000))]) {
        try { await action(); } catch (error) { failures.push(error.code); }
      }
      return { failures, unchanged: store.getSnapshot().items[0].uploadId === before };
    });
    expect(value).toEqual({ failures: ['stale_scope', 'stale_scope'], unchanged: true });
  });
});
