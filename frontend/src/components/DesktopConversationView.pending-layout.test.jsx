import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from '@playwright/test';
import { render } from '@testing-library/react';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { DesktopConversationView } from './DesktopConversationView';
import { DesktopStatusBar } from './DesktopStatusBar';

vi.mock('../contexts/AutocorrectContext', () => ({ useAutocorrect: () => ({ autocorrectEnabled: false, toggleAutocorrect() {} }) }));
vi.mock('../hooks/useAutocorrectInput', () => ({ useAutocorrectInput: () => ({ handleKeyDown() {}, handleSelectionChange() {} }) }));
vi.mock('./TerminalMicButton', () => ({ TerminalMicButton: () => null }));

const enabled = process.env.E2E_CHAT_LAYOUT === '1';
let browser, markup, css;
beforeAll(async () => {
  if (!enabled) return;
  const view = render(<div className="terminal-with-status"><div className="desktop-terminal-stack">
    <div className="desktop-conversation-surface"><DesktopConversationView turns={[]} mode="structured" showHeader={false} aiType="codex" connectionState="online" isSendReady isStreaming
      structuredMessages={[{ role: 'user', messageId: 'question', content: 'Review this action.' }, { role: 'assistant', messageId: 'reply', content: 'Here is the action.' }]}
      pendingApproval={{ approvalId: 'synthetic-id', toolName: 'Bash', description: 'Run the exact command?', toolInput: { command: 'npm test' } }} onApprove={() => {}} /></div>
    <DesktopStatusBar sessionId="synthetic-layout" compactConversation composerValue="Unsent draft" onComposerChange={() => {}} onComposerSubmit={() => {}}
      isStreaming onInterrupt={() => {}} showTopRow={false} showComposerFooter={false} showImageButton={false} showAiSelector={false} showMicButtons={false} />
  </div></div>);
  markup = view.container.innerHTML;
  view.unmount();
  css = (await Promise.all(['styles.css', 'ProUI.css', 'WorkspaceShell.css', 'WorkspaceUI.css', 'components/TerminalPane.css', 'components/DesktopConversationView.css', 'components/DesktopComposer.css']
    .map(file => readFile(resolve(process.cwd(), 'src', file), 'utf8')))).join('\n');
  const runtime = resolve(process.cwd(), '../.runtime/browser');
  const manifest = JSON.parse(await readFile(resolve(runtime, 'runtime.json'), 'utf8'));
  browser = await chromium.launch({ executablePath: resolve(runtime, manifest.chromium), headless: true });
});
afterAll(async () => { await browser?.close(); }, 30000);

describe.skipIf(!enabled)('pending request layout in managed Chromium', () => {
  it.each([{ width: 1280, height: 900 }, { width: 390, height: 844 }])('keeps the request and composer reachable at $width', async ({ width, height }) => {
    const context = await browser.newContext({ viewport: { width, height } });
    try {
      const page = await context.newPage();
      await page.route('**/*', route => route.abort());
      await page.setContent(`<style>${css}\nhtml,body,#root{margin:0;width:100%;height:100%;}</style><main id="root" class="environment-shell environment-workspace">${markup}</main>`);
      const geometry = await page.evaluate(() => {
        const rail = document.querySelector('.desktop-pending-requests').getBoundingClientRect();
        const composer = document.querySelector('.workspace-composer').getBoundingClientRect();
        const approval = document.querySelector('[aria-label="Approval required"]');
        return { noHorizontalOverflow: document.documentElement.scrollWidth <= innerWidth,
          outsideTranscript: !document.querySelector('.desktop-thread').contains(approval),
          adjacent: rail.bottom <= composer.top + 1 && rail.top >= 0,
          composerFits: composer.right <= innerWidth && composer.bottom <= innerHeight,
          actions: approval.querySelectorAll('button').length };
      });
      expect(geometry).toEqual({ noHorizontalOverflow: true, outsideTranscript: true, adjacent: true, composerFits: true, actions: 2 });
    } finally { await context.close(); }
  });
});
