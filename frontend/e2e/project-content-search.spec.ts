import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, test } from '@playwright/test';

test.skip(process.env.E2E_LOCAL_TESTING !== '1', 'Requires an isolated local testing server.');
test.skip(process.platform === 'win32', 'Content search is not yet available on non-Unix hosts.');
test.use({ launchOptions: { executablePath: process.env.E2E_LOCAL_BROWSER } });

for (const viewport of [{ width: 320, height: 640 }, { width: 1280, height: 800 }]) {
  test(`searches only the owned project at ${viewport.width}px`, async ({ page }, testInfo) => {
    test.setTimeout(45_000);
    page.setDefaultTimeout(8_000);
    await page.setViewportSize(viewport);
    const fixtureRoot = process.env.E2E_SEARCH_ROOT;
    if (!fixtureRoot) throw new Error('Set E2E_SEARCH_ROOT to an isolated, allowed directory.');
    await mkdir(fixtureRoot, { recursive: true });
    const workspace = await mkdtemp(path.join(fixtureRoot, 'v4-content-search-'));
    await mkdir(path.join(workspace, 'src'));
    await writeFile(path.join(workspace, 'src', 'example.txt'), 'First line\nunique-search-needle\n');
    let sessionId = '';
    let accessToken = '';
    try {
      await page.goto('/');
      await page.getByLabel('Username', { exact: true }).fill(`cs-${randomUUID()}`);
      await page.getByRole('button', { name: 'Open workspace', exact: true }).click();
      await expect(page.getByRole('region', { name: 'Workspace start' })).toBeVisible();
      accessToken = await page.evaluate(() => localStorage.getItem('terminal_access_token') || '');
      const response = await page.request.post('/api/terminal', {
        headers: { Authorization: `Bearer ${accessToken}` }, data: { cwd: workspace, title: 'Search fixture' },
      });
      expect(response.ok(), `Could not create isolated terminal: ${response.status()}`).toBe(true);
      sessionId = (await response.json()).session.id;
      await page.reload();
      await page.getByRole('button', { name: viewport.width <= 768 ? 'Files' : 'Open project in Files', exact: true }).click();
      const files = page.getByRole('region', { name: 'Files', exact: true });
      await files.getByRole('button', { name: 'Search project contents', exact: true }).click();
      await files.getByRole('searchbox', { name: 'Search project contents', exact: true }).fill('unique-search-needle');
      await files.getByRole('button', { name: 'Search project', exact: true }).click();
      const result = files.getByRole('button', { name: /src\/example\.txt:2.*unique-search-needle/ });
      await expect(result).toBeVisible();
      await expect.poll(() => result.evaluate(node => {
        const panel = node.closest('.file-manager-content-search')!.getBoundingClientRect();
        const bounds = node.getBoundingClientRect();
        return bounds.top >= panel.top && bounds.bottom <= panel.bottom;
      })).toBe(true);
      await expect(files).toBeInViewport({ ratio: 1 });
      await page.screenshot({ path: testInfo.outputPath('project-content-search.png') });
      await result.click();
      const selected = files.getByRole('region', { name: 'Selected search result' });
      await expect(selected).toBeFocused();
      await expect(selected).toContainText('src/example.txt:2');
      await expect(selected).toContainText('unique-search-needle');
      await expect(selected).toContainText('File may have changed since search.');
      await expect(files.getByText('example.txt', { exact: true })).toBeVisible();
      const back = selected.getByRole('button', { name: 'Back to search results' });
      await expect(back).toBeInViewport({ ratio: 1 });
      expect(await back.evaluate(node => {
        const panel = node.closest('.file-manager-selected-result')!.getBoundingClientRect();
        const bounds = node.getBoundingClientRect();
        return bounds.top >= panel.top && bounds.bottom <= panel.bottom;
      })).toBe(true);
      await page.screenshot({ path: testInfo.outputPath('project-selected-result.png') });
      if (viewport.width === 320) {
        await page.setViewportSize({ width: 320, height: 400 });
        await expect(back).toBeInViewport({ ratio: 1 });
        await expect(selected.getByText('File may have changed since search.')).toBeInViewport({ ratio: 1 });
        expect(await back.evaluate(node => {
          const panel = node.closest('.file-manager-selected-result')!.getBoundingClientRect();
          const bounds = node.getBoundingClientRect();
          return bounds.top >= panel.top && bounds.bottom <= panel.bottom;
        })).toBe(true);
        await page.screenshot({ path: testInfo.outputPath('project-selected-result-short.png') });
        await page.setViewportSize(viewport);
      }
      await selected.getByRole('button', { name: 'Open current file at line', exact: true }).click();
      const preview = selected.getByRole('region', { name: 'Current file preview', exact: true });
      await expect(preview).toContainText('First line');
      await expect(preview.locator('[aria-current="true"]')).toContainText('unique-search-needle');
      await page.screenshot({ path: testInfo.outputPath('project-line-preview.png') });
      if (viewport.width === 320) {
        await page.setViewportSize({ width: 320, height: 400 });
        await expect(back).toBeInViewport({ ratio: 1 });
        await expect(preview.locator('[aria-current="true"]')).toBeInViewport({ ratio: 0.95 });
        await page.screenshot({ path: testInfo.outputPath('project-line-preview-short.png') });
        await page.setViewportSize(viewport);
      }
      await back.click();
      await expect(result).toBeFocused();
    } finally {
      if (sessionId && accessToken) await page.request.delete(`/api/terminal/${sessionId}`, { headers: { Authorization: `Bearer ${accessToken}` }, timeout: 5000 });
      await rm(workspace, { recursive: true, force: true });
    }
  });
}
