import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from '@playwright/test';
import { render, screen } from '@testing-library/react';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { setUser } from '../utils/auth';
import { managedChromiumPath } from '../test/managedChromium';
import { ProjectFilePreview } from './ProjectFilePreview';

vi.mock('../utils/api', () => ({ apiFetch: async () => ({ ok: true, json: async () => ({
  root: '/fixture', path: 'src/example.js', line: 2, totalLines: 35,
  lines: Array.from({ length: 9 }, (_, index) => ({ line: index + 1, text: `const line${index + 1} = true;`, truncated: false })),
}) }) }));

const enabled = process.env.E2E_PROJECT_FILE_PREVIEW === '1';
let browser, css, markup;
beforeAll(async () => {
  if (!enabled) return;
  setUser({ id: 'preview-layout-fixture' });
  const view = render(<ProjectFilePreview sessionId="ss-fixture" root="/fixture" file={{ path: 'src/example.js', line: 2 }} onClose={() => {}} onShowInFiles={() => true} />);
  await screen.findByText('Lines 1–9 of 35');
  markup = document.body.innerHTML;
  view.unmount();
  css = (await Promise.all(['styles.css', 'ProUI.css', 'components/ProjectFilePreview.css'].map(file => readFile(resolve(process.cwd(), 'src', file), 'utf8')))).join('\n');
  browser = await chromium.launch({ executablePath: await managedChromiumPath(), headless: true });
});
afterAll(async () => { await browser?.close(); setUser(null); });

describe.skipIf(!enabled)('project file preview layout', () => {
  it.each([320, 390, 1280])('keeps file navigation and actions inside a %ipx viewport', async width => {
    const context = await browser.newContext({ viewport: { width, height: 720 }, hasTouch: width < 600, isMobile: width < 600 });
    try {
      const page = await context.newPage();
      await context.route('**/*', route => route.abort());
      await page.setContent(`<meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}\nhtml,body{margin:0;width:100%;}</style>${markup}`);
      const geometry = await page.evaluate(() => {
        const dialog = document.querySelector('.project-file-preview').getBoundingClientRect();
        const controls = [...document.querySelectorAll('.project-file-preview button')].map(button => button.getBoundingClientRect());
        return { documentWidth: document.documentElement.scrollWidth, dialog: { left: dialog.left, right: dialog.right, top: dialog.top, bottom: dialog.bottom }, controls: controls.map(rect => ({ left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, height: rect.height })) };
      });
      expect(geometry.documentWidth).toBeLessThanOrEqual(width);
      expect(geometry.dialog.left).toBeGreaterThanOrEqual(0);
      expect(geometry.dialog.right).toBeLessThanOrEqual(width);
      expect(geometry.dialog.top).toBeGreaterThanOrEqual(0);
      expect(geometry.dialog.bottom).toBeLessThanOrEqual(720);
      expect(geometry.controls.every(control => control.left >= 0 && control.right <= width && control.top >= 0 && control.bottom <= 720 && control.height >= 44)).toBe(true);
      if (width === 320 && process.env.PROJECT_PREVIEW_SCREENSHOT) await page.screenshot({ path: process.env.PROJECT_PREVIEW_SCREENSHOT, animations: 'disabled' });
    } finally { await context.close(); }
  });
});
