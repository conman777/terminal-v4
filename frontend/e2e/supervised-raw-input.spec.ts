import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';

test.skip(process.env.E2E_LOCAL_TESTING !== '1', 'Requires an isolated local testing server.');
test.use({ launchOptions: { executablePath: process.env.E2E_LOCAL_BROWSER } });

for (const width of [320, 1280]) {
  test(`uncertain raw input remains reviewable after reload at ${width}px`, async ({ page }) => {
    const sessionId = 'ss-raw-input-fixture';
    const requestId = '018fdf56-2333-7abc-8abc-123456789abc';
    let status: 'none' | 'issued' | 'uncertain' | 'reviewed' = 'none';
    let sends = 0;
    const session = { id: sessionId, provider: 'claude', aiType: 'claude', title: 'Synthetic raw input thread', cwd: '/tmp/raw-input-fixture', status: 'completed', updatedAt: '2026-10-26T10:00:00Z' };
    await page.setViewportSize({ width, height: 700 });
    await page.route(/\/api\/structured\/sessions(?:\?.*)?$/, route => route.fulfill({ json: [session] }));
    await page.route(`**/api/structured/sessions/${sessionId}`, route => route.fulfill({ json: session }));
    await page.routeWebSocket(`**/api/structured/sessions/${sessionId}/ws*`, socket => socket.send(JSON.stringify({ __terminal_meta: true, type: 'structured_event', event: { type: 'message_completed', role: 'assistant', content: 'Ready.', messageId: 'message', turnId: 'turn', seq: 1 } })));
    await page.route('**/api/structured/input-capabilities', route => route.fulfill({ json: { protocol: 1 } }));
    await page.route('**/api/structured/input-receipts', route => route.fulfill({ json: { receipts: ['issued', 'uncertain'].includes(status) ? [{ sessionId, requestId, status }] : [], nextCursor: null } }));
    await page.route(`**/api/structured/sessions/${sessionId}/input-operation`, route => { status = 'issued'; return route.fulfill({ json: { protocol: 1, requestId, deliveryToken: 'fixture-token' } }); });
    await page.route(`**/api/structured/sessions/${sessionId}/supervised-input`, route => { sends += 1; status = 'uncertain'; return route.fulfill({ status: 409, json: { outcome: 'uncertain', requestId } }); });
    await page.route(`**/api/structured/input-receipts/${sessionId}/${requestId}`, route => route.fulfill({ json: { sessionId, requestId, status } }));
    await page.route(`**/api/structured/input-receipts/${sessionId}/${requestId}/review`, route => { status = 'reviewed'; return route.fulfill({ json: { sessionId, requestId, status } }); });
    await page.goto('/');
    await page.getByLabel('Username', { exact: true }).fill(`raw-${randomUUID()}`);
    await page.getByRole('button', { name: 'Open workspace', exact: true }).click();
    await expect(page.getByRole('textbox', { name: 'Command composer', exact: true })).toBeVisible();
    const result = await page.evaluate(async id => {
      const { sendRawInput } = await import('/src/utils/supervisedRawInputController.js');
      try { await sendRawInput(id, '\r', () => { throw new Error('unexpected legacy path'); }); return 'unexpected success'; }
      catch (error) { return (error as Error).message; }
    }, sessionId);
    expect(result).toContain('could not be confirmed');
    expect(sends).toBe(1);
    const retry = await page.evaluate(async id => {
      const { sendRawInput } = await import('/src/utils/supervisedRawInputController.js');
      try { await sendRawInput(id, '\r', () => { throw new Error('unexpected legacy path'); }); return 'unexpected success'; }
      catch (error) { return (error as Error).message; }
    }, sessionId);
    expect(retry).toContain('needs review');
    expect(sends).toBe(1);
    const review = page.getByRole('region', { name: 'Input delivery review' });
    await expect(review).toContainText('Delivery uncertain');
    await expect(review).toBeInViewport({ ratio: 1 });
    await review.getByRole('button', { name: 'Minimize review' }).click();
    await expect(review).toHaveCount(0);
    await page.getByRole('button', { name: 'Review pending input (1)' }).click();
    await expect(review).toBeInViewport({ ratio: 1 });
    await page.reload();
    await expect(review).toContainText('Delivery uncertain');
    await expect(review.getByRole('button', { name: 'Continue after review' })).toBeDisabled();
    await review.getByRole('checkbox', { name: /I checked the terminal/ }).check();
    await review.getByRole('button', { name: 'Continue after review' }).click();
    await expect(review).toHaveCount(0);
    expect(sends).toBe(1);
  });
}
