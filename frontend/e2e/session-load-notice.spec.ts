import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';

test.skip(process.env.E2E_LOCAL_TESTING !== '1', 'Requires an isolated local testing server.');
test.use({ launchOptions: { executablePath: process.env.E2E_LOCAL_BROWSER } });

for (const viewport of [{ width: 320, height: 568 }, { width: 390, height: 844 }, { width: 1440, height: 900 }]) {
  test(`session inventory failure can be retried at ${viewport.width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize(viewport);
    let failInventory = true;
    let requests = 0;
    await page.route(/\/api\/structured\/ownership(?:\?.*)?$/, route => route.fulfill({ status: 404, json: { error: 'Ownership guard unavailable' } }));
    const ownershipUnavailable = page.waitForResponse(response => /\/api\/structured\/ownership(?:\?.*)?$/.test(response.url()) && response.status() === 404);
    await page.route(/\/api\/structured\/sessions(?:\?.*)?$/, async route => {
      if (route.request().method() !== 'GET') return route.continue();
      requests += 1;
      await route.fulfill(failInventory
        ? { status: 503, json: { error: 'Synthetic session inventory failure' } }
        : { status: 200, json: [] });
    });
    await page.goto('/');
    await page.getByLabel('Username', { exact: true }).fill(`inventory-${randomUUID()}`);
    await page.getByRole('button', { name: 'Open workspace', exact: true }).click();
    const notice = page.getByRole('region', { name: 'Session loading problem' });
    await expect(notice.getByRole('alert')).toHaveText('Could not load your sessions.');
    await ownershipUnavailable;
    await expect(notice.getByRole('checkbox')).toHaveCount(0);
    await expect(notice.getByText(/another server is using your sessions/i)).toHaveCount(0);
    const projectLabel = page.getByRole('button', { name: 'Project', exact: true }).locator(':scope > span');
    await expect(projectLabel).toBeVisible();
    expect(await projectLabel.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    if (viewport.width <= 440) {
      const model = page.locator('.workspace-start-model .model-settings-trigger');
      await expect(model).toBeVisible();
      // Chromium can report a 44px CSS box a few thousandths smaller after transforms.
      expect((await model.boundingBox())!.height).toBeGreaterThanOrEqual(43.99);
      expect((await model.locator(':scope > span:nth-child(2)').boundingBox())!.width).toBeGreaterThanOrEqual(48);
      await model.click();
      const settings = page.getByRole('dialog', { name: /choose .* model/i });
      await expect(settings).toBeVisible();
      await settings.getByRole('button', { name: 'Close model settings' }).click();
    }
    const retry = notice.getByRole('button', { name: 'Retry loading sessions' });
    await expect(retry).toBeVisible();
    const button = await retry.boundingBox();
    expect(button!.height).toBeGreaterThanOrEqual(44);
    expect(button!.width).toBeGreaterThanOrEqual(44);
    const box = await notice.boundingBox();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath('session-load-error.png'), animations: 'disabled' });
    if (viewport.width <= 768) {
      await page.getByRole('button', { name: 'Menu', exact: true }).click();
      const drawer = page.getByRole('dialog', { name: 'Mobile menu' });
      await expect(drawer.getByText('Load failed')).toBeVisible();
      const status = drawer.getByText('Thread list may be incomplete');
      await expect(status).toBeVisible();
      await status.scrollIntoViewIfNeeded();
      await expect.poll(() => status.evaluate(element => {
        const rect = element.getBoundingClientRect();
        const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
        return hit === element || element.contains(hit);
      })).toBe(true);
      const layers = await page.evaluate(() => ({
        notice: Number(getComputedStyle(document.querySelector('.session-load-notice')!).zIndex),
        drawer: Number(getComputedStyle(document.querySelector('.mobile-drawer-modern')!).zIndex),
      }));
      expect(layers.notice).toBeLessThan(layers.drawer);
      await expect(drawer.getByText('No active threads')).toHaveCount(0);
      await page.screenshot({ path: testInfo.outputPath('session-load-drawer.png'), animations: 'disabled' });
      await drawer.getByRole('button', { name: 'Close menu' }).click();
    } else {
      const sidebar = page.getByRole('complementary', { name: 'Threads' });
      await expect(sidebar.getByText('Thread list may be incomplete')).toBeVisible();
      await expect(sidebar.getByText('No threads yet')).toHaveCount(0);
    }
    const previous = requests;
    failInventory = false;
    const recovered = page.waitForResponse(response => /\/api\/structured\/sessions(?:\?.*)?$/.test(response.url())
      && response.request().method() === 'GET' && response.status() === 200);
    await retry.click();
    await recovered;
    await expect.poll(() => requests).toBeGreaterThan(previous);
    await expect(notice).toHaveCount(0);
    if (viewport.width <= 768) {
      await page.getByRole('button', { name: 'Menu', exact: true }).click();
      const drawer = page.getByRole('dialog', { name: 'Mobile menu' });
      await expect(drawer.getByText('Thread list may be incomplete')).toHaveCount(0);
      await expect(drawer.getByText('No active threads')).toBeVisible();
    } else {
      const sidebar = page.getByRole('complementary', { name: 'Threads' });
      await expect(sidebar.getByText('Thread list may be incomplete')).toHaveCount(0);
      await expect(sidebar.getByText('No threads yet')).toBeVisible();
    }
  });
}

for (const viewport of [{ width: 320, height: 568 }, { width: 320, height: 360 }]) {
  test(`ownership review stays usable at ${viewport.width}x${viewport.height}`, async ({ page }, testInfo) => {
    await page.setViewportSize(viewport);
    let failInventory = true;
    let reconciliation: unknown;
    const epoch = randomUUID();
    await page.route(/\/api\/structured\/sessions(?:\?.*)?$/, async route => {
      if (route.request().method() !== 'GET') return route.continue();
      await route.fulfill(failInventory ? { status: 503, json: { error: 'Synthetic ownership hold' } } : { status: 200, json: [] });
    });
    await page.route(/\/api\/structured\/ownership(?:\?.*)?$/, route => route.fulfill({ json: { state: 'unconfirmed', epoch } }));
    await page.route('**/api/structured/ownership/reconcile', async route => {
      reconciliation = route.request().postDataJSON();
      failInventory = false;
      await route.fulfill({ status: 200, json: { state: 'clean' } });
    });
    await page.goto('/');
    await page.getByLabel('Username', { exact: true }).fill(`review-${randomUUID()}`);
    await page.getByRole('button', { name: 'Open workspace', exact: true }).click();
    const notice = page.getByRole('region', { name: 'Session loading problem' });
    await expect(notice.getByText(/previous server stopped without confirming cleanup/i)).toBeVisible();
    const box = await notice.boundingBox();
    expect(box!.y).toBeGreaterThanOrEqual(0);
    expect(box!.y + box!.height).toBeLessThanOrEqual(viewport.height);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    if (viewport.height === 360) expect(await notice.evaluate(element => element.scrollHeight > element.clientHeight)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath('ownership-before-scroll.png'), animations: 'disabled' });
    if (viewport.height === 360) {
      const touch = await page.context().newCDPSession(page);
      await touch.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 });
      expect(await notice.evaluate(element => element.contains(document.elementFromPoint(280, 310)))).toBe(true);
      await touch.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 280, y: 310 }] });
      for (const y of [290, 260, 230, 200, 170, 140, 125]) {
        await page.waitForTimeout(30);
        await touch.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: 280, y }] });
      }
      await touch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await expect.poll(() => notice.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
      await touch.detach();
    }
    const checkbox = notice.getByRole('checkbox', { name: 'I have checked that the previous processes have stopped.' });
    const proceed = notice.getByRole('button', { name: 'Continue after review' });
    await expect(proceed).toBeDisabled();
    await checkbox.scrollIntoViewIfNeeded();
    await checkbox.check();
    const checkboxBox = await checkbox.boundingBox();
    expect(checkboxBox!.y).toBeGreaterThanOrEqual(0);
    expect(checkboxBox!.y + checkboxBox!.height).toBeLessThanOrEqual(viewport.height);
    await expect(proceed).toBeEnabled();
    await proceed.scrollIntoViewIfNeeded();
    const button = await proceed.boundingBox();
    expect(button!.height).toBeGreaterThanOrEqual(44);
    expect(button!.width).toBeGreaterThanOrEqual(44);
    expect(button!.y).toBeGreaterThanOrEqual(0);
    expect(button!.y + button!.height).toBeLessThanOrEqual(viewport.height);
    for (const name of ['Check ownership again', 'Retry loading sessions']) {
      const action = notice.getByRole('button', { name });
      await action.scrollIntoViewIfNeeded();
      await expect(action).toBeVisible();
      const bounds = await action.boundingBox();
      expect(bounds!.height).toBeGreaterThanOrEqual(44);
      expect(bounds!.y).toBeGreaterThanOrEqual(0);
      expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(viewport.height);
    }
    await proceed.scrollIntoViewIfNeeded();
    if (viewport.height === 360) expect(await notice.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
    await page.screenshot({ path: testInfo.outputPath('ownership-actions.png'), animations: 'disabled' });
    await proceed.click();
    await expect(notice).toHaveCount(0);
    expect(reconciliation).toMatchObject({ epoch, acknowledged: true });
    expect((reconciliation as { operationId?: string }).operationId).toMatch(/^[0-9a-f-]{36}$/);
  });
}
