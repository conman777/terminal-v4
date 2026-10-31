import { execFileSync } from 'node:child_process';
import { chromium } from '@playwright/test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { managedChromiumPath } from '../test/managedChromium';

let browser, script;
beforeAll(async () => {
  const entry = `import React from 'react'; import {createRoot} from 'react-dom/client';
    import {AuthProvider,useAuth} from './src/contexts/AuthContext';
    import {NotesProvider,useNotes} from './src/contexts/NotesContext';
    import {NotesModal} from './src/components/NotesModal';
    import {createBrowserAuthAuthority} from './src/utils/standaloneIndexedDbAuthAuthority';
    import {createBrowserAuthLifecycle} from './src/utils/browserAuthLifecycle';
    import {createStrictAuthNotifications} from './src/utils/strictAuthNotifications';
    window.authority=createBrowserAuthAuthority({verifyLogoutReceipt:async ({receipt})=>receipt==='verified',verifyLoginFailureReceipt:async()=>false});
    window.notifications=createStrictAuthNotifications();
    window.lifecycle=createBrowserAuthLifecycle({authority,notifications,transport:{login:async()=>({kind:'issued',user:{id:'owner',username:'synthetic'},session:'session',accessToken:'synthetic-token',refreshToken:'refresh',logoutCapability:'a'.repeat(64)}),logout:async()=>'verified'}});
    const strictAuth={lifecycle,home:location.origin+'/',validateSession:async()=>({status:'valid'}),subscribe:notifications.subscribe};
    function Screen(){const n=useNotes();return <NotesModal isOpen onClose={()=>{}} notes={n.notes} loadStatus={n.notesLoadStatus} loadError={n.notesLoadError} onRetryLoad={n.reloadNotes} scopeKey={n.notesScopeKey} scopeHeld={n.notesScopeHeld} onAdd={n.addNote} onUpdate={n.updateNote} onDelete={n.deleteNote}/>}
    function Workspace(){const auth=useAuth();return auth.user?<NotesProvider><Screen/></NotesProvider>:null}
    window.mount=()=>createRoot(document.getElementById('root')).render(<AuthProvider strictAuth={strictAuth}><Workspace/></AuthProvider>);`;
  script = JSON.parse(execFileSync(process.execPath, ['src/test/bundleFixture.mjs'], { cwd: process.cwd(), encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, input: JSON.stringify({ entry, root: process.cwd() }) })).find(file => file.path.endsWith('.js')).text;
  browser = await chromium.launch({ executablePath: await managedChromiumPath(), headless: true });
}, 120000);
afterAll(async () => { await browser?.close(); });

describe('strict notes in independent browser tabs', () => {
  it.each([320, 390])('saves a note and keeps a new draft after sign-out at %ipx', async width => {
    const context = await browser.newContext({ viewport: { width, height: 800 } });
    const writes = []; let notes = [];
    try {
      await context.route('http://localhost:45322/**', async route => {
        const request = route.request(), path = new URL(request.url()).pathname;
        if (path === '/fixture.js') return route.fulfill({ contentType: 'text/javascript', body: script });
        if (path === '/api/notes') {
          if (request.method() === 'POST') {
            writes.push({ authorization: request.headers().authorization, body: request.postDataJSON() });
            notes = [{ id: 'note-a', ...request.postDataJSON(), createdAt: new Date().toISOString() }];
            return route.fulfill({ status: 201, json: { note: notes[0] } });
          }
          return route.fulfill({ status: 200, json: { notes } });
        }
        return route.fulfill({ contentType: 'text/html', body: '<div id="root"></div><script src="/fixture.js"></script>' });
      });
      const [first, second] = await Promise.all([context.newPage(), context.newPage()]);
      for (const page of [first, second]) { await page.goto('http://localhost:45322/'); await page.waitForFunction(() => window.lifecycle); }
      await first.evaluate(() => authority.provision());
      await first.evaluate(() => lifecycle.login(location.origin + '/', {}));
      await first.evaluate(() => mount());
      await first.getByRole('button', { name: 'New Note' }).first().click();
      await first.getByPlaceholder('Untitled').fill('Saved note');
      await first.getByPlaceholder('Write something... (Markdown supported)').fill('First content');
      await first.getByRole('button', { name: 'Save', exact: true }).click();
      await first.getByText('Saved note').first().waitFor();
      await first.getByRole('button', { name: 'New Note' }).first().click();
      await first.getByPlaceholder('Untitled').fill('Unsent title');
      await first.getByPlaceholder('Write something... (Markdown supported)').fill('Keep this draft');
      await second.evaluate(() => lifecycle.logout());
      await first.waitForFunction(() => /secure session/i.test(document.body.textContent));
      expect(await first.getByPlaceholder('Write something... (Markdown supported)').inputValue()).toBe('Keep this draft');
      await first.getByRole('button', { name: 'Save', exact: true }).click();
      expect(writes).toEqual([{ authorization: 'Bearer synthetic-token', body: { title: 'Saved note', content: 'First content', category: 'General' } }]);
    } finally { await context.close(); }
  }, 30000);
});
