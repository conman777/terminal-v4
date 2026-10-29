import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from '@playwright/test';
import { managedChromiumPath } from '../test/managedChromium';
import { render } from '@testing-library/react';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LightweightMarkdown } from './LightweightMarkdown';

const enabled = process.env.E2E_CHAT_LAYOUT === '1';
const evidence = resolve(process.cwd(), '../output/overnight-polish-20261025/chat');
const content = '3. Inspect the workspace\n   - Read `layout.css`\n     7. Verify the phone\n     8. Verify desktop\n   - Review an unusually long identifier: ' + 'syntheticIdentifier'.repeat(8)
  + '\n4. Share the result\n\n   Keep this continuation with the sharing step.\n\nOutside the list.';
let browser, markup, css;

beforeAll(async () => {
  if (!enabled) return;
  const view = render(<LightweightMarkdown content={content} />);
  markup = view.container.innerHTML;
  view.unmount();
  css = (await Promise.all(['styles.css', 'ProUI.css', 'WorkspaceShell.css', 'WorkspaceUI.css', 'components/LightweightMarkdown.css']
    .map(file => readFile(resolve(process.cwd(), 'src', file), 'utf8')))).join('\n');
  browser = await chromium.launch({ executablePath: await managedChromiumPath(), headless: true });
  await mkdir(evidence, { recursive: true });
});
afterAll(async () => { await browser?.close(); });

describe.skipIf(!enabled)('semantic nested Markdown lists in managed Chromium', () => {
  it.each([
    { width: 390, height: 844, theme: 'dark' },
    { width: 800, height: 700, theme: 'light' },
  ])('keeps nesting visibly indented and within the reading rail at $width in $theme', async ({ width, height, theme }) => {
    const context = await browser.newContext({ viewport: { width, height } });
    try {
      const page = await context.newPage();
      await context.route('**/*', route => route.abort());
      await page.setContent(`<style>${css}\nbody{margin:0}main{padding:24px 12px;max-width:760px;margin:0 auto;box-sizing:border-box}</style><main class="environment-shell"><div class="cc-message cc-assistant"><div class="cc-assistant-content">${markup}</div></div></main>`);
      await page.evaluate(value => document.documentElement.setAttribute('data-theme', value), theme);
      const semantics = await page.locator('.lightweight-markdown').evaluate(markdown => {
        const root = markdown.querySelector(':scope > ol');
        const children = root.firstElementChild.querySelector(':scope > ul');
        const steps = children.firstElementChild.querySelector(':scope > ol');
        const lefts = [root, children, steps].map(list => list.firstElementChild.getBoundingClientRect().left);
        return { markdownCount: document.querySelectorAll('.lightweight-markdown').length, listCount: markdown.querySelectorAll('ul, ol').length,
          rootItems: root.children.length, childItems: children.children.length, stepItems: steps.children.length,
          starts: [root.getAttribute('start'), steps.getAttribute('start')],
          visibleIndentation: lefts[1] - lefts[0] >= 16 && lefts[2] - lefts[1] >= 16,
          paragraphOwnedByItem: root.lastElementChild.lastElementChild.textContent === 'Keep this continuation with the sharing step.',
          followingProseOutside: markdown.lastElementChild.tagName === 'P' && markdown.lastElementChild.textContent === 'Outside the list.',
          noHorizontalOverflow: document.documentElement.scrollWidth === innerWidth && markdown.scrollWidth <= markdown.clientWidth,
          inlineCode: children.firstElementChild.querySelector('code').textContent };
      });
      expect(semantics).toEqual({ markdownCount: 1, listCount: 3, rootItems: 2, childItems: 2, stepItems: 2, starts: ['3', '7'], visibleIndentation: true,
        paragraphOwnedByItem: true, followingProseOutside: true, noHorizontalOverflow: true, inlineCode: 'layout.css' });
      let captureRetries = 0;
      for (;;) {
        try { await page.screenshot({ path: resolve(evidence, `nested-lists-${width}-${theme}.png`), animations: 'disabled' }); break; }
        catch (error) {
          if (captureRetries >= 2 || !String(error.message).includes('Unable to capture screenshot')) throw error;
          captureRetries += 1;
          await page.evaluate(() => new Promise(requestAnimationFrame));
        }
      }
      await writeFile(resolve(evidence, `nested-lists-${width}.json`), JSON.stringify({ semantics, captureRetries, sourceMarkupOnly: true }, null, 2));
    } finally { await context.close(); }
  });
});
