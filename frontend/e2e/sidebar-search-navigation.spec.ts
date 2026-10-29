import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';

test.skip(process.env.E2E_LOCAL_TESTING !== '1', 'Requires an isolated local testing server.');
test.use({ launchOptions: { executablePath: process.env.E2E_LOCAL_BROWSER }, viewport: { width: 1280, height: 800 } });

test('opens a saved content match at its message without losing a draft', async ({ page }, testInfo) => {
  const session = { id: 'ss-search-fixture', provider: 'codex', runtime: 'codex', title: 'Search fixture', cwd: '/tmp/search-fixture',
    status: 'completed', model: 'fixture-model', reasoning: 'high', createdAt: '2026-10-25T10:00:00Z', updatedAt: '2026-10-25T10:00:00Z' };
  await page.route('**/api/agent/catalog*', route => route.fulfill({ json: { agents: [{ id: 'codex', label: 'Codex', runtime: 'codex', available: true, models: [{ id: 'fixture-model', label: 'Fixture model', default: true }], reasoningLevels: ['high'] }] } }));
  await page.route(/\/api\/structured\/sessions(?:\?.*)?$/, route => route.fulfill({ json: [session] }));
  await page.route(`**/api/structured/sessions/${session.id}`, route => route.fulfill({ json: session }));
  await page.route(`**/api/structured/sessions/${session.id}/thread`, route => route.fulfill({ json: { thread: { archived: false } } }));
  await page.route('**/api/workspace/history?*', route => route.fulfill({ json: [{ sessionId: session.id, title: session.title, snippet: 'The exact needle is here', matchType: 'message', anchor: { type: 'message', messageId: 'search-match', role: 'assistant' } }] }));
  await page.routeWebSocket(`**/api/structured/sessions/${session.id}/ws*`, socket => {
    for (const event of [
      { type: 'message_completed', role: 'user', content: 'Find the answer', messageId: 'search-user', turnId: 'search-turn', seq: 1 },
      { type: 'message_completed', role: 'assistant', content: 'The exact needle is here', messageId: 'search-match', turnId: 'search-turn', seq: 2 },
      { type: 'turn_completed', turnId: 'search-turn', status: 'completed', seq: 3 },
    ]) socket.send(JSON.stringify({ __terminal_meta: true, type: 'structured_event', event }));
  });
  await page.goto('/');
  await page.getByLabel('Username', { exact: true }).fill(`search-${randomUUID()}`);
  await page.getByRole('button', { name: 'Open workspace', exact: true }).click();
  await expect(page.getByText('The exact needle is here', { exact: true })).toBeVisible();
  const composer = page.getByRole('textbox', { name: 'Command composer', exact: true });
  await composer.fill('Unsent draft stays here');
  await page.getByRole('textbox', { name: 'Search threads' }).fill('needle');
  const result = page.getByRole('region', { name: 'Saved conversation results' }).getByRole('button', { name: /exact needle/i });
  await expect(result).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('desktop-search.png'), animations: 'disabled' });
  await result.click();
  await expect(page.getByText('Matching message located.', { exact: true })).toBeVisible();
  await expect(page.locator('[data-message-id="search-match"]')).toBeFocused();
  await expect(composer).toHaveValue('Unsent draft stays here');
});

test.describe('mobile saved content search', () => {
  test.use({ viewport: { width: 393, height: 684 }, isMobile: true, hasTouch: true });
  test('finds and focuses a message while retaining the draft', async ({ page }, testInfo) => {
    const session = { id: 'ss-mobile-search-fixture', provider: 'codex', runtime: 'codex', title: 'Mobile fixture', cwd: '/tmp/mobile-search-fixture',
      status: 'completed', model: 'fixture-model', reasoning: 'high', createdAt: '2026-10-25T10:00:00Z', updatedAt: '2026-10-25T10:00:00Z' };
    await page.route('**/api/agent/catalog*', route => route.fulfill({ json: { agents: [{ id: 'codex', label: 'Codex', runtime: 'codex', available: true, models: [{ id: 'fixture-model', label: 'Fixture model', default: true }], reasoningLevels: ['high'] }] } }));
    await page.route(/\/api\/structured\/sessions(?:\?.*)?$/, route => route.fulfill({ json: [session] }));
    await page.route(`**/api/structured/sessions/${session.id}`, route => route.fulfill({ json: session }));
    await page.route(`**/api/structured/sessions/${session.id}/thread`, route => route.fulfill({ json: { thread: { archived: false } } }));
    await page.route('**/api/workspace/history?*', route => route.fulfill({ json: [{ sessionId: session.id, title: session.title, snippet: 'The mobile needle is here', matchType: 'message', anchor: { type: 'message', messageId: 'mobile-match', role: 'assistant' } }] }));
    await page.routeWebSocket(`**/api/structured/sessions/${session.id}/ws*`, socket => {
      for (const event of [
        { type: 'message_completed', role: 'user', content: 'Find the mobile answer', messageId: 'mobile-user', turnId: 'mobile-turn', seq: 1 },
        { type: 'message_completed', role: 'assistant', content: 'The mobile needle is here', messageId: 'mobile-match', turnId: 'mobile-turn', seq: 2 },
        { type: 'turn_completed', turnId: 'mobile-turn', status: 'completed', seq: 3 },
      ]) socket.send(JSON.stringify({ __terminal_meta: true, type: 'structured_event', event }));
    });
    await page.goto('/');
    await page.getByLabel('Username', { exact: true }).fill(`msearch-${randomUUID()}`);
    await page.getByRole('button', { name: 'Open workspace', exact: true }).click();
    await expect(page.getByText('The mobile needle is here', { exact: true })).toBeVisible();
    const composer = page.getByRole('textbox', { name: 'Command composer', exact: true });
    await composer.fill('Mobile draft remains');
    await page.getByRole('button', { name: 'Menu', exact: true }).click();
    const drawer = page.getByRole('dialog', { name: 'Mobile menu', exact: true });
    await drawer.getByRole('searchbox', { name: 'Search threads' }).fill('needle');
    const result = drawer.getByRole('button', { name: /mobile needle/i });
    await expect(result).toBeVisible();
    expect((await result.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath('mobile-search.png'), animations: 'disabled' });
    await result.click();
    await expect(page.getByText('Matching message located.', { exact: true })).toBeVisible();
    await expect(page.locator('[data-message-id="mobile-match"]')).toBeFocused();
    await expect(composer).toHaveValue('Mobile draft remains');
  });
});
