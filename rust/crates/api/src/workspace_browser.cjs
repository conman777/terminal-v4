const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const { randomUUID } = require('node:crypto');
const http = require('node:http');
const net = require('node:net');
const MAX_CAPTURE_BYTES = 5_500_000;
const MAX_RESPONSE_BYTES = 8_000_000;

function browserUrl(value) {
  if (typeof value !== 'string' || value.length > 8192) throw new Error('Enter an HTTP or HTTPS address.');
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Enter an HTTP or HTTPS address without embedded credentials.');
  return url.href;
}

function viewport(width, height) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 320 || width > 1920 || height < 240 || height > 1200) throw new Error('Invalid browser viewport.');
  return { width, height };
}

function imageInventorySource() {
  return typeof V4_IMAGE_INVENTORY === 'string'
    ? V4_IMAGE_INVENTORY
    : fs.readFileSync(path.join(__dirname, 'browser_image_inventory.js'), 'utf8');
}

function browserKey(value) {
  if (typeof value !== 'string' || value.length > 80) throw new Error('Unsupported browser key.');
  const parts = value.split('+'), base = parts.pop();
  const masks = { Alt: 1, Control: 2, Meta: 4, Shift: 8 };
  let modifiers = 0;
  for (const name of parts) {
    if (!Object.hasOwn(masks, name) || modifiers & masks[name]) throw new Error('Unsupported browser key.');
    modifiers |= masks[name];
  }
  const named = {
    Enter: ['Enter', 13, '\r'], Tab: ['Tab', 9, ''], Escape: ['Escape', 27, ''],
    Backspace: ['Backspace', 8, ''], Delete: ['Delete', 46, ''], Space: ['Space', 32, ' '],
    ArrowLeft: ['ArrowLeft', 37, ''], ArrowUp: ['ArrowUp', 38, ''], ArrowRight: ['ArrowRight', 39, ''], ArrowDown: ['ArrowDown', 40, ''],
    Home: ['Home', 36, ''], End: ['End', 35, ''], PageUp: ['PageUp', 33, ''], PageDown: ['PageDown', 34, ''],
  };
  let key, code, virtualKey, text;
  if (/^[a-zA-Z]$/.test(base)) {
    key = modifiers & 8 ? base.toUpperCase() : base;
    code = `Key${base.toUpperCase()}`; virtualKey = base.toUpperCase().charCodeAt(0); text = key;
  } else if (/^[0-9]$/.test(base)) {
    key = modifiers & 8 ? ')!@#$%^&*('[Number(base)] : base;
    code = `Digit${base}`; virtualKey = base.charCodeAt(0); text = key;
  } else if (Object.hasOwn(named, base)) {
    [code, virtualKey, text] = named[base]; key = base === 'Space' ? ' ' : base;
  } else if (/^F(?:[1-9]|1[0-2])$/.test(base)) {
    key = code = base; virtualKey = 111 + Number(base.slice(1)); text = '';
  } else throw new Error('Unsupported browser key.');
  if (modifiers & 7) text = '';
  return { key, code, windowsVirtualKeyCode: virtualKey, modifiers, text };
}

