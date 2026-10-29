import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from '@playwright/test';
import { managedChromiumPath } from './test/managedChromium';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// Palette sampled from T3 Code (Beta) 0.1.2 running on macOS and its shipped tokens.
const T3_PALETTE = {
  dark: { canvas: 'rgb(10, 10, 10)', sidebar: 'rgb(0, 0, 0)', surface: 'rgb(16, 16, 16)', sendFill: 'rgb(58, 75, 189)', sendText: 'rgb(255, 255, 255)' },
  light: { canvas: 'rgb(252, 252, 253)', sidebar: 'rgb(250, 250, 250)', surface: 'rgb(255, 255, 255)', sendFill: 'rgb(27, 78, 216)', sendText: 'rgb(255, 255, 255)' },
};
const STYLESHEETS = ['styles.css', 'WorkspaceUI.css', 'ProUI.css', 'components/ThreadsSidebar.css', 'components/DesktopComposer.css', 'WorkspaceShell.css'];
const MARKUP = `<div class="environment-shell environment-workspace">
  <aside class="pro-sidebar threads-sidebar"></aside>
  <main class="main-content">
    <form class="workspace-composer"><div class="desktop-status-bar unified-conversation-composer"><div class="status-composer-shell"><button class="status-send-btn" aria-label="Send">↑</button><button class="status-send-btn idle-send" aria-label="Send empty" disabled>↑</button></div></div></form>
    <div class="preview-panel"><span class="preview-probe">Preview</span></div>
  </main>
</div>
<section role="dialog" aria-label="Settings" class="modal-content"></section>`;

let browser, css;
beforeAll(async () => {
  css = (await Promise.all(STYLESHEETS.map(file => readFile(resolve(process.cwd(), 'src', file), 'utf8')))).join('\n');
  browser = await chromium.launch({ executablePath: await managedChromiumPath(), headless: true });
});
afterAll(async () => { await browser?.close(); });

describe('T3 Code workspace palette', () => {
  it.each(['dark', 'light'])('paints the %s workspace surfaces with the T3 palette', async theme => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    try {
      const page = await context.newPage();
      // Theme is set before styles apply so colour transitions cannot be observed mid-flight.
      await page.setContent(`<html data-theme="${theme}"><head><style>${css}</style></head><body>${MARKUP}</body></html>`);
      const surfaces = await page.evaluate(() => {
        const style = selector => getComputedStyle(document.querySelector(selector));
        const send = style('.status-send-btn');
        return {
          canvas: style('.main-content').backgroundColor,
          sidebar: style('.pro-sidebar').backgroundColor,
          surface: style('.modal-content').backgroundColor,
          sendFill: send.backgroundColor,
          sendText: send.color,
          sendIsRound: send.borderRadius === '50%' || parseFloat(send.borderRadius) >= parseFloat(send.width) / 2,
          idleSendKeepsFill: style('.idle-send').backgroundColor === send.backgroundColor && Number(style('.idle-send').opacity) < 1,
          previewCanvasToken: style('.preview-probe').getPropertyValue('--bg-base').trim() === getComputedStyle(document.documentElement).getPropertyValue('--bg-base').trim(),
        };
      });
      expect(surfaces).toEqual({ ...T3_PALETTE[theme], sendIsRound: true, idleSendKeepsFill: true, previewCanvasToken: true });
    } finally { await context.close(); }
  });
});
