import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';

test.skip(process.env.E2E_LOCAL_TESTING !== '1', 'Requires an isolated local testing server.');
test.use({ launchOptions: { executablePath: process.env.E2E_LOCAL_BROWSER }, viewport: { width: 393, height: 684 }, isMobile: true, hasTouch: true });

const session = {
  id: 'ss-mobile-conversation-layout', provider: 'codex', runtime: 'codex',
  title: 'Review the terminal UI', cwd: '/tmp/mobile-layout-fixture', status: 'completed',
  model: 'gpt-6.1-sol', reasoning: 'high', serviceTier: 'default',
  createdAt: '2026-10-25T10:00:00Z', updatedAt: '2026-10-25T10:00:00Z',
};
const content = `The mobile workspace should make the conversation easy to read.

I checked the layout, navigation, and command composer. The main changes are:

- Keep the session controls compact.
- Leave room for the conversation.
- Keep important actions easy to reach.

### Verification

The terminal now keeps long code lines inside their own scroll area:

\`\`\`sh
printf '%s\\n' 'A deliberately long command to verify that code does not force the entire phone screen to scroll sideways'
\`\`\`

**The conversation remains the focus.** You can scroll through the response and continue with a follow-up.`;
const transcript = [
  { type: 'message_completed', role: 'user', content: 'Can you review this project and explain what changed?', messageId: 'user', turnId: 'turn', seq: 1 },
  { type: 'message_completed', role: 'assistant', content, messageId: 'assistant', turnId: 'turn', seq: 2 },
  { type: 'turn_completed', turnId: 'turn', status: 'completed', seq: 3 },
];

test.beforeEach(async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.route('**/api/agent/catalog*', route => route.fulfill({ json: { agents: [{
    id: 'codex', label: 'Codex', runtime: 'codex', available: true, status: 'ready',
    models: [{ id: 'gpt-6.1-sol', label: 'GPT-6.1-Sol', default: true }, { id: 'gpt-6-astra', label: 'GPT-6-Astra' }],
    reasoningLevels: ['low', 'medium', 'high'],
  }] } }));
  await page.route(/\/api\/structured\/sessions(?:\?.*)?$/, route => route.fulfill({ json: [session] }));
  await page.route(`**/api/structured/sessions/${session.id}`, route => route.fulfill({ json: session }));
  await page.routeWebSocket(`**/api/structured/sessions/${session.id}/ws*`, ws => {
    for (const event of transcript) ws.send(JSON.stringify({ __terminal_meta: true, type: 'structured_event', event }));
  });
  await page.goto('/');
  await page.getByLabel('Username', { exact: true }).fill(`mobile-${randomUUID()}`);
  await page.getByRole('button', { name: 'Open workspace', exact: true }).click();
  await expect(page.getByText('The conversation remains the focus.', { exact: true })).toBeVisible();
});

test('a multiline mobile draft stays readable when the composer loses focus', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 640 });
  const composer = page.getByRole('textbox', { name: 'Command composer', exact: true });
  const draft = 'Please keep this longer draft visible after I open another control.';
  await composer.fill(draft);
  await composer.blur();
  await expect(composer).toHaveValue(draft);
  await expect.poll(() => composer.evaluate(node => node.scrollHeight <= node.clientHeight + 1)).toBe(true);
});

