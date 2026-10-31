import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';

test.skip(process.env.E2E_BACKGROUND_DELEGATION !== '1', 'Requires an isolated local API configured with the synthetic delegation provider.');
test.use({ launchOptions: { executablePath: process.env.E2E_LOCAL_BROWSER } });

for (const viewport of [{ width: 320, height: 568 }, { width: 393, height: 852 }, { width: 1440, height: 900 }]) {
  test.describe(`background delegation at ${viewport.width}px`, () => {
    test.use({ viewport, isMobile: viewport.width <= 768, hasTouch: viewport.width <= 768 });
    test('approves a read-only child and delivers its verified result to the parent queue', async ({ page, request }) => {
      test.setTimeout(60_000);
      const app = new URL(String(test.info().project.use.baseURL));
      expect(app.protocol).toBe('http:');
      expect(['127.0.0.1', 'localhost']).toContain(app.hostname);
      expect(await (await request.get('/api/auth/mode')).json()).toEqual({ mode: 'local-testing' });
      const provider = new URL(process.env.E2E_DELEGATION_PROVIDER_URL || 'http://127.0.0.1:1');
      expect(provider.protocol).toBe('http:');
      expect(provider.hostname).toBe('127.0.0.1');
      const health = await request.get(new URL('/fixture-health', provider).toString());
      expect(await health.json()).toEqual({ fixture: 'terminal-v4-background-delegation' });
      const workspace = mkdtempSync(path.join(tmpdir(), 'terminal-v4-delegation-e2e-'));
      writeFileSync(path.join(workspace, 'notes'), 'original');
      const title = `Delegation ${randomUUID()}`;
      const errors: string[] = [];
      let headers: { Authorization: string } | undefined;
      let sessionId: string | undefined;
      page.on('pageerror', error => errors.push(error.message));
      try {
        await page.goto('/');
        await page.getByLabel('Username', { exact: true }).fill(`bg-${randomUUID()}`);
        await page.getByRole('button', { name: 'Open workspace', exact: true }).click();
        await page.waitForFunction(() => Boolean(localStorage.getItem('terminal_access_token')));
        const accessToken = await page.evaluate(() => localStorage.getItem('terminal_access_token'));
        headers = { Authorization: `Bearer ${accessToken}` };
        expect((await request.post('/api/vault', { headers, data: { keyName: 'terminal-v4:provider:deepseek', keyValue: 'synthetic-fixture-key' } })).ok()).toBe(true);
        expect((await request.patch('/api/settings', { headers, data: { recentFolders: [workspace], sidebarProjects: [{ path: workspace, name: 'Fixture project' }] } })).ok()).toBe(true);
        const created = await request.post('/api/structured/sessions', { headers, data: { cwd: workspace, provider: 'deepseek', model: 'deepseek-chat', title } });
        expect(created.ok()).toBe(true);
        sessionId = (await created.json()).id;
        await page.reload();
        if (viewport.width <= 768) {
          await page.getByRole('button', { name: 'Menu', exact: true }).click();
          await page.getByRole('dialog', { name: 'Mobile menu' }).getByText(title, { exact: true }).first().click();
        } else {
          await page.getByText(title, { exact: true }).first().click();
        }
        const composer = page.getByRole('textbox', { name: 'Command composer', exact: true });
        await composer.fill('Investigate the fixture project in the background.');
        await page.getByRole('button', { name: 'Send message', exact: true }).click();
        const approval = page.getByRole('group', { name: 'Approval required' });
        await expect(approval.getByText('Run a read-only background investigation?')).toBeVisible();
        await expect(approval.getByText('Inspect notes in the fixture project.', { exact: true })).toBeVisible();
        await expect(approval.getByText(/can run the result automatically while your authorization remains valid/)).toBeVisible();
        await expect(approval.getByLabel('Approval details')).toBeHidden();
        const approve = approval.getByRole('button', { name: 'Approve', exact: true });
        const reachable = await approve.evaluate(button => {
          const bounds = button.getBoundingClientRect();
          const composer = document.querySelector('.workspace-composer')!.getBoundingClientRect();
          const hit = document.elementFromPoint(bounds.left + bounds.width / 2, bounds.top + bounds.height / 2);
          return bounds.top >= 0 && bounds.bottom <= composer.top && (hit === button || button.contains(hit));
        });
        expect(reachable).toBe(true);
        await approve.click();
        await expect(page.getByText('Background investigation started.', { exact: true })).toBeVisible();
        await expect(page.getByText('Parent received the verified background answer.', { exact: true })).toBeVisible({ timeout: 30_000 });
        expect(readFileSync(path.join(workspace, 'notes'), 'utf8')).toBe('original');
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        expect(errors).toEqual([]);
      } finally {
        try {
          if (sessionId && headers) {
            const deleted = await request.delete(`/api/structured/sessions/${sessionId}`, { headers });
            expect(deleted.ok()).toBe(true);
          }
        } finally {
          rmSync(workspace, { recursive: true, force: true });
        }
      }
    });
  });
}
