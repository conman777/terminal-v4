import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from '@playwright/test';
import { render, screen } from '@testing-library/react';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { DesktopConversationView } from './DesktopConversationView';
import { DesktopStatusBar } from './DesktopStatusBar';
import { WorkspaceStartView } from './WorkspaceStartView';

vi.mock('../contexts/AutocorrectContext', () => ({ useAutocorrect: () => ({ autocorrectEnabled: false, toggleAutocorrect() {} }) }));
vi.mock('../hooks/useAutocorrectInput', () => ({ useAutocorrectInput: () => ({ handleKeyDown() {}, handleSelectionChange() {} }) }));
vi.mock('./TerminalMicButton', () => ({ TerminalMicButton: () => null }));
vi.mock('../utils/api', () => ({ apiFetch: async () => { throw new Error('Synthetic catalog unavailable'); } }));

const enabled = process.env.E2E_CHAT_LAYOUT === '1';
const evidence = resolve(process.cwd(), '../output/overnight-polish-20261025/chat');
const code = '# Nested example\n```js\nconst label = "left • right";\n```\nAfter • preserve the original';
const approval = { id: 'synthetic-exact-request', name: 'browser_evaluate', label: 'Synthetic reviewer', arguments: { code: 'document.querySelector("main").textContent' }, target: { url: 'https://example.test/review' } };
let browser, css, markup, retryMarkup, ptyMarkup;
async function capture(page, name) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await page.screenshot({ path: resolve(evidence, name), animations: 'disabled' });
      return attempt;
    } catch (error) {
      if (attempt >= 2 || !String(error.message).includes('Unable to capture screenshot')) throw error;
      await page.evaluate(() => new Promise(requestAnimationFrame));
    }
  }
}

beforeAll(async () => {
  if (!enabled) return;
  const view = render(<div className="terminal-with-status"><div className="desktop-terminal-stack">
    <div className="desktop-conversation-surface"><DesktopConversationView turns={[]} mode="structured" showHeader={false} aiType="codex" connectionState="online" isSendReady isStreaming
      structuredMessages={[
        { role: 'user', messageId: 'question', content: 'Keep the nested code sample and review the next action.' },
        { role: 'tool', toolCallId: 'read-layout', toolName: 'read_file', toolInput: { path: '/synthetic/layout.css' }, result: 'Synthetic layout output' },
        { role: 'assistant', messageId: 'answer', content: 'Review https://example.test/docs.\n\n````markdown\n' + code + '\n````\n\n| Surface | Result |\n| --- | --- |\n| Reading | Ready |' },
        { role: 'tool', toolCallId: 'read-one', toolName: 'read_file', toolInput: { path: '/synthetic/src/layout.css' }, result: 'Synthetic file output' },
        { role: 'tool', toolCallId: 'read-two', toolName: 'read_file', toolInput: { path: '/synthetic/src/view.jsx' }, result: 'Synthetic file output' },
      ]} browserApprovals={[approval]} onBrowserApprove={() => {}} /></div>
    <DesktopStatusBar sessionId="synthetic-render" compactConversation composerValue="Keep this unsent follow-up." onComposerChange={() => {}} onComposerSubmit={() => {}}
      isStreaming onInterrupt={() => {}} composerSubmitDisabled showTopRow={false} showComposerFooter={false} showImageButton={false} showAiSelector={false} showMicButtons={false} />
  </div></div>);
  markup = view.container.innerHTML;
  view.unmount();
  const retry = render(<WorkspaceStartView currentPath="/synthetic/project" onSubmitPrompt={() => {}} />);
  await screen.findByRole('button', { name: 'Retry loading agents' });
  retryMarkup = retry.container.innerHTML;
  retry.unmount();
  const pty = render(<div className="terminal-with-status terminal-first"><div className="desktop-terminal-stack terminal-first">
    <div className="desktop-terminal-slot is-open"><pre style={{ margin: 16 }}>{'Synthetic shell output\n$ ready'}</pre></div>
    <DesktopStatusBar sessionId="synthetic-pty" isActive composerValue="Keep this shell command unsent." onComposerChange={() => {}} onComposerSubmit={() => {}}
      showTopRow={false} showComposerFooter={false} aiType={null} showMicButtons={false}
      composerSecondaryAction={<button type="button" className="status-sandbox-toggle" aria-label="Launch permissions unavailable" disabled>Full access</button>} />
  </div></div>);
  ptyMarkup = pty.container.innerHTML;
  pty.unmount();
  css = (await Promise.all([
    'styles.css', 'ProUI.css', 'WorkspaceShell.css', 'WorkspaceUI.css', 'components/TerminalPane.css',
    'components/ComposerPicker.css', 'components/AgentModelPicker.css', 'components/ModelSettingsPopover.css',
    'components/LightweightMarkdown.css', 'components/ToolCallBlock.css', 'components/StructuredActivityGroup.css',
    'components/DesktopConversationView.css', 'components/DesktopComposer.css',
  ].map(file => readFile(resolve(process.cwd(), 'src', file), 'utf8')))).join('\n');
  const runtime = resolve(process.cwd(), '../.runtime/browser');
  const manifest = JSON.parse(await readFile(resolve(runtime, 'runtime.json'), 'utf8'));
  browser = await chromium.launch({ executablePath: resolve(runtime, manifest.chromium), headless: true });
  await mkdir(evidence, { recursive: true });
});
afterAll(async () => { await browser?.close(); });

