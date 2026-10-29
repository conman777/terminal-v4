import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { chromium } from '@playwright/test';
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

let server, browser, origin;
beforeAll(async () => {
  server = createServer(async (req, res) => {
    if (req.url?.startsWith('/noble/')) {
      res.setHeader('Content-Type', 'text/javascript');
      res.end(await readFile(new URL('../../node_modules/@noble/hashes/esm/' + req.url.slice('/noble/'.length), import.meta.url), 'utf8'));
      return;
    }
    if (['/startImageTransfer.js', '/userImageDraftStore.js', '/userImageInput.js', '/createUuid.js', '/sha256.js'].includes(req.url)) {
      res.setHeader('Content-Type', 'text/javascript');
      const source = await readFile(new URL('.' + req.url, import.meta.url), 'utf8');
      res.end(source.replace("from './userImageInput'", "from '/userImageInput.js'")
        .replace("from './createUuid'", "from '/createUuid.js'").replace("from './sha256'", "from '/sha256.js'"));
      return;
    }
    res.setHeader('Content-Type', 'text/html');
    res.end('<title>Isolated image transfer</title><script type="importmap">{"imports":{"@noble/hashes/sha2":"/noble/sha2.js","@noble/hashes/crypto":"/noble/crypto.js"}}</script><script type="module">import {createUserImageDraftStore} from "/userImageDraftStore.js";import * as transfer from "/startImageTransfer.js";Object.assign(window,{createUserImageDraftStore,transfer});</script>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ executablePath: process.env.E2E_LOCAL_BROWSER || (process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : undefined), headless: true,
    args: ['--host-resolver-rules=MAP v4-insecure.test 127.0.0.1', '--no-proxy-server'] });
});
afterAll(async () => { await browser?.close(); server?.closeAllConnections(); await new Promise(resolve => server?.close(resolve)); });

describe('saved start image transfer', () => {
  it('binds the first message to an explicitly chosen request ID and rejects a different one', async () => {
    const context = await browser.newContext();
    const page = await context.newPage();
    try {
      await page.goto(origin); await page.waitForFunction(() => window.transfer);
      const result = await page.evaluate(async () => {
        const scope = ['synthetic-owner', location.origin + '/', 'home', 'ss-request'];
        const make = () => createUserImageDraftStore({ scope, isCurrent: () => true,
          legacy: { readRaw: () => localStorage.getItem('session'), writeMarker: value => localStorage.setItem('session', value) } });
        const store = make(); await store.hydrate(); await store.promoteLegacy(); store.setText('Send image'); await store.flush();
        const data = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGMQNI0GAAD8AKKX/vJMAAAAAElFTkSuQmCC'), value => value.charCodeAt(0));
        await store.addFiles([new File([data], 'chart.png', { type: 'image/png' })], { expectedRevision: store.getSnapshot().revision });
        const ticket = await store.beginUpload(store.getSnapshot().localIds[0]);
        const ref = { attachmentId: ticket.uploadId, artifactId: ticket.artifactId, mimeType: ticket.mimeType, bytes: ticket.bytes, name: ticket.name };
        await store.completeUpload(ticket, { status: 'ready', expiresAt: Date.now() + 60000, attachment: ref });
        const current = store.getSnapshot(), requestId = '00000000-0000-4000-8000-000000000001';
        const input = { text: current.text, draftRevision: current.revision, localIds: current.localIds, attachments: [ref], requestId };
        const first = await store.prepareIntent(input);
        const retry = await store.prepareIntent(input);
        let rejected = false; try { await store.prepareIntent({ ...input, requestId: '00000000-0000-4000-8000-000000000002' }); } catch { rejected = true; }
        const result = { requestId: first.requestId, reused: retry.reused, sameBody: retry.serializedBody === first.serializedBody, rejected };
        store.close(); return result;
      });
      expect(result).toEqual({ requestId: '00000000-0000-4000-8000-000000000001', reused: true, sameBody: true, rejected: true });
    } finally { await context.close(); }
  });
  it('saves and copies verified images on a genuinely insecure HTTP origin', async () => {
    const context = await browser.newContext();
    const page = await context.newPage();
    try {
      await page.goto(origin.replace('127.0.0.1', 'v4-insecure.test')); await page.waitForFunction(() => window.transfer);
      const result = await page.evaluate(async () => {
        const scope = id => ['synthetic-owner', location.origin + '/', 'home', id];
        const make = id => createUserImageDraftStore({ scope: scope(id), isCurrent: () => true,
          legacy: { readRaw: () => localStorage.getItem(id), writeMarker: value => localStorage.setItem(id, value) } });
        const source = make('workspace-start'), target = make('ss-http');
        await source.hydrate(); await source.promoteLegacy(); source.setText('Synthetic'); await source.flush();
        await target.hydrate(); await target.promoteLegacy(); target.setText('Synthetic'); await target.flush();
        const bytes = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGMQNI0GAAD8AKKX/vJMAAAAAElFTkSuQmCC'), value => value.charCodeAt(0));
        await source.addFiles([new File([bytes], 'image.png', { type: 'image/png' })], { expectedRevision: source.getSnapshot().revision });
        const binding = await transfer.captureStartImageBinding(source, scope('ss-http'), () => true);
        const id = await transfer.startImageRequestId(binding);
        const copied = await transfer.copyStartImages({ source, target, binding, isCurrent: () => true });
        const targetBytes = await target.getBlob(copied.localIds[0]);
        const value = { secure: isSecureContext, subtle: Boolean(crypto.subtle), random: typeof crypto.getRandomValues === 'function',
          rawHash: targetBytes.rawSha256, artifactId: targetBytes.artifactId, id };
        source.close(); target.close(); return value;
      });
      const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGMQNI0GAAD8AKKX/vJMAAAAAElFTkSuQmCC', 'base64');
      expect(result).toEqual({ secure: false, subtle: false, random: true,
        rawHash: createHash('sha256').update(bytes).digest('hex'),
        artifactId: createHash('sha256').update('v4-image-v1\0image/png\0').update(bytes).digest('hex'), id: expect.stringMatching(/^[a-f0-9-]{36}$/) });
    } finally { await context.close(); }
  });
  it('saves, copies and computes the same request identity without SubtleCrypto', async () => {
    const context = await browser.newContext();
    const page = await context.newPage();
    try {
      await page.goto(origin); await page.waitForFunction(() => window.transfer);
      const result = await page.evaluate(async () => {
        const subtle = crypto.subtle;
        Object.defineProperty(crypto, 'subtle', { value: undefined, configurable: true });
        const scope = id => ['synthetic-owner', location.origin + '/', 'home', id];
        const make = id => createUserImageDraftStore({ scope: scope(id), isCurrent: () => true,
          legacy: { readRaw: () => localStorage.getItem(id), writeMarker: value => localStorage.setItem(id, value) } });
        const source = make('workspace-start'), target = make('ss-no-subtle');
        await source.hydrate(); await source.promoteLegacy(); source.setText('Synthetic image'); await source.flush();
        await target.hydrate(); await target.promoteLegacy(); target.setText('Synthetic image'); await target.flush();
        const bytes = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGMQNI0GAAD8AKKX/vJMAAAAAElFTkSuQmCC'), value => value.charCodeAt(0));
        await source.addFiles([new File([bytes], 'image.png', { type: 'image/png' })], { expectedRevision: source.getSnapshot().revision });
        const binding = await transfer.captureStartImageBinding(source, scope('ss-no-subtle'), () => true);
        const without = await transfer.startImageRequestId(binding);
        const copied = await transfer.copyStartImages({ source, target, binding, isCurrent: () => true });
        const targetBytes = await target.getBlob(copied.localIds[0]);
        delete crypto.subtle;
        const withNative = await transfer.startImageRequestId(binding);
        const raw = [...new Uint8Array(await subtle.digest('SHA-256', bytes))].map(value => value.toString(16).padStart(2, '0')).join('');
        const result = { sameId: without === withNative, hashMatches: targetBytes.rawSha256 === raw, bytes: targetBytes.bytes };
        source.close(); target.close(); return result;
      });
      expect(result).toEqual({ sameId: true, hashMatches: true, bytes: 69 });
    } finally { await context.close(); }
  });
  it('only one tab can renew an explicitly held source revision', async () => {
    const context = await browser.newContext();
    const page = await context.newPage();
    try {
      await page.goto(origin); await page.waitForFunction(() => window.transfer);
      const result = await page.evaluate(async () => {
        const scope = ['synthetic-owner', location.origin + '/', 'home', 'workspace-start'];
        const make = () => createUserImageDraftStore({ scope, isCurrent: () => true,
          legacy: { readRaw: () => localStorage.getItem('start'), writeMarker: value => localStorage.setItem('start', value) } });
        const first = make(); await first.hydrate(); await first.promoteLegacy();
        const data = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGMQNI0GAAD8AKKX/vJMAAAAAElFTkSuQmCC'), value => value.charCodeAt(0));
        await first.addFiles([new File([data], 'chart.png', { type: 'image/png' })], { expectedRevision: first.getSnapshot().revision });
        const binding = await transfer.captureStartImageSource(first, () => true);
        const oldId = await transfer.startImageRequestId(binding);
        const second = make(); await second.hydrate();
        const expected = { expectedRevision: binding.sourceRevision, expectedLocalIds: binding.sourceLocalIds };
        const outcomes = await Promise.allSettled([first.renewStartRevision(expected), second.renewStartRevision(expected)]);
        await first.hydrate();
        const fresh = await transfer.captureStartImageSource(first, () => true);
        const result = { fulfilled: outcomes.filter(value => value.status === 'fulfilled').length,
          rejected: outcomes.filter(value => value.status === 'rejected').length, newId: await transfer.startImageRequestId(fresh) !== oldId,
          retained: fresh.sourceLocalIds.length === 1 };
        first.close(); second.close(); return result;
      });
      expect(result).toEqual({ fulfilled: 1, rejected: 1, newId: true, retained: true });
    } finally { await context.close(); }
  });
  it('copies verified originals and recognizes the same batch after reopening', async () => {
    const context = await browser.newContext();
    const page = await context.newPage();
    try {
      await page.goto(origin); await page.waitForFunction(() => window.transfer);
      const result = await page.evaluate(async () => {
        const scope = id => ['synthetic-owner', location.origin + '/', 'home', id];
        const make = id => createUserImageDraftStore({ scope: scope(id), isCurrent: () => true,
          legacy: { readRaw: () => localStorage.getItem(id), writeMarker: value => localStorage.setItem(id, value) } });
        const source = make('workspace-start'), target = make('ss-start');
        await source.hydrate(); await source.promoteLegacy(); source.setText('Image question'); await source.flush();
        await target.hydrate(); await target.promoteLegacy(); target.setText('Image question'); await target.flush();
        const data = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGMQNI0GAAD8AKKX/vJMAAAAAElFTkSuQmCC'), value => value.charCodeAt(0));
        await source.addFiles([new File([data], 'chart.png', { type: 'image/png' })], { expectedRevision: source.getSnapshot().revision });
        const binding = await transfer.captureStartImageBinding(source, scope('ss-start'), () => true);
        const first = await transfer.copyStartImages({ source, target, binding, isCurrent: () => true });
        source.close(); target.close();
        const reopenedSource = make('workspace-start'), reopenedTarget = make('ss-start');
        const second = await transfer.copyStartImages({ source: reopenedSource, target: reopenedTarget, binding, isCurrent: () => true });
        const src = await reopenedSource.getBlob(binding.sourceLocalIds[0]);
        const dst = await reopenedTarget.getBlob(second.localIds[0]);
        const state = { firstRecovered: first.recovered, secondRecovered: second.recovered, sameId: first.localIds[0] === second.localIds[0],
          sourceCount: reopenedSource.getSnapshot().localIds.length, targetCount: reopenedTarget.getSnapshot().localIds.length,
          sameBytes: src.rawSha256 === dst.rawSha256, name: dst.name };
        reopenedSource.close(); reopenedTarget.close(); return state;
      });
      expect(result).toEqual({ firstRecovered: false, secondRecovered: true, sameId: true, sourceCount: 1, targetCount: 1, sameBytes: true, name: 'chart.png' });
    } finally { await context.close(); }
  });
});
