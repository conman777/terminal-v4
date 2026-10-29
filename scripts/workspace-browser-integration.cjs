const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const { once } = require('node:events');
const { Client } = require('@modelcontextprotocol/sdk/client');
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');
const runtime = process.env.TERMINAL_V4_BROWSER_RUNTIME_DIR;
const { chromium } = require(path.join(runtime, 'node_modules/playwright'));
const manifest = require(path.join(runtime, 'runtime.json'));

async function main() {
  const origin = process.env.TERMINAL_V4_BROWSER_TEST_ORIGIN;
  const fixture = http.createServer((_req, res) => {
    res.setHeader('Content-Type', 'text/html');
    res.setHeader('Content-Security-Policy', "frame-ancestors 'none'");
    res.end(`<title>Shared browser fixture</title><style>body{font:20px system-ui;padding:30px;background:#eef3f7;color:#152131}input,button{font:inherit;padding:10px}</style><h1>Built-in shared browser</h1><label>Name <input id="name"></label><button onclick="document.title=document.querySelector('#name').value">Apply</button><button onclick="const answer=prompt('Synthetic browser prompt','DEFAULT_BROWSER_PROMPT');document.title=answer===null?'PROMPT_CANCELLED':answer">Ask name</button>`);
  });
  fixture.listen(0, '127.0.0.1'); await once(fixture, 'listening');
  const site = `http://127.0.0.1:${fixture.address().port}`;
  const token = process.env.TERMINAL_V4_BROWSER_TEST_APP_TOKEN;
  async function appRequest(url, method = 'GET', body, other = false) {
    const response = await fetch(origin + url, { method, headers: { Authorization: `Bearer ${other ? process.env.TERMINAL_V4_BROWSER_TEST_OTHER_TOKEN : token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return response;
  }
  const settings = await appRequest('/api/agent/browser', 'PUT', { enabled: true, executable: null, headless: true, timeoutSeconds: 15, allowedOrigins: [site] });
  assert.equal(settings.status, 200);
  const browser = await chromium.launch({ executablePath: path.join(runtime, manifest.chromium), headless: true, chromiumSandbox: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 960 } });
  const page = await context.newPage(); const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const client = new Client({ name: 'terminal-v4-owned-browser-integration', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(origin + '/api/workspace-browser/mcp'), { requestInit: { headers: { Authorization: 'Bearer ' + process.env.TERMINAL_V4_BROWSER_TEST_MCP_TOKEN } } });
  try {
    await page.goto(origin);
    await page.evaluate(({ token, user }) => { localStorage.setItem('terminal_access_token', token); localStorage.setItem('terminal_user', JSON.stringify(user)); }, { token, user: JSON.parse(process.env.TERMINAL_V4_BROWSER_TEST_USER) });
    await page.reload(); await page.getByRole('button', { name: 'Browser', exact: true }).waitFor();
    await page.getByRole('button', { name: 'Browser', exact: true }).click();
    await page.waitForFunction(() => {
      const button = document.querySelector('button[aria-label="New browser tab"]');
      return !!button && !button.disabled;
    });
    console.log('MCP connect'); await client.connect(transport); console.log('MCP connected');
    const tools = await client.listTools(); assert.ok(tools.tools.some(tool => tool.name === 'browser_snapshot'));
    async function call(name, args = {}, allow = true) {
      console.log('START ' + name);
      const result = client.callTool({ name, arguments: args });
      if (name !== 'browser_release_control') {
        await page.getByRole('button', { name: allow ? 'Allow once' : 'Deny', exact: true }).waitFor();
        await page.getByRole('button', { name: allow ? 'Allow once' : 'Deny', exact: true }).click();
      }
      const response = await result; console.log('END ' + name + (response.isError ? ' ERROR ' + response.content?.[0]?.text : ' OK')); return response;
    }
    let result = await call('browser_open', { url: site }); assert.equal(result.isError, false);
    const tab = JSON.parse(result.content[0].text).tabId;
    await page.getByRole('tab', { name: 'Shared browser fixture', exact: true }).waitFor();
    result = await call('browser_snapshot', { tabId: tab }); assert.equal(result.isError, false);
    const snapshot = JSON.parse(result.content[0].text);
    const name = snapshot.elements.find(row => row.name === 'Name'), button = snapshot.elements.find(row => row.name === 'Apply');
    assert.ok(name && button);
    result = await call('browser_type', { tabId: tab, ref: name.ref, text: 'AGENT_IN_SHARED_BROWSER' }); assert.equal(result.isError, false);
    result = await call('browser_click', { tabId: tab, ref: button.ref }); assert.equal(result.isError, false);
    await page.getByRole('tab', { name: 'AGENT_IN_SHARED_BROWSER', exact: true }).waitFor();
    await page.waitForFunction(() => !!document.querySelector('.workspace-browser-surface img')?.naturalWidth);
    assert.equal(await page.locator('iframe').count(), 0);
    await page.getByRole('button', { name: 'Take control', exact: true }).click();
    await page.getByRole('button', { name: 'Let agents control', exact: true }).waitFor();
    assert.equal(Math.round((await page.locator('.workspace-browser-heading').boundingBox()).height), 52);
    result = await call('browser_type', { tabId: tab, ref: name.ref, text: 'MUST_NOT_APPLY' });
    assert.equal(result.isError, true); assert.match(result.content[0].text, /user has taken control/i);
    result = await call('browser_snapshot', { tabId: tab });
    assert.equal(JSON.parse(result.content[0].text).elements.find(row => row.ref === name.ref).value, 'AGENT_IN_SHARED_BROWSER');
    await page.getByRole('button', { name: 'Let agents control', exact: true }).click();
    result = await call('browser_type', { tabId: tab, ref: name.ref, text: 'AGENT_RESUMED' }); assert.equal(result.isError, false);
    await call('browser_click', { tabId: tab, ref: button.ref });
    await page.getByRole('tab', { name: 'AGENT_RESUMED', exact: true }).waitFor();
    const denied = client.callTool({ name: 'browser_close', arguments: { tabId: tab } });
    await page.getByRole('button', { name: 'Deny', exact: true }).waitFor();
    const pending = await (await appRequest('/api/workspace-browser/approvals')).json();
    const cross = await appRequest('/api/workspace-browser/approvals/' + pending.requests[0].id, 'POST', { approved: true }, true); assert.equal(cross.status, 404);
    await page.getByRole('button', { name: 'Deny', exact: true }).click(); assert.equal((await denied).isError, true);
    await call('browser_release_control');
    await page.waitForFunction(() => document.querySelector('.workspace-browser-ownership')?.textContent === 'Shared browser ready');
    await page.waitForTimeout(400);
    if (process.env.TERMINAL_V4_BROWSER_TEST_OUTPUT) await page.screenshot({ path: path.join(process.env.TERMINAL_V4_BROWSER_TEST_OUTPUT, 'shared-browser-desktop.png') });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole('dialog', { name: 'Browser panel', exact: true }).waitFor();
    await page.waitForFunction(() => document.querySelector('.workspace-browser-surface img')?.naturalWidth === Math.max(320, Math.floor(document.querySelector('.workspace-browser-surface').getBoundingClientRect().width)));
    await page.waitForTimeout(400);
    const mobile = await page.getByRole('dialog', { name: 'Browser panel', exact: true }).boundingBox(); assert.ok(mobile && mobile.x >= 0 && mobile.x + mobile.width <= 391);
    if (process.env.TERMINAL_V4_BROWSER_TEST_OUTPUT) await page.screenshot({ path: path.join(process.env.TERMINAL_V4_BROWSER_TEST_OUTPUT, 'shared-browser-mobile.png') });
    await page.getByRole('button', { name: 'Close browser pane', exact: true }).click();
    await page.getByRole('button', { name: 'Menu', exact: true }).click(); await page.getByRole('button', { name: 'Browser', exact: true }).click();
    await page.getByRole('tab', { name: 'AGENT_RESUMED', exact: true }).waitFor();
    await page.locator('.workspace-browser-surface').press('Tab');
    await page.locator('.workspace-browser-surface').press('Enter');
    await page.getByLabel('Browser dialog response', { exact: true }).waitFor();
    await page.waitForFunction(() => document.querySelector('input[aria-label="Browser dialog response"]')?.value === 'DEFAULT_BROWSER_PROMPT');
    const sharedSession = await (await appRequest('/api/workspace-browser/sessions', 'POST')).json();
    assert.equal((await appRequest(`/api/workspace-browser/sessions/${sharedSession.id}/command`, 'POST', { type: 'control', owner: 'human' })).status, 200);
    await page.getByRole('button', { name: 'Let agents control', exact: true }).waitFor();
    assert.equal(Math.round((await page.locator('.workspace-browser-heading').boundingBox()).height), 52);
    await page.getByLabel('Browser dialog response', { exact: true }).fill('PROMPT_DRAFT_HANDOFF');
    result = await call('browser_snapshot', { tabId: tab }); assert.equal(result.isError, true);
    await page.getByRole('button', { name: 'Let agents control', exact: true }).click();
    await page.getByRole('button', { name: 'Let agents control', exact: true }).waitFor({ state: 'hidden' });
    assert.equal(await page.getByLabel('Browser dialog response', { exact: true }).inputValue(), 'PROMPT_DRAFT_HANDOFF');
    console.log('PASS handoff retains edited prompt after an agent action fails during the dialog');
    await page.getByLabel('Browser dialog response', { exact: true }).fill('PROMPT_BROWSER_UI_OK');
    await page.getByRole('button', { name: 'OK', exact: true }).click();
    await page.getByRole('tab', { name: 'PROMPT_BROWSER_UI_OK', exact: true }).waitFor();
    assert.equal(await page.locator('.workspace-browser-dialog').count(), 0);
    console.log('PASS human browser prompt default, exact dialog decision and response through the web pane');
    assert.deepEqual(errors, []);
    console.log('PASS real MCP client + browser-pane approvals + shared managed page + takeover + owner isolation + desktop/mobile UI');
  } finally {
    await client.close().catch(() => {}); await browser.close(); fixture.closeAllConnections(); await new Promise(resolve => fixture.close(resolve));
  }
}
main().catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });
