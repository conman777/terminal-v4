import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';

test.skip(process.env.E2E_LOCAL_TESTING !== '1', 'Requires an isolated local testing server.');
test.use({ launchOptions: { executablePath: process.env.E2E_LOCAL_BROWSER } });

const session = { id: 'ss-markdown-alerts', provider: 'codex', runtime: 'codex', title: 'Markdown fixture',
  cwd: '/tmp/markdown-layout-fixture', status: 'completed', model: 'gpt-6.1-sol', createdAt: '2026-10-25T10:00:00Z' };
const content = `Review the plan:

> [!WARNING]
> Check **both environments** before proceeding.
>
> - [x] Desktop checked
> - [ ] Phone check pending

Normal text after the alert.

<details>
<summary>Implementation details</summary>

Open the **review notes** before continuing.

<details><summary>Nested checks</summary>

The hidden needle is here.

</details>

</details>`;

for (const fixture of [{ width: 320, height: 640, mobile: true }, { width: 1280, height: 800, mobile: false }]) {
  test.describe(`${fixture.width}px`, () => {
    test.use({ viewport: { width: fixture.width, height: fixture.height }, isMobile: fixture.mobile, hasTouch: fixture.mobile });
    test('renders alerts and immutable task status in the conversation', async ({ page }, testInfo) => {
      await page.route('**/api/agent/catalog*', route => route.fulfill({ json: { agents: [{ id: 'codex', runtime: 'codex', available: true, models: [{ id: 'gpt-6.1-sol', default: true }] }] } }));
      await page.route(/\/api\/structured\/sessions(?:\?.*)?$/, route => route.fulfill({ json: [session] }));
      await page.route(`**/api/structured/sessions/${session.id}`, route => route.fulfill({ json: session }));
      await page.route(`**/api/structured/sessions/${session.id}/approval-capability`, route => route.fulfill({ json: { protocol: 1, mode: 'legacy', outstanding: false } }));
      await page.routeWebSocket(`**/api/structured/sessions/${session.id}/ws*`, ws => {
        for (const event of [{ type: 'message_completed', role: 'assistant', content, messageId: 'answer', turnId: 'turn', seq: 1 },
          { type: 'turn_completed', turnId: 'turn', status: 'completed', seq: 2 }]) ws.send(JSON.stringify({ __terminal_meta: true, type: 'structured_event', event }));
      });
      await page.goto('/');
      await page.getByLabel('Username', { exact: true }).fill(`markdown-${randomUUID()}`);
      await page.getByRole('button', { name: 'Open workspace', exact: true }).click();
      const alert = page.locator('.lightweight-markdown .md-alert-warning');
      await expect(alert).toBeVisible();
      await expect(alert).toContainText('Warning');
      await expect(alert.getByText('both environments')).toBeVisible();
      const checks = alert.getByRole('checkbox');
      await expect(checks).toHaveCount(2);
      await expect(checks.nth(0)).toBeChecked();
      await expect(checks.nth(0)).toBeDisabled();
      await expect(checks.nth(1)).not.toBeChecked();
      await expect(checks.nth(1)).toBeDisabled();
      await expect(page.getByText('Normal text after the alert.')).toBeVisible();
      const section = page.locator('.lightweight-markdown > details.md-details');
      const summary = section.locator(':scope > summary');
      expect((await summary.boundingBox())?.height).toBeGreaterThanOrEqual(44);
      await expect(section).not.toHaveAttribute('open');
      await expect(page.getByText('review notes')).toBeHidden();
      await summary.focus();
      await page.keyboard.press('Enter');
      await expect(section).toHaveAttribute('open');
      await expect(page.getByText('review notes')).toBeVisible();
      const nested = section.locator('details.md-details');
      expect((await nested.locator(':scope > summary').boundingBox())?.height).toBeGreaterThanOrEqual(44);
      await nested.locator(':scope > summary').click();
      await expect(page.getByText('The hidden needle is here.')).toBeVisible();
      await summary.click();
      if (fixture.mobile) {
        await page.getByRole('button', { name: 'More actions', exact: true }).click();
        await page.getByRole('button', { name: 'Find in thread', exact: true }).click();
      } else await page.keyboard.press('Meta+f');
      const search = page.getByRole('searchbox', { name: 'Find in thread', exact: true });
      await search.fill('hidden needle');
      await expect(section).toHaveAttribute('open');
      await expect(nested).toHaveAttribute('open');
      await expect(page.getByText('The hidden needle is here.')).toBeVisible();
      await expect(search).toBeFocused();
      await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      await page.screenshot({ path: testInfo.outputPath(`alert-${fixture.width}.png`) });
    });
  });
}
