import { readFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from '@playwright/test';
import { managedChromiumPath } from '../test/managedChromium';
import { fireEvent, render } from '@testing-library/react';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LightweightMarkdown } from './LightweightMarkdown';
import { ConversationLinksProvider } from '../contexts/ConversationLinksContext';

const enabled = process.env.E2E_CHAT_LAYOUT === '1';
const evidence = resolve(process.cwd(), '../output/rich-markdown/chat');
const longLine = 'const veryLongIdentifierName = await someFunction("a string literal that keeps going and going", 12345); // trailing comment that is long';
const content = [
  'Result [1] with `src/components/VeryLongComponentNameForLayoutChecks.jsx:1234` and [an earlier thread](thread:abc) and <cite href="https://example.test/a/very/long/path/that/keeps/going">a long citation label that must wrap or truncate</cite>.',
  '```ts\n' + longLine + '\nfunction f(): number { return 1; }\n```',
  '```diff\n-old line\n+new line\n```',
  '```mermaid\ngraph TD\nA[Start] --> B[Work]\nB -->|retry| A\nB --> C[Done]\n```',
  '```mermaid\npie title x\n```',
  '![Chart of load](http://fixture.invalid/chart.svg)',
  '[1]: https://example.test/doc "Example document with a rather long title for wrapping"',
].join('\n\n');
const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="1200"><rect width="1600" height="1200" fill="#345"/></svg>';
let browser, css, markup;

beforeAll(async () => {
  if (!enabled) return;
  const view = render(<ConversationLinksProvider value={{ root: '/work', openFile() {}, openThread() {}, hasThread: () => true }}><LightweightMarkdown content={content} /></ConversationLinksProvider>);
  fireEvent.click(view.getByRole('button', { name: 'View larger: Chart of load' }));
  markup = document.body.innerHTML;
  view.unmount();
  css = (await Promise.all(['styles.css', 'ProUI.css', 'WorkspaceShell.css', 'WorkspaceUI.css', 'components/LightweightMarkdown.css']
    .map(file => readFile(resolve(process.cwd(), 'src', file), 'utf8')))).join('\n');
  browser = await chromium.launch({ executablePath: await managedChromiumPath(), headless: true });
  await mkdir(evidence, { recursive: true });
});
afterAll(async () => { await browser?.close(); });

describe.skipIf(!enabled)('rich Markdown in managed Chromium', () => {
  it.each([
    { width: 320, height: 640, theme: 'dark' },
    { width: 390, height: 844, theme: 'light' },
    { width: 1280, height: 800, theme: 'dark' },
  ])('stays inside the viewport at $width in $theme with a usable lightbox', async ({ width, height, theme }) => {
    const context = await browser.newContext({ viewport: { width, height } });
    try {
      const page = await context.newPage();
      await context.route('**/*', route => route.request().url().startsWith('http://fixture.invalid/')
        ? route.fulfill({ contentType: 'image/svg+xml', body: svg }) : route.abort());
      await page.setContent(`<style>${css}\nbody{margin:0}main{padding:24px 12px;max-width:760px;margin:0 auto;box-sizing:border-box}</style><main class="environment-shell"><div class="cc-message cc-assistant"><div class="cc-assistant-content">${markup.replace(/<div class="md-lightbox"[\s\S]*$/, '')}</div></div></main>${markup.match(/<div class="md-lightbox"[\s\S]*$/)?.[0] || ''}`);
      await page.evaluate(value => document.documentElement.setAttribute('data-theme', value), theme);
      await page.waitForFunction(() => [...document.images].every(image => image.complete));
      const result = await page.evaluate(() => {
        const inside = element => { const r = element.getBoundingClientRect(); return r.left >= -0.5 && r.right <= innerWidth + 0.5 && r.top >= -0.5 && r.bottom <= innerHeight + 0.5; };
        const markdown = document.querySelector('.lightweight-markdown');
        const bounds = markdown.getBoundingClientRect();
        const chips = [...markdown.querySelectorAll('.md-citation')];
        const keyword = markdown.querySelector('.tok-keyword');
        const plain = markdown.querySelector('pre code');
        const panel = document.querySelector('.md-lightbox-panel');
        const image = panel.querySelector('img');
        return {
          noPageOverflow: document.documentElement.scrollWidth <= innerWidth,
          markdownFits: bounds.left >= 0 && bounds.right <= innerWidth + 0.5,
          chipCount: chips.length, chipsFit: chips.every(chip => chip.getBoundingClientRect().right <= bounds.right + 1),
          chipsHaveTarget: chips.every(chip => chip.matches('a[href][rel="noopener noreferrer"], button, .md-citation-unavailable')),
          codeScrollsInside: [...markdown.querySelectorAll('pre')].every(pre => pre.getBoundingClientRect().right <= bounds.right + 1),
          keywordColorDiffers: getComputedStyle(keyword).color !== getComputedStyle(plain).color,
          noteVisible: markdown.querySelector('.md-code-note')?.textContent,
          backEdge: markdown.querySelectorAll('path.md-flowchart-back').length,
          lightboxFits: inside(panel) && image.getBoundingClientRect().width > 100,
          dialogRole: panel.getAttribute('role'),
        };
      });
      expect(result).toEqual({ noPageOverflow: true, markdownFits: true, chipCount: 5, chipsFit: true, chipsHaveTarget: true, codeScrollsInside: true,
        keywordColorDiffers: true, noteVisible: 'Unsupported diagram syntax. Showing source.', backEdge: 1, lightboxFits: true, dialogRole: 'dialog' });
      await page.screenshot({ path: resolve(evidence, `rich-markdown-${width}-${theme}.png`), animations: 'disabled' });
    } finally { await context.close(); }
  });
});
