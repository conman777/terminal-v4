import { expect, test } from '@playwright/test';
import { expectFits, fixtureDraft, installFixture, managedChromium, openUtility, settingsSections, shellCommand, toolTabs } from './ui-unification-fixture';

test.skip(process.env.E2E_UI_UNIFICATION !== '1', 'Opt in only against the authorized local-testing gateway; never a live account.');
test.skip(!process.env.BASE_URL, 'Set BASE_URL to the explicit local-testing server under test; this spec has no default host.');
test.use({ baseURL: process.env.BASE_URL, launchOptions: { executablePath: managedChromium } });

test.describe('small phone workspace start', () => {
  test.use({ viewport: { width: 320, height: 568 }, hasTouch: true, isMobile: true });
  test('starts a task without the model control covering send', async ({ page }, testInfo) => {
    const fixture = await installFixture(page, testInfo);
    try {
      await fixture.login();
      const start = page.getByRole('region', { name: 'Workspace start', exact: true });
      await start.getByRole('textbox', { name: 'Command composer', exact: true }).fill('Review the responsive workspace layout.');
      await start.getByRole('button', { name: 'Project', exact: true }).click();
      await page.getByRole('menuitemradio', { name: 'tmp /tmp', exact: true }).click();
      const input = start.getByRole('textbox', { name: 'Command composer', exact: true });
      await expect.poll(() => input.evaluate(node => node.scrollHeight <= node.clientHeight + 1)).toBe(true);
      await fixture.screenshot('start-controls');
      await start.getByRole('button', { name: 'Start task', exact: true }).click();
      await expect(page.getByText('The workspace now keeps a clear reading rail.', { exact: false })).toBeVisible();
      fixture.passed();
    } finally { await fixture.finish(); }
  });
});

for (const width of [320, 1280]) {
  test(`chooses a worktree base at ${width}px without losing the prompt`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 800 });
    const fixture = await installFixture(page, testInfo);
    const requests: unknown[] = [];
    try {
      await page.route('**/api/workspace/git/branches?*', async route => {
        if (route.request().method() !== 'GET') return route.fallback();
        await route.fulfill({ status: 200, json: { branches: ['refs/heads/main', 'refs/remotes/origin/stable'], truncated: false } });
      });
      await page.route('**/api/workspace/git/worktrees', async route => {
        if (route.request().method() !== 'POST') return route.fallback();
        requests.push(route.request().postDataJSON());
        await route.fulfill({ status: 400, json: { error: 'Synthetic worktree creation stopped.' } });
      });
      await fixture.login();
      const start = page.getByRole('region', { name: 'Workspace start', exact: true });
      const composer = start.getByRole('textbox', { name: 'Command composer', exact: true });
      await composer.fill('Review the release');
      await start.getByRole('button', { name: 'Project', exact: true }).click();
      await page.getByRole('menuitemradio', { name: 'tmp /tmp', exact: true }).click();
      await start.getByRole('button', { name: 'Where', exact: true }).click();
      await page.getByRole('menuitemradio', { name: /New worktree/ }).click();
      const base = start.getByRole('textbox', { name: 'Worktree base branch or commit', exact: true });
      await expect(base).toHaveValue('HEAD');
      await start.getByRole('combobox', { name: 'Choose a base branch' }).selectOption('refs/remotes/origin/stable');
      await expect(base).toHaveValue('refs/remotes/origin/stable');
      await expectFits(page);
      await fixture.screenshot('worktree-base');
      await start.getByRole('button', { name: 'Start task', exact: true }).click();
      await expect(start.getByRole('alert')).toContainText('Synthetic worktree creation stopped.');
      await expect(composer).toHaveValue('Review the release');
      expect(requests).toEqual([{ path: '/tmp', name: 'Review the release', baseRef: 'refs/remotes/origin/stable', operationId: expect.any(String) }]);
      fixture.passed();
    } finally { await fixture.finish(); }
  });
}

