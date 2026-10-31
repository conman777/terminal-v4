import { test, expect } from '@playwright/test';

test.skip(process.env.E2E_LOCAL_TESTING !== '1', 'Requires an isolated username-only local testing server with synthetic data.');
test.use({ launchOptions: { executablePath: process.env.E2E_LOCAL_BROWSER } });

test('notes, bookmark edits, vault and resources preserve their real API contracts', async ({ page, context }, testInfo) => {
  test.setTimeout(90000);
  page.setDefaultTimeout(10000);
  const pageErrors: string[] = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
  await page.getByLabel('Username', { exact: true }).fill(`feature-regressions-${Date.now()}`);
  await page.getByRole('button', { name: 'Open workspace', exact: true }).click();
  await expect(page.getByRole('button', { name: 'New thread', exact: true })).toBeVisible();

  const screenshot = async (name: string) => {
    await page.screenshot({ path: testInfo.outputPath(`${name}.png`), fullPage: true, animations: 'disabled' });
    await testInfo.attach(name, { path: testInfo.outputPath(`${name}.png`), contentType: 'image/png' });
  };
  const apiGet = (path: string) => page.evaluate(async path => {
    const response = await fetch(path, { headers: { Authorization: `Bearer ${localStorage.getItem('terminal_access_token')}` } });
    if (!response.ok) throw new Error(`Fixture read failed: ${response.status}`);
    return response.json();
  }, path);

  await page.getByRole('button', { name: 'Workspace apps', exact: true }).click();
  await page.getByRole('menu', { name: 'Workspace apps', exact: true }).getByRole('menuitem', { name: 'Notes', exact: true }).click();
  const notes = page.locator('.notes-v2');
  const createNote = async (title: string, content: string) => {
    await notes.getByTitle('New note (⌘N)').click();
    await notes.getByPlaceholder('Untitled', { exact: true }).fill(title);
    await notes.getByPlaceholder('Write something... (Markdown supported)').fill(content);
    await notes.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(notes.locator('.notes-v2-item-title', { hasText: title })).toBeVisible();
  };
  await createNote('Alpha note', 'Alpha original');
  await createNote('Beta note', 'Beta original');
  await notes.locator('.notes-v2-item').filter({ hasText: 'Alpha note' }).click();
  await notes.getByPlaceholder('Write something... (Markdown supported)').fill('Alpha saved before switching');
  await notes.locator('.notes-v2-item').filter({ hasText: 'Beta note' }).click();
  await expect(notes.getByPlaceholder('Untitled', { exact: true })).toHaveValue('Beta note');
  await notes.locator('.notes-v2-item').filter({ hasText: 'Alpha note' }).click();
  await expect(notes.getByPlaceholder('Write something... (Markdown supported)')).toHaveValue('Alpha saved before switching');
  const storedNotes = await apiGet('/api/notes');
  expect(storedNotes.notes.find((note: {title: string}) => note.title === 'Alpha note').content).toBe('Alpha saved before switching');
  await screenshot('notes-switched-with-pending-autosave');

  await page.route('**/api/notes/*', route => route.request().method() === 'PUT'
    ? route.fulfill({ status: 500, json: { error: 'Synthetic note save failure' } }) : route.continue());
  await notes.getByPlaceholder('Write something... (Markdown supported)').fill('Alpha retained after failed save');
  await expect(notes.getByRole('alert')).toContainText('Could not save note');
  await expect(notes.getByPlaceholder('Write something... (Markdown supported)')).toHaveValue('Alpha retained after failed save');
  await expect(notes.locator('.notes-v2-save-status')).not.toHaveText('Saved');
  await screenshot('notes-failure-retains-edits');
  await page.unroute('**/api/notes/*');
  await notes.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(notes.locator('.notes-v2-save-status')).toHaveText('Saved');

  await notes.getByTitle('New note (⌘N)').click();
  await notes.getByPlaceholder('Untitled', { exact: true }).fill('Creation retained');
  await notes.getByPlaceholder('Write something... (Markdown supported)').fill('Unsaved synthetic creation');
  await page.route('**/api/notes', route => route.request().method() === 'POST'
    ? route.fulfill({ status: 500, json: { error: 'Synthetic note create failure' } }) : route.continue());
  await notes.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(notes.getByRole('alert')).toContainText('Could not save note');
  await expect(notes.getByPlaceholder('Untitled', { exact: true })).toHaveValue('Creation retained');
  await expect(notes.getByPlaceholder('Write something... (Markdown supported)')).toHaveValue('Unsaved synthetic creation');
  await screenshot('notes-failed-create-retains-draft');
  await page.unroute('**/api/notes');
  await notes.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(notes.locator('.notes-v2-item-title', { hasText: 'Creation retained' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(notes).toHaveCount(0);

  await page.getByRole('button', { name: 'Workspace apps', exact: true }).click();
  await page.getByRole('menu', { name: 'Workspace apps', exact: true }).getByRole('menuitem', { name: 'Bookmarks', exact: true }).click();
  const bookmarks = page.locator('.bookmark-modal');
  const createBookmark = async (name: string, command: string) => {
    await bookmarks.getByTitle('Add bookmark').click();
    await bookmarks.getByLabel('Name', { exact: true }).fill(name);
    await bookmarks.getByLabel('Command', { exact: true }).fill(command);
    await bookmarks.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(bookmarks.locator('.bookmark-name', { hasText: name })).toBeVisible();
  };
  await createBookmark('Alpha bookmark', 'echo alpha-fixture');
  await createBookmark('Beta bookmark', 'echo beta-fixture');
  await bookmarks.locator('.bookmark-item').filter({ hasText: 'Alpha bookmark' }).getByRole('button', { name: 'Edit bookmark', exact: true }).click();
  await expect(bookmarks.getByLabel('Name', { exact: true })).toHaveValue('Alpha bookmark');
  await bookmarks.locator('.bookmark-item').filter({ hasText: 'Beta bookmark' }).getByRole('button', { name: 'Edit bookmark', exact: true }).click();
  await expect(bookmarks.getByLabel('Name', { exact: true })).toHaveValue('Beta bookmark');
  await expect(bookmarks.getByLabel('Command', { exact: true })).toHaveValue('echo beta-fixture');
  await bookmarks.getByLabel('Command', { exact: true }).fill('echo beta-updated-fixture');
  await bookmarks.getByRole('button', { name: 'Update', exact: true }).click();
  await expect(bookmarks.locator('.bookmark-item').filter({ hasText: 'Beta bookmark' })).toContainText('echo beta-updated-fixture');
  const storedBookmarks = await apiGet('/api/bookmarks');
  expect(storedBookmarks.bookmarks.filter(({ name }: {name:string}) => name === 'Alpha bookmark' || name === 'Beta bookmark').map(({ name, command }: {name: string, command: string}) => ({ name, command })).sort((a: {name:string}, b: {name:string}) => a.name.localeCompare(b.name))).toEqual([
    { name: 'Alpha bookmark', command: 'echo alpha-fixture' },
    { name: 'Beta bookmark', command: 'echo beta-updated-fixture' }
  ]);
  await screenshot('bookmark-alpha-beta-edit');
  await bookmarks.getByRole('button', { name: 'Close', exact: true }).click();

  await page.locator('.pro-sidebar').getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('button', { name: 'Voice', exact: true }).click();
  await page.getByRole('button', { name: 'Open API Settings', exact: true }).click();
  const apiSettings = page.locator('.api-settings-modal');
  await apiSettings.getByRole('button', { name: '+ Add Key', exact: true }).click();
  await apiSettings.getByPlaceholder('Key name (e.g. Anthropic)').fill('Browser synthetic key');
  const secret = 'synthetic-browser-secret-9876';
  await apiSettings.getByPlaceholder('Key value', { exact: true }).fill(secret);
  await apiSettings.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(apiSettings.getByText('Key added to vault', { exact: true })).toBeVisible();
  await expect(apiSettings.getByText('Browser synthetic key', { exact: true })).toBeVisible();
  await expect(apiSettings.getByText('****9876', { exact: true })).toBeVisible();
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await apiSettings.getByRole('button', { name: 'Copy', exact: true }).click();
  await expect(apiSettings.getByRole('button', { name: 'Copied!', exact: true })).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(secret);
  await screenshot('vault-created-listed-copied');
  await apiSettings.getByRole('button', { name: 'Close', exact: true }).last().click();

  // The resources entry point is checked through normal navigation, never React internals.
  await page.locator('.pro-sidebar').getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('button', { name: 'Processes', exact: true }).click();
  await page.getByRole('button', { name: 'Open System Resources', exact: true }).click();
  const resources = page.locator('.system-resources-view');
  await expect(resources.getByRole('heading', { name: 'System Resources', exact: true })).toBeVisible();
  await expect(resources.locator('.sr-stat-value').first()).not.toHaveText('—');
  await expect(resources).not.toContainText('NaN');
  for (const percentage of await resources.locator('.sr-circular-value').allTextContents()) {
    expect(percentage).toMatch(/^\d{1,3}%$/);
  }
  await screenshot('resources-real-stats');
  await resources.getByRole('button', { name: 'Back to workspace', exact: true }).click();
  await expect(resources).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'What should we build?', exact: true })).toBeVisible();
  expect(pageErrors).toEqual([]);
});

