import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { chromium } from '@playwright/test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { managedChromiumPath } from '../test/managedChromium';

let browser, script, css;
beforeAll(async () => {
  const entry = `import './src/styles.css'; import './src/WorkspaceUI.css'; import './src/ProUI.css';
    import React from 'react'; import {createRoot} from 'react-dom/client';
    import {AuthProvider,useAuth} from './src/contexts/AuthContext';
    import {BookmarkProvider,useBookmarks} from './src/contexts/BookmarkContext';
    import {BookmarkModal} from './src/components/BookmarkModal';
    import {createBrowserAuthAuthority} from './src/utils/standaloneIndexedDbAuthAuthority';
    import {createBrowserAuthLifecycle} from './src/utils/browserAuthLifecycle';
    import {createStrictAuthNotifications} from './src/utils/strictAuthNotifications';
    window.authority=createBrowserAuthAuthority({verifyLogoutReceipt:async ({receipt})=>receipt==='verified',verifyLoginFailureReceipt:async()=>false});
    window.notifications=createStrictAuthNotifications();
    window.lifecycle=createBrowserAuthLifecycle({authority,notifications,transport:{login:async()=>({kind:'issued',user:{id:'owner',username:'synthetic'},session:'session',accessToken:'synthetic-token',refreshToken:'refresh',logoutCapability:'a'.repeat(64)}),logout:async()=>'verified'}});
    const strictAuth={lifecycle,home:location.origin+'/',validateSession:async()=>({status:'valid'}),subscribe:notifications.subscribe};
    function Screen(){const b=useBookmarks();return <BookmarkModal isOpen onClose={()=>{}} bookmarks={b.bookmarks} loadStatus={b.bookmarksLoadStatus} loadError={b.bookmarksLoadError} onRetryLoad={b.reloadBookmarks} scopeKey={b.bookmarksScopeKey} scopeHeld={b.bookmarksScopeHeld} scopeHoldMessage={b.bookmarksScopeHoldMessage} scopeHoldCanRetry={b.bookmarksScopeHoldCanRetry} executionUnavailable={b.bookmarksExecutionUnavailable} saveUnavailable={b.bookmarksSaveUnavailable} onAdd={b.addBookmark} onUpdate={b.updateBookmark} onDelete={b.deleteBookmark} onExecute={b.executeBookmark}/>}
    function Workspace(){const auth=useAuth();return auth.user?<BookmarkProvider><Screen/></BookmarkProvider>:null}
    window.mount=()=>createRoot(document.getElementById('root')).render(<AuthProvider strictAuth={strictAuth}><Workspace/></AuthProvider>);`;
  const virtual = { '^\\./TerminalSessionContext$': "export const useTerminalSession=()=>({activeSessionId:'terminal-fixture'});" };
  const output = JSON.parse(execFileSync(process.execPath, ['src/test/bundleFixture.mjs'], { cwd: process.cwd(), encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, input: JSON.stringify({ entry, virtual, root: process.cwd() }) }));
  script = output.find(file => file.path.endsWith('.js')).text;
  css = output.find(file => file.path.endsWith('.css')).text;
  browser = await chromium.launch({ executablePath: await managedChromiumPath(), headless: true });
}, 120000);
afterAll(async () => { await browser?.close(); });

describe('strict bookmarks in independent browser tabs', () => {
  it.each([320, 390])('saves a bookmark and retains a new draft after sign-out at %ipx', async width => {
    const context = await browser.newContext({ viewport: { width, height: 800 } });
    const writes = []; const terminalRequests = []; let bookmarks = []; let ownershipConflict = false;
    try {
      await context.route('http://localhost:45323/**', async route => {
        const request = route.request(), path = new URL(request.url()).pathname;
        if (path === '/fixture.js') return route.fulfill({ contentType: 'text/javascript', body: script });
        if (path === '/fixture.css') return route.fulfill({ contentType: 'text/css', body: css });
        if (path.startsWith('/api/terminal/')) { terminalRequests.push(path); return route.fulfill({ status: 204 }); }
        if (path === '/api/bookmarks') {
          if (ownershipConflict) return route.fulfill({ status: 409, json: { error: 'Bookmark storage ownership is ambiguous. Administrator review is required.' } });
          if (request.method() === 'POST') {
            writes.push({ authorization: request.headers().authorization, body: request.postDataJSON() });
            bookmarks = [{ id: 'bookmark-a', ...request.postDataJSON(), createdAt: new Date().toISOString() }];
            return route.fulfill({ status: 201, json: { bookmark: bookmarks[0] } });
          }
          return route.fulfill({ status: 200, json: { bookmarks } });
        }
        return route.fulfill({ contentType: 'text/html', body: '<link rel="stylesheet" href="/fixture.css"><div id="root"></div><script src="/fixture.js"></script>' });
      });
      const [first, second] = await Promise.all([context.newPage(), context.newPage()]);
      for (const page of [first, second]) { await page.goto('http://localhost:45323/'); await page.waitForFunction(() => window.lifecycle); }
      await first.evaluate(() => authority.provision());
      await first.evaluate(() => lifecycle.login(location.origin + '/', {}));
      await first.evaluate(() => mount());
      await first.getByTitle('Add bookmark').click();
      await first.getByLabel('Name', { exact: true }).fill('Saved bookmark');
      await first.getByLabel('Command', { exact: true }).fill('echo saved');
      await first.getByRole('button', { name: 'Save', exact: true }).click();
      await first.getByText('Saved bookmark', { exact: true }).waitFor();
      expect(await first.getByRole('button', { name: 'Execute bookmark: Saved bookmark' }).isDisabled()).toBe(true);
      await first.getByTitle('Add bookmark').click();
      await first.getByLabel('Name', { exact: true }).fill('Unsent name');
      await first.getByLabel('Command', { exact: true }).fill('echo keep-draft');
      ownershipConflict = true;
      await first.getByRole('button', { name: 'Save', exact: true }).click();
      await first.getByText(/Administrator review is required/).waitFor();
      expect(await first.getByLabel('Command', { exact: true }).count()).toBe(0);
      ownershipConflict = false;
      await first.getByRole('button', { name: 'Retry loading bookmarks', exact: true }).click();
      await first.waitForFunction(() => document.querySelector('#bookmark-command')?.value === 'echo keep-draft');
      const save = await first.getByRole('button', { name: 'Save', exact: true }).boundingBox();
      expect(save.height).toBeGreaterThanOrEqual(44);
      expect(await first.getByRole('dialog', { name: 'Bookmarks' }).evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
      await second.evaluate(() => lifecycle.logout());
      await first.waitForFunction(() => /secure session/i.test(document.body.textContent));
      expect(await first.getByLabel('Command', { exact: true }).inputValue()).toBe('echo keep-draft');
      if (process.env.TERMINAL_V4_EVIDENCE_DIR) await first.screenshot({ path: join(process.env.TERMINAL_V4_EVIDENCE_DIR, `strict-bookmarks-${width}.png`), animations: 'disabled' });
      expect(await first.getByRole('button', { name: 'Save', exact: true }).isDisabled()).toBe(true);
      await first.getByLabel('Command', { exact: true }).fill('echo updated-draft');
      expect(await first.getByLabel('Command', { exact: true }).inputValue()).toBe('echo updated-draft');
      expect(writes).toEqual([{ authorization: 'Bearer synthetic-token', body: { name: 'Saved bookmark', command: 'echo saved', category: 'General' } }]);
      expect(terminalRequests).toEqual([]);
    } finally { await context.close(); }
  }, 30000);
});
