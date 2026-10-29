const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const projectRoot = path.resolve(__dirname, '../../../../..');
const { chromium } = require(require.resolve('playwright', { paths: [projectRoot, path.join(projectRoot, 'backend')] }));

test('inspector selects exact elements, previews repeated edits, restores inline priorities and rejects non-parent commands', async () => {
  const browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {}) });
  try {
    const page = await browser.newPage();
    await page.setContent('<iframe></iframe>');
    await page.evaluate(() => { window.messages = []; window.addEventListener('message', e => window.messages.push(e.data)); });
    const frame = page.frames()[1];
    await frame.setContent('<main><p>Sibling</p><button style="color: red !important; width: 90px">First</button><button>Second</button></main>');
    await frame.addScriptTag({ content: fs.readFileSync(path.join(__dirname, 'inspector.js'), 'utf8') });
    await page.waitForFunction(() => window.messages.some(m => m.type === 'preview-inspector-ready'));
    const send = data => page.evaluate(data => document.querySelector('iframe').contentWindow.postMessage(data, '*'), data);
    await send({ type: 'preview-parent-ready', previewEpoch: 'fixture-document-epoch' });
    await send({ type: 'preview-inspect-mode', enabled: true });
    await frame.locator('button').first().click();
    await page.waitForFunction(() => window.messages.some(m => m.type === 'preview-element-selected'));
    const selected = await page.evaluate(() => window.messages.find(m => m.type === 'preview-element-selected').element);
    assert.equal(await page.evaluate(() => window.messages.find(m => m.type === 'preview-element-selected').previewEpoch), 'fixture-document-epoch');
    await frame.evaluate(() => window.postMessage({ type: 'preview-parent-ready', previewEpoch: 'wrong-source-epoch' }, '*'));
    await send({ type: 'preview-request-detailed-info' });
    await page.waitForFunction(() => window.messages.some(m => m.type === 'preview-detailed-info'));
    assert.equal(await page.evaluate(() => window.messages.find(m => m.type === 'preview-detailed-info').previewEpoch), 'fixture-document-epoch');
    await send({ type: 'preview-parent-ready', previewEpoch: 'next-document-epoch' });
    await send({ type: 'preview-request-detailed-info' });
    await page.waitForFunction(() => window.messages.some(m => m.type === 'preview-detailed-info' && m.previewEpoch === 'next-document-epoch'));
    assert.equal(selected.tagName, 'button');
    assert.equal(selected.rect.width, 90);
    assert.equal(await frame.locator(selected.fullSelector).count(), 1);
    assert.equal(await frame.locator(selected.fullSelector).textContent(), 'First');
    await send({ type: 'preview-apply-style-preview', elementId: selected.elementId, styles: { color: 'blue', width: '110px' } });
    await frame.waitForFunction(() => document.querySelector('button').style.width === '110px');
    await send({ type: 'preview-apply-style-preview', elementId: selected.elementId, styles: { color: 'green', width: '130px' } });
    await frame.waitForFunction(() => document.querySelector('button').style.width === '130px');
    await send({ type: 'preview-revert-style-preview' });
    await frame.waitForFunction(() => document.querySelector('button').style.width === '90px');
    assert.equal(await frame.locator('button').first().evaluate(el => el.style.getPropertyPriority('color')), 'important');
    assert.equal(await frame.locator('button').first().evaluate(el => el.style.color), 'red');
    await frame.evaluate(id => window.postMessage({ type: 'preview-apply-style-preview', elementId: id, styles: { width: '999px' } }, '*'), selected.elementId);
    await frame.waitForTimeout(50);
    assert.equal(await frame.locator('button').first().evaluate(el => el.style.width), '90px');
    await send({ type: 'preview-clear-selection' });
    await send({ type: 'preview-inspect-mode', enabled: false });
    await frame.locator('button').first().click();
    assert.equal(await page.evaluate(() => window.messages.filter(m => m.type === 'preview-element-selected').length), 1);
  } finally { await browser.close(); }
});


test('mobile tap selection can preview and revert an element styling', async () => {
  const browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {}) });
  try {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    const page = await context.newPage();
    await page.setContent('<iframe style="width:350px;height:500px"></iframe>');
    await page.evaluate(() => { window.messages = []; window.addEventListener('message', e => window.messages.push(e.data)); });
    const frame = page.frames()[1];
    await frame.setContent('<button>Tap me</button>');
    await frame.addScriptTag({ content: fs.readFileSync(path.join(__dirname, 'inspector.js'), 'utf8') });
    const send = data => page.evaluate(data => document.querySelector('iframe').contentWindow.postMessage(data, '*'), data);
    await send({ type: 'preview-inspect-mode', enabled: true });
    await frame.locator('button').tap();
    await page.waitForFunction(() => window.messages.some(m => m.type === 'preview-element-selected'));
    const id = await page.evaluate(() => window.messages.find(m => m.type === 'preview-element-selected').element.elementId);
    const originalStyle = await frame.locator('button').getAttribute('style');
    await send({ type: 'preview-apply-style-preview', elementId: id, styles: { color: 'blue' } });
    await frame.waitForFunction(() => document.querySelector('button').style.color === 'blue');
    await send({ type: 'preview-revert-style-preview' });
    await frame.waitForTimeout(100);
    assert.equal((await frame.locator('button').getAttribute('style')) || '', originalStyle || '');
    await context.close();
  } finally { await browser.close(); }
});