test('phone can open and leave the resources dashboard through Settings', async ({ page }, testInfo) => {
  const pageErrors: string[] = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
  await page.getByLabel('Username', { exact: true }).fill(`feature-phone-${Date.now()}`);
  await page.getByRole('button', { name: 'Open workspace', exact: true }).click();
  await page.getByRole('button', { name: 'Menu', exact: true }).click();
  await page.getByRole('dialog', { name: 'Mobile menu', exact: true }).getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('button', { name: 'Processes', exact: true }).click();
  await page.getByRole('button', { name: 'Open System Resources', exact: true }).click();
  const resources = page.locator('.system-resources-view');
  await expect(resources.getByRole('heading', { name: 'System Resources', exact: true })).toBeVisible();
  await expect(resources.locator('.sr-stat-value').first()).not.toHaveText('—');
  expect(await resources.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('resources-phone.png'), fullPage: true, animations: 'disabled' });
  await resources.getByRole('button', { name: 'Back to workspace', exact: true }).click();
  await expect(resources).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'What should we build?', exact: true })).toBeVisible();
  expect(pageErrors).toEqual([]);
});

for (const width of [320, 390]) {
  test(`phone note save errors remain readable and usable at ${width}px`, async ({ page }, testInfo) => {
    page.setDefaultTimeout(10000);
    await page.setViewportSize({ width, height: 844 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto('/');
    await page.getByLabel('Username', { exact: true }).fill(`notes-phone-${width}-${Date.now()}`);
    await page.getByRole('button', { name: 'Open workspace', exact: true }).click();
    await page.getByRole('button', { name: 'Menu', exact: true }).click();
    await page.getByRole('dialog', { name: 'Mobile menu', exact: true }).getByRole('button', { name: 'Notes', exact: true }).click();
    const notes = page.getByRole('dialog', { name: 'Notes' });
    await notes.getByRole('button', { name: 'New note', exact: true }).click();
    await notes.getByPlaceholder('Untitled').fill('Phone note');
    await notes.getByPlaceholder('Write something... (Markdown supported)').fill('Saved text');
    await notes.getByRole('button', { name: 'Save', exact: true }).click();
    await notes.getByRole('button', { name: /Phone note/ }).click();
    await page.route('**/api/notes/*', route => route.request().method() === 'PUT'
      ? route.fulfill({ status: 500, json: { error: 'Synthetic note save failure' } }) : route.continue());
    await notes.getByPlaceholder('Write something... (Markdown supported)').fill('Retained phone draft');
    await expect(notes.getByRole('alert')).toContainText('may have completed');
    const retry = notes.getByRole('button', { name: 'Retry', exact: true });
    const box = await retry.boundingBox();
    const textBottom = await notes.getByRole('alert').evaluate(node => {
      const range = document.createRange();
      range.selectNodeContents(node.firstChild!);
      return range.getBoundingClientRect().bottom;
    });
    expect(box?.height).toBeGreaterThanOrEqual(44);
    expect(box!.y).toBeGreaterThanOrEqual(textBottom + 6);
    expect(await notes.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`notes-error-${width}.png`), fullPage: true, animations: 'disabled' });
  });
}

