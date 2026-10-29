import { test, expect } from '@playwright/test';

test.skip(process.env.E2E_LOCAL_TESTING !== '1', 'Requires an isolated username-only local testing server with synthetic data.');
test.use({ launchOptions: { executablePath: process.env.E2E_LOCAL_BROWSER } });

test('notes, bookmark edits, vault and resources preserve their real API contracts', async ({ page, context }, testInfo) => {
  test.setTimeout(90000);
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

  await page.getByRole('button', { name: 'Notes', exact: true }).click();
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

  await page.getByRole('button', { name: 'Bookmarks', exact: true }).click();
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
