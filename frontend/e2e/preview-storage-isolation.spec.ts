import { test, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { loginIfNeeded, openDevToolsPanel, openPreviewPanel } from './test-helpers';

test('sandboxed preview reports unavailable storage without breaking its inspection script', async ({ page, request }) => {
  const fixture = createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/html' });
    response.end('<!doctype html><html><head><title>Storage isolation fixture</title></head><body><h1>Storage isolation fixture</h1><button onclick="this.textContent=\'Clicked\'">Click fixture</button></body></html>');
  });
  await new Promise<void>(resolve => fixture.listen(0, '127.0.0.1', resolve));
  const port = (fixture.address() as { port: number }).port;
  const errors: string[] = [];
  try {
    await page.addInitScript(() => {
      if (window.top !== window) return;
      (window as any).__storageSyncs = [];
      window.addEventListener('message', event => {
        if (event.data?.type === 'preview-storage-sync') (window as any).__storageSyncs.push(event.data);
      });
    });
    await loginIfNeeded(page, request);
    await openPreviewPanel(page);
    page.on('pageerror', error => errors.push(error.message));
    await page.getByLabel('Preview URL', { exact: true }).fill(`http://127.0.0.1:${port}`);
    await page.getByLabel('Preview URL', { exact: true }).press('Enter');
    const frame = page.frameLocator('.preview-iframe');
    await expect(frame.getByRole('heading', { name: 'Storage isolation fixture' })).toBeVisible({ timeout: 15000 });
    await expect.poll(() => page.evaluate(port => (window as any).__storageSyncs.some((message: any) => message.port === port && message.available?.localStorage === false && message.available?.sessionStorage === false), port)).toBe(true);
    await frame.getByRole('button', { name: 'Click fixture' }).click();
    await expect(frame.getByRole('button', { name: 'Clicked', exact: true })).toBeVisible();
    expect(errors).toEqual([]);
    await openDevToolsPanel(page);
    await page.locator('.devtools-tab', { hasText: 'Storage' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Browser storage is unavailable' })).toBeVisible();
    await expect(page.getByTitle('Add new item', { exact: true })).toBeDisabled();
  } finally {
    await new Promise<void>(resolve => { fixture.close(() => resolve()); fixture.closeAllConnections(); });
  }
});
