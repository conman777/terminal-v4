import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';

test.skip(process.env.E2E_LOCAL_TESTING !== '1', 'Requires an isolated local testing server.');
test.use({ launchOptions: { executablePath: process.env.E2E_LOCAL_BROWSER }, isMobile: true, hasTouch: true });

for (const width of [320, 393]) {
  test(`file attachments stay with the mobile conversation at ${width}px`, async ({ page }) => {
    const first = { id: 'ss-attachment-first', provider: 'codex', runtime: 'codex', title: 'First attachment thread', cwd: '/tmp/attachment-fixture', status: 'completed', model: 'fixture-model', updatedAt: '2026-10-26T10:00:00Z' };
    const second = { ...first, id: 'ss-attachment-second', title: 'Second attachment thread', updatedAt: '2026-10-25T10:00:00Z' };
    await page.setViewportSize({ width, height: 700 });
    await page.route(/\/api\/structured\/sessions(?:\?.*)?$/, route => route.fulfill({ json: [first, second] }));
    for (const session of [first, second]) {
      await page.route(`**/api/structured/sessions/${session.id}`, route => route.fulfill({ json: session }));
      await page.routeWebSocket(`**/api/structured/sessions/${session.id}/ws*`, socket => socket.send(JSON.stringify({ __terminal_meta: true, type: 'structured_event', event: { type: 'message_completed', role: 'assistant', content: 'Ready.', messageId: 'message', turnId: 'turn', seq: 1 } })));
    }
    await page.route('**/api/files/attachment', route => route.fulfill({ json: { path: '/tmp/attachment-fixture/fixture.txt' } }));
    await page.goto('/');
    await page.getByLabel('Username', { exact: true }).fill(`attach-${randomUUID()}`);
    await page.getByRole('button', { name: 'Open workspace', exact: true }).click();
    const composer = page.getByRole('textbox', { name: 'Command composer', exact: true });
    await expect(page.getByRole('button', { name: /Show full thread title: First attachment thread/ })).toBeVisible();
    await composer.fill('Please review the attached file.');
    const chooserPromise = page.waitForEvent('filechooser');
    await page.getByRole('button', { name: 'Attach file' }).click();
    const chooser = await chooserPromise;
    await chooser.setFiles({ name: 'fixture.txt', mimeType: 'text/plain', buffer: Buffer.from('Fixture content') });
    await expect(page.getByLabel('Composer attachments')).toContainText('fixture.txt');

    await page.getByRole('button', { name: 'Menu', exact: true }).click();
    await page.getByRole('dialog', { name: 'Mobile menu' }).getByRole('button', { name: /Second attachment thread/ }).click();
    await expect(page.getByLabel('Composer attachments')).toHaveCount(0);
    await page.getByRole('button', { name: 'Menu', exact: true }).click();
    await page.getByRole('dialog', { name: 'Mobile menu' }).getByRole('button', { name: /First attachment thread/ }).click();
    await expect(composer).toHaveValue('Please review the attached file.');
    await expect(page.getByLabel('Composer attachments')).toContainText('fixture.txt');
    await page.reload();
    await expect(page.getByLabel('Composer attachments')).toContainText('fixture.txt');
    await expect(page.getByText('Restored file selections. Check the files before sending; they may have changed.')).toBeVisible();
    await expect(composer).toHaveValue('Please review the attached file.');
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
  });
}

test('a delayed file upload cannot erase a draft after switching conversations', async ({ page }) => {
  const first = { id: 'ss-delayed-upload-first', provider: 'codex', runtime: 'codex', title: 'First delayed thread', cwd: '/tmp/attachment-fixture', status: 'completed', model: 'fixture-model', updatedAt: '2026-10-26T10:00:00Z' };
  const second = { ...first, id: 'ss-delayed-upload-second', title: 'Second delayed thread', updatedAt: '2026-10-25T10:00:00Z' };
  await page.setViewportSize({ width: 320, height: 700 });
  await page.route(/\/api\/structured\/sessions(?:\?.*)?$/, route => route.fulfill({ json: [first, second] }));
  for (const session of [first, second]) {
    await page.route(`**/api/structured/sessions/${session.id}`, route => route.fulfill({ json: session }));
    await page.routeWebSocket(`**/api/structured/sessions/${session.id}/ws*`, socket => socket.send(JSON.stringify({ __terminal_meta: true, type: 'structured_event', event: { type: 'message_completed', role: 'assistant', content: 'Ready.', messageId: 'message', turnId: 'turn', seq: 1 } })));
  }
  let releaseUpload!: () => void;
  const uploadReleased = new Promise<void>(resolve => { releaseUpload = resolve; });
  await page.route('**/api/files/attachment', async route => {
    await uploadReleased;
    await route.fulfill({ json: { path: '/tmp/attachment-fixture/delayed.txt' } }).catch(() => {});
  });
  try {
    await page.goto('/');
    await page.getByLabel('Username', { exact: true }).fill(`delayed-${randomUUID()}`);
    await page.getByRole('button', { name: 'Open workspace', exact: true }).click();
    const composer = page.getByRole('textbox', { name: 'Command composer', exact: true });
    await expect(page.getByRole('button', { name: /Show full thread title: First delayed thread/ })).toBeVisible();
    await composer.fill('Keep this draft through a delayed upload.');
    const chooserPromise = page.waitForEvent('filechooser');
    await page.getByRole('button', { name: 'Attach file' }).click();
    const uploadStarted = page.waitForRequest('**/api/files/attachment');
    await (await chooserPromise).setFiles({ name: 'delayed.txt', mimeType: 'text/plain', buffer: Buffer.from('Fixture content') });
    await uploadStarted;
    await page.getByRole('button', { name: 'Menu', exact: true }).click();
    await page.getByRole('dialog', { name: 'Mobile menu' }).getByRole('button', { name: /Second delayed thread/ }).click();
    await expect(composer).toHaveValue('');
    const uploadFinished = page.waitForResponse('**/api/files/attachment');
    releaseUpload();
    await uploadFinished;
    await page.getByRole('button', { name: 'Menu', exact: true }).click();
    await page.getByRole('dialog', { name: 'Mobile menu' }).getByRole('button', { name: /First delayed thread/ }).click();
    await expect(composer).toHaveValue('Keep this draft through a delayed upload.');
    await expect(page.getByLabel('Composer attachments')).toHaveCount(0);
  } finally {
    releaseUpload();
  }
});

