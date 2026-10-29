import { act, renderHook, waitFor } from '@testing-library/react';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// Fixed module-start configuration, equivalent to a configured build/reload.
// This does not claim VITE_API_URL can switch in place in a running app.
vi.hoisted(() => { vi.stubEnv('VITE_API_URL', 'https://synthetic-home.invalid/v4/home/'); });
import { ports, resetFixture, cleanFixture, SESSION, OWNER, CATALOG, snapshot, file, A, response, deferred, R2 } from '../test/userImagesJoinFixture';
vi.mock('../utils/api', () => ({ apiFetch: vi.fn() }));
vi.mock('../utils/userImageDraftStore', () => ({ createUserImageDraftStore: (...args) => ports.nativeFactory(...args) }));
import { apiFetch } from '../utils/api';
import { captureAuthScope } from '../utils/auth';
import { resolveHomeApiUrl } from '../utils/apiBase';
import { getComposerDraftStore } from '../utils/composerDraftStore';
import { setActiveEnvironment } from '../utils/remoteEnvironments';
import { useUserImageComposer } from './useUserImageComposer';

let options;
beforeEach(() => {
  resetFixture(); apiFetch.mockReset().mockImplementation(async url => url === '/api/agent/catalog' ? response(CATALOG) : response(null, 404));
  ports.native.publish(snapshot({ scopeKey: JSON.stringify([OWNER, new URL(resolveHomeApiUrl('/'), window.location.origin).href, 'home', SESSION.id]), localIds: [], items: [] }));
  options = { session: SESSION, active: true, store: getComposerDraftStore(SESSION.id), sendMessage: vi.fn(), checkPendingMessage: vi.fn(), retryPendingMessage: vi.fn() };
});
afterEach(cleanFixture);
afterAll(() => vi.unstubAllEnvs());

describe('real shared image view hook scopes and canonical admission', () => {
  it('[H04 full home] uses actual configured helper/auth full URL including path and trailing slash', async () => {
    const hook = renderHook(() => useUserImageComposer(options));
    const home = new URL(resolveHomeApiUrl('/'), window.location.origin).href;
    expect(home).toBe('https://synthetic-home.invalid/v4/home/'); expect(captureAuthScope().home).toBe(home);
    await waitFor(() => expect(hook.result.current.userImages?.scopeKey).toBe(JSON.stringify([OWNER, home, 'home', SESSION.id])));
    expect(ports.nativeFactory).not.toHaveBeenCalled();
  });

  it('[C01 paired] blocks paired images before any attachment HTTP despite execution grants', async () => {
    setActiveEnvironment({ id: 'paired-fixture', capabilities: { agentExecute: true, transfer: true } });
    const hook = renderHook(() => useUserImageComposer(options));
    await waitFor(() => expect(hook.result.current.userImages?.admission.state).toBe('blocked'));
    expect(hook.result.current.userImages.canAdd).toBe(false);
    await act(async () => { await hook.result.current.userImages.addFiles([file()], { source: 'drop' }).catch(() => {}); });
    expect(apiFetch.mock.calls.filter(([url]) => url.includes('/attachments'))).toEqual([]);
    expect(ports.nativeFactory).not.toHaveBeenCalled();
  });

  it('[H04 session ABA] an old view Add callback cannot attach files after A to B to A even when the scope string matches again', async () => {
    const hook = renderHook(({ session }) => useUserImageComposer({ ...options, session, store: getComposerDraftStore(session.id) }), { initialProps: { session: SESSION } });
    await waitFor(() => expect(hook.result.current.userImages?.canAdd).toBe(true));
    const oldAdd = hook.result.current.userImages.addFiles;
    hook.rerender({ session: { ...SESSION, id: 'ss-other-image-fixture' } }); hook.rerender({ session: SESSION });
    await waitFor(() => expect(hook.result.current.userImages?.canAdd).toBe(true));
    await act(async () => { await oldAdd([file()], { source: 'picker' }).catch(() => {}); });
    expect(ports.nativeFactory).not.toHaveBeenCalled();
    expect(apiFetch.mock.calls.filter(([url]) => url.includes('/attachments'))).toEqual([]);
  });

  it('[C01/H04 model] model ABA during committed upload preparation fences the old upload and ready result', async () => {
    const held = deferred(); ports.native.beginUpload.mockReturnValueOnce(held.promise);
    ports.native.addFiles.mockImplementation(async () => {
      const local = snapshot({ scopeKey: ports.native.getSnapshot().scopeKey, items: [{ ...snapshot().items[0], uploadState: 'local', descriptor: null }] });
      ports.native.publish(local); return { committed: true, headRevision: 1, revision: local.revision, snapshot: local };
    });
    const hook = renderHook(({ session }) => useUserImageComposer({ ...options, session }), { initialProps: { session: SESSION } });
    await waitFor(() => expect(hook.result.current.userImages?.canAdd).toBe(true));
    let adding; await act(async () => { adding = hook.result.current.userImages.addFiles([file()], { source: 'paste' }); adding.catch(() => {}); });
    await waitFor(() => expect(ports.native.beginUpload).toHaveBeenCalled());
    hook.rerender({ session: { ...SESSION, model: 'text-only' } });
    hook.rerender({ session: SESSION });
    await waitFor(() => expect(hook.result.current.userImages?.admission.state).toBe('allowed'));
    await act(async () => { held.resolve({ ...(await ports.native.getBlob('33333333-3333-4333-8333-333333333333')), scopeKey: ports.native.getSnapshot().scopeKey, authorityId: R2, uploadGeneration: 1 }); await adding.catch(() => {}); });
    expect(hook.result.current.userImages.admission.state).toBe('allowed');
    expect(apiFetch.mock.calls.filter(([url]) => url.includes('/attachments'))).toEqual([]);
    expect(ports.native.completeUpload).not.toHaveBeenCalled();
  });
});