async function createBrowser(options = {}) {
  const runtimeRoot = fs.realpathSync(process.env.TERMINAL_V4_BROWSER_RUNTIME_DIR || path.resolve(__dirname, '../../../../.runtime/browser'));
  const manifest = JSON.parse(fs.readFileSync(path.join(runtimeRoot, 'runtime.json'), 'utf8'));
  const executablePath = fs.realpathSync(path.join(runtimeRoot, manifest.chromium));
  if (!executablePath.startsWith(runtimeRoot + path.sep)) throw new Error('Browser engine must be inside the app-owned runtime.');
  const { chromium } = require(path.join(runtimeRoot, 'node_modules/playwright'));
  if (require(path.join(runtimeRoot, 'node_modules/playwright/package.json')).version !== manifest.playwrightVersion) throw new Error('Bundled browser runtime version mismatch.');
  const policies = new Map(), retiredPolicies = new WeakMap(), worlds = new WeakMap(), documents = new WeakMap(), viewRevisions = new WeakMap(), scrollContinuations = new WeakMap(), inputContinuations = new WeakMap(), ready = new WeakMap();
  function networkAllowed(url, policy) {
    if (!policy) return true;
    const value = new URL(url);
    if (value.protocol === 'ws:') value.protocol = 'http:';
    else if (value.protocol === 'wss:') value.protocol = 'https:';
    return ['http:', 'https:'].includes(value.protocol) && policy.origins.includes(value.origin);
  }
  // A loopback proxy also guards native worker WebSockets, which Playwright's
  // frame-injected WebSocket routing cannot intercept. Control is session-wide.
  function sessionNetworkAllowed(url) { return [...policies.values()].every(policy => networkAllowed(url, policy)); }
  const proxy = await networkProxy(sessionNetworkAllowed);
  let browser;
  try { browser = await chromium.launch({ headless: true, chromiumSandbox: true, executablePath, proxy: proxy.config }); }
  catch (error) { await proxy.close(); throw error; }
  const context = await browser.newContext({ viewport: viewport(options.width || 1280, options.height || 800), acceptDownloads: false, serviceWorkers: 'block' });
  context.setDefaultTimeout(10000);
  context.setDefaultNavigationTimeout(20000);
  const tabs = new Map(), dialogs = new Map();
  const modalListeners = new Set();
  async function policyFor(page) {
    if (policies.has(page)) return policies.get(page);
    if (retiredPolicies.has(page)) return retiredPolicies.get(page);
    const opener = await page.opener();
    const policy = opener ? await policyFor(opener) : null;
    policies.set(page, policy);
    return policy;
  }
  await context.route('**/*', async route => {
    try {
      const request = route.request();
      if (request.serviceWorker()) { await route.abort('blockedbyclient'); return; }
      let page;
      try { page = request.frame().page(); } catch {}
      // Initial popup requests can precede their Page. In that gap, require the
      // intersection of installed scopes, which is at least as strict as its opener.
      const permittedRequest = page ? networkAllowed(request.url(), await policyFor(page)) : sessionNetworkAllowed(request.url());
      if (!permittedRequest) await route.abort('blockedbyclient');
      else await route.continue();
    } catch { await route.abort('blockedbyclient').catch(() => {}); }
  });
  await context.routeWebSocket('**/*', route => {
    if (!sessionNetworkAllowed(route.url())) void route.close({ code: 1008, reason: 'Browser origin is not allowed.' }).catch(() => {});
    else route.connectToServer();
  });
  async function installPolicy(page, policy) {
    policies.set(page, policy);
    proxy.resetConnections();
  }
  let active, closing = false, keyboardRelease = null, heldPointer = null;
  const cancelledGestures = new Set();
  function retireGesture(gestureId) {
    if (gestureId === undefined || cancelledGestures.has(gestureId)) return;
    if (cancelledGestures.size >= 4096) throw new Error('Browser pointer recovery capacity reached. Reset the browser.');
    cancelledGestures.add(gestureId);
  }
  async function cancelPointer() {
    if (!heldPointer) return;
    const held = heldPointer;
    retireGesture(held.gestureId);
    if (!held.page.isClosed()) {
      await held.page.mouse.move(-1, -1);
      await held.page.mouse.up({ button: held.button, clickCount: 0 });
    }
    if (heldPointer === held) heldPointer = null;
  }
  function pendingDialog() {
    const entry = dialogs.entries().next().value;
    return entry ? { tabId: entry[0], ...entry[1] } : null;
  }
  function attach(page) {
    if (closing) { void page.close().catch(() => {}); return; }
    if (tabs.size >= 8) { void page.close().catch(() => {}); return; }
    const id = randomUUID();
    tabs.set(id, page); active = id;
    documents.set(page, randomUUID());
    viewRevisions.set(page, 0);
    let inheritance = Promise.resolve();
    if (!policies.has(page)) {
      // Hold a conservative scope immediately, including about:blank popups. The
      // opener can close before its asynchronous lookup or the first request.
      const scopes = [...policies.values()].filter(Boolean);
      const provisional = scopes.length ? { origins: scopes[0].origins.filter(origin => scopes.every(scope => scope.origins.includes(origin))), label: scopes[0].label } : null;
      policies.set(page, provisional);
      inheritance = (async () => {
        const opener = await page.opener();
        const policy = opener ? await policyFor(opener) : null;
        if (!page.isClosed() && policies.get(page) === provisional) policies.set(page, policy ? { origins: [...policy.origins], label: policy.label } : null);
      })();
    }
    page.on('dialog', value => { dialogs.delete(id); dialogs.set(id, { id: randomUUID(), value }); for (const listener of modalListeners) listener(); });
    page.on('close', () => {
      retiredPolicies.set(page, policies.get(page));
      policies.delete(page);
      tabs.delete(id);
      dialogs.delete(id);
      if (active === id) active = tabs.keys().next().value;
    });
    // A browser tab may navigate to websites, but never to host files or browser internals.
    page.on('framenavigated', frame => {
      if (frame === page.mainFrame() && !/^(https?:|about:blank$)/.test(frame.url())) void page.close().catch(() => {});
    });
    const setup = (async () => {
      await inheritance;
      const cdp = await context.newCDPSession(page);
      const world = { cdp, id: null, mainId: null, frameId: null };
      worlds.set(page, world);
      cdp.on('Page.frameNavigated', ({ frame }) => {
        if (frame.parentId) return;
        documents.set(page, randomUUID());
        world.id = null; world.mainId = null; world.frameId = frame.id;
      });
      await cdp.send('Page.enable');
      const tree = await cdp.send('Page.getFrameTree');
      world.frameId = tree.frameTree.frame.id;
      cdp.on('Runtime.executionContextCreated', ({ context }) => {
        if (context.auxData?.isDefault && context.auxData.frameId === world.frameId) world.mainId = context.id;
      });
      cdp.on('Runtime.executionContextsCleared', () => { world.mainId = null; world.id = null; });
      await cdp.send('Runtime.enable');
      await page.routeWebSocket('**/*', async route => {
        try {
          if (!networkAllowed(route.url(), await policyFor(page))) await route.close({ code: 1008, reason: 'Browser origin is not allowed.' });
          else route.connectToServer();
        } catch { await route.close().catch(() => {}); }
      });
    })();
    ready.set(page, setup);
    void setup.catch(() => page.close().catch(() => {}));
  }
  context.on('page', attach);
  async function newPage() { const page = await context.newPage(); await ready.get(page); return page; }
  await newPage();
  function metadata() {
    return { activeTabId: active || null, tabs: [...tabs].map(([id, page]) => ({ id, documentId: documents.get(page), viewRevision: viewRevisions.get(page), url: page.url().slice(0, 8192) })), keyboardRelease: keyboardRelease?.status || null };
  }
  function target(tabId = active) {
    const page = tabs.get(tabId);
    if (!page || page.isClosed()) throw new Error('Browser target tab is no longer available.');
    return { tabId, documentId: documents.get(page), url: page.url().slice(0, 8192) };
  }
  async function state() {
    const values = await Promise.all(metadata().tabs.map(async row => {
      const page = tabs.get(row.id);
      const [title, history] = await Promise.all([
        dialogs.size ? 'Browser dialog' : timed(page.title(), 250).catch(() => 'Browser tab'),
        timed(Promise.resolve().then(() => worlds.get(page)?.cdp.send('Page.getNavigationHistory')), 250).catch(() => null),
      ]);
      const validHistory = Array.isArray(history?.entries) && Number.isInteger(history.currentIndex) && history.currentIndex >= 0 && history.currentIndex < history.entries.length;
      return { ...row, title: title.slice(0, 512), canGoBack: validHistory && history.currentIndex > 0, canGoForward: validHistory && history.currentIndex < history.entries.length - 1 };
    }));
    const dialog = pendingDialog();
    return { activeTabId: active || null, tabs: values, engine: { name: 'Chromium', version: browser.version(), managed: true }, keyboardRelease: keyboardRelease?.status || null, dialog: dialog ? { id: dialog.id, tabId: dialog.tabId, type: dialog.value.type(), message: dialog.value.message().slice(0, 4096), defaultValue: dialog.value.defaultValue().slice(0, 4096) } : null };
  }
  async function evaluate(page, expression, contextId, documentId) {
    if (!contextId || documents.get(page) !== documentId) throw new Error('Browser target document changed; resolve the target and approve again.');
    const response = await timed(worlds.get(page).cdp.send('Runtime.evaluate', { expression, contextId, returnByValue: true, awaitPromise: true, timeout: 5000 }), 5000);
    if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text || 'Browser expression failed.');
    const value = response.result.value ?? null;
    if (Buffer.byteLength(JSON.stringify(value)) > 65536) throw new Error('Browser result exceeds 64 KB.');
    return value;
  }
  async function isolated(page, expression, create, documentId) {
    const world = worlds.get(page);
    if (!world?.id && create) {
      const cdp = world.cdp;
      const tree = await cdp.send('Page.getFrameTree');
      const value = await cdp.send('Page.createIsolatedWorld', { frameId: tree.frameTree.frame.id, worldName: 'terminal-v4-shared-browser', grantUniveralAccess: false });
      world.id = value.executionContextId;
    }
    if (!world?.id) throw new Error('Stale element ref; take another snapshot.');
    return evaluate(page, expression, world.id, documentId);
  }
  function element(input) {
    if (typeof input.ref !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(input.ref)) throw new Error('Invalid browser element ref.');
    return `(()=>{const e=globalThis.__v4refs?.byRef.get(${JSON.stringify(input.ref)});if(!e?.isConnected)throw Error('Stale element ref; take another snapshot');return e;})()`;
  }
  function permitted(url, origins) { return url === 'about:blank' || /^https?:/.test(url) && origins.includes(new URL(url).origin); }
  async function agentCommand({ name, input = {}, allowedOrigins, label, target: binding, humanReading = false }, operation) {
    if (!Array.isArray(allowedOrigins) || !allowedOrigins.every(value => typeof value === 'string') || typeof label !== 'string') throw new Error('Invalid agent browser scope.');
    const read = ['browser_tabs', 'browser_snapshot', 'browser_get_images', 'browser_screenshot', 'browser_wait'].includes(name);
    if (humanReading && !read) throw new Error('Human-owned browser access is read only.');
    if (name === 'browser_tabs' && !input.tabId) {
      const current = await state();
      const visible = current.tabs.filter(tab => permitted(tab.url, allowedOrigins));
      return { tabs: visible, activeTabId: visible.some(tab => tab.id === active) ? active : null };
    }
    if (name === 'browser_open') {
      const url = input.url || 'about:blank';
      if (!permitted(url, allowedOrigins)) throw new Error('Browser origin is not allowed.');
      if (tabs.size >= 8) throw new Error('Close a tab before opening another.');
      const page = await newPage();
      const id = [...tabs].find(([, value]) => value === page)[0];
      await installPolicy(page, { origins: [...allowedOrigins], label });
      if (url !== 'about:blank') await page.goto(browserUrl(url), { waitUntil: 'domcontentloaded' });
      return { ...target(id) };
    }
    if (!binding || typeof binding.tabId !== 'string' || typeof binding.documentId !== 'string') throw new Error('An exact browser target tab and document is required.');
    if (input.tabId && input.tabId !== binding.tabId) throw new Error('Browser target tab does not match the requested tab.');
    const id = binding.tabId, page = tabs.get(id);
    if (!page || page.isClosed()) throw new Error('Browser tab is no longer available.');
    await ready.get(page);
    const verifyTarget = () => { if (page.isClosed() || documents.get(page) !== binding.documentId) throw new Error('Browser target document changed; resolve the target and approve again.'); };
    const inspect = (expression, create = false) => isolated(page, expression, create, binding.documentId);
    verifyTarget();
    if (!permitted(page.url(), allowedOrigins)) throw new Error('The selected page is outside the agent allowed origins.');
    if (!humanReading) {
      active = id;
      await installPolicy(page, { origins: [...allowedOrigins], label });
      verifyTarget();
    }
    switch (name) {
      case 'browser_tabs': return { activeTabId: active };
      case 'browser_close': await page.close(); if (!tabs.size) await newPage(); return { closed: true, tabId: id };
      case 'browser_navigate': {
        if (!permitted(input.url, allowedOrigins)) throw new Error('Browser origin is not allowed.');
        const url = input.url === 'about:blank' ? input.url : browserUrl(input.url);
        await page.goto(url, { waitUntil: 'domcontentloaded' }); return { tabId: id, url: page.url() };
      }
      case 'browser_back': await page.goBack({ waitUntil: 'domcontentloaded' }); return { tabId: id, url: page.url() };
      case 'browser_forward': await page.goForward({ waitUntil: 'domcontentloaded' }); return { tabId: id, url: page.url() };
      case 'browser_screenshot': {
        const verifyImageTarget = () => {
          verifyTarget();
          if (!permitted(page.url(), allowedOrigins)) throw new Error('The selected page is outside the agent allowed origins.');
        };
        const image = await captureImage(page, { type: 'png' }, verifyImageTarget);
        verifyImageTarget();
        return { mimeType: 'image/png', format: 'base64', data: image.toString('base64') };
      }
      case 'browser_get_images': return inspect(imageInventorySource(), true);
      case 'browser_snapshot': {
        const prefix = randomUUID().replaceAll('-', '');
        return inspect(`(()=>{
          const state=globalThis.__v4refs||(globalThis.__v4refs={next:1,prefix:${JSON.stringify(prefix)},byNode:new WeakMap(),byRef:new Map()});
          for(const [ref,node] of state.byRef)if(!node.isConnected)state.byRef.delete(ref);
          const clean=(s,n=300)=>String(s||'').replace(/\\s+/g,' ').trim().slice(0,n);
          const visible=e=>e.getClientRects().length&&getComputedStyle(e).visibility!=='hidden'&&getComputedStyle(e).display!=='none'&&e.getAttribute('aria-hidden')!=='true';
          const rows=[];let visited=0,truncated=false;
          const visit=root=>{for(const e of root.children||[]){if(++visited>5000||rows.length>=300){truncated=true;return;}if(['SCRIPT','STYLE','NOSCRIPT','TEMPLATE'].includes(e.tagName))continue;
            if(visible(e)){
              const role=e.getAttribute('role')||({A:'link',BUTTON:'button',INPUT:e.type==='checkbox'?'checkbox':e.type==='radio'?'radio':'textbox',TEXTAREA:'textbox',SELECT:'combobox',IMG:'img',IFRAME:'iframe',H1:'heading',H2:'heading',H3:'heading'}[e.tagName]);
              if(role||e.tabIndex>=0||e.isContentEditable){let ref=state.byNode.get(e);if(!ref){ref='e'+state.prefix+'_'+state.next++;state.byNode.set(e,ref);}state.byRef.set(ref,e);
                const labelled=e.getAttribute('aria-labelledby')?.split(/\\s+/).map(id=>document.getElementById(id)?.textContent||'').join(' ');
                const row={ref,role:role||'generic',tag:e.tagName.toLowerCase(),name:clean(e.getAttribute('aria-label')||labelled||Array.from(e.labels||[]).map(l=>l.textContent).join(' ')||e.alt||e.title||e.placeholder||e.innerText),disabled:!!e.disabled};
                if(e instanceof HTMLInputElement||e instanceof HTMLTextAreaElement||e instanceof HTMLSelectElement)row.value=e.type==='password'?'[redacted]':clean(e.value,500);
                if(e instanceof HTMLSelectElement)row.options=Array.from(e.options).slice(0,100).map(o=>({value:clean(o.value),label:clean(o.label),disabled:o.disabled}));
                if(e.tagName==='A')row.href=clean(e.href,2048);rows.push(row);
              }
              if(e.shadowRoot)visit(e.shadowRoot);visit(e);
            }
          }};visit(document.body||document.documentElement);
          const result={url:location.href.slice(0,4096),title:document.title.slice(0,300),text:(document.body?.innerText||'').slice(0,12000),elements:rows,truncated};
          while(new TextEncoder().encode(JSON.stringify(result)).length>60000&&rows.length){rows.pop();result.truncated=true;}return result;
        })()`, true);
      }
      case 'browser_evaluate': {
        if (typeof input.script !== 'string' || Buffer.byteLength(input.script) > 32768) throw new Error('Invalid browser script.');
        const result = await evaluate(page, input.script, worlds.get(page).mainId, binding.documentId);
        if (Buffer.byteLength(JSON.stringify(result ?? null)) > 65536) throw new Error('Browser script result exceeds 64 KB.');
        return result ?? null;
      }
      case 'browser_type': {
        if (typeof input.text !== 'string' || Buffer.byteLength(input.text) > 32768) throw new Error('Invalid browser text.');
        await inspect(`(()=>{const e=${element(input)};if(e.matches(':disabled')||e.readOnly||!e.getClientRects().length||getComputedStyle(e).visibility==='hidden'||!(e instanceof HTMLTextAreaElement||e.isContentEditable||e instanceof HTMLInputElement&&['text','search','url','tel','email','password','number'].includes(e.type)))throw Error('Ref is not visible and editable');e.scrollIntoView({block:'center'});e.focus();if(document.activeElement!==e&&e.getRootNode().activeElement!==e)throw Error('Element could not receive focus');if(${input.clear !== false}){if(e.isContentEditable){const r=document.createRange();r.selectNodeContents(e);const s=getSelection();s.removeAllRanges();s.addRange(r);}else e.select();}return true;})()`);
        verifyTarget();
        if (!operation?.active) throw new Error('Typing ended before text admission.');
        await inspect(`(()=>{const e=${element(input)};if(e.matches(':disabled')||e.readOnly||!e.getClientRects().length||getComputedStyle(e).visibility==='hidden'||!(e instanceof HTMLTextAreaElement||e.isContentEditable||e instanceof HTMLInputElement&&['text','search','url','tel','email','password','number'].includes(e.type))||document.activeElement!==e&&e.getRootNode().activeElement!==e)throw Error('Element lost focus or is no longer editable; review before retrying');if(!document.execCommand('insertText',false,${JSON.stringify(input.text)}))throw Error('Text insertion failed');return true;})()`);
        return { typedCharacters: [...input.text].length };
      }
      case 'browser_press': {
        const spec = browserKey(input.key);
        await inspect(`(()=>{const e=${element(input)};if(e.matches(':disabled')||e.getAttribute('aria-disabled')==='true'||!e.getClientRects().length||getComputedStyle(e).visibility==='hidden'||e instanceof HTMLInputElement&&e.type==='file')throw Error('Element input is unavailable');e.scrollIntoView({block:'center'});e.focus();if(document.activeElement!==e&&e.getRootNode().activeElement!==e)throw Error('Element could not receive focus');return true;})()`);
        verifyTarget();
        if (!operation?.active) throw new Error('Keyboard action ended before key admission.');
        const action = { status: 'pending' };
        keyboardRelease = action;
        const cdp = worlds.get(page).cdp;
        let downError;
        try { await cdp.send('Input.dispatchKeyEvent', { ...spec, type: spec.text ? 'keyDown' : 'rawKeyDown', unmodifiedText: spec.text }); }
        catch (error) { downError = error; }
        try { await timed(cdp.send('Input.dispatchKeyEvent', { ...spec, type: 'keyUp', text: '', unmodifiedText: '' }), 5000); }
        catch { action.status = 'unconfirmed'; throw new Error('Keyboard release is unconfirmed. Close the browser before further input.'); }
        if (keyboardRelease === action) keyboardRelease = null;
        if (downError) throw new Error('Keyboard action outcome is unconfirmed; inspect the page before retrying.');
        return { pressed: input.key };
      }
      case 'browser_select': return inspect(`(()=>{const e=${element(input)},value=${JSON.stringify(input.value)};if(!(e instanceof HTMLSelectElement)||e.matches(':disabled')||!e.getClientRects().length||getComputedStyle(e).visibility==='hidden'||!Array.from(e.options).some(o=>o.value===value&&!o.disabled&&!o.closest('optgroup')?.disabled))throw Error('Option is unavailable');e.value=value;e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));return {selected:e.value};})()`);
      case 'browser_click':
      case 'browser_scroll': {
        const position = input.ref ? await inspect(`(()=>{const e=${element(input)};if(e.matches(':disabled')||e.getAttribute('aria-disabled')==='true'||e instanceof HTMLInputElement&&e.type==='file')throw Error('Element input is unavailable');e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();if(!r.width||!r.height||getComputedStyle(e).visibility==='hidden')throw Error('Element is not visible');const x=Math.max(0,Math.min(innerWidth-1,r.x+r.width/2)),y=Math.max(0,Math.min(innerHeight-1,r.y+r.height/2)),top=document.elementFromPoint(x,y);if(top!==e&&!e.contains(top)&&!top?.shadowRoot?.contains(e))throw Error('Element is covered');return {x,y};})()`) : { x: page.viewportSize().width / 2, y: page.viewportSize().height / 2 };
        verifyTarget();
        if (name === 'browser_click') await page.mouse.click(position.x, position.y);
        else { if (![input.deltaX || 0, input.deltaY].every(value => Number.isInteger(value) && Math.abs(value) <= 10000)) throw new Error('Scroll deltas must be -10000 to 10000'); await page.mouse.move(position.x, position.y); verifyTarget(); await page.mouse.wheel(input.deltaX || 0, input.deltaY); }
        return { ok: true };
      }
      case 'browser_wait': {
        if (input.ref && input.text) throw new Error('Wait for either ref or text, not both.');
        let matched;
        if (input.ref) { try { matched = await inspect(`(()=>{const e=${element(input)};return !!(e.getClientRects().length&&getComputedStyle(e).visibility!=='hidden');})()`); } catch (error) { verifyTarget(); matched = false; } }
        else if (typeof input.text === 'string') matched = await inspect(`(document.body?.innerText || '').includes(${JSON.stringify(input.text)})`, true);
        else matched = await inspect("document.readyState !== 'loading'", true);
        return { matched: matched === !input.hidden };
      }
      default: throw new Error('Unknown browser tool.');
    }
  }
  async function dispatch(input, operation) {
    if (!input || typeof input !== 'object') throw new Error('Invalid browser command.');
    let page = tabs.get(active);
    if (input.type === 'agent') {
      if (!input.humanReading) await cancelPointer();
      if (['browser_scroll', 'browser_press', 'browser_type', 'browser_click', 'browser_select', 'browser_evaluate'].includes(input.name)) {
        const targetPage = tabs.get(input.target?.tabId);
        if (targetPage) viewRevisions.set(targetPage, (viewRevisions.get(targetPage) || 0) + 1);
      }
      return agentCommand(input, operation);
    }
    if (input.type === 'releaseAgent') { for (const [page, policy] of policies) if (policy?.label === input.label) policies.delete(page); return { released: true }; }
    if (input.type === 'target') return target(input.tabId);
    const scrollKey = input.type === 'key' && typeof input.key === 'string'
      && ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown', 'Space'].includes(input.key.split('+').at(-1));
    const scrolling = input.type === 'wheel' || scrollKey;
    const typing = input.type === 'text' || input.type === 'key' && !scrollKey;
    if (scrolling && input.scrollId !== undefined && (typeof input.scrollId !== 'string' || !/^[a-zA-Z0-9-]{1,64}$/.test(input.scrollId))) throw new Error('Invalid browser scroll identity.');
    if (typing && input.inputId !== undefined && (typeof input.inputId !== 'string' || !/^[a-zA-Z0-9-]{1,64}$/.test(input.inputId))) throw new Error('Invalid browser input identity.');
    if (['pointer', 'wheel', 'key', 'text'].includes(input.type) && input.action !== 'cancel' && input.frame !== undefined) {
      const frame = input.frame, size = page?.viewportSize();
      if (!frame || typeof frame !== 'object' || typeof frame.tabId !== 'string'
        || typeof frame.documentId !== 'string' || !Number.isInteger(frame.width) || !Number.isInteger(frame.height)
        || (frame.revision !== undefined && !Number.isSafeInteger(frame.revision))) throw new Error('Invalid browser view binding.');
      const revision = page && viewRevisions.get(page);
      const sameView = page && active === frame.tabId && documents.get(page) === frame.documentId
        && size?.width === frame.width && size?.height === frame.height;
      const pointerContinuation = input.type === 'pointer' && ['move', 'up'].includes(input.action)
        && input.gestureId !== undefined && heldPointer?.page === page && heldPointer.gestureId === input.gestureId
        && heldPointer.originRevision === frame.revision && heldPointer.expectedRevision === revision;
      const scroll = page && scrollContinuations.get(page);
      const scrollContinuation = scrolling && input.scrollId !== undefined && scroll?.id === input.scrollId
        && scroll.originRevision === frame.revision && scroll.expectedRevision === revision;
      const typed = page && inputContinuations.get(page);
      const typingContinuation = typing && input.inputId !== undefined && typed?.id === input.inputId
        && typed.originRevision === frame.revision && typed.expectedRevision === revision;
      if (!sameView || (frame.revision !== undefined && revision !== frame.revision && !pointerContinuation && !scrollContinuation && !typingContinuation)) {
        if (input.type === 'pointer' && input.action === 'up' && heldPointer?.gestureId === input.gestureId) await cancelPointer();
        throw new Error('Browser view changed; wait for the updated page and try again.');
      }
    }
    if (['newTab', 'switchTab', 'closeTab', 'navigate', 'back', 'forward', 'reload'].includes(input.type)
      || (input.type === 'resize' && page && (page.viewportSize()?.width !== input.width || page.viewportSize()?.height !== input.height))) await cancelPointer();
    if (input.type === 'control') {
      if (input.owner !== 'human' || input.human !== true) throw new Error('Explicit authorized human control is required.');
      for (const owned of tabs.values()) policies.set(owned, null);
      return state();
    }
    const humanMutation = ['newTab', 'switchTab', 'closeTab', 'navigate', 'back', 'forward', 'reload', 'wheel', 'key', 'text'].includes(input.type) || input.type === 'pointer' && ['down', 'up'].includes(input.action);
    if (input.human === true && humanMutation) {
      // Human control is session-wide; reads and layout never release agent scope.
      for (const owned of tabs.values()) policies.set(owned, null);
    }
    if (input.type === 'newTab') {
      if (tabs.size >= 8) throw new Error('Close a tab before opening another (maximum eight).');
      page = await newPage();
      if (input.url) await page.goto(browserUrl(input.url), { waitUntil: 'domcontentloaded' });
    } else if (input.type === 'switchTab') {
      if (!tabs.has(input.id)) throw new Error('Browser tab is no longer available.');
      active = input.id;
    } else if (input.type === 'closeTab') {
      if (!tabs.has(input.id)) throw new Error('Browser tab is no longer available.');
      await tabs.get(input.id).close();
      if (!tabs.size) await newPage();
    } else {
      if (!page || page.isClosed()) throw new Error('Open a browser tab to continue.');
      switch (input.type) {
        case 'state': break;
        case 'navigate': await page.goto(browserUrl(input.url), { waitUntil: 'domcontentloaded' }); break;
        case 'back': await page.goBack({ waitUntil: 'domcontentloaded' }); break;
        case 'forward': await page.goForward({ waitUntil: 'domcontentloaded' }); break;
        case 'reload': await page.reload({ waitUntil: 'domcontentloaded' }); break;
        case 'resize': {
          const next = viewport(input.width, input.height), previous = page.viewportSize();
          if (previous?.width !== next.width || previous?.height !== next.height) viewRevisions.set(page, (viewRevisions.get(page) || 0) + 1);
          await page.setViewportSize(next);
          break;
        }
        case 'pointer': {
          if (input.action === 'cancel') {
            if (input.gestureId !== undefined && (typeof input.gestureId !== 'string' || !/^[a-zA-Z0-9-]{1,64}$/.test(input.gestureId))) throw new Error('Invalid pointer action identity.');
            retireGesture(input.gestureId);
            if (!heldPointer || heldPointer.gestureId === input.gestureId) await cancelPointer();
            break;
          }
          const size = page.viewportSize();
          if (![input.x, input.y].every(Number.isFinite) || input.x < 0 || input.x > size.width || input.y < 0 || input.y > size.height || !['left', 'right', 'middle'].includes(input.button || 'left')) throw new Error('Invalid pointer input.');
          if (input.gestureId !== undefined && (typeof input.gestureId !== 'string' || !/^[a-zA-Z0-9-]{1,64}$/.test(input.gestureId))) throw new Error('Invalid pointer action identity.');
          if (input.action === 'down' && input.gestureId !== undefined && (cancelledGestures.has(input.gestureId) || cancelledGestures.size >= 4096)) throw new Error('This browser pointer action was cancelled or recovery capacity is full.');
          if (input.action === 'down' && heldPointer) throw new Error('Another browser pointer action is still active.');
          if (input.action === 'move' && heldPointer && heldPointer.gestureId !== input.gestureId) throw new Error('A different browser pointer action is active.');
          if (input.action === 'up' && !heldPointer) break;
          if (input.action === 'up' && (heldPointer.page !== page || heldPointer.gestureId !== input.gestureId || heldPointer.button !== (input.button || 'left'))) throw new Error('Browser pointer action changed; try again.');
          if (input.action === 'down' || heldPointer) {
            const revision = (viewRevisions.get(page) || 0) + 1;
            viewRevisions.set(page, revision);
            if (heldPointer) heldPointer.expectedRevision = revision;
          }
          await page.mouse.move(input.x, input.y);
          if (input.action === 'down') { heldPointer = { page, button: input.button || 'left', gestureId: input.gestureId, originRevision: input.frame?.revision, expectedRevision: viewRevisions.get(page) }; await page.mouse.down({ button: input.button || 'left', clickCount: input.clickCount === 2 ? 2 : 1 }); }
          else if (input.action === 'up') {
            const gesture = heldPointer;
            await page.mouse.up({ button: input.button || 'left', clickCount: input.clickCount === 2 ? 2 : 1 });
            if (gesture.gestureId && Number.isSafeInteger(input.frame?.revision) && viewRevisions.get(page) === gesture.expectedRevision) {
              inputContinuations.set(page, { id: gesture.gestureId, originRevision: input.frame.revision, expectedRevision: gesture.expectedRevision });
            }
            heldPointer = null;
          }
          else if (input.action !== 'move') throw new Error('Invalid pointer action.');
          break;
        }
        case 'wheel':
          if (![input.deltaX, input.deltaY].every(value => Number.isFinite(value) && Math.abs(value) <= 2000)) throw new Error('Invalid scroll input.');
          viewRevisions.set(page, (viewRevisions.get(page) || 0) + 1);
          if (input.scrollId && Number.isSafeInteger(input.frame?.revision)) scrollContinuations.set(page, { id: input.scrollId, originRevision: input.frame.revision, expectedRevision: viewRevisions.get(page) });
          else scrollContinuations.delete(page);
          await page.mouse.wheel(input.deltaX, input.deltaY); break;
        case 'key':
          if (typeof input.key !== 'string' || !/^(?:(?:Control|Meta|Alt|Shift)\+){0,4}(?:[A-Za-z0-9]|Enter|Tab|Escape|Backspace|Delete|Arrow(?:Left|Right|Up|Down)|Home|End|PageUp|PageDown|Space|F(?:[1-9]|1[0-2]))$/.test(input.key)) throw new Error('Unsupported browser key.');
          if (scrollKey) {
            viewRevisions.set(page, (viewRevisions.get(page) || 0) + 1);
            if (input.scrollId && Number.isSafeInteger(input.frame?.revision)) scrollContinuations.set(page, { id: input.scrollId, originRevision: input.frame.revision, expectedRevision: viewRevisions.get(page) });
            else scrollContinuations.delete(page);
          } else {
            viewRevisions.set(page, (viewRevisions.get(page) || 0) + 1);
            if (input.inputId && Number.isSafeInteger(input.frame?.revision)) inputContinuations.set(page, { id: input.inputId, originRevision: input.frame.revision, expectedRevision: viewRevisions.get(page) });
            else inputContinuations.delete(page);
          }
          await page.keyboard.press(input.key); break;
        case 'text':
          if (typeof input.text !== 'string' || input.text.length > 65536 || input.text.includes('\0')) throw new Error('Invalid text input.');
          viewRevisions.set(page, (viewRevisions.get(page) || 0) + 1);
          if (input.inputId && Number.isSafeInteger(input.frame?.revision)) inputContinuations.set(page, { id: input.inputId, originRevision: input.frame.revision, expectedRevision: viewRevisions.get(page) });
          else inputContinuations.delete(page);
          await page.keyboard.insertText(input.text); break;
        case 'dialog': {
          const dialog = pendingDialog();
          if (input.dialogId !== undefined && input.dialogId !== dialog?.id) throw new Error('Browser dialog changed; refresh before responding.');
          if (!dialog) break;
          if (input.human === true) for (const owned of tabs.values()) policies.set(owned, null);
          const value = dialog.value;
          const dialogPage = tabs.get(dialog.tabId);
          if (dialogPage) viewRevisions.set(dialogPage, (viewRevisions.get(dialogPage) || 0) + 1);
          if (input.accept === true) await value.accept(typeof input.text === 'string' ? input.text.slice(0, 4096) : '');
          else await value.dismiss();
          if (dialogs.get(dialog.tabId)?.id === dialog.id) dialogs.delete(dialog.tabId);
          await cancelPointer();
          break;
        }
        case 'frame': {
          const tabId = active, documentId = documents.get(page), viewRevision = viewRevisions.get(page), size = page.viewportSize();
          if (dialogs.size || page.url() === 'about:blank') return { ...(await state()), ...size, viewRevision, image: null };
          const image = await captureImage(page, { type: 'jpeg', quality: 72 });
          const current = await state(), actual = tabs.get(active);
          if (active !== tabId || documents.get(page) !== documentId || viewRevisions.get(page) !== viewRevision || dialogs.size) {
            return { ...current, ...(actual?.viewportSize() || size), viewRevision: actual ? viewRevisions.get(actual) : viewRevision, image: null };
          }
          return { ...current, ...size, viewRevision, image: image.toString('base64') };
        }
        default: throw new Error('Unsupported browser command.');
      }
    }
    return state();
  }
  async function command(input) {
    if (keyboardRelease && !['state', 'target', 'frame', 'dialog', 'control', 'releaseAgent', 'closeTab'].includes(input?.type)
      && !(input?.type === 'agent' && input.name === 'browser_close')) throw new Error('Keyboard release is pending or unconfirmed. Dismiss the dialog or close the browser before further input.');
    if (dialogs.size && !['state', 'target', 'frame', 'dialog', 'releaseAgent', 'control'].includes(input?.type)) throw new Error('Dismiss the browser dialog before continuing.');
    if (input?.type === 'dialog') return dispatch(input);
    let interrupt;
    const operation = { active: true };
    const modalError = new Error('Browser dialog opened; dismiss it before continuing.');
    const modal = new Promise((_, reject) => { interrupt = () => { operation.active = false; reject(modalError); }; });
    modalListeners.add(interrupt);
    try { return await Promise.race([dispatch(input, operation), modal]); }
    catch (error) {
      if (error === modalError && input?.type === 'agent' && input.name === 'browser_press') throw new Error(keyboardRelease ? 'Browser dialog opened; dismiss it to finish keyboard release.' : 'Browser dialog opened before keyboard input; dismiss it and review the action again.');
      if (error === modalError && input?.human === true && input.type !== 'agent') return state();
      throw error;
    }
    finally { operation.active = false; modalListeners.delete(interrupt); }
  }
  return { command, metadata, close: async () => { closing = true; try { await browser.close(); } finally { await proxy.close(); } }, browser, runtimeRoot, executablePath };
}

