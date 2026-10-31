import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from '@playwright/test';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { managedChromiumPath } from '../test/managedChromium';

let server, browser, context, page, origin;
beforeAll(async () => {
  const source = await readFile(resolve(process.cwd(), 'src/utils/largePasteRecovery.js'), 'utf8');
  server = createServer((request, response) => {
    if (request.url === '/store.js') { response.setHeader('Content-Type', 'text/javascript'); response.end(source); return; }
    response.setHeader('Content-Type', 'text/html');
    response.end('<title>Synthetic paste recovery</title><script type="module">import {createLargePasteRecovery} from "/store.js"; window.createRecovery = createLargePasteRecovery;</script>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ executablePath: await managedChromiumPath(), headless: true });
}, 60000);
afterAll(async () => { await browser?.close(); server?.closeAllConnections(); if (server) await new Promise(resolve => server.close(resolve)); });
beforeEach(async () => {
  context = await browser.newContext(); page = await context.newPage();
  await page.goto(origin); await page.waitForFunction(() => window.createRecovery);
});
afterEach(async () => { await context?.close(); });

describe('large paste recovery in browser storage', () => {
  it('retains the original bytes and draft boundaries across a reload', async () => {
    const initial = await page.evaluate(async () => {
      const store = createRecovery({ scope: ['owner-a', location.origin, 'home', 'thread-a'], isCurrent: () => true });
      const text = 'λtext\r\n'.repeat(200000);
      await store.save({ id: '11111111-1111-4111-8111-111111111111', blob: new Blob([text], { type: 'text/plain' }), original: 'left SELECT right', prefix: 'left ', suffix: ' right', revision: 'draft-1' });
      store.close();
      return new TextEncoder().encode(text).length;
    });
    await page.reload(); await page.waitForFunction(() => window.createRecovery);
    const restored = await page.evaluate(async () => {
      const store = createRecovery({ scope: ['owner-a', location.origin, 'home', 'thread-a'], isCurrent: () => true });
      const value = await store.read();
      const result = { id: value.id, text: await value.blob.text(), bytes: value.blob.size, original: value.original, prefix: value.prefix, suffix: value.suffix, revision: value.revision };
      store.close(); return result;
    });
    expect(restored).toEqual({ id: '11111111-1111-4111-8111-111111111111', text: 'λtext\r\n'.repeat(200000), bytes: initial, original: 'left SELECT right', prefix: 'left ', suffix: ' right', revision: 'draft-1' });
  });

  it('fences owners, environments, threads and stale scopes', async () => {
    const result = await page.evaluate(async () => {
      const scope = ['owner-a', location.origin, 'home', 'thread-a'];
      let current = true;
      const owner = createRecovery({ scope, isCurrent: () => current });
      await owner.save({ id: '11111111-1111-4111-8111-111111111111', blob: new Blob(['source'], { type: 'text/plain' }), original: '', prefix: '', suffix: '', revision: 'draft-1' });
      const others = [
        ['owner-b', location.origin, 'home', 'thread-a'],
        ['owner-a', location.origin, 'paired', 'thread-a'],
        ['owner-a', location.origin, 'home', 'thread-b'],
      ].map(other => createRecovery({ scope: other, isCurrent: () => true }));
      const hidden = await Promise.all(others.map(store => store.read()));
      const foreignClear = await owner.clear('22222222-2222-4222-8222-222222222222');
      current = false;
      let stale; try { await owner.read(); } catch (error) { stale = error.code; }
      owner.close(); others.forEach(store => store.close());
      return { hidden, foreignClear, stale };
    });
    expect(result).toEqual({ hidden: [null, null, null], foreignClear: false, stale: 'stale_scope' });
  });

  it('allows only one pending paste per thread across tabs and requires its exact identity to clear', async () => {
    const second = await context.newPage(); await second.goto(origin); await second.waitForFunction(() => window.createRecovery);
    const make = (target, id) => target.evaluate(async id => {
      const store = createRecovery({ scope: ['owner-a', location.origin, 'home', 'thread-a'], isCurrent: () => true });
      try { await store.save({ id, blob: new Blob([id], { type: 'text/plain' }), original: '', prefix: '', suffix: '', revision: 'draft-1' }); return 'saved'; }
      catch (error) { return error.code; }
      finally { store.close(); }
    }, id);
    const results = await Promise.all([make(page, '11111111-1111-4111-8111-111111111111'), make(second, '22222222-2222-4222-8222-222222222222')]);
    expect(results.sort()).toEqual(['exists', 'saved']);
    const cleared = await page.evaluate(async () => {
      const store = createRecovery({ scope: ['owner-a', location.origin, 'home', 'thread-a'], isCurrent: () => true });
      const saved = await store.read();
      const wrong = await store.clear(saved.id === '11111111-1111-4111-8111-111111111111' ? '22222222-2222-4222-8222-222222222222' : '11111111-1111-4111-8111-111111111111');
      const stillThere = (await store.read()).id === saved.id;
      const right = await store.clear(saved.id);
      const gone = await store.read(); store.close(); return { wrong, stillThere, right, gone };
    });
    expect(cleared).toEqual({ wrong: false, stillThere: true, right: true, gone: null });
  });

  it('enforces the per-owner count limit and reuses capacity only after the matching record is cleared', async () => {
    const result = await page.evaluate(async () => {
      const stores = Array.from({ length: 9 }, (_, index) => createRecovery({ scope: ['owner-a', location.origin, 'home', `thread-${index}`], isCurrent: () => true }));
      const payload = { id: '11111111-1111-4111-8111-111111111111', blob: new Blob(['source'], { type: 'text/plain' }), original: '', prefix: '', suffix: '', revision: 'draft-1' };
      for (const store of stores.slice(0, 8)) await store.save(payload);
      let blocked; try { await stores[8].save(payload); } catch (error) { blocked = error.code; }
      await stores[0].clear(payload.id); await stores[8].save(payload);
      const saved = (await stores[8].read()).id; stores.forEach(store => store.close()); return { blocked, saved };
    });
    expect(result).toEqual({ blocked: 'capacity', saved: '11111111-1111-4111-8111-111111111111' });
  });

  it('holds interrupted upload claims for explicit review and fences stale completions', async () => {
    const id = '11111111-1111-4111-8111-111111111111', first = '22222222-2222-4222-8222-222222222222', second = '33333333-3333-4333-8333-333333333333';
    await page.evaluate(async ({ id, first }) => {
      const store = createRecovery({ scope: ['owner-a', location.origin, 'home', 'thread-a'], isCurrent: () => true });
      await store.save({ id, blob: new Blob(['source'], { type: 'text/plain' }), original: '', prefix: '', suffix: '', revision: 'draft-1' });
      await store.claim(id, first); store.close();
    }, { id, first });
    await page.reload(); await page.waitForFunction(() => window.createRecovery);
    const result = await page.evaluate(async ({ id, first, second }) => {
      const store = createRecovery({ scope: ['owner-a', location.origin, 'home', 'thread-a'], isCurrent: () => true });
      const held = await store.read();
      let duplicate, discard;
      try { await store.claim(id, second); } catch (error) { duplicate = error.code; }
      try { await store.clear(id); } catch (error) { discard = error.code; }
      const reviewed = await store.markUncertain(id, first);
      let unreviewed; try { await store.claim(id, second); } catch (error) { unreviewed = error.code; }
      await store.claim(id, second, { reviewUncertain: true });
      const stale = await store.finish(id, first);
      const right = await store.finish(id, second);
      const gone = await store.read(); store.close();
      return { held: held.status, duplicate, discard, reviewed, unreviewed, stale, right, gone };
    }, { id, first, second });
    expect(result).toEqual({ held: 'claimed', duplicate: 'in_progress', discard: 'in_progress', reviewed: true, unreviewed: 'needs_review', stale: false, right: true, gone: null });
  });

  it('grants only one upload claim when two tabs try simultaneously', async () => {
    await page.evaluate(async () => {
      const store = createRecovery({ scope: ['owner-a', location.origin, 'home', 'thread-a'], isCurrent: () => true });
      await store.save({ id: '11111111-1111-4111-8111-111111111111', blob: new Blob(['source'], { type: 'text/plain' }), original: '', prefix: '', suffix: '', revision: 'draft-1' });
      store.close();
    });
    const second = await context.newPage(); await second.goto(origin); await second.waitForFunction(() => window.createRecovery);
    const claim = (target, claimId) => target.evaluate(async claimId => {
      const store = createRecovery({ scope: ['owner-a', location.origin, 'home', 'thread-a'], isCurrent: () => true });
      try { await store.claim('11111111-1111-4111-8111-111111111111', claimId); return 'claimed'; }
      catch (error) { return error.code; }
      finally { store.close(); }
    }, claimId);
    const results = await Promise.all([claim(page, '22222222-2222-4222-8222-222222222222'), claim(second, '33333333-3333-4333-8333-333333333333')]);
    expect(results.sort()).toEqual(['claimed', 'in_progress']);
  });

  it('fails closed when saved capacity metadata is missing', async () => {
    const result = await page.evaluate(async () => {
      const scope = ['owner-a', location.origin, 'home', 'thread-a'];
      const store = createRecovery({ scope, isCurrent: () => true });
      await store.save({ id: '11111111-1111-4111-8111-111111111111', blob: new Blob(['source'], { type: 'text/plain' }), original: '', prefix: '', suffix: '', revision: 'draft-1' });
      const db = await new Promise((resolve, reject) => { const request = indexedDB.open('terminal-v4-large-paste-recovery', 1); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
      await new Promise((resolve, reject) => { const transaction = db.transaction('budgets', 'readwrite'); transaction.objectStore('budgets').delete(scope.slice(0, 2)); transaction.oncomplete = resolve; transaction.onabort = () => reject(transaction.error); });
      let error; try { await store.read(); } catch (caught) { error = caught.code; }
      store.close(); db.close(); return error;
    });
    expect(result).toBe('corrupt');
  });

  it('supports the 25 MiB attachment limit and rejects a larger source', async () => {
    const result = await page.evaluate(async () => {
      const store = createRecovery({ scope: ['owner-a', location.origin, 'home', 'thread-a'], isCurrent: () => true });
      const base = { id: '11111111-1111-4111-8111-111111111111', original: '', prefix: '', suffix: '', revision: 'draft-1' };
      await store.save({ ...base, blob: new Blob([new Uint8Array(25 * 1024 * 1024)], { type: 'text/plain' }) });
      const size = (await store.read()).blob.size;
      await store.clear(base.id);
      let oversized; try { await store.save({ ...base, blob: new Blob([new Uint8Array(25 * 1024 * 1024 + 1)], { type: 'text/plain' }) }); } catch (error) { oversized = error.code; }
      store.close(); return { size, oversized };
    });
    expect(result).toEqual({ size: 25 * 1024 * 1024, oversized: 'invalid_input' });
  }, 15000);
});