test('phone holds an ambiguous note draft until the account collision is resolved', async ({ page }) => {
  test.skip(process.env.E2E_OWNER_COLLISION_FIXTURE !== '1' || !process.env.E2E_LOCAL_DATA_DIR, 'Requires an explicitly marked disposable test database.');
  page.setDefaultTimeout(10000);
  const { readFile } = await import('node:fs/promises');
  const path = await import('node:path');
  const dataDir = process.env.E2E_LOCAL_DATA_DIR!;
  expect(await readFile(path.join(dataDir, '.synthetic-owner-fixture'), 'utf8')).toBe('synthetic owner collision fixture');
  const { DatabaseSync } = await import('node:sqlite');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await page.getByLabel('Username', { exact: true }).fill(`notes-collision-${Date.now()}`);
  await page.getByRole('button', { name: 'Open workspace', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Menu', exact: true })).toBeVisible();
  const owner = await page.evaluate(() => JSON.parse(localStorage.getItem('terminal_user') || '{}').id as string);
  expect(owner).toMatch(/^local-testing-/);
  await page.getByRole('button', { name: 'Menu', exact: true }).click();
  await page.getByRole('dialog', { name: 'Mobile menu', exact: true }).getByRole('button', { name: 'Notes', exact: true }).click();
  const notes = page.getByRole('dialog', { name: 'Notes' });
  await expect(notes.getByText(/No notes yet|Could not load notes/)).toBeVisible();
  if (await notes.getByRole('button', { name: 'Retry loading notes', exact: true }).isVisible()) {
    await notes.getByRole('button', { name: 'Retry loading notes', exact: true }).click();
  }
  await expect(notes.getByText('No notes yet', { exact: true })).toBeVisible();
  await notes.getByRole('button', { name: 'New note', exact: true }).click();
  await notes.getByPlaceholder('Untitled').fill('Private draft');
  await notes.getByPlaceholder('Write something... (Markdown supported)').fill('Keep this content');
  const alias = `${owner}_`;
  const db = new DatabaseSync(path.join(dataDir, 'terminal.db'));
  db.exec('PRAGMA busy_timeout=2000');
  try {
    db.prepare('INSERT INTO users(id,username,password_hash,created_at,updated_at) VALUES(?,?,?,?,?)').run(alias, `collision-${Date.now()}`, 'synthetic', '2026', '2026');
    const rejected = page.waitForResponse(response => response.url().endsWith('/api/notes') && response.request().method() === 'POST');
    await notes.getByRole('button', { name: 'Save', exact: true }).click();
    expect((await rejected).status()).toBe(409);
    await expect(notes.getByRole('alert')).toContainText('Administrator review is required');
    await expect(notes.getByPlaceholder('Write something... (Markdown supported)')).toHaveCount(0);
    db.prepare('DELETE FROM users WHERE id=?').run(alias);
    await notes.getByRole('button', { name: 'Retry loading notes', exact: true }).click();
    await expect(notes.getByPlaceholder('Write something... (Markdown supported)')).toHaveValue('Keep this content');
    await notes.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(notes.getByRole('button', { name: /Private draft/ })).toBeVisible();
  } finally {
    db.close();
  }
});

test('phone holds an ambiguous bookmark draft until the account collision is resolved', async ({ page }, testInfo) => {
  test.skip(process.env.E2E_OWNER_COLLISION_FIXTURE !== '1' || !process.env.E2E_LOCAL_DATA_DIR, 'Requires an explicitly marked disposable test database.');
  page.setDefaultTimeout(10000);
  const { readFile } = await import('node:fs/promises');
  const path = await import('node:path');
  const dataDir = process.env.E2E_LOCAL_DATA_DIR!;
  expect(await readFile(path.join(dataDir, '.synthetic-owner-fixture'), 'utf8')).toBe('synthetic owner collision fixture');
  const { DatabaseSync } = await import('node:sqlite');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await page.getByLabel('Username', { exact: true }).fill(`bookmark-collision-${Date.now()}`);
  await page.getByRole('button', { name: 'Open workspace', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Menu', exact: true })).toBeVisible();
  const owner = await page.evaluate(() => JSON.parse(localStorage.getItem('terminal_user') || '{}').id as string);
  expect(owner).toMatch(/^local-testing-/);
  await page.getByRole('button', { name: 'Menu', exact: true }).click();
  await page.getByRole('dialog', { name: 'Mobile menu', exact: true }).getByRole('button', { name: 'Bookmarks', exact: true }).click();
  const bookmarks = page.getByRole('dialog', { name: 'Bookmarks' });
  await expect(bookmarks.getByText(/All Bookmarks|Could not load bookmarks/).first()).toBeVisible();
  if (await bookmarks.getByRole('button', { name: 'Retry loading bookmarks', exact: true }).isVisible()) {
    await bookmarks.getByRole('button', { name: 'Retry loading bookmarks', exact: true }).click();
  }
  await bookmarks.getByTitle('Add bookmark').click();
  await bookmarks.getByLabel('Name', { exact: true }).fill('Private bookmark draft');
  await bookmarks.getByLabel('Command', { exact: true }).fill('echo retained');
  const alias = `${owner}_`;
  const db = new DatabaseSync(path.join(dataDir, 'terminal.db'));
  db.exec('PRAGMA busy_timeout=2000');
  try {
    db.prepare('INSERT INTO users(id,username,password_hash,created_at,updated_at) VALUES(?,?,?,?,?)').run(alias, `bookmark-collision-${Date.now()}`, 'synthetic', '2026', '2026');
    const rejected = page.waitForResponse(response => response.url().endsWith('/api/bookmarks') && response.request().method() === 'POST');
    await bookmarks.getByRole('button', { name: 'Save', exact: true }).click();
    expect((await rejected).status()).toBe(409);
    await expect(bookmarks.getByRole('alert')).toContainText('Administrator review is required');
    await expect(bookmarks.getByLabel('Name', { exact: true })).toHaveCount(0);
    for (const width of [320, 390]) {
      await page.setViewportSize({ width, height: 844 });
      const retry = await bookmarks.getByRole('button', { name: 'Retry loading bookmarks', exact: true }).boundingBox();
      const close = await bookmarks.getByRole('button', { name: 'Close', exact: true }).boundingBox();
      expect(retry!.height).toBeGreaterThanOrEqual(44);
      expect(close!.height).toBeGreaterThanOrEqual(44);
      expect(close!.width).toBeGreaterThanOrEqual(44);
      expect(await bookmarks.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
      await page.screenshot({ path: testInfo.outputPath(`bookmark-ownership-hold-${width}.png`), animations: 'disabled' });
    }
    db.prepare('DELETE FROM users WHERE id=?').run(alias);
    await bookmarks.getByRole('button', { name: 'Retry loading bookmarks', exact: true }).click();
    await expect(bookmarks.getByLabel('Name', { exact: true })).toHaveValue('Private bookmark draft');
    await expect(bookmarks.getByLabel('Command', { exact: true })).toHaveValue('echo retained');
    await page.route('**/api/bookmarks', route => route.request().method() === 'POST'
      ? route.fulfill({ status: 500, json: { error: 'Synthetic unconfirmed save' } }) : route.continue());
    await bookmarks.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(bookmarks.getByRole('alert')).toContainText('may have completed');
    await expect(bookmarks.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
    await bookmarks.getByRole('button', { name: 'Close', exact: true }).click();
    await page.getByRole('button', { name: 'Menu', exact: true }).click();
    await page.getByRole('dialog', { name: 'Mobile menu', exact: true }).getByRole('button', { name: 'Bookmarks', exact: true }).click();
    await expect(bookmarks.getByLabel('Name', { exact: true })).toHaveValue('Private bookmark draft');
    await expect(bookmarks.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
    await page.unroute('**/api/bookmarks');
    await bookmarks.getByRole('button', { name: 'I checked; enable retry', exact: true }).click();
    await bookmarks.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(bookmarks.getByText('Private bookmark draft')).toBeVisible();
  } finally {
    db.close();
  }
});
