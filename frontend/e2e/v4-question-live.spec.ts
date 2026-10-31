import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmdirSync } from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';

test.skip(process.env.E2E_LIVE_QUESTION !== '1', 'Requires an isolated API with the synthetic question provider.');
test.use({ launchOptions: { executablePath: process.env.E2E_LOCAL_BROWSER } });

for (const viewport of [{ width: 320, height: 640 }, { width: 1280, height: 800 }]) {
  test.describe(`${viewport.width}px live multi-select`, () => {
    test.use({ viewport, isMobile: viewport.width < 768, hasTouch: viewport.width < 768 });
    test('sends the complete answer through the owned session to the synthetic provider', async ({ page, request }, testInfo) => {
      test.setTimeout(60_000);
      const app = new URL(String(test.info().project.use.baseURL));
      expect(app.protocol).toBe('http:');
      expect(['127.0.0.1', 'localhost']).toContain(app.hostname);
      expect(await (await request.get('/api/auth/mode')).json()).toEqual({ mode: 'local-testing' });
      const root = process.env.E2E_QUESTION_ROOT;
      if (!root || !path.isAbsolute(root)) throw new Error('An isolated fixture root is required');
      const workspace = mkdtempSync(path.join(root, 'workspace-'));
      const title = `Multi question ${randomUUID()}`;
      let headers: { Authorization: string } | undefined;
      let sessionId: string | undefined;
      try {
        await page.goto('/');
        await page.getByLabel('Username', { exact: true }).fill(`mq-${randomUUID()}`);
        await page.getByRole('button', { name: 'Open workspace', exact: true }).click();
        await page.waitForFunction(() => Boolean(localStorage.getItem('terminal_access_token')));
        headers = { Authorization: `Bearer ${await page.evaluate(() => localStorage.getItem('terminal_access_token'))}` };
        expect((await request.post('/api/vault', { headers, data: { keyName: 'terminal-v4:provider:deepseek', keyValue: 'synthetic-question-key' } })).ok()).toBe(true);
        const created = await request.post('/api/structured/sessions', { headers, data: { cwd: workspace, provider: 'deepseek', model: 'deepseek-chat', title } });
        expect(created.ok()).toBe(true);
        sessionId = (await created.json()).id;
        await page.reload();
        if (viewport.width < 768) {
          await page.getByRole('button', { name: 'Menu', exact: true }).click();
          await page.getByRole('dialog', { name: 'Mobile menu' }).getByText(title, { exact: true }).first().click();
        } else await page.getByText(title, { exact: true }).first().click();
        const composer = page.getByRole('textbox', { name: 'Command composer', exact: true });
        await composer.fill('Ask which devices to review.');
        await page.getByRole('button', { name: 'Send message', exact: true }).click();
        const card = page.getByRole('group', { name: 'Agent question', exact: true });
        await expect(card).toBeVisible();
        await card.getByRole('checkbox', { name: 'Phone', exact: true }).check();
        await card.getByRole('checkbox', { name: 'Desktop', exact: true }).check();
        await card.getByRole('checkbox', { name: 'Something else', exact: true }).check();
        await card.getByRole('textbox', { name: 'Your answer to: Which devices?' }).fill('Tablet');
        await card.getByRole('textbox', { name: 'What should I check?' }).fill('The keyboard');
        const send = card.getByRole('button', { name: 'Send answers' });
        await send.scrollIntoViewIfNeeded();
        await expect(send).toBeInViewport({ ratio: 1 });
        expect(await send.evaluate(button => {
          const bounds = button.getBoundingClientRect();
          const hit = document.elementFromPoint(bounds.left + bounds.width / 2, bounds.top + bounds.height / 2);
          return hit === button || button.contains(hit);
        })).toBe(true);
        await page.screenshot({ path: testInfo.outputPath('live-multi-question.png') });
        await send.click();
        await expect(page.getByText('Verified all selected answers.', { exact: true })).toBeVisible({ timeout: 20_000 });
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      } finally {
        try {
          if (sessionId && headers) expect((await request.delete(`/api/structured/sessions/${sessionId}`, { headers })).ok()).toBe(true);
        } finally { rmdirSync(workspace); }
      }
    });
  });
}