test('retains a worktree request after a lost response on a phone', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 320, height: 700 });
  const fixture = await installFixture(page, testInfo);
  const requests: Record<string, string>[] = [];
  try {
    await page.route('**/api/workspace/git/worktrees', async route => {
      if (route.request().method() !== 'POST') return route.fallback();
      requests.push(route.request().postDataJSON());
      if (requests.length === 1) return route.abort();
      return route.fulfill({ json: { path: '/tmp', available: true, creationStatus: 'ready' } });
    });
    await fixture.login();
    const start = page.getByRole('region', { name: 'Workspace start', exact: true });
    const composer = start.getByRole('textbox', { name: 'Command composer', exact: true });
    await composer.fill('Keep this worktree request');
    await start.getByRole('button', { name: 'Project', exact: true }).click();
    await page.getByRole('menuitemradio', { name: 'tmp /tmp', exact: true }).click();
    await start.getByRole('button', { name: 'Where', exact: true }).click();
    await page.getByRole('menuitemradio', { name: /New worktree/ }).click();
    await start.getByRole('button', { name: 'Start task', exact: true }).click();
    await expect(start.getByText(/previous request may have created a checkout/i)).toBeVisible();
    await expect(composer).toHaveValue('Keep this worktree request');
    const button = start.getByRole('button', { name: 'Use a new worktree request' });
    expect((await button.boundingBox())?.height).toBeGreaterThanOrEqual(44);
    await expectFits(page);
    await fixture.screenshot('worktree-response-lost');
    await start.getByRole('button', { name: 'Start task', exact: true }).click();
    await expect(page.getByText('The workspace now keeps a clear reading rail.', { exact: false })).toBeVisible();
    expect(requests).toHaveLength(2);
    expect(requests[0].operationId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(requests[1]).toEqual(requests[0]);
    fixture.passed();
  } finally { await fixture.finish(); }
});