async function captureImage(page, options, verify = () => {}) {
  const deadline = Date.now() + 5000;
  for (let attempt = 0; ; attempt++) {
    verify();
    let image;
    try { image = await page.screenshot({ ...options, timeout: Math.max(1, deadline - Date.now()) }); }
    catch (error) {
      verify();
      if (attempt >= 2 || !String(error.message).includes('Protocol error (Page.captureScreenshot): Unable to capture screenshot') || deadline - Date.now() <= 200) throw error;
      await new Promise(resolve => setTimeout(resolve, 200));
      continue;
    }
    verify();
    if (image.length > MAX_CAPTURE_BYTES) throw new Error('Browser image exceeds 5.5 MB. Reduce the viewport or page detail.');
    return image;
  }
}

async function networkProxy(allowed) {
  const username = randomUUID(), password = randomUUID();
  const authorization = 'Basic ' + Buffer.from(username + ':' + password).toString('base64');
  const sockets = new Map();
  function authorize(request, socket) {
    if (request.headers['proxy-authorization'] === authorization) return true;
    socket.end('HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="Terminal v4"\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
    return false;
  }
  function destination(request, socket) {
    if (!authorize(request, socket)) return null;
    try {
      const url = new URL(request.url);
      if (!['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol) || url.username || url.password || !allowed(url.href)) throw new Error('Blocked');
      sockets.set(socket, url.href);
      return url;
    } catch { socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'); return null; }
  }
  function headers(request, url) {
    const result = { ...request.headers, host: url.host };
    delete result['proxy-authorization']; delete result['proxy-connection'];
    return result;
  }
  const server = http.createServer((request, response) => {
    const url = destination(request, request.socket);
    if (!url) return;
    if (url.protocol !== 'http:') { response.writeHead(400); response.end(); return; }
    const outgoing = http.request(url, { method: request.method, headers: headers(request, url), agent: false }, incoming => {
      response.writeHead(incoming.statusCode, incoming.headers); incoming.pipe(response);
    });
    outgoing.on('socket', socket => { sockets.set(socket, url.href); socket.on('close', () => sockets.delete(socket)); });
    outgoing.on('error', () => { if (!response.headersSent) response.writeHead(502); response.end(); });
    request.on('error', () => outgoing.destroy());
    request.pipe(outgoing);
  });
  server.on('connection', socket => { sockets.set(socket, null); socket.on('error', () => {}); socket.on('close', () => sockets.delete(socket)); });
  server.on('connect', (request, client, head) => {
    if (!authorize(request, client)) return;
    let secure, plain;
    try {
      secure = new URL('https://' + request.url); plain = new URL('http://' + request.url);
      if (secure.username || secure.password || secure.pathname !== '/' || secure.search || secure.hash || !allowed(secure.href) && !allowed(plain.href)) throw new Error('Blocked');
    } catch { client.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'); return; }
    // Chromium tunnels both ws and TLS through CONNECT. Inspect the first bytes
    // before opening an upstream socket so ws maps to http and wss to https.
    const connect = first => {
      client.pause();
      const url = first[0] === 22 ? secure : plain;
      if (!allowed(url.href)) { client.destroy(); return; }
      sockets.set(client, url.href);
      const upstream = net.connect({ host: url.hostname.replace(/^\[|\]$/g, ''), port: Number(url.port) || (url.protocol === 'https:' ? 443 : 80) });
      sockets.set(upstream, url.href);
      upstream.on('connect', () => { upstream.write(first); client.pipe(upstream); upstream.pipe(client); client.resume(); });
      upstream.on('error', () => client.destroy());
      upstream.on('close', () => { sockets.delete(upstream); client.destroy(); });
      client.on('close', () => upstream.destroy());
    };
    client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if (head.length) connect(head); else client.once('data', connect);
  });
  server.on('upgrade', (request, client, head) => {
    const url = destination(request, client);
    if (!url) return;
    url.protocol = 'http:';
    const outgoing = http.request(url, { headers: headers(request, url), agent: false });
    outgoing.on('upgrade', (response, upstream, upstreamHead) => {
      sockets.set(upstream, url.href); upstream.on('error', () => client.destroy()); upstream.on('close', () => { sockets.delete(upstream); client.destroy(); }); client.on('close', () => upstream.destroy());
      client.write(`HTTP/1.1 ${response.statusCode} ${response.statusMessage}\r\n` + response.rawHeaders.reduce((text, value, index) => text + value + (index % 2 ? '\r\n' : ': '), '') + '\r\n');
      if (head.length) upstream.write(head); if (upstreamHead.length) client.write(upstreamHead);
      client.pipe(upstream); upstream.pipe(client);
    });
    outgoing.on('response', response => { response.resume(); client.destroy(); });
    outgoing.on('error', () => client.destroy()); outgoing.end();
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const resetConnections = () => { for (const [socket, url] of sockets) if (url && !allowed(url)) socket.destroy(); };
  return { config: { server: `http://127.0.0.1:${server.address().port}`, username, password, bypass: '<-loopback>' }, resetConnections, close: () => new Promise(resolve => { for (const socket of sockets.keys()) socket.destroy(); server.close(resolve); }) };
}

async function timed(promise, milliseconds) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Browser operation timed out.')), milliseconds); })]); }
  finally { clearTimeout(timer); }
}

let mainPromise;
function main() { return mainPromise ||= runMain(); }
function writeResponse(response) {
  let line = JSON.stringify(response);
  if (Buffer.byteLength(line) + 1 > MAX_RESPONSE_BYTES) line = JSON.stringify({ id: response.id, ok: false, error: 'Browser response exceeds 8 MB. Reduce the viewport or requested output.', state: response.state });
  process.stdout.write(line + '\n');
}
async function runMain() {
  const session = await createBrowser();
  const initial = await session.command({ type: 'state' });
  writeResponse({ id: 0, ok: true, value: initial, state: initial });
  let pending = Promise.resolve();
  const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  input.on('line', line => {
    pending = pending.then(async () => {
      let id = null;
      try {
        const envelope = JSON.parse(line);
        id = envelope?.id ?? null;
        if (!Number.isSafeInteger(id) || id <= 0) throw new Error('Browser request ID must be a positive safe integer.');
        if (line.length > 100000) throw new Error('Browser command is too large.');
        const value = await session.command(envelope.command);
        writeResponse({ id, ok: true, value, state: session.metadata() });
      } catch (error) { writeResponse({ id, ok: false, error: String(error.message).slice(0, 2000), state: session.metadata() }); }
    });
  });
  const stop = async () => { await session.close().catch(() => {}); process.exit(0); };
  input.on('close', stop); process.once('SIGTERM', stop); process.once('SIGINT', stop);
}
module.exports = { browserUrl, viewport, browserKey, createBrowser };
if (require.main === module) main().catch(() => { process.stderr.write('Unable to launch the bundled Chromium runtime. Repair or reinstall Terminal v4.\n'); process.exit(1); });