test('mobile composer exposes model controls and preserves its draft when changing models', async ({ page }) => {
  const changes: unknown[] = [];
  await page.route(`**/api/structured/sessions/${session.id}/selection`, async route => {
    const selection = route.request().postDataJSON();
    changes.push(selection);
    await route.fulfill({ json: { ...session, ...selection } });
  });
  const composer = page.getByRole('textbox', { name: 'Command composer', exact: true });
  await composer.fill('Keep this draft while I choose a different model.');
  const settings = page.getByRole('button', { name: /^Model settings:/ });
  await expect(settings).toBeInViewport();
  await settings.click();
  await page.getByRole('option', { name: 'GPT-6-Astra', exact: true }).click();
  await expect.poll(() => changes.length).toBe(1);
  expect(changes).toEqual([{ model: 'gpt-6-astra', reasoning: 'high' }]);
  await expect(settings).toContainText('gpt-6-astra');
  await expect(settings).toHaveAccessibleName(/gpt-6-astra/i);
  await page.getByRole('button', { name: 'Reasoning: High', exact: true }).click();
  await page.getByRole('option', { name: 'Medium', exact: true }).click();
  await expect.poll(() => changes.length).toBe(2);
  await page.getByRole('button', { name: 'Speed: Standard', exact: true }).click();
  await page.getByRole('option', { name: 'Fast', exact: true }).click();
  await expect.poll(() => changes.length).toBe(3);
  expect(changes).toEqual([
    { model: 'gpt-6-astra', reasoning: 'high' },
    { model: 'gpt-6-astra', reasoning: 'medium' },
    { model: 'gpt-6-astra', reasoning: 'medium', serviceTier: 'fast' },
  ]);
  await expect(composer).toHaveValue('Keep this draft while I choose a different model.');
});

test('first-open model settings keep all controls compact while the catalog loads', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 320, height: 402 });
  let releaseCatalog!: () => void;
  const held = new Promise<void>(resolve => { releaseCatalog = resolve; });
  await page.route('**/api/agent/catalog*', async route => { await held; await route.fallback(); });
  const trigger = page.getByRole('button', { name: /^Model settings:/ });
  await trigger.click();
  const dialog = page.getByRole('dialog', { name: 'Conversation model settings', exact: true });
  await expect(dialog).toBeInViewport({ ratio: 1 });
  await expect(dialog.getByRole('combobox')).toHaveCount(0);
  await expect(dialog.getByRole('searchbox', { name: 'Search Codex models' })).toBeVisible();
  const before = await dialog.boundingBox();
  await expect(dialog.getByRole('button', { name: 'Reasoning: High' })).toBeDisabled();
  releaseCatalog();
  const model = dialog.getByRole('option', { name: 'GPT-6.1-Sol', exact: true });
  await expect(model).toBeEnabled();
  expect((await dialog.boundingBox())!.height).toBe(before!.height);
  expect((await model.boundingBox())!.height).toBe(44);
  await expect(dialog.getByRole('button', { name: 'Speed: Standard' })).toBeInViewport({ ratio: 1 });
  await expect(page.locator('#root')).toHaveJSProperty('inert', true);
  const close = dialog.getByRole('button', { name: 'Close model settings', exact: true });
  const speed = dialog.getByRole('button', { name: 'Speed: Standard' });
  await close.focus();
  await page.keyboard.press('Shift+Tab');
  await expect(speed).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(close).toBeFocused();
  await page.screenshot({ path: testInfo.outputPath('model-settings-small-phone.png') });
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await expect(page.locator('#root')).toHaveJSProperty('inert', false);
  await trigger.click();
  await expect(dialog).toBeInViewport({ ratio: 1 });
  await page.setViewportSize({ width: 393, height: 684 });
  await expect(dialog).toBeInViewport({ ratio: 1 });
  await expect.poll(async () => { const composer = await page.locator('.status-composer-shell').boundingBox(); return Math.abs(composer!.y + composer!.height - 684); }).toBeLessThan(3);
  await expect.poll(async () => { const panel = await dialog.boundingBox(); const button = await trigger.boundingBox(); return Math.abs(panel!.y + panel!.height - button!.y + 8); }).toBeLessThan(2);
  await page.screenshot({ path: testInfo.outputPath('model-settings-phone.png') });
  await page.getByRole('button', { name: 'Close model settings', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await trigger.click();
  await page.locator('.mobile-model-backdrop').click({ position: { x: 4, y: 4 } });
  await expect(dialog).toHaveCount(0);
});

