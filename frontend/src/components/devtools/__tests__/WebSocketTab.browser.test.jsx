import { fireEvent, render, screen } from '@testing-library/react';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { chromium } from '@playwright/test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { WebSocketTab } from '../WebSocketTab';
import { apiFetch } from '../../../utils/api';

vi.mock('../../../utils/api', () => ({ apiFetch: vi.fn() }));

describe.runIf(process.env.E2E_WEBSOCKET_LAYOUT === '1')('WebSocketTab actual Chromium layout', () => {
  let browser;
  let css;
  beforeAll(async () => {
    css = (await Promise.all(['../../../styles.css', '../../../WorkspaceUI.css', '../../../devtools.css', '../WebSocketTab.css'].map(path =>
      readFile(new URL(path, import.meta.url), 'utf8')
    ))).join('\n');
    browser = await chromium.launch({
      executablePath: process.env.E2E_LOCAL_BROWSER || (process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : undefined),
      headless: true,
    });
  });
  afterAll(async () => { await browser?.close(); });

  it.each(['dark', 'light'].flatMap(theme => [980, 360, 320].map(width => ({ theme, width }))))('bounds both lists at $width px in $theme theme', async ({ theme, width }) => {
    const connections = Array.from({ length: 12 }, (_, index) => ({
      id: `connection-${index}`, url: `ws://synthetic.invalid/${'long-path-'.repeat(15)}${index}`,
      status: index % 2 ? 'closed' : 'connected', timestamp: 1000 + index,
      protocols: ['json', 'synthetic-v2'],
    }));
    const messages = Array.from({ length: 100 }, (_, index) => ({
      id: `message-${index}`, direction: index % 2 ? 'sent' : 'received', format: 'text',
      data: `fixture-${index} ${'payload'.repeat(100)}`, size: 710, timestamp: 2000 + index,
    }));
    apiFetch.mockResolvedValue({ ok: true, json: async () => ({ connections, messages }) });
    const { container } = render(<WebSocketTab port={4173} />);
    await screen.findByText('Messages (100)');
    const page = await browser.newPage({ viewport: { width, height: 400 }, hasTouch: width < 600 });
    try {
      await page.route('**/*', route => route.abort());
      const html = `<!doctype html><html data-theme="${theme}"><style>${css}</style><style>body{margin:0}#fixture{height:280px;width:100%;overflow:hidden}.fixture-tabs{flex:0 0 36px}</style><div id="fixture"><div class="devtools-panel"><div class="fixture-tabs">WebSocket</div><div class="devtools-content">${container.innerHTML}</div></div></div></html>`;
      await page.setContent(html);
      if (process.env.E2E_WEBSOCKET_EVIDENCE) {
        await mkdir(process.env.E2E_WEBSOCKET_EVIDENCE, { recursive: true });
        const prefix = join(process.env.E2E_WEBSOCKET_EVIDENCE, `${theme}-${width}`);
        await writeFile(`${prefix}.html`, html);
        await page.locator('#fixture').screenshot({ path: `${prefix}.png` });
      }
      const metrics = await page.evaluate(() => {
        const root = document.querySelector('.devtools-content').firstElementChild;
        const layout = root.querySelector('.websocket-tab__layout');
        const panes = [...layout.children];
        const lists = panes.map(pane => pane.lastElementChild);
        const rect = element => { const { top, bottom, left, right, height } = element.getBoundingClientRect(); return { top, bottom, left, right, height }; };
        return {
          display: getComputedStyle(layout).display, root: rect(root), layout: rect(layout),
          lists: lists.map(list => ({ ...rect(list), clientHeight: list.clientHeight, scrollHeight: list.scrollHeight, overflowY: getComputedStyle(list).overflowY })),
          background: getComputedStyle(lists[0]).backgroundColor,
          bodyWidth: document.body.scrollWidth,
        };
      });
      console.info(JSON.stringify({ theme, width, metrics }));
      expect(metrics.display).toBe('grid');
      expect(metrics.root.bottom).toBeLessThanOrEqual(280);
      expect(metrics.layout.bottom).toBeLessThanOrEqual(280);
      expect(metrics.bodyWidth).toBe(width);
      for (const list of metrics.lists) {
        expect(list.height).toBeGreaterThan(60);
        expect(list.bottom).toBeLessThanOrEqual(280);
        expect(list.overflowY).toBe('auto');
        expect(list.scrollHeight).toBeGreaterThan(list.clientHeight);
      }
      expect(metrics.background).toBe(theme === 'light' ? 'rgb(255, 255, 255)' : 'rgb(16, 16, 16)');
      const scroll = await page.evaluate(() => {
        const [connectionsList, messagesList] = document.querySelectorAll('.websocket-tab__scroll');
        connectionsList.scrollTop = connectionsList.scrollHeight;
        const before = messagesList.scrollTop;
        messagesList.scrollTop = messagesList.scrollHeight;
        return { connection: connectionsList.scrollTop, messageBefore: before, messageAfter: messagesList.scrollTop, page: window.scrollY };
      });
      expect(scroll.connection).toBeGreaterThan(0);
      expect(scroll.messageBefore).toBe(0);
      expect(scroll.messageAfter).toBeGreaterThan(0);
      expect(scroll.page).toBe(0);
      const lastConnection = page.getByRole('button', { name: /connection-11/ });
      await lastConnection.focus();
      await page.keyboard.press('Tab');
      expect(await page.getByRole('button', { name: 'All', exact: true }).evaluate(button => button === document.activeElement)).toBe(true);

      fireEvent.click(screen.getByRole('button', { name: /Inspect message message-0:/ }));
      await page.locator('.devtools-content').evaluate((element, markup) => { element.innerHTML = markup; }, container.innerHTML);
      const detail = await page.getByRole('region', { name: 'Message details', exact: true }).evaluate(element => ({
        bottom: element.getBoundingClientRect().bottom, height: element.clientHeight,
        scrollHeight: element.scrollHeight, overflowY: getComputedStyle(element).overflowY,
        payload: element.querySelector('pre').textContent, bodyWidth: document.body.scrollWidth,
      }));
      expect(detail.bottom).toBeLessThanOrEqual(280);
      expect(detail.scrollHeight).toBeGreaterThan(detail.height);
      expect(detail.overflowY).toBe('auto');
      expect(detail.payload).toBe(messages[0].data);
      expect(detail.bodyWidth).toBe(width);
      if (process.env.E2E_WEBSOCKET_EVIDENCE) {
        await writeFile(join(process.env.E2E_WEBSOCKET_EVIDENCE, `${theme}-${width}.json`), JSON.stringify({ theme, width, metrics, scroll, detail }, null, 2));
      }
    } finally { await page.close(); }
  });
});