describe.skipIf(!enabled)('conversation source markup with managed Chromium and application CSS', () => {
  it('keeps the active PTY composer controls quiet and permission state legible', async () => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    try {
      const page = await context.newPage();
      await context.route('**/*', route => route.abort());
      await page.setContent(`<style>${css}\nhtml,body,#root{margin:0;width:100%;height:100%;}</style><main id="root" class="environment-shell environment-workspace">${ptyMarkup}</main>`);
      const geometry = await page.evaluate(() => {
        const composer = document.querySelector('.status-composer-shell');
        const row = document.querySelector('.status-bar-right');
        const selector = document.querySelector('.status-ai-selector');
        const permissions = document.querySelector('.status-sandbox-toggle');
        const token = document.createElement('span'); token.style.border = '1px solid var(--border-default)'; composer.append(token);
        const result = { neutralComposerBorder: getComputedStyle(composer).borderColor === getComputedStyle(token).borderColor,
          quietActionRow: getComputedStyle(row).backgroundColor === 'rgba(0, 0, 0, 0)',
          quietSelectorBorder: getComputedStyle(selector).borderColor === 'rgba(0, 0, 0, 0)',
          permissionOpacity: getComputedStyle(permissions).opacity, permissionsDisabled: permissions.disabled,
          cliIdentity: Boolean(selector.querySelector('.status-ai-cli-icon')) };
        token.remove(); return result;
      });
      const captureRetries = await capture(page, `pty-composer${process.env.E2E_CHAT_BASELINE ? '-before' : '-after'}.png`);
      expect(geometry).toEqual({ neutralComposerBorder: true, quietActionRow: true, quietSelectorBorder: true, permissionOpacity: '1', permissionsDisabled: true, cliIdentity: true });
      await writeFile(resolve(evidence, 'pty-geometry.json'), JSON.stringify({ geometry, captureRetries }, null, 2));
    } finally { await context.close(); }
  });

  it.each([
    { width: 1280, height: 900, theme: 'dark', touch: false },
    { width: 800, height: 700, theme: 'light', touch: false },
    { width: 390, height: 844, theme: 'dark', touch: true },
  ])('keeps reading, exact approvals and composer reachable at $width in $theme', async ({ width, height, theme, touch }) => {
    const context = await browser.newContext({ viewport: { width, height }, hasTouch: touch });
    try {
      const page = await context.newPage();
      await context.route('**/*', route => route.abort());
      await page.setContent(`<style>${css}\nhtml,body,#root{margin:0;width:100%;height:100%;}</style><main id="root" class="environment-shell environment-workspace">${markup}</main>`);
      await page.evaluate(value => document.documentElement.setAttribute('data-theme', value), theme);
      expect(await page.getByRole('region', { name: 'markdown code' }).textContent()).toBe(code);
      expect(await page.getByRole('link', { name: 'https://example.test/docs', exact: true }).getAttribute('href')).toBe('https://example.test/docs');
      const details = page.locator('.structured-browser-approval details');
      await details.locator('summary').focus();
      await page.keyboard.press('Enter');
      expect(await details.getAttribute('open')).not.toBeNull();
      const original = page.locator('[aria-label="Browser approval details"]');
      expect(JSON.parse(await original.textContent())).toEqual(approval.arguments);
      const toolRow = await page.locator('.cc-tool-header').first().evaluate(button => {
        const name = button.querySelector('.cc-tool-name').getBoundingClientRect();
        const path = button.querySelector('.cc-tool-path').getBoundingClientRect();
        return { sameLine: Math.abs(name.y + name.height / 2 - path.y - path.height / 2) < 2, height: button.getBoundingClientRect().height };
      });
      expect(toolRow).toEqual({ sameLine: true, height: touch ? 44 : 32 });
      const stop = page.getByRole('button', { name: 'Stop response', exact: true });
      await stop.scrollIntoViewIfNeeded();
      const geometry = await page.evaluate(() => {
        const buttons = [...document.querySelectorAll('.structured-browser-approval button, .status-response-stop')];
        const composer = document.querySelector('.workspace-composer').getBoundingClientRect();
        const form = document.querySelector('.status-composer-shell').getBoundingClientRect();
        const rail = document.querySelector('.desktop-thread-inner').getBoundingClientRect();
        const gutter = parseFloat(getComputedStyle(document.querySelector('.desktop-thread-inner')).paddingLeft);
        return { overflow: document.documentElement.scrollWidth > innerWidth, stopCount: document.querySelectorAll('[aria-label="Stop response"]').length,
          composerFits: composer.x >= 0 && composer.right <= innerWidth && composer.bottom <= innerHeight,
          railFits: rail.x >= 0 && rail.right <= innerWidth,
          readingAlignment: Math.abs(form.left - rail.left - gutter) < 1 && Math.abs(form.right - rail.right + gutter) < 1,
          minimumActionHeight: Math.min(...buttons.map(button => button.getBoundingClientRect().height)) };
      });
      expect(geometry).toEqual({ overflow: false, stopCount: 1, composerFits: true, railFits: true, readingAlignment: true, minimumActionHeight: touch ? 44 : 32 });
      await page.locator('.desktop-thread').evaluate(thread => { thread.scrollTop = thread.scrollHeight; });
      const captureRetries = await capture(page, `conversation-${width}-${theme}.png`);
      await details.evaluate(node => { node.open = false; });
      await page.locator('.desktop-thread').evaluate(thread => { thread.scrollTop = 0; });
      await capture(page, `conversation-reading-${width}-${theme}.png`);
      await page.setContent(`<style>${css}\nhtml,body,#root{margin:0;width:100%;height:100%;}</style><main id="root" class="environment-shell environment-workspace">${retryMarkup}</main>`);
      await page.evaluate(value => document.documentElement.setAttribute('data-theme', value), theme);
      const retry = page.getByRole('button', { name: 'Retry loading agents' });
      await retry.focus();
      const retryGeometry = await retry.evaluate(button => { const r = button.getBoundingClientRect(); return { fits: r.x >= 0 && r.right <= innerWidth && r.y >= 0 && r.bottom <= innerHeight, height: r.height, focused: document.activeElement === button }; });
      expect(retryGeometry).toEqual({ fits: true, height: touch ? 44 : 32, focused: true });
      const retryCaptureRetries = await capture(page, `start-retry-${width}-${theme}.png`);
      await writeFile(resolve(evidence, `geometry-${width}.json`), JSON.stringify({ geometry, toolRow, retryGeometry, captureRetries, retryCaptureRetries, sourceMarkupOnly: true, managedChromium: true }, null, 2));
    } finally { await context.close(); }
  });
});
