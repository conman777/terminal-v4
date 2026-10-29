import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from '@playwright/test';
import { managedChromiumPath } from '../test/managedChromium';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { setUser } from '../utils/auth';
import { WorkspaceStartView } from './WorkspaceStartView';

const mocks = vi.hoisted(() => ({ available: false, upload: vi.fn() }));
vi.mock('../utils/api', () => ({ apiFetch: async url => ({ ok: true, json: async () => String(url).startsWith('/api/agent/catalog')
  ? { agents: [{ id: 'codex', label: 'Codex', runtime: 'v4', available: mocks.available, status: 'not-installed', capabilities: { structured: true },
    models: [{ id: 'synthetic-model', label: 'Synthetic model', default: true }] }] } : {} }), uploadScreenshot: (...args) => mocks.upload(...args) }));
vi.mock('../contexts/AutocorrectContext', () => ({ useAutocorrect: () => ({ autocorrectEnabled: false, toggleAutocorrect() {} }) }));
vi.mock('../hooks/useAutocorrectInput', () => ({ useAutocorrectInput: () => ({ handleKeyDown() {}, handleSelectionChange() {} }) }));
vi.mock('./TerminalMicButton', () => ({ TerminalMicButton: () => null }));

const enabled = process.env.E2E_CHAT_LAYOUT === '1';
const evidence = resolve(process.cwd(), '../output/overnight-polish-20261025/chat');
let browser, css;
beforeEach(() => { localStorage.clear(); setUser({ id: 'fixture-user' }); mocks.available = false; mocks.upload.mockReset(); });
beforeAll(async () => {
  if (!enabled) return;
  css = (await Promise.all(['styles.css', 'ProUI.css', 'WorkspaceShell.css', 'WorkspaceUI.css', 'components/DesktopComposer.css',
    'components/ComposerPicker.css', 'components/AgentModelPicker.css', 'components/ModelSettingsPopover.css']
    .map(file => readFile(resolve(process.cwd(), 'src', file), 'utf8')))).join('\n');
  browser = await chromium.launch({ executablePath: await managedChromiumPath(), headless: true });
  await mkdir(evidence, { recursive: true });
});
afterAll(async () => { await browser?.close(); });

describe.skipIf(!enabled)('workspace launch prerequisites with managed Chromium', () => {
  it('renders an actionable unsupported-image rejection while retaining the phone start draft', async () => {
    mocks.available = true;
    const submit = vi.fn();
    const view = render(<WorkspaceStartView currentPath="/synthetic/project" onSubmitPrompt={submit} />);
    const composer = screen.getByRole('textbox', { name: 'Command composer' });
    fireEvent.change(composer, { target: { value: 'Use the screenshot to fix this' } });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Start task' })).toBeEnabled());
    fireEvent.drop(composer.closest('form'), { dataTransfer: { types: ['Files'], files: [new File(['synthetic'], 'start-image.png', { type: 'image/png' })] } });
    const message = 'Images cannot be attached on this screen. Open a conversation to add images.';
    expect(await screen.findByRole('alert')).toHaveTextContent(message);
    expect(mocks.upload).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
    const markup = view.container.innerHTML;
    view.unmount();
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true });
    try {
      const page = await context.newPage();
      await context.route('**/*', route => route.abort());
      await page.setContent(`<style>${css}</style><main class="environment-shell environment-workspace" style="height:100%">${markup}</main>`);
      const geometry = await page.getByRole('alert').evaluate(element => {
        const r = element.getBoundingClientRect();
        return { fits: r.x >= 0 && r.right <= innerWidth && r.y >= 0 && r.bottom <= innerHeight,
          noHorizontalOverflow: document.documentElement.scrollWidth === innerWidth,
          message: element.textContent, text: document.querySelector('textarea').value,
          attachmentCount: document.querySelectorAll('.status-composer-attachment-name').length };
      });
      expect(geometry).toEqual({ fits: true, noHorizontalOverflow: true, message, text: 'Use the screenshot to fix this', attachmentCount: 0 });
      let captureRetries = 0;
      for (;;) {
        try { await page.screenshot({ path: resolve(evidence, 'start-image-rejected-390-dark.png'), animations: 'disabled' }); break; }
        catch (error) {
          if (captureRetries >= 2 || !String(error.message).includes('Unable to capture screenshot')) throw error;
          captureRetries += 1;
          await page.evaluate(() => new Promise(requestAnimationFrame));
        }
      }
      await writeFile(resolve(evidence, 'start-image-rejected-390.json'), JSON.stringify({ geometry, captureRetries, sourceMarkupOnly: true }, null, 2));
    } finally { await context.close(); }
  });

  it.each([
    { name: 'missing-project', width: 390, height: 844, path: undefined, hint: 'Choose a project before starting a task.' },
    { name: 'unavailable-agent', width: 390, height: 844, path: '/synthetic/project', hint: 'Codex is unavailable. Complete agent setup on this host, then recheck availability.' },
    { name: 'unavailable-agent', width: 800, height: 700, path: '/synthetic/project', hint: 'Codex is unavailable. Complete agent setup on this host, then recheck availability.' },
  ])('shows the $name prerequisite at $width without inviting a blocked Send', async ({ name, width, height, path, hint }) => {
    const view = render(<WorkspaceStartView currentPath={path} onSubmitPrompt={() => {}} onAddWorkspace={() => {}} />);
    await screen.findByRole('button', { name: /Codex model Synthetic model/ });
    expect(screen.getByText(hint)).toBeVisible();
    const markup = view.container.innerHTML;
    view.unmount();
    const context = await browser.newContext({ viewport: { width, height }, hasTouch: width < 600 });
    try {
      const page = await context.newPage();
      await context.route('**/*', route => route.abort());
      await page.setContent(`<style>${css}</style><main class="environment-shell environment-workspace" style="height:100%">${markup}</main>`);
      const geometry = await page.locator('.workspace-start-hint').evaluate(element => {
        const r = element.getBoundingClientRect();
        return { hintFits: r.x >= 0 && r.right <= innerWidth && r.y >= 0 && r.bottom <= innerHeight,
          noHorizontalOverflow: document.documentElement.scrollWidth === innerWidth, text: element.textContent,
          sendDisabled: document.querySelector('[aria-label="Start task"]').disabled,
          composerEditable: !document.querySelector('textarea').disabled,
          readyHintAbsent: !document.body.textContent.includes('Project selected. Describe your task above, then send to start.') };
      });
      expect(geometry).toEqual({ hintFits: true, noHorizontalOverflow: true, text: hint, sendDisabled: true, composerEditable: true, readyHintAbsent: true });
      let captureRetries = 0;
      for (;;) {
        try { await page.screenshot({ path: resolve(evidence, `start-${name}-${width}.png`), animations: 'disabled' }); break; }
        catch (error) {
          if (captureRetries >= 2 || !String(error.message).includes('Unable to capture screenshot')) throw error;
          captureRetries += 1;
          await page.evaluate(() => new Promise(requestAnimationFrame));
        }
      }
      await writeFile(resolve(evidence, `start-${name}-${width}.json`), JSON.stringify({ geometry, captureRetries, sourceMarkupOnly: true }, null, 2));
    } finally { await context.close(); }
  });
});