test('model search and keyboard navigation keep settings in a single popup', async ({ page }, testInfo) => {
  await page.getByRole('button', { name: /^Model settings:/ }).click();
  const dialog = page.getByRole('dialog', { name: 'Conversation model settings', exact: true });
  const search = dialog.getByRole('searchbox', { name: 'Search Codex models' });
  await search.fill('astra');
  await expect(dialog.getByRole('option')).toHaveCount(1);
  await search.press('ArrowDown');
  await expect(dialog.getByRole('option', { name: 'GPT-6-Astra', exact: true })).toBeFocused();
  await search.fill('nothing-matches');
  await expect(dialog.getByText('No models match your search.')).toBeVisible();
  await search.fill('');
  await dialog.getByRole('button', { name: 'Reasoning: High' }).click();
  await expect(dialog.getByRole('listbox', { name: 'Reasoning effort' })).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(1);
  await page.screenshot({ path: testInfo.outputPath('reasoning-menu.png') });
  await page.keyboard.press('Escape');
  await expect(search).toBeVisible();
  await dialog.getByRole('button', { name: 'Speed: Standard' }).click();
  await page.screenshot({ path: testInfo.outputPath('speed-menu.png') });
  await dialog.getByRole('button', { name: 'Response speed' }).click();
  await expect(search).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
});

test('long model and speed lists stay usable on a small phone', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 402 });
  await page.route('**/api/agent/catalog*', route => route.fulfill({ json: { agents: [{
    id: 'codex', label: 'Codex', runtime: 'codex', status: 'ready', reasoningLevels: ['low', 'high'],
    models: [{ id: session.model, label: 'GPT-6.1-Sol' }, ...Array.from({ length: 24 }, (_, index) => ({ id: `model-${index}`, label: `Available model ${index}` }))],
  }] } }));
  await page.getByRole('button', { name: /^Model settings:/ }).click();
  const dialog = page.getByRole('dialog', { name: 'Conversation model settings', exact: true });
  await expect(dialog).toBeInViewport({ ratio: 1 });
  const list = dialog.getByRole('listbox', { name: 'Codex models', exact: true });
  await expect(list.getByRole('option')).toHaveCount(25);
  expect(await list.evaluate(element => element.scrollHeight > element.clientHeight)).toBe(true);
  const last = list.getByRole('option', { name: 'Available model 23', exact: true });
  await last.scrollIntoViewIfNeeded();
  await expect(last).toBeInViewport({ ratio: 1 });
  await dialog.getByRole('button', { name: 'Speed: Standard' }).click();
  const fastest = dialog.getByRole('option', { name: 'Ultrafast', exact: true });
  await fastest.scrollIntoViewIfNeeded();
  await expect(fastest).toBeInViewport({ ratio: 1 });
  await expect(dialog.getByRole('button', { name: 'Close model settings', exact: true })).toBeInViewport({ ratio: 1 });
});

test('a failed model change preserves the selection and draft and can be retried', async ({ page }) => {
  const composer = page.getByRole('textbox', { name: 'Command composer', exact: true });
  await composer.fill('Keep this draft after a failed update.');
  let fail = true;
  await page.route(`**/api/structured/sessions/${session.id}/selection`, async route => {
    if (fail) await route.fulfill({ status: 503, json: { error: 'Model is temporarily unavailable' } });
    else await route.fulfill({ json: { ...session, ...route.request().postDataJSON() } });
  });
  await page.getByRole('button', { name: /^Model settings:/ }).click();
  const dialog = page.getByRole('dialog', { name: 'Conversation model settings', exact: true });
  const model = dialog.getByRole('option', { name: 'GPT-6-Astra', exact: true });
  await model.click();
  await expect(dialog.getByRole('alert')).toHaveText('Model is temporarily unavailable');
  await expect(model).toBeEnabled();
  await expect(dialog.getByRole('option', { name: 'GPT-6.1-Sol', exact: true })).toHaveAttribute('aria-selected', 'true');
  fail = false;
  await model.click();
  await expect(model).toHaveAttribute('aria-selected', 'true');
  await expect(dialog.getByRole('alert')).toHaveCount(0);
  await page.getByRole('button', { name: 'Close model settings', exact: true }).click();
  await expect(composer).toHaveValue('Keep this draft after a failed update.');
  await page.getByLabel('More composer actions', { exact: true }).click();
  await expect(page.locator('.composer-input-options-menu')).toBeInViewport({ ratio: 1 });
});

