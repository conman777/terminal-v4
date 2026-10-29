import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from '@playwright/test';
import { render } from '@testing-library/react';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { managedChromiumPath } from '../../test/managedChromium';
import { DesktopStatusBar } from '../DesktopStatusBar';
import { AgentQuestionCard } from '../AgentQuestionCard';
import { addContext, buildTerminalContext, buildThreadContext } from './composerContext';

vi.mock('../../contexts/AutocorrectContext', () => ({ useAutocorrect: () => ({ autocorrectEnabled: false, toggleAutocorrect() {} }) }));
vi.mock('../../hooks/useAutocorrectInput', () => ({ useAutocorrectInput: () => ({ handleKeyDown() {}, handleSelectionChange() {} }) }));
vi.mock('../TerminalMicButton', () => ({ TerminalMicButton: () => null }));

const enabled = process.env.E2E_COMPOSER_CONTEXT === '1';
const longTitle = 'A very long thread title that must truncate instead of widening the phone composer';
const questions = [
  { id: 'a', header: 'Theme', question: 'Which accent colour should the long-named design system use everywhere?', options: [{ label: 'Indigo', description: 'Matches the reference product and keeps contrast' }, { label: 'Amber' }] },
  { id: 'b', question: 'Name it', options: [{ label: 'Terminal' }] },
];
let browser, css, markup;

beforeAll(async () => {
  if (!enabled) return;
  const value = addContext(addContext('Unsent follow-up', buildTerminalContext({ text: 'npm test\nFAIL', label: 'Thread terminal' })), buildThreadContext({ id: 't1', title: longTitle }));
  const view = render(<div className="terminal-with-status"><div className="desktop-terminal-stack">
    <div className="structured-approval-prompt"><AgentQuestionCard questions={questions} onAnswer={() => {}} onDismiss={() => {}} /></div>
    <DesktopStatusBar sessionId="layout" compactConversation composerValue={value} onComposerChange={() => {}} onComposerSubmit={() => {}}
      mentionThreads={[{ id: 't1', title: longTitle }]} showTopRow={false} showComposerFooter={false} showImageButton={false} showAiSelector={false} showMicButtons={false} />
  </div></div>);
  markup = view.container.innerHTML;
  view.unmount();
  css = (await Promise.all(['styles.css', 'ProUI.css', 'WorkspaceShell.css', 'WorkspaceUI.css', 'components/TerminalPane.css', 'components/DesktopConversationView.css',
    'components/DesktopComposer.css', 'components/AgentQuestionCard.css'].map(file => readFile(resolve(process.cwd(), 'src', file), 'utf8')))).join('\n');
  browser = await chromium.launch({ executablePath: await managedChromiumPath(), headless: true });
});
afterAll(async () => { await browser?.close(); });

describe.skipIf(!enabled)('composer context and question panel at phone widths', () => {
  it.each([320, 390])('fits chips, counter and question options without horizontal overflow at %ipx', async width => {
    const context = await browser.newContext({ viewport: { width, height: 800 }, hasTouch: true, isMobile: true });
    try {
      const page = await context.newPage();
      await context.route('**/*', route => route.abort());
      await page.setContent(`<meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}\nhtml,body,#root{margin:0;width:100%;}</style><main id="root" class="environment-shell environment-workspace">${markup}</main>`);
      const geometry = await page.evaluate(() => {
        const inside = node => { const box = node.getBoundingClientRect(); return box.left >= 0 && box.right <= innerWidth; };
        const chips = [...document.querySelectorAll('.composer-context-chip')];
        const remove = [...document.querySelectorAll('.composer-context-chip button')];
        const options = [...document.querySelectorAll('.agent-question-option')];
        return { overflow: document.documentElement.scrollWidth > innerWidth, chipCount: chips.length, chipsFit: chips.every(inside),
          removeTargets: Math.min(...remove.map(node => Math.min(node.getBoundingClientRect().width, node.getBoundingClientRect().height))) >= 44,
          optionsFit: options.every(inside), optionHeights: Math.min(...options.map(node => node.getBoundingClientRect().height)) >= 44,
          counters: [...document.querySelectorAll('.agent-question-counter')].map(node => node.textContent) };
      });
      expect(geometry).toEqual({ overflow: false, chipCount: 2, chipsFit: true, removeTargets: true, optionsFit: true, optionHeights: true, counters: ['1/2', '2/2'] });
    } finally { await context.close(); }
  });
});
