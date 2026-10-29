import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, type Page, type TestInfo, type WebSocketRoute } from '@playwright/test';

export const evidenceRoot = process.env.E2E_UI_EVIDENCE ? path.resolve(process.env.E2E_UI_EVIDENCE) : path.resolve(import.meta.dirname, '../../output/ui-unification-20261025');
export const fixtureWorkspace = '/tmp';
export const fixtureDraft = 'Check the responsive layout and retain this unsent follow-up.';
export const shellCommand = "printf '\\033[32mui-pty-ready\\033[0m\\n'; stty size";
export const managedChromium = path.resolve(import.meta.dirname, '../../.runtime/browser/browsers/chromium-1248/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing');
const distDirectory = process.env.E2E_UI_DIST ? path.resolve(process.env.E2E_UI_DIST) : path.resolve(import.meta.dirname, '../dist');

const stamp = '2026-10-25T12:00:00Z';
const catalog = { agents: [
  { id: 'codex', label: 'Codex', runtime: 'codex', available: true, status: 'ready', capabilities: { structured: true }, models: [{ id: 'gpt-6.1-sol', label: 'GPT-6.1-Sol', default: true, imageInput: true }, { id: 'gpt-6-astra', label: 'GPT-6-Astra' }], reasoningLevels: ['low', 'high', 'xhigh'] },
  { id: 'claude', label: 'Claude Code', runtime: 'claude', available: true, status: 'ready', capabilities: { structured: true }, models: [{ id: 'sonnet', label: 'Sonnet', default: true }], reasoningLevels: ['low', 'high'] },
] };

export const toolTabs = ['Git & worktrees', 'History', 'Rewind', 'Tasks & schedules', 'Learning', 'Installed skills', 'File transfers', 'Share workspace', 'Session replay'];
export const settingsSections = ['Workspace', 'Terminal', 'Interface', 'Provider connections', 'MCP servers', 'Agent browser', 'Account knowledge', 'Voice', 'Processes'];

