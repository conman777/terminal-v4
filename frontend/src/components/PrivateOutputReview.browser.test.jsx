import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from '@playwright/test';
import { render, screen, fireEvent } from '@testing-library/react';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PrivateOutputReview } from './PrivateOutputReview';
import { managedChromiumPath } from '../test/managedChromium';

const actionId = 'a'.repeat(64);
vi.mock('../utils/api', () => ({ apiFetch: async () => ({ ok: true, json: async () => ({ previewToken: '12345678-1234-4234-9234-123456789abc', output: { actionId: 'a'.repeat(64), stdout: 'synthetic-output-'.repeat(50), stderr: 'synthetic warning', stdoutTruncated: true, stderrTruncated: false, window: 'tail' } }) }) }));
const enabled = process.env.E2E_PRIVATE_OUTPUT === '1';
let browser, css, markup;
beforeAll(async () => {
  if (!enabled) return;
  const view = render(<div className="desktop-conversation-view"><div className="desktop-pending-requests"><PrivateOutputReview sessionId="synthetic-session" approval={{ approvalId: 'synthetic-approval', toolInput: { actionId } }} onReject={() => {}} /></div></div>);
  fireEvent.click(screen.getByRole('button', { name: 'Review output' }));
  await screen.findByText(/synthetic-output-/);
  markup = view.container.innerHTML;
  view.unmount();
  css = (await Promise.all(['styles.css', 'ProUI.css', 'WorkspaceShell.css', 'WorkspaceUI.css', 'components/DesktopConversationView.css'].map(file => readFile(resolve(process.cwd(), 'src', file), 'utf8')))).join('\n');
  browser = await chromium.launch({ executablePath: await managedChromiumPath(), headless: true });
});
afterAll(async () => { await browser?.close(); });

describe.skipIf(!enabled)('private output review layout', () => {
  it.each([320, 390, 1280])('keeps output and actions usable at %ipx', async width => {
    const touch = width < 600;
    const context = await browser.newContext({ viewport: { width, height: 844 }, hasTouch: touch, isMobile: touch });
    try {
      const page = await context.newPage();
      await context.route('**/*', route => route.abort());
      await page.setContent(`<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"><style>${css}\nhtml,body{margin:0;width:100%;} .desktop-pending-requests{padding:12px;}</style>${markup}`);
      const geometry = await page.evaluate(() => {
        const panel = document.querySelector('.private-output-review').getBoundingClientRect();
        const pre = document.querySelector('.private-output-streams pre').getBoundingClientRect();
        const buttons = [...document.querySelectorAll('.private-output-review button')].map(button => button.getBoundingClientRect());
        return { documentWidth: document.documentElement.scrollWidth, panelLeft: panel.left, panelRight: panel.right, preWidth: pre.width, preHeight: pre.height, buttonHeights: buttons.map(button => button.height) };
      });
      expect(geometry.documentWidth).toBeLessThanOrEqual(width);
      expect(geometry.panelLeft).toBeGreaterThanOrEqual(0);
      expect(geometry.panelRight).toBeLessThanOrEqual(width);
      expect(geometry.preWidth).toBeLessThanOrEqual(width);
      expect(geometry.preHeight).toBeLessThanOrEqual(180);
      if (touch) expect(geometry.buttonHeights.every(height => height >= 44)).toBe(true);
      if (width === 390 && process.env.PRIVATE_REVIEW_SCREENSHOT) {
        for (let attempt = 0; ; attempt += 1) {
          try { await page.screenshot({ path: process.env.PRIVATE_REVIEW_SCREENSHOT, animations: 'disabled' }); break; }
          catch (error) {
            if (attempt >= 2 || !String(error.message).includes('Unable to capture screenshot')) throw error;
            await page.evaluate(() => new Promise(requestAnimationFrame));
          }
        }
      }
    } finally { await context.close(); }
  });
});