test('reopening a conversation warns if another tab changed its files while it was closed', async ({ page, context }) => {
  const first = { id: 'ss-cross-tab-file-first', provider: 'codex', runtime: 'codex', title: 'First file thread', cwd: '/tmp/attachment-fixture', status: 'completed', model: 'fixture-model', updatedAt: '2026-10-26T10:00:00Z' };
  const second = { ...first, id: 'ss-cross-tab-file-second', title: 'Second file thread', updatedAt: '2026-10-25T10:00:00Z' };
  await page.setViewportSize({ width: 393, height: 700 });
  await page.route(/\/api\/structured\/sessions(?:\?.*)?$/, route => route.fulfill({ json: [first, second] }));
  for (const session of [first, second]) {
    await page.route(`**/api/structured/sessions/${session.id}`, route => route.fulfill({ json: session }));
    await page.routeWebSocket(`**/api/structured/sessions/${session.id}/ws*`, socket => socket.send(JSON.stringify({ __terminal_meta: true, type: 'structured_event', event: { type: 'message_completed', role: 'assistant', content: 'Ready.', messageId: 'message', turnId: 'turn', seq: 1 } })));
  }
  await page.route('**/api/files/attachment', route => route.fulfill({ json: { path: '/tmp/attachment-fixture/first.txt' } }));
  await page.goto('/');
  await page.getByLabel('Username', { exact: true }).fill(`cross-tab-${randomUUID()}`);
  await page.getByRole('button', { name: 'Open workspace', exact: true }).click();
  await expect(page.getByRole('button', { name: /Show full thread title: First file thread/ })).toBeVisible();
  const composer = page.getByRole('textbox', { name: 'Command composer', exact: true });
  await composer.fill('Keep this draft.');
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Attach file' }).click();
  await (await chooser).setFiles({ name: 'first.txt', mimeType: 'text/plain', buffer: Buffer.from('Fixture content') });
  await expect(page.getByLabel('Composer attachments')).toContainText('first.txt');
  await page.getByRole('button', { name: 'Menu', exact: true }).click();
  await page.getByRole('dialog', { name: 'Mobile menu' }).getByRole('button', { name: /Second file thread/ }).click();
  await expect(composer).toHaveValue('');

  const other = await context.newPage();
  try {
    await other.route('**/fixture-storage-writer', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Storage fixture</title>' }));
    await other.goto('/fixture-storage-writer');
    await other.evaluate(sessionId => {
      const key = Object.keys(localStorage).find(value => value.includes('composerFiles:') && value.includes(sessionId));
      if (!key) throw new Error('Missing saved fixture selection');
      localStorage.setItem(key, JSON.stringify({ version: 1, sessionId, items: [{ name: 'other.txt', path: '/tmp/attachment-fixture/other.txt' }] }));
    }, first.id);
    await page.getByRole('button', { name: 'Menu', exact: true }).click();
    await page.getByRole('dialog', { name: 'Mobile menu' }).getByRole('button', { name: /First file thread/ }).click();
    await expect(page.getByRole('alert')).toContainText('changed in another tab');
    await expect(composer).toHaveValue('Keep this draft.');
    await expect(page.getByLabel('Composer attachments')).toContainText('first.txt');
    await expect(page.getByRole('button', { name: 'Send message' })).toBeDisabled();
  } finally {
    await other.close();
  }
});

test('a competing tab cannot send an outdated mobile attachment selection', async ({ page, context }) => {
  const session = { id: 'ss-competing-send', provider: 'codex', runtime: 'codex', title: 'Competing attachment thread', cwd: '/tmp/attachment-fixture', status: 'completed', model: 'fixture-model', updatedAt: '2026-10-26T10:00:00Z' };
  let sends = 0;
  await context.route(/\/api\/structured\/sessions(?:\?.*)?$/, route => route.fulfill({ json: [session] }));
  await context.route(`**/api/structured/sessions/${session.id}`, route => route.fulfill({ json: session }));
  await context.route(`**/api/structured/sessions/${session.id}/input`, route => {
    sends += 1;
    return route.fulfill({ json: { accepted: true } });
  });
  await context.route('**/api/files/attachment', route => {
    const body = route.request().postData() || '';
    return route.fulfill({ json: { path: body.includes('second.txt') ? '/tmp/attachment-fixture/second.txt' : '/tmp/attachment-fixture/first.txt' } });
  });
  const prepare = async (target: typeof page) => {
    await target.setViewportSize({ width: 320, height: 700 });
    await target.routeWebSocket(`**/api/structured/sessions/${session.id}/ws*`, socket => socket.send(JSON.stringify({ __terminal_meta: true, type: 'structured_event', event: { type: 'message_completed', role: 'assistant', content: 'Ready.', messageId: 'message', turnId: 'turn', seq: 1 } })));
  };
  await prepare(page);
  await page.addInitScript(() => {
    (window as any).blockFixtureStorageEvents = false;
    window.addEventListener('storage', event => {
      if ((window as any).blockFixtureStorageEvents && event.key?.includes('composerFiles:')) event.stopImmediatePropagation();
    }, true);
  });
  await page.goto('/');
  await page.getByLabel('Username', { exact: true }).fill(`competing-${randomUUID()}`);
  await page.getByRole('button', { name: 'Open workspace', exact: true }).click();
  await expect(page.getByRole('button', { name: /Show full thread title: Competing attachment thread/ })).toBeVisible();
  const composer = page.getByRole('textbox', { name: 'Command composer', exact: true });
  await composer.fill('Keep this message.');
  const firstChooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Attach file' }).click();
  await (await firstChooser).setFiles({ name: 'first.txt', mimeType: 'text/plain', buffer: Buffer.from('first') });
  await expect(page.getByLabel('Composer attachments')).toContainText('first.txt');
  await expect(page.getByRole('button', { name: 'Send message' })).toBeEnabled();

  const second = await context.newPage();
  try {
    await prepare(second);
    await second.addInitScript(() => {
      (window as any).fixtureTransactions = 0;
      const original = IDBDatabase.prototype.transaction;
      IDBDatabase.prototype.transaction = function (...args) {
        if (args[0] === 'lock') (window as any).fixtureTransactions += 1;
        return original.apply(this, args);
      };
    });
    await second.goto('/');
    await expect(second.getByRole('button', { name: /Show full thread title: Competing attachment thread/ })).toBeVisible();
    await expect(second.getByLabel('Composer attachments')).toContainText('first.txt');
    await page.evaluate(() => { (window as any).blockFixtureStorageEvents = true; });
    await page.evaluate(() => new Promise<void>((resolve, reject) => {
      const opening = indexedDB.open('terminal-v4-file-selection-lock', 1);
      opening.onupgradeneeded = () => opening.result.createObjectStore('lock');
      opening.onerror = () => reject(opening.error);
      opening.onsuccess = () => {
        const store = opening.result.transaction('lock', 'readwrite').objectStore('lock');
        (window as any).releaseFixtureLock = false;
        let announced = false;
        const keepAlive = () => {
          const request = store.get('selection');
          request.onsuccess = () => {
            if (!announced) { announced = true; resolve(); }
            if (!(window as any).releaseFixtureLock) keepAlive();
          };
        };
        keepAlive();
      };
    }));
    const previousTransactions = await second.evaluate(() => (window as any).fixtureTransactions);
    const secondChooser = second.waitForEvent('filechooser');
    await second.getByRole('button', { name: 'Attach file' }).click();
    await (await secondChooser).setFiles({ name: 'second.txt', mimeType: 'text/plain', buffer: Buffer.from('second') });
    await second.waitForFunction(previous => (window as any).fixtureTransactions > previous, previousTransactions);
    await page.getByRole('button', { name: 'Send message' }).click();
    await expect(page.getByRole('button', { name: 'Send message' })).toBeDisabled();
    await page.evaluate(() => { (window as any).releaseFixtureLock = true; });
    await expect(page.getByRole('alert')).toContainText('changed in another tab');
    await expect(composer).toHaveValue('Keep this message.');
    await expect(page.getByLabel('Composer attachments')).toContainText('first.txt');
    await expect(second.getByLabel('Composer attachments')).toContainText('second.txt');
    await page.getByRole('button', { name: 'Review saved files' }).click();
    await expect(page.getByRole('group', { name: 'Saved file selections' })).toContainText('/tmp/attachment-fixture/second.txt');
    expect(sends).toBe(0);
  } finally {
    await page.evaluate(() => { (window as any).releaseFixtureLock = true; }).catch(() => {});
    await second.close();
  }
});