/** Every real write is allowlisted here. Structured sessions never reach a server. */
export async function installFixture(page: Page, testInfo: TestInfo) {
  const account = `ui-unification-${randomUUID().replaceAll('-', '')}`;
  const caseName = testInfo.titlePath.slice(1).join('-').replace(/[^a-z0-9]+/gi, '-').toLowerCase();
  const structuredId = `ss-${randomUUID().replaceAll('-', '')}`;
  const terminalIds = new Set<string>();
  const browserIds = new Set<string>();
  const sockets = new Set<WebSocketRoute>();
  const blocked: string[] = [];
  const mocked: string[] = [];
  const pageErrors: string[] = [];
  const writes: string[] = [];
  const cleanup: Record<string, unknown>[] = [];
  let build: unknown;
  const observed: Record<string, unknown>[] = [];
  let structured = false;
  let filesError = false;
  let noteFailure = false;
  let sequence = 0;
  let completed = false;
  const sizeSamples = new Map<string, number>();
  let syntheticSnapshot = { id: structuredId, title: 'Responsive workspace review', cwd: fixtureWorkspace, provider: 'codex', runtime: 'codex', model: 'gpt-6.1-sol', reasoning: 'high', status: 'idle', createdAt: stamp, updatedAt: stamp, events: [] as Record<string, unknown>[], thread: { projectPath: fixtureWorkspace, topic: 'Responsive workspace review' } };
  const notes = [{ id: 'ui-note', title: 'Layout review', content: 'Keep the composer draft while changing tools.', category: '', createdAt: stamp, updatedAt: stamp }];
  const bookmarks = [{ id: 'ui-bookmark', name: 'Inspect terminal size', command: 'stty size', category: 'Development' }];
  const emit = (event: Record<string, unknown>) => {
    const value = { ts: Date.now(), ...event, seq: ++sequence };
    syntheticSnapshot.events.push(value);
    for (const socket of sockets) socket.send(JSON.stringify({ __terminal_meta: true, type: 'structured_event', event: value }));
  };
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.route('**/preview/49999/**', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Layout review</title><style>body{font:16px system-ui;margin:24px;color:#252525;background:#fafafa;max-width:48rem}h1{font-size:24px}p{line-height:1.6}button{font:inherit;padding:10px 14px;border:1px solid #aaa;border-radius:6px;background:white}</style><h1>Workspace layout review</h1><p>A synthetic project page for checking the preview toolbar, viewport modes and developer tools.</p><button type="button">Review changes</button></html>' }));
  await page.routeWebSocket('**/*', socket => {
    const url = new URL(socket.url());
    if (url.pathname === `/api/structured/sessions/${structuredId}/ws`) {
      sockets.add(socket);
      for (const event of syntheticSnapshot.events) socket.send(JSON.stringify({ __terminal_meta: true, type: 'structured_event', event }));
      socket.onClose(() => sockets.delete(socket));
      socket.onMessage(() => blocked.push('Unexpected synthetic socket input'));
      return;
    }
    if ([...terminalIds].some(id => url.pathname === `/api/terminal/${id}/ws`)) {
      const server = socket.connectToServer();
      let commandBuffer = '';
      socket.onMessage(message => {
        const text = String(message);
        let auth = false;
        try { auth = JSON.parse(text).type === 'auth'; } catch { /* PTY data is raw text. */ }
        if (auth) { server.send(message); return; }
        if ((shellCommand + '\r').startsWith(commandBuffer + text)) {
          commandBuffer += text;
          if (commandBuffer === shellCommand + '\r') { server.send(commandBuffer); commandBuffer = ''; }
        }
        else blocked.push('Unexpected owned PTY socket input');
      });
      return;
    }
    // Other transports (system latency, global state) have no private backing data.
    socket.onMessage(() => {});
  });

  await page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    const endpoint = url.pathname;
    const method = request.method();
    const read = ['GET', 'HEAD', 'OPTIONS'].includes(method);
    const json = async (value: unknown, status = 200) => { mocked.push(`${method} ${endpoint}`); await route.fulfill({ status, json: value }); };
    let body: Record<string, any> = {};
    try { body = request.postDataJSON() || {}; } catch { /* Non-JSON writes remain denied. */ }
    const real = async () => {
      if (!read) writes.push(`${method} ${endpoint}`);
      const response = await route.fetch();
      if (endpoint === '/api/terminal' && method === 'POST' && response.ok()) terminalIds.add((await response.json()).session.id);
      if (endpoint === '/api/workspace-browser/sessions' && method === 'POST' && response.ok()) browserIds.add((await response.json()).id);
      await route.fulfill({ response });
    };
    if (['/api/auth/config', '/api/auth/mode'].includes(endpoint) && read) return real();
    if (endpoint === '/api/auth/local-testing' && method === 'POST' && body.username === account) return real();
    if (endpoint === '/api/auth/me' && read) return real();
    if (endpoint === '/api/preview/session' && method === 'POST') return json({ ok: true });
    if (endpoint === '/api/terminal' && method === 'POST' && body.cwd === fixtureWorkspace && body.title === account) return real();
    if (endpoint === '/api/terminal' && read) return real();
    if (endpoint.startsWith('/api/terminal/')) {
      const owned = terminalIds.has(endpoint.split('/')[3]);
      if (owned && endpoint.endsWith('/stream') && read) return route.continue();
      if (owned && endpoint.endsWith('/generate-topic')) return json({ topic: 'Responsive terminal review' });
      if (owned && endpoint.endsWith('/detect-project')) return json({ cwd: fixtureWorkspace });
      if (owned && endpoint.endsWith('/git-branches')) return json({ branches: ['main'], current: 'main' });
      if (owned && endpoint.endsWith('/turns')) return json({ turns: [] });
      if (owned && endpoint.endsWith('/thread')) return json({ thread: body });
      if (owned && (read || method === 'DELETE' || (endpoint.endsWith('/input') && body.command === shellCommand + '\r') || (endpoint.endsWith('/resize') && method === 'POST' && Number.isInteger(body.cols) && Number.isInteger(body.rows)))) return real();
    }
    if (endpoint === '/api/state' && read) {
      const response = await route.fetch({ url: url.origin + '/api/terminal' });
      const value = await response.json();
      return json({ sessions: value.sessions, projectInfo: { cwd: fixtureWorkspace }, processes: [] });
    }
    if (endpoint === '/api/structured/sessions') {
      if (read) return json(structured ? [{ ...syntheticSnapshot, events: [] }] : []);
      if (method === 'POST' && body.cwd === fixtureWorkspace) { structured = true; return json(syntheticSnapshot); }
    }
    if (endpoint === `/api/structured/sessions/${structuredId}` && read) return json(syntheticSnapshot);
    if (endpoint === `/api/structured/sessions/${structuredId}/attachments` && method === 'POST' && request.headers()['content-type']?.startsWith('multipart/form-data') && (request.postDataBuffer()?.length || Infinity) <= 2048 && request.postDataBuffer()?.includes(Buffer.from('ui-pixel.png'))) return json({ error: 'Synthetic image upload denied; no file was written.' }, 403);
    if (endpoint.startsWith(`/api/structured/sessions/${structuredId}/attachments/`) && method === 'DELETE') return route.fulfill({ status: 204 });
    if (endpoint === `/api/structured/sessions/${structuredId}/input` && method === 'POST') {
      const requestId = body.requestId;
      const content = body.text || body.input || body.message || body.data || '';
      emit({ type: 'user_message_accepted', role: 'user', content, requestId, turnId: 'ui-turn', messageId: 'ui-user' });
      emit({ type: 'tool_started', toolCallId: 'ui-read', toolName: 'Read', toolInput: { file_path: '/tmp/src/layout.css' }, turnId: 'ui-turn' });
      emit({ type: 'tool_completed', toolCallId: 'ui-read', toolName: 'Read', result: '.workspace { min-width: 0; }', turnId: 'ui-turn' });
      emit({ type: 'message_completed', role: 'assistant', messageId: 'ui-assistant', turnId: 'ui-turn', content: 'The workspace now keeps a clear reading rail.\n\n- Preserve the unsent draft.\n- Keep Browser controls reachable.\n\n```css\n.workspace { min-width: 0; }\n```\n\n| Surface | Check |\n| --- | --- |\n| Composer | Draft retained |\n| Browser | Resize and reopen |' });
      emit({ type: 'turn_completed', turnId: 'ui-turn', status: 'completed' });
      return json({ requestId, turnId: 'ui-turn', messageId: 'ui-user', acceptedSeq: 1, status: 'completed' });
    }
    if (endpoint === `/api/structured/sessions/${structuredId}/approve` && method === 'POST') {
      emit({ type: 'approval_resolved', approvalId: 'ui-approval' });
      emit({ type: 'turn_completed', turnId: 'ui-approval-turn', status: 'completed' });
      return json({ status: 'accepted', approvalId: 'ui-approval', approved: body.approved });
    }
    if (endpoint === `/api/structured/sessions/${structuredId}/selection` && method === 'PATCH') { syntheticSnapshot = { ...syntheticSnapshot, ...body }; return json(syntheticSnapshot); }
    if (endpoint === '/api/workspace-browser/approvals' && read) return json([]);
    if (endpoint === '/api/workspace-browser/sessions' && method === 'POST') return real();
    if (endpoint.startsWith('/api/workspace-browser/sessions/') && browserIds.has(endpoint.split('/')[4])) {
      if (read || method === 'DELETE' || (endpoint.endsWith('/command') && ['resize', 'state', 'control'].includes(body.type))) return real();
    }
    if (read) {
      if (endpoint === '/api/agent/catalog') return json(catalog);
      if (endpoint === '/api/agent/auth') return json({ providers: [{ id: 'codex', label: 'Codex', status: 'auth-required', configured: false, methods: ['cli'], command: 'codex login' }] });
      if (endpoint === '/api/settings') return json({ terminalFontSize: 14, terminalWebglEnabled: false, recentFolders: [fixtureWorkspace], theme: 'dark', previewUrl: 'http://localhost:49999' });
      if (endpoint === '/api/fs/list') return json({ path: fixtureWorkspace, parent: '/', folders: ['src', 'docs'] });
      if (endpoint === '/api/files/list') return filesError ? json({ error: 'Synthetic directory unavailable. Retry to continue.' }, 503) : json({ path: fixtureWorkspace, items: [{ name: 'src', type: 'directory', size: 0, modified: stamp }, { name: 'README.md', type: 'file', size: 1240, modified: stamp }, { name: 'layout.css', type: 'file', size: 864, modified: stamp }] });
      if (endpoint === '/api/notes') return json({ notes });
      if (endpoint === '/api/bookmarks') return json({ bookmarks });
      if (endpoint === '/api/vault') return json({ keys: [] });
      if (endpoint === '/api/auth/passkey/credentials') return json({ credentials: [] });
      if (endpoint === '/api/processes') return json({ processes: [], repositories: [] });
      if (endpoint === '/api/environments') return json({ environments: [], grants: [] });
      if (endpoint === '/api/tunnels') return json([]);
      if (endpoint === '/api/client-build') return real();
      if (endpoint === '/api/projects/scan') return json({ projects: [], scanPaths: [] });
      if (endpoint === '/api/system/preview-config') return json({});
      if (endpoint === '/api/workspace/git/status') return json({ branch: 'main', files: [{ path: 'src/layout.css', status: 'M', staged: false }], isGitRepo: true });
      if (endpoint === '/api/workspace/git/diff') return json({ patch: 'diff --git a/src/layout.css b/src/layout.css\n@@ -1 +1 @@\n-.workspace { width: 100vw; }\n+.workspace { min-width: 0; }' });
      if (['/api/workspace/git/worktrees', '/api/workspace/git/checkpoints', '/api/workspace/history', '/api/workspace/native-history/imports'].includes(endpoint)) return json([]);
      if (endpoint === '/api/workspace/native-history/sources') return json({ sources: [{ sourceId: 'ui-native-source', provider: 'codex', title: 'Synthetic responsive layout review', messageCount: 4, truncated: false }], warnings: [] });
      if (endpoint === '/api/workspace/tasks') return json({ tasks: [], schedules: [] });
      if (endpoint === '/api/workspace/rewind') return json({ managed: false, checkpoints: [], activeSessions: [], operations: [] });
      if (endpoint === '/api/workspace/skills') return json({ skills: [], warnings: [] });
      if (endpoint === '/api/workspace/profile' || endpoint === '/api/account/knowledge') return json({ memory: '', skills: [], revision: 1 });
      if (endpoint.includes('proposals')) return json({ proposals: [] });
      if (endpoint.includes('transfers')) return json([]);
      if (endpoint === '/api/collaboration/invitations') return json({ invitations: [] });
      if (endpoint === '/api/recordings') return json({ recordings: [] });
      if (endpoint === '/api/agent/mcp') return json({ servers: [] });
      if (endpoint === '/api/agent/connections') return json({ profiles: [] });
      if (endpoint === '/api/agent/browser') return json({ enabled: false, executable: null, headless: true, timeoutSeconds: 15, allowedOrigins: [] });
      if (endpoint === '/api/preview/active-ports') return json({ ports: [] });
      if (endpoint.startsWith('/api/preview/49999/')) return json({ logs: [], cookies: [], localStorage: {}, sessionStorage: {}, entries: [] });
      if (endpoint === '/api/transcribe/health') return json({ available: false, error: 'Voice is unavailable in this fixture.' });
      if (endpoint === '/api/health') return json({ status: 'ok' });
      if (endpoint === '/api/relay/status') return json({ configured: false, connected: false, brokerEnabled: false });
      if (endpoint === '/api/desktop/status') return json({ supported: false, enabled: false, monitors: [], reason: 'Remote desktop is disabled for this fixture.' });
      if (endpoint === '/api/system/stats') return json({ stats: { cpuPercent: 24, cpu: { cores: 8 }, memoryUsed: 6 * 1024 ** 3, memoryTotal: 16 * 1024 ** 3, memoryPercent: 37.5, diskUsed: 80 * 1024 ** 3, diskTotal: 256 * 1024 ** 3, diskPercent: 31.25, uptime: 7200, timestamp: Date.now(), processes: [] } });
      if (endpoint === '/api/system/stats/history') return json({ history: [{ cpuPercent: 20, memoryPercent: 35, diskPercent: 31, timestamp: 1792929600000 }, { cpuPercent: 24, memoryPercent: 37.5, diskPercent: 31.25, timestamp: 1792929900000 }] });
    }
    if (endpoint === '/api/settings' && method === 'PATCH') return json(body);
    if (endpoint === '/api/preview/resource-auth' && method === 'POST' && typeof body.targetPath === 'string' && body.targetPath.startsWith('/preview/49999/')) return json({ previewToken: 'synthetic-preview-token', targetPath: body.targetPath });
    if (endpoint === '/api/notes/ui-note' && method === 'PUT') {
      if (noteFailure) return json({ error: 'Synthetic note save unavailable' }, 503);
      Object.assign(notes[0], body); return json({ note: notes[0] });
    }
    blocked.push(`${method} ${endpoint}`);
    return json({ error: 'UI fixture blocked an unconfigured request' }, 403);
  });

  async function screenshot(name: string) {
    await mkdir(evidenceRoot, { recursive: true });
    const filename = `${caseName}-${name}.png`;
    const target = path.join(evidenceRoot, filename);
    let captureRetries = 0;
    for (;;) {
      try { await page.screenshot({ path: target, animations: 'disabled', fullPage: false }); break; }
      catch (error) {
        if (!(error instanceof Error) || !error.message.includes('Unable to capture screenshot') || captureRetries >= 2) throw error;
        captureRetries++;
        await page.bringToFront();
        await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
      }
    }
    await testInfo.attach(name, { path: target, contentType: 'image/png' });
    const geometry = await page.evaluate(() => {
      const visible = (element: Element) => { const box = element.getBoundingClientRect(); return box.width > 0 && box.height > 0 && getComputedStyle(element).visibility !== 'hidden'; };
      const headers = [...document.querySelectorAll('.terminal-pane-header, .workspace-browser-heading, .mobile-header, .pro-sidebar-header')].filter(visible).map(element => ({ selector: element.className, height: element.getBoundingClientRect().height }));
      const inputs = [...document.querySelectorAll('textarea[aria-label="Command composer"], input[aria-label="Browser address"]')].filter(visible).map(element => ({ label: element.getAttribute('aria-label'), fontSize: getComputedStyle(element).fontSize, fontFamily: getComputedStyle(element).fontFamily, width: element.getBoundingClientRect().width }));
      return { theme: document.documentElement.getAttribute('data-theme'), coarsePointer: matchMedia('(pointer: coarse)').matches, headers, inputs };
    });
    observed.push({ name, screenshot: filename, viewport: page.viewportSize(), geometry, captureRetries });
  }
  return {
    account, structuredId, terminalIds, blocked, pageErrors, observed, writes, screenshot,
    emitStructured(event: Record<string, unknown>) { emit(event); },
    setStructuredStatus(status: string) { syntheticSnapshot = { ...syntheticSnapshot, status }; },
    includeSyntheticConversation() { structured = true; },
    async imageConversation() {
      structured = true;
      syntheticSnapshot = { ...syntheticSnapshot, runtime: 'v4', title: 'V4 image review', thread: { ...syntheticSnapshot.thread, topic: 'V4 image review' } };
      emit({ type: 'message_completed', role: 'assistant', messageId: 'ui-image-intro', turnId: 'ui-image-review', content: 'Attach a small layout reference before writing the next review.' });
      await page.reload();
      await expect(page.getByText('Attach a small layout reference before writing the next review.', { exact: true })).toBeVisible();
    },
    async ptySize(id: string, label: string) {
      await page.evaluate(async ({ id, command }) => {
        const headers = { Authorization: `Bearer ${localStorage.getItem('terminal_access_token')}`, 'Content-Type': 'application/json' };
        const response = await fetch(`/api/terminal/${id}/input`, { method: 'POST', headers, body: JSON.stringify({ command }) });
        if (!response.ok) throw new Error(`Owned PTY sample failed: ${response.status}`);
      }, { id, command: shellCommand + '\r' });
      let sizes: number[][] = [];
      await expect.poll(async () => {
        sizes = await page.evaluate(async id => {
          const response = await fetch(`/api/terminal/${id}/history`, { headers: { Authorization: `Bearer ${localStorage.getItem('terminal_access_token')}` } });
          const data = await response.json();
          const text = data.history.map((entry: { text: string }) => entry.text).join('');
          return [...text.matchAll(/(?:^|[\r\n])(\d+)\s+(\d+)(?=[\r\n])/g)].map(match => [Number(match[1]), Number(match[2])]);
        }, id);
        return sizes.length;
      }).toBeGreaterThan(sizeSamples.get(id) || 1);
      sizeSamples.set(id, sizes.length);
      const size = sizes.at(-1)!;
      observed.push({ name: `pty-size-${label}`, rows: size[0], columns: size[1] });
      return size;
    },
    passed() { completed = testInfo.errors.length === 0; },
    setFilesError(value: boolean) { filesError = value; },
    setNoteFailure(value: boolean) { noteFailure = value; },
    approval() { emit({ type: 'turn_started', turnId: 'ui-approval-turn' }); emit({ type: 'approval_required', approvalId: 'ui-approval', turnId: 'ui-approval-turn', toolName: 'Bash', toolInput: { command: 'printf approved-preview' }, description: 'Run a harmless preview check' }); },
    appendReview() {
      const updates = [
        'Navigation review\n\nThe project tree keeps its hierarchy, selected thread and resize handle. Search uses the existing labels.',
        'Composer review\n\nThe follow-up remains editable while tools are open. Model selection stays attached to this conversation.',
        'Browser review\n\nThe pane keeps its tabs when closed. The terminal renderer stays mounted while the browser width changes.',
        'Responsive review\n\nThe phone menu and tool sheet use their established breakpoints. Keyboard focus returns to the opening control.',
        'State review\n\nA failed note save keeps the draft. File errors explain how to retry without hiding the active workspace.',
      ];
      for (const [index, content] of updates.entries()) {
        const turnId = `ui-review-${index}`;
        emit({ type: 'message_completed', role: 'user', messageId: `${turnId}-user`, turnId, content: `Review section ${index + 1}.` });
        emit({ type: 'message_completed', role: 'assistant', messageId: `${turnId}-assistant`, turnId, content });
      }
    },
    appendLatest() { emit({ type: 'message_completed', role: 'assistant', messageId: 'ui-latest', turnId: 'ui-latest', content: 'The latest review is ready. Your earlier reading position is preserved.' }); },
    async login() {
      await page.goto('/');
      await expect(page.getByRole('heading', { name: 'Choose your username' })).toBeVisible();
      await screenshot('login');
      await page.getByLabel('Username', { exact: true }).fill(account);
      await page.getByRole('button', { name: 'Open workspace', exact: true }).click();
      await expect(page.getByRole('region', { name: 'Workspace start' })).toBeVisible();
      const currentScript = await page.locator('script[src*="/assets/index-"]').getAttribute('src');
      const dist = await readFile(path.join(distDirectory, 'index.html'), 'utf8');
      const distScript = dist.match(/src="([^"]*\/assets\/index-[^"]+\.js)"/)?.[1];
      const sourceRoot = path.resolve(import.meta.dirname, '../src');
      const sourceFiles = (await readdir(sourceRoot, { recursive: true, withFileTypes: true })).filter(entry => entry.isFile());
      const sourceTimes = await Promise.all(sourceFiles.map(async entry => ({ path: path.join(entry.parentPath, entry.name), mtime: (await stat(path.join(entry.parentPath, entry.name))).mtimeMs })));
      const latestSource = sourceTimes.reduce((latest, file) => file.mtime > latest.mtime ? file : latest);
      const distTime = (await stat(path.join(distDirectory, 'index.html'))).mtimeMs;
      build = { baseURL: testInfo.project.use.baseURL, distDirectory, currentScript, distScript, matchesCurrentDist: currentScript === distScript, distNewerThanSource: distTime >= latestSource.mtime, latestSource: path.relative(sourceRoot, latestSource.path) };
      if (process.env.E2E_UI_DIST) expect(currentScript, 'Staged server must serve the selected task-local dist').toBe(distScript);
      if (process.env.E2E_UI_EXPECT_CURRENT_BUILD === '1') {
        expect(currentScript, 'Gateway must serve the current combined frontend dist').toBe(distScript);
        expect(distTime, 'Parent must build after all frontend source edits').toBeGreaterThanOrEqual(latestSource.mtime);
      }
    },
    async terminal() {
      const response = await page.evaluate(async ({ cwd, title }) => {
        const response = await fetch('/api/terminal', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${localStorage.getItem('terminal_access_token')}` }, body: JSON.stringify({ cwd, title }) });
        if (!response.ok) throw new Error(`Owned PTY creation failed: ${response.status}`);
        return response.json();
      }, { cwd: fixtureWorkspace, title: account });
      terminalIds.add(response.session.id);
      await page.reload();
      return response.session.id as string;
    },
    async finish() {
      if (!completed) await screenshot('failure').catch(() => {});
      const origin = new URL(testInfo.project.use.baseURL as string).origin;
      const accessToken = await page.evaluate(() => localStorage.getItem('terminal_access_token')).catch(() => null);
      await page.goto('about:blank');
      await page.unrouteAll({ behavior: 'wait' });
      for (const id of terminalIds) {
        writes.push(`DELETE /api/terminal/${id}`);
        cleanup.push(await page.request.delete(`${origin}/api/terminal/${id}`, { headers: { Authorization: `Bearer ${accessToken}` } }).then(response => ({ resource: 'owned-pty', id, status: response.status() })).catch(() => ({ resource: 'owned-pty', id, status: 'cleanup-failed' })));
      }
      for (const id of browserIds) {
        writes.push(`DELETE /api/workspace-browser/sessions/${id}`);
        cleanup.push(await page.request.delete(`${origin}/api/workspace-browser/sessions/${id}`, { headers: { Authorization: `Bearer ${accessToken}` } }).then(response => ({ resource: 'owned-browser', id, status: response.status() })).catch(() => ({ resource: 'owned-browser', id, status: 'cleanup-failed' })));
      }
      await mkdir(evidenceRoot, { recursive: true });
      const cleanupFailures = cleanup.filter(item => typeof item.status !== 'number' || (item.status >= 400 && item.status !== 404));
      completed = completed && cleanupFailures.length === 0;
      await writeFile(path.join(evidenceRoot, `${caseName}.json`), JSON.stringify({ status: completed ? 'passed' : 'failed-or-interrupted', capturedAt: new Date().toISOString(), phase: process.env.E2E_UI_EXPECT_CURRENT_BUILD === '1' ? 'current-build' : process.env.E2E_UI_DIST ? 'staged' : 'baseline', disposableAccount: account, build, observed, blocked: [...new Set(blocked)], mocked: [...new Set(mocked)], realWrites: writes, cleanup, pageErrors }, null, 2));
      expect.soft(cleanupFailures, 'Disposable PTY and browser cleanup must complete').toEqual([]);
    },
  };
}

export async function openUtility(page: Page, name: string) {
  const menu = page.getByRole('dialog', { name: 'Mobile menu', exact: true });
  if (await menu.isVisible()) await menu.getByRole('button', { name: 'Close menu', exact: true }).click();
  if (name === 'Preview') {
    const previewTab = page.getByRole('tab', { name: 'Preview', exact: true }).filter({ visible: true });
    if (await previewTab.count()) { await previewTab.click(); return; }
    const overflow = page.getByRole('button', { name: 'More actions', exact: true });
    if (await overflow.isVisible()) {
      await overflow.click();
      const action = page.getByRole('button', { name: 'Preview', exact: true }).filter({ visible: true });
      if (await action.count()) { await action.click(); return; }
      await page.keyboard.press('Escape');
    }
  }
  const direct = page.getByRole('button', { name, exact: true }).filter({ visible: true });
  if (await direct.count()) { await direct.first().click(); return; }
  if (name === 'Files') {
    await page.getByRole('button', { name: 'More actions', exact: true }).click();
    await page.getByRole('button', { name: 'File Manager', exact: true }).filter({ visible: true }).click();
    return;
  }
  await page.getByRole('button', { name: 'Menu', exact: true }).click();
  await expect(menu).toBeVisible();
  await menu.getByRole('button', { name, exact: true }).click();
}

export async function expectFits(page: Page, locator = page.locator('#root')) {
  await expect(locator).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(page.viewportSize()!.width);
  await expect(locator).toBeInViewport({ ratio: 1 });
}