for (const profile of [
  { name: 'desktop-1440', viewport: { width: 1440, height: 1000 }, hasTouch: false },
  { name: 'intermediate-800', viewport: { width: 800, height: 1000 }, hasTouch: false },
  { name: 'touch-1024', viewport: { width: 1024, height: 1000 }, hasTouch: true },
  { name: 'phone-390', viewport: { width: 390, height: 844 }, hasTouch: true },
]) {
  test.describe(profile.name, () => {
    test.use({ viewport: profile.viewport, hasTouch: profile.hasTouch, isMobile: profile.viewport.width <= 768 });
    if ([1440, 390].includes(profile.viewport.width)) test('image thumbnail, denied upload, disabled send and removal keep the draft', async ({ page }, testInfo) => {
      test.setTimeout(45_000);
      page.setDefaultTimeout(8_000);
      const fixture = await installFixture(page, testInfo);
      try {
        await fixture.login();
        await fixture.imageConversation();
        const composer = page.getByRole('textbox', { name: 'Command composer', exact: true });
        await composer.fill(fixtureDraft);
        await expect(page.getByRole('button', { name: 'Add image', exact: true })).toBeEnabled();
        const chooser = page.waitForEvent('filechooser');
        await page.getByRole('button', { name: 'Add image', exact: true }).click();
        await (await chooser).setFiles({ name: 'ui-pixel.png', mimeType: 'image/png', buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAX+XDSwAAAABJRU5ErkJggg==', 'base64') });
        const attachments = page.getByRole('region', { name: 'Image attachments', exact: true });
        await expect(attachments.getByRole('img', { name: 'Draft image: ui-pixel.png', exact: true })).toBeVisible();
        await expect(attachments.getByRole('img', { name: 'Draft image: ui-pixel.png', exact: true })).toHaveJSProperty('naturalWidth', 1);
        await expect(attachments.getByText('Image upload failed', { exact: true })).toBeVisible();
        await expect(page.locator('.user-image-composer .status-send-btn')).toBeDisabled();
        await fixture.screenshot('image-thumbnail-upload-error-disabled-send');
        await expect.soft(attachments, 'Image feedback must not expose an internal error code').not.toContainText('upload_unconfirmed');
        await expect.soft(page.getByText('The upload receipt is invalid or expired.', { exact: true }), 'Image upload failure should be announced once').toHaveCount(1);
        await attachments.getByRole('button', { name: 'Remove image ui-pixel.png', exact: true }).click();
        await expect(attachments).toHaveCount(0);
        await expect(composer).toHaveValue(fixtureDraft);
        await fixture.screenshot('image-removed-draft-retained');
        expect(fixture.pageErrors).toEqual([]);
        fixture.passed();
      } finally { await fixture.finish(); }
    });
    test('workspace, conversation, tools and auxiliary surfaces retain usable controls', async ({ page }, testInfo) => {
      test.setTimeout(180_000);
      page.setDefaultTimeout(8_000);
      await page.emulateMedia({ reducedMotion: 'reduce' });
      const fixture = await installFixture(page, testInfo);
      try {
        await fixture.login();
        const start = page.getByRole('region', { name: 'Workspace start', exact: true });
        const draft = start.getByRole('textbox', { name: 'Command composer', exact: true });
        await expect(start.getByRole('button', { name: 'Start task', exact: true })).toBeDisabled();
        await draft.fill('Review the responsive workspace layout.');
        await start.getByRole('button', { name: 'Project', exact: true }).click();
        await page.getByRole('menuitemradio', { name: 'tmp /tmp', exact: true }).click();
        await expect(start.getByRole('button', { name: 'Start task', exact: true })).toBeEnabled();
        await start.getByRole('button', { name: 'Codex model GPT-6.1-Sol', exact: true }).click();
        const picker = page.getByRole('dialog', { name: 'Choose Codex model', exact: true });
        await expectFits(page, picker);
        await fixture.screenshot('model-picker');
        await picker.getByRole('button', { name: 'Close model settings' }).click();
        await start.getByRole('button', { name: 'Start task', exact: true }).click();
        await expect(page.getByText('The workspace now keeps a clear reading rail.', { exact: false })).toBeVisible();
        const composer = page.getByRole('textbox', { name: 'Command composer', exact: true }).filter({ visible: true });
        await composer.fill(fixtureDraft);
        await expectFits(page);
        await fixture.screenshot('conversation-dark');
        const workGroup = page.getByRole('button', { name: /^Worked for / }).first();
        if (await workGroup.isVisible()) await workGroup.click();
        const activity = page.getByRole('button', { name: 'Read layout.css Completed', exact: true });
        await activity.click();
        await expect(activity).toHaveAttribute('aria-expanded', 'true');
        await fixture.screenshot('tool-activity-expanded');
        await activity.click();
        fixture.approval();
        await expect(page.getByRole('button', { name: 'Reject', exact: true })).toBeVisible();
        await fixture.screenshot('approval');
        await page.getByRole('button', { name: 'Reject', exact: true }).click();
        await expect(page.getByRole('button', { name: 'Reject', exact: true })).toHaveCount(0);
        await expect(composer).toHaveValue(fixtureDraft);
        fixture.appendReview();
        const thread = page.locator('.desktop-thread, .chat-messages, .cc-messages').filter({ visible: true }).first();
        await expect.poll(() => thread.evaluate(node => node.scrollHeight > node.clientHeight)).toBe(true);
        await thread.evaluate(node => { node.scrollTop = 0; node.dispatchEvent(new Event('scroll', { bubbles: true })); });
        fixture.appendLatest();
        await expect(page.getByText('The latest review is ready.', { exact: false })).toHaveCount(1);
        await expect.poll(() => thread.evaluate(node => node.scrollTop)).toBeLessThanOrEqual(2);
        await fixture.screenshot('conversation-scroll-away');

        await openUtility(page, 'Settings');
        const settings = page.locator('.session-settings-modal');
        for (const section of settingsSections) {
          await settings.getByRole('button', { name: section, exact: true }).click();
          await expectFits(page, settings);
          if (section === 'Agent browser') {
            const browserSettings = settings.locator('.agent-browser-settings');
            await expect(browserSettings.getByRole('form', { name: 'Agent browser configuration', exact: true })).toBeVisible();
            const advanced = browserSettings.locator('summary').filter({ hasText: 'Advanced browser options' });
            if (await advanced.count()) await advanced.click();
            await expect(settings.getByRole('spinbutton', { name: 'Action timeout (seconds)', exact: true })).toHaveValue('15');
            await expect(settings.locator('.agent-browser-settings').getByRole('alert')).toHaveCount(0);
            if (await advanced.count()) await advanced.click();
          }
          await fixture.screenshot(`settings-${section.toLowerCase().replaceAll(' ', '-')}`);
        }
        const closeError = await settings.getByRole('button', { name: 'Close', exact: true }).click({ timeout: 1500 }).then(() => null, error => error.message);
        expect.soft(closeError, 'Settings header Close must be reachable below the environment bar').toBeNull();
        if (closeError) await settings.getByRole('button', { name: 'Cancel', exact: true }).click();
        await expect(composer).toHaveValue(fixtureDraft);

        await openUtility(page, 'Project tools');
        const tools = page.locator('.workspace-tools-dialog');
        for (const tab of toolTabs) {
          if (profile.viewport.width <= 768 && await tools.getByRole('button', { name: 'All tools', exact: true }).isVisible()) await tools.getByRole('button', { name: 'All tools', exact: true }).click();
          await tools.getByRole('tab', { name: tab, exact: true }).click();
          await expectFits(page, tools);
          if (tab === 'History') {
            await tools.getByRole('button', { name: 'Find native conversations', exact: true }).click();
            await expect(tools.getByText('Synthetic responsive layout review', { exact: true })).toBeVisible();
          }
          if (tab === 'Tasks & schedules') await expect(tools.getByRole('button', { name: 'Queue task', exact: true })).toBeDisabled();
          if (tab === 'File transfers') await expect(tools.getByRole('button', { name: 'Upload file', exact: true })).toBeDisabled();
          await fixture.screenshot(`tools-${tab.toLowerCase().replace(/[^a-z]+/g, '-')}`);
        }
        await tools.getByRole('button', { name: 'Close workspace tools', exact: true }).click();
        await expect(composer).toHaveValue(fixtureDraft);

        await openUtility(page, 'Files');
        const files = page.getByRole('region', { name: 'Files', exact: true });
        await expect(files.getByText('README.md', { exact: true })).toBeVisible();
        await expectFits(page, files);
        await fixture.screenshot('files');
        fixture.setFilesError(true);
        await files.getByTitle('Refresh', { exact: true }).click();
        await expect(files).toContainText('Synthetic directory unavailable');
        await fixture.screenshot('files-error');
        await files.getByRole('button', { name: 'Close files', exact: true }).click();

        await openUtility(page, 'Notes');
        const notes = page.locator('.notes-v2');
        await notes.locator('.notes-v2-item').filter({ hasText: 'Layout review' }).click();
        fixture.setNoteFailure(true);
        await notes.getByPlaceholder('Write something... (Markdown supported)').fill('Retain these review notes after a failed save.');
        await expect(notes.getByRole('alert')).toContainText('Could not save note');
        await expect(notes.getByPlaceholder('Write something... (Markdown supported)')).toHaveValue('Retain these review notes after a failed save.');
        await fixture.screenshot('notes-error-retains-draft');
        fixture.setNoteFailure(false);
        await notes.getByRole('button', { name: 'Retry', exact: true }).click();
        await expect(notes.locator('.notes-v2-save-status')).toHaveText('Saved');
        await notes.getByRole('button', { name: 'Close', exact: true }).click();
        await expect(notes).toHaveCount(0);
        await openUtility(page, 'Bookmarks');
        await expect(page.locator('.bookmark-modal').getByText('Inspect terminal size', { exact: true })).toBeVisible();
        await fixture.screenshot('bookmarks');
        await page.locator('.bookmark-modal').getByRole('button', { name: 'Close', exact: true }).click();
        await expect(composer).toHaveValue(fixtureDraft);
        expect(fixture.pageErrors).toEqual([]);
        fixture.passed();
      } finally { await fixture.finish(); }
    });

    test('real PTY survives Browser geometry and unsent shell drafts', async ({ page }, testInfo) => {
      test.setTimeout(90_000);
      page.setDefaultTimeout(8_000);
      await page.emulateMedia({ reducedMotion: 'reduce' });
      const fixture = await installFixture(page, testInfo);
      try {
        await fixture.login();
        if (profile.viewport.width > 768) fixture.includeSyntheticConversation();
        const sessionId = await fixture.terminal();
        await expect(page.locator('.xterm').filter({ visible: true })).toBeVisible();
        const composer = page.getByRole('textbox', { name: 'Command composer', exact: true }).filter({ visible: true });
        await composer.fill(shellCommand);
        if (profile.hasTouch) {
          await expect.soft(composer, 'Coarse-pointer input must avoid browser text zoom').toHaveCSS('font-size', '16px');
          const send = await page.getByRole('button', { name: 'Send to terminal', exact: true }).filter({ visible: true }).boundingBox();
          expect.soft(send!.width, 'Coarse-pointer send target width').toBeGreaterThanOrEqual(44);
          expect.soft(send!.height, 'Coarse-pointer send target height').toBeGreaterThanOrEqual(44);
        }
        await page.getByRole('button', { name: 'Send to terminal', exact: true }).filter({ visible: true }).click();
        await expect.poll(() => page.evaluate(async id => {
          const response = await fetch(`/api/terminal/${id}/history`, { headers: { Authorization: `Bearer ${localStorage.getItem('terminal_access_token')}` } });
          return JSON.stringify((await response.json()).history);
        }, sessionId)).toContain('ui-pty-ready');
        await expect(page.locator('.xterm').filter({ visible: true })).toBeVisible();
        const terminal = page.locator('.xterm').first();
        const renderer = await terminal.elementHandle();
        await composer.fill(fixtureDraft);
        await fixture.screenshot('real-pty');
        if (profile.viewport.width > 768) {
          const before = await fixture.ptySize(sessionId, 'before-fullscreen');
          await page.getByRole('button', { name: 'Fullscreen', exact: true }).click();
          await expect(page.getByRole('button', { name: 'Exit fullscreen', exact: true })).toBeVisible();
          expect(await renderer!.evaluate(node => node.isConnected)).toBe(true);
          await expect(composer).toHaveValue(fixtureDraft);
          const fullscreen = await fixture.ptySize(sessionId, 'fullscreen');
          expect(fullscreen.every(value => value > 0)).toBe(true);
          await fixture.screenshot('terminal-fullscreen');
          await page.getByRole('button', { name: 'Exit fullscreen', exact: true }).click();
          expect(await renderer!.evaluate(node => node.isConnected)).toBe(true);
          await expect(composer).toHaveValue(fixtureDraft);
          await expect.poll(() => fixture.ptySize(sessionId, 'restored')).toEqual(before);
          await fixture.screenshot('terminal-restored');
        }
        await openUtility(page, 'Browser');
        await expect(page.getByRole('button', { name: 'Close browser pane', exact: true })).toBeVisible();
        await expect(page.getByRole('region', { name: 'Workspace browser' }).getByRole('tab', { name: 'New tab', exact: true })).toBeVisible({ timeout: 20_000 });
        if (profile.viewport.width >= 980) {
          const resizer = page.getByRole('separator', { name: 'Resize browser panel', exact: true });
          const initialWidth = Number(await resizer.getAttribute('aria-valuenow'));
          await resizer.press('ArrowRight');
          await expect.poll(async () => Number(await resizer.getAttribute('aria-valuenow'))).toBe(initialWidth - 24);
          await resizer.press('ArrowLeft');
          await expect.poll(async () => Number(await resizer.getAttribute('aria-valuenow'))).toBe(initialWidth);
        } else {
          await expect(page.getByRole('dialog', { name: 'Browser panel', exact: true })).toBeVisible();
        }
        await fixture.screenshot('browser-open');
        await page.setViewportSize({ width: profile.viewport.width, height: profile.viewport.height - 100 });
        await page.getByRole('button', { name: 'Close browser pane', exact: true }).click();
        expect(await renderer!.evaluate(node => node.isConnected)).toBe(true);
        await expect(composer).toHaveValue(fixtureDraft);
        await page.getByRole('button', { name: 'Choose AI coder', exact: true }).filter({ visible: true }).click();
        await page.getByRole('menuitem', { name: 'Provider authentication', exact: true }).click();
        const providerAuth = page.getByRole('dialog', { name: 'Provider authentication', exact: true });
        await expect(providerAuth).toBeVisible();
        await fixture.screenshot('provider-authentication');
        const providerCloseError = await providerAuth.getByRole('button', { name: 'Close', exact: true }).click({ timeout: 1500 }).then(() => null, error => error.message);
        expect.soft(providerCloseError, 'Provider authentication Close must be reachable below the mobile header').toBeNull();
        if (providerCloseError) await page.keyboard.press('Escape');
        const browser = page.getByRole('region', { name: 'Workspace browser' });
        await openUtility(page, 'Browser');
        await expect(page.getByRole('button', { name: 'Close browser pane', exact: true })).toBeVisible();
        await expect(browser.getByRole('tab', { name: 'New tab', exact: true })).toBeVisible();
        await fixture.screenshot('browser-reopened');
        await browser.getByRole('textbox', { name: 'Browser address', exact: true }).fill('javascript:alert(1)');
        await browser.getByRole('button', { name: 'Go', exact: true }).click();
        await expect(browser.getByRole('alert')).toContainText('Use an HTTP or HTTPS address');
        await fixture.screenshot('browser-invalid-address');
        await page.getByRole('button', { name: 'Close browser pane', exact: true }).click();
        await expect(composer).toHaveValue(fixtureDraft);
        expect(await renderer!.evaluate(node => node.isConnected)).toBe(true);
        expect(fixture.pageErrors).toEqual([]);
        fixture.passed();
      } finally { await fixture.finish(); }
    });

    test('auxiliary dialogs, light theme and keyboard focus remain reachable', async ({ page }, testInfo) => {
      test.setTimeout(120_000);
      page.setDefaultTimeout(8_000);
      await page.emulateMedia({ reducedMotion: 'reduce' });
      const fixture = await installFixture(page, testInfo);
      try {
        await fixture.login();
        const composer = page.getByRole('textbox', { name: 'Command composer', exact: true });
        await composer.fill(fixtureDraft);
        await page.getByRole('button', { name: 'Switch server, This server', exact: true }).click();
        const environments = page.getByRole('dialog', { name: 'Switch server', exact: true });
        await expect(environments.getByText('No other servers connected.', { exact: true })).toBeVisible();
        await expectFits(page, environments);
        await fixture.screenshot('environments-and-remote-tools');
        await environments.getByRole('button', { name: 'Close server chooser', exact: true }).click();
        await expect(composer).toHaveValue(fixtureDraft);

        await openUtility(page, 'Settings');
        const settings = page.locator('.session-settings-modal');
        await settings.getByRole('button', { name: 'Voice', exact: true }).click();
        await settings.getByRole('button', { name: 'Open API Settings', exact: true }).click();
        const apiSettings = page.locator('.api-settings-modal');
        await expectFits(page, apiSettings);
        await fixture.screenshot('api-settings-empty');
        await apiSettings.getByRole('button', { name: '+ Add Key', exact: true }).click();
        await expect(apiSettings.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
        await fixture.screenshot('api-settings-disabled-add');
        await apiSettings.getByRole('button', { name: 'Close', exact: true }).last().click();

        await openUtility(page, 'Settings');
        await settings.getByRole('button', { name: 'Processes', exact: true }).click();
        await settings.getByRole('button', { name: 'Open Process Manager', exact: true }).click();
        const processManager = page.locator('.process-modal');
        await expectFits(page, processManager);
        await fixture.screenshot('process-manager-empty');
        await processManager.getByRole('button', { name: 'Close', exact: true }).last().click();

        await openUtility(page, 'Settings');
        await settings.getByRole('button', { name: 'Processes', exact: true }).click();
        await settings.getByRole('button', { name: 'Open System Resources', exact: true }).click();
        const resources = page.locator('.system-resources-view');
        await expect(resources.getByRole('heading', { name: 'System Resources', exact: true })).toBeVisible();
        await expect(resources).not.toContainText('NaN');
        await expectFits(page, resources);
        await fixture.screenshot('system-resources-synthetic-stats');
        await resources.getByRole('button', { name: 'Back to workspace', exact: true }).click();
        await expect.soft(composer, 'Returning from System Resources must retain the Workspace Start draft').toHaveValue(fixtureDraft);
        await composer.fill(fixtureDraft);

        if (profile.viewport.width <= 768) {
          await page.getByRole('button', { name: 'Menu', exact: true }).click();
          const menu = page.getByRole('dialog', { name: 'Mobile menu', exact: true });
          await menu.getByRole('button', { name: 'Light mode', exact: true }).click();
        } else {
          await page.locator('.pro-sidebar-footer').getByLabel('More options', { exact: true }).click();
          await page.getByRole('button', { name: 'Toggle Theme', exact: true }).filter({ visible: true }).click();
        }
        await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
        await expect(composer).toHaveValue(fixtureDraft);
        await composer.focus();
        await page.keyboard.press('Tab');
        const focused = page.locator(':focus-visible');
        await expect(focused).toHaveCount(1);
        expect(await focused.evaluate(element => {
          const css = getComputedStyle(element);
          return css.outlineStyle !== 'none' || css.boxShadow !== 'none';
        }), 'Keyboard focus must remain visible').toBe(true);
        await fixture.screenshot('light-theme-keyboard-focus');
        if (profile.viewport.width <= 768) {
          await fixture.terminal();
          await expect(page.locator('.xterm').filter({ visible: true })).toBeVisible();
        }
        const mainComposerNode = profile.viewport.width >= 980 ? await composer.elementHandle() : null;
        await openUtility(page, 'Preview');
        const preview = page.locator('.preview-panel').filter({ visible: true });
        await expect(preview).toBeVisible();
        await expect(preview.frameLocator('iframe.preview-iframe').getByRole('heading', { name: 'Workspace layout review', exact: true })).toBeVisible();
        if (profile.viewport.width >= 980) {
          await preview.getByRole('button', { name: 'More browser tools', exact: true }).click();
          await preview.getByRole('button', { name: 'Show Main Terminal', exact: true }).click();
          await expect(composer).toBeVisible();
          const divider = page.getByRole('separator', { name: 'Resize terminal and Preview', exact: true });
          const mainPane = page.locator('.main-content > .terminal-pane');
          const initial = await mainPane.boundingBox();
          await expect(divider).toHaveAttribute('aria-valuenow', '50');
          await divider.press('ArrowRight');
          await expect(divider).toHaveAttribute('aria-valuenow', '55');
          await expect.poll(async () => (await mainPane.boundingBox())!.width).toBeGreaterThan(initial!.width);
          await divider.press('Shift+ArrowLeft');
          await expect(divider).toHaveAttribute('aria-valuenow', '45');
          await divider.press('Home');
          await expect(divider).toHaveAttribute('aria-valuenow', '20');
          await divider.press('End');
          await expect(divider).toHaveAttribute('aria-valuenow', '80');
          await divider.press('Enter');
          await expect(divider).toHaveAttribute('aria-valuenow', '50');
          await divider.hover({ trial: true });
          const box = await divider.boundingBox();
          const point = { x: box!.x + box!.width / 2, y: box!.y + box!.height / 2 };
          if (profile.hasTouch) {
            const touch = await page.context().newCDPSession(page);
            await touch.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ ...point, id: 0 }] });
            await expect(divider).toHaveClass(/active/);
            await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
            await touch.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: point.x + 40, y: point.y, id: 0 }] });
            await expect.poll(async () => Number(await divider.getAttribute('aria-valuenow'))).toBeGreaterThan(50);
            await touch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
            await touch.detach();
          } else {
            await page.mouse.move(point.x, point.y);
            await page.mouse.down();
            await page.mouse.move(point.x + 40, point.y, { steps: 4 });
            await page.mouse.up();
          }
          expect(Number(await divider.getAttribute('aria-valuenow'))).toBeGreaterThan(50);
          await divider.press('Enter');
          await expect(divider).toHaveAttribute('aria-valuenow', '50');
          expect(await mainComposerNode!.evaluate(node => node.isConnected)).toBe(true);
          await expect(composer).toHaveValue(fixtureDraft);
          await fixture.screenshot('outer-preview-keyboard-pointer-resize-draft-retained');
        }
        await fixture.screenshot('preview-synthetic-project');
        if (profile.viewport.width <= 768) {
          await preview.getByRole('button', { name: 'More tools', exact: true }).click();
          await preview.getByRole('button', { name: 'Console', exact: true }).click();
          await expect(preview.getByRole('button', { name: 'Close logs', exact: true })).toBeVisible();
          await fixture.screenshot('preview-mobile-console');
          await preview.getByRole('button', { name: 'Close logs', exact: true }).click();
        } else {
          await preview.getByRole('button', { name: 'Debug', exact: true }).click();
          const devtools = preview.locator('.devtools-panel');
          for (const tab of ['Network', 'Console', 'Storage', 'WebSocket']) {
            await devtools.getByRole('button', { name: tab, exact: true }).click();
            await fixture.screenshot(`preview-devtools-${tab.toLowerCase()}`);
          }
        }
        if (profile.viewport.width <= 768) {
          await preview.getByRole('button', { name: 'Close', exact: true }).click();
        } else {
          await preview.getByRole('button', { name: 'Close browser', exact: true }).click();
        }
        await openUtility(page, 'New terminal');
        const folder = page.getByRole('dialog', { name: /^(New terminal|New thread)$/ });
        await expectFits(page, folder);
        await fixture.screenshot('new-thread-folder-browser');
        await folder.getByRole('button', { name: 'Cancel', exact: true }).click();
        expect(fixture.pageErrors).toEqual([]);
        fixture.passed();
      } finally { await fixture.finish(); }
    });
  });
}

test('fixture guard rejects provider starts, private data reads and file or share mutations', async ({ page }, testInfo) => {
  const fixture = await installFixture(page, testInfo);
  try {
    await fixture.login();
    const statuses = await page.evaluate(async () => {
      const attempts = [
        ['POST', '/api/structured/sessions/real-session/input'],
        ['POST', '/api/workspace/tasks'],
        ['POST', '/api/files/delete'],
        ['POST', '/api/collaboration/invitations'],
        ['GET', '/api/vault/real-key/reveal'],
        ['POST', '/api/workspace/native-history/import'],
        ['POST', '/api/desktop/sessions'],
      ];
      return Promise.all(attempts.map(async ([method, endpoint]) => (await fetch(endpoint, { method, headers: { 'Content-Type': 'application/json' }, ...(method === 'POST' ? { body: '{}' } : {}) })).status));
    });
    expect(statuses).toEqual([403, 403, 403, 403, 403, 403, 403]);
    expect(fixture.writes).toEqual(['POST /api/auth/local-testing']);
    fixture.passed();
  } finally { await fixture.finish(); }
});