for (const viewport of [{ width: 393, height: 684 }, { width: 320, height: 568 }]) {
  test(`conversation leaves room to read at ${viewport.width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize(viewport);
    const header = page.locator('.desktop-conversation-header');
    const form = page.locator('.status-composer-shell');
    await expect(page.locator('.layout.mobile')).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath('conversation.png') });
    const layout = await page.locator('.layout.mobile').boundingBox();
    expect(layout!.y + layout!.height).toBeCloseTo(viewport.height, 0);
    await expect(header).toHaveCount(0);
    expect((await form.boundingBox())!.height).toBeLessThanOrEqual(135);
    await form.screenshot({ path: testInfo.outputPath('composer.png') });
    const thread = await page.locator('.desktop-thread').boundingBox();
    expect(thread!.height).toBeGreaterThanOrEqual(viewport.height * 0.6);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(viewport.width);
    const composer = page.getByRole('textbox', { name: 'Command composer', exact: true });
    await expect(composer).toHaveCSS('font-size', '16px');
    await expect(composer).toHaveAttribute('placeholder', 'Message Codex…');
    const idleHeight = (await composer.boundingBox())!.height;
    expect(idleHeight).toBe(44);
    const modelTrigger = page.getByRole('button', { name: /Model settings.*gpt-6\.1-sol/i });
    const modelLabel = modelTrigger.locator('span').nth(1);
    await expect(modelLabel).toContainText('gpt-6.1-sol');
    expect(await modelLabel.evaluate(element => {
      const range = document.createRange();
      range.setStart(element.firstChild!, 0);
      range.setEnd(element.firstChild!, 'gpt-6.1'.length);
      return range.getBoundingClientRect().width + 10 <= element.clientWidth;
    })).toBe(true);
    for (const name of ['Start voice input', 'More composer actions', 'Send message']) {
      const control = page.getByLabel(name, { exact: true });
      await expect(control).toBeInViewport({ ratio: 1 });
      const bounds = await control.boundingBox();
      expect(bounds!.width).toBeGreaterThanOrEqual(44);
      expect(bounds!.height).toBeGreaterThanOrEqual(44);
    }
    await expect(page.getByRole('button', { name: 'Attach file', exact: true })).toBeInViewport({ ratio: 1 });
    await expect(form.locator('input[type="file"]')).not.toHaveAttribute('accept');
    await page.getByLabel('More composer actions', { exact: true }).click();
    const context = page.getByRole('button', { name: 'Session context', exact: true });
    await expect(context).toBeVisible();
    await context.click();
    const contextPanel = page.getByRole('dialog', { name: 'Session context', exact: true });
    await expect(contextPanel).toBeInViewport({ ratio: 1 });
    await page.screenshot({ path: testInfo.outputPath('session-context.png') });
    await page.keyboard.press('Escape');
    await expect(context).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(page.getByLabel('More composer actions', { exact: true })).toBeFocused();
    await form.tap({ position: { x: 4, y: 4 } });
    await expect(composer).toBeFocused();
    await expect.poll(async () => (await composer.boundingBox())!.height).toBeGreaterThan(idleHeight);
    await composer.tap();
    await expect(composer).toBeFocused();
    await composer.fill('First line');
    await composer.press('Enter');
    await composer.pressSequentially('Second line');
    await expect(composer).toHaveValue('First line\nSecond line');
    await composer.blur();
    await expect.poll(() => composer.evaluate(node => node.scrollHeight <= node.clientHeight + 1)).toBe(true);
    expect((await composer.boundingBox())!.height).toBeGreaterThanOrEqual(idleHeight);
    expect((await composer.boundingBox())!.height).toBeLessThanOrEqual(120);
    await expect(composer).toHaveValue('First line\nSecond line');
    await composer.focus();
    await expect(page.getByLabel('More composer actions', { exact: true })).toBeInViewport();
    await composer.fill('A follow-up with several lines\nKeep the composer readable\nKeep the conversation visible\nDo not lose this draft');
    await expect.poll(async () => (await composer.boundingBox())!.height).toBeGreaterThan(44);
    expect((await composer.boundingBox())!.height).toBeLessThanOrEqual(120);
    await composer.fill('Keep this draft while changing the viewport.');
    await page.setViewportSize({ width: viewport.width, height: 402 });
    await expect(composer).toBeInViewport();
    await expect(composer).toHaveValue('Keep this draft while changing the viewport.');
    await page.getByLabel('More composer actions', { exact: true }).click();
    await expect(page.locator('.composer-input-options-menu')).toBeInViewport({ ratio: 1 });
    await page.getByRole('button', { name: 'Session context', exact: true }).click();
    await expect(page.getByRole('dialog', { name: 'Session context', exact: true })).toBeInViewport({ ratio: 1 });
    await page.screenshot({ path: testInfo.outputPath('conversation-keyboard-height.png') });
  });
}

test('mobile conversation keeps approvals and Stop reachable', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 320, height: 568 });
  let confirmCancellation = () => {};
  await page.routeWebSocket(`**/api/structured/sessions/${session.id}/ws*`, ws => {
    for (const event of [
      ...transcript,
      { type: 'turn_started', turnId: 'running', seq: 4 },
      { type: 'message_delta', role: 'assistant', messageId: 'running-assistant', turnId: 'running', content: 'I am checking the project.', seq: 5 },
      { type: 'approval_required', approvalId: 'phone-approval', turnId: 'running', toolName: 'run_command', description: 'Check tool approval on phone', seq: 6 },
    ]) ws.send(JSON.stringify({ __terminal_meta: true, type: 'structured_event', event }));
    confirmCancellation = () => ws.send(JSON.stringify({ __terminal_meta: true, type: 'structured_event', event: { type: 'turn_completed', turnId: 'running', status: 'cancelled', seq: 7 } }));
  });
  await page.route(`**/api/structured/sessions/${session.id}/interrupt`, async route => {
    confirmCancellation();
    await route.fulfill({ json: { status: 'cancelled', cleanupConfirmed: true } });
  });
  await page.reload();
  const stop = page.getByRole('button', { name: 'Stop response', exact: true });
  await expect(stop).toBeInViewport();
  const composer = page.getByRole('textbox', { name: 'Command composer', exact: true });
  await composer.fill('Draft while the response runs');
  await expect(stop).toBeInViewport({ ratio: 1 });
  await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeInViewport({ ratio: 1 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(320);
  await page.screenshot({ path: testInfo.outputPath('mobile-running-controls.png') });
  const modelSettings = page.getByRole('button', { name: /^Model settings:/ });
  await modelSettings.click();
  await expect(page.getByRole('option', { name: 'GPT-6.1-Sol', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Reasoning: High', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Close model settings', exact: true }).click();
  await expect(page.getByText('Check tool approval on phone', { exact: true })).toBeVisible();
  const approve = page.getByRole('button', { name: 'Approve', exact: true });
  await expect(approve).toBeInViewport();
  expect((await approve.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await page.screenshot({ path: testInfo.outputPath('mobile-approval.png') });
  await stop.click();
  await expect(stop).toHaveCount(0);
  await expect(composer).toBeEnabled();
  await expect(composer).toHaveValue('Draft while the response runs');
});

for (const viewport of [{ width: 320, height: 568 }, { width: 393, height: 852 }, { width: 1440, height: 900 }]) {
  test(`background investigation activity describes a started child at ${viewport.width}px`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.routeWebSocket(`**/api/structured/sessions/${session.id}/ws*`, ws => {
      for (const event of [
        ...transcript,
        { type: 'message_completed', role: 'user', content: 'Investigate the project.', messageId: 'investigation-user', turnId: 'investigation', seq: 4 },
        { type: 'tool_started', toolName: 'delegate_task_background', toolCallId: 'child', toolInput: { prompt: 'Inspect the fixture project.' }, turnId: 'investigation', seq: 5 },
        { type: 'tool_completed', toolName: 'delegate_task_background', toolCallId: 'child', result: JSON.stringify({ status: 'running', delivery: 'The result will be delivered when the parent is ready.', operation_id: 'internal-operation' }), turnId: 'investigation', seq: 6 },
        { type: 'message_completed', role: 'assistant', content: 'The investigation is underway.', messageId: 'investigation-answer', turnId: 'investigation', seq: 7 },
        { type: 'turn_completed', turnId: 'investigation', status: 'completed', seq: 8 },
      ]) ws.send(JSON.stringify({ __terminal_meta: true, type: 'structured_event', event }));
    });
    await page.reload();
    await expect(page.getByText('The investigation is underway.', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: /^Worked(?: for |$)/ }).last().click();
    const card = page.getByRole('button', { name: /Background investigation.*Inspect the fixture project.*Started/ });
    await expect(card).toBeVisible();
    await expect(card).not.toContainText('Completed');
    await card.click();
    await expect(page.getByText('The result will be delivered when the parent is ready.', { exact: true })).toBeVisible();
    const raw = page.locator('.cc-todo-raw').filter({ hasText: 'Raw result' });
    await expect(raw).not.toHaveAttribute('open', '');
    await raw.locator('summary').click();
    await expect(raw).toContainText('internal-operation');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });

  test(`background investigation approval is readable and reachable at ${viewport.width}px`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.routeWebSocket(`**/api/structured/sessions/${session.id}/ws*`, ws => {
      for (const event of [
        ...transcript,
        { type: 'turn_started', turnId: 'delegation-turn', seq: 4 },
        { type: 'approval_required', approvalId: 'delegation-approval', turnId: 'delegation-turn', toolName: 'delegate_task_background', description: 'Internal approval description', toolInput: { prompt: 'Inspect notes in the fixture project.', workspace: '/private/tmp/terminal-v4-fixture/project-mobile', provider: 'deepseek', model: 'deepseek-chat', permission: 'read_only_child', operation_id: 'internal-operation' }, seq: 5 },
      ]) ws.send(JSON.stringify({ __terminal_meta: true, type: 'structured_event', event }));
    });
    let decision: unknown;
    await page.route(`**/api/structured/sessions/${session.id}/approve`, async route => {
      decision = route.request().postDataJSON();
      await route.fulfill({ json: { status: 'accepted', approvalId: 'delegation-approval', approved: true } });
    });
    await page.reload();
    const review = page.getByRole('group', { name: 'Approval required' });
    await expect(review.getByText('Run a read-only background investigation?')).toBeVisible();
    await expect(review.getByText('Inspect notes in the fixture project.', { exact: true })).toBeVisible();
    await expect(review.getByLabel('Approval details')).toBeHidden();
    const geometry = await review.evaluate(node => {
      const fields = node.querySelector('.structured-delegation-fields')!;
      const actions = node.querySelector('.desktop-interactive-prompt-actions')!.getBoundingClientRect();
      const approve = node.querySelector('button')!.getBoundingClientRect();
      const help = fields.nextElementSibling!.getBoundingClientRect();
      const summary = node.querySelector('summary')!.getBoundingClientRect();
      const composer = document.querySelector('.workspace-composer')!.getBoundingClientRect();
      const hit = document.elementFromPoint(approve.left + approve.width / 2, approve.top + approve.height / 2);
      return { helpVisible: help.bottom <= actions.top, detailsVisible: summary.bottom <= actions.top,
        actionsAboveComposer: approve.bottom <= composer.top, actionReachable: hit === node.querySelector('button') };
    });
    expect(geometry).toEqual({ helpVisible: true, detailsVisible: true, actionsAboveComposer: true, actionReachable: true });
    await review.getByText('More details').click();
    await expect(review.getByLabel('Approval details')).toContainText('internal-operation');
    await review.getByRole('button', { name: 'Approve', exact: true }).click();
    await expect.poll(() => decision).toEqual({ approved: true, approvalId: 'delegation-approval' });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
}

test('long background investigation details remain scrollable without hiding the decision', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 568 });
  const prompt = Array.from({ length: 30 }, (_, index) => `Inspect fixture file ${index + 1}.`).join('\n');
  const workspace = `/tmp/${'fixture-project/'.repeat(24)}`;
  await page.routeWebSocket(`**/api/structured/sessions/${session.id}/ws*`, ws => {
    for (const event of [
      ...transcript,
      { type: 'turn_started', turnId: 'long-delegation', seq: 4 },
      { type: 'approval_required', approvalId: 'long-approval', turnId: 'long-delegation', toolName: 'delegate_task_background', toolInput: { prompt, workspace, provider: 'deepseek', model: 'deepseek-chat', permission: 'read_only_child' }, seq: 5 },
    ]) ws.send(JSON.stringify({ __terminal_meta: true, type: 'structured_event', event }));
  });
  await page.reload();
  const review = page.getByRole('group', { name: 'Approval required' });
  const task = review.locator('.structured-delegation-fields pre').first();
  const project = review.locator('.structured-delegation-project');
  await expect(task).toHaveText(prompt);
  await expect(project).toHaveText(workspace);
  expect(await task.evaluate(node => node.scrollHeight > node.clientHeight)).toBe(true);
  expect(await project.evaluate(node => node.scrollHeight > node.clientHeight)).toBe(true);
  const approve = review.getByRole('button', { name: 'Approve', exact: true });
  expect(await approve.evaluate(button => {
    const bounds = button.getBoundingClientRect();
    const hit = document.elementFromPoint(bounds.left + bounds.width / 2, bounds.top + bounds.height / 2);
    return hit === button || button.contains(hit);
  })).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

for (const viewport of [{ width: 320, height: 568 }, { width: 1440, height: 900 }]) {
  test(`schedule review stays usable at ${viewport.width}px`, async ({ page }) => {
    await page.setViewportSize(viewport);
    const prompt = 'Review the project and report findings. '.repeat(300);
    const description = `Review this schedule action. Running starts an unattended task.\n${prompt}`;
    let decision: unknown;
    await page.routeWebSocket(`**/api/structured/sessions/${session.id}/ws*`, ws => {
      for (const event of [
        ...transcript,
        { type: 'turn_started', turnId: 'schedule-turn', seq: 4 },
        { type: 'approval_required', approvalId: 'schedule-approval', turnId: 'schedule-turn', toolName: 'manage_schedule', description, toolInput: { action: 'run', schedule: { name: 'Fixture', prompt } }, seq: 5 },
      ]) ws.send(JSON.stringify({ __terminal_meta: true, type: 'structured_event', event }));
    });
    await page.route(`**/api/structured/sessions/${session.id}/approve`, async route => {
      decision = route.request().postDataJSON();
      await route.fulfill({ json: { status: 'accepted', approvalId: 'schedule-approval', approved: true } });
    });
    await page.reload();
    const review = page.getByRole('group', { name: 'Approval required' });
    await expect(review.getByText('Run this schedule now? An unattended task will start.')).toBeVisible();
    const details = review.getByLabel('Approval details');
    await expect(details).toContainText(prompt.trim());
    await expect.poll(() => details.evaluate(node => node.scrollHeight > node.clientHeight)).toBe(true);
    const approve = review.getByRole('button', { name: 'Approve', exact: true });
    await approve.scrollIntoViewIfNeeded();
    await expect(approve).toBeInViewport();
    expect((await approve.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await approve.click();
    await expect.poll(() => decision).toEqual({ approved: true, approvalId: 'schedule-approval' });
  });
}

test('desktop keeps the same thread and composer hierarchy in both themes', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(page.locator('.layout:not(.mobile)')).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Command composer', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Codex model GPT-6.1-Sol', exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(1440);
  await page.screenshot({ path: testInfo.outputPath('desktop-dark.png') });
  await page.locator('.pro-sidebar-footer').getByLabel('More options', { exact: true }).click();
  await page.getByRole('button', { name: 'Toggle Theme', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await page.screenshot({ path: testInfo.outputPath('desktop-light.png') });
});
