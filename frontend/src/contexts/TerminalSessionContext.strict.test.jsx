import { act, render, renderHook, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TerminalSessionProvider, useTerminalSession } from './TerminalSessionContext';
import { setActiveEnvironment } from '../utils/remoteEnvironments';

vi.mock('./FolderContext', () => ({ useFolders: () => ({ recentFolders: [], addRecentFolder: vi.fn() }) }));

const active = (owner = 'account-a') => ({ status: 'active', incarnation: `inc-${owner}`, user: { id: owner },
  pair: { owner, session: `login-${owner}`, home: 'http://localhost:3000/', accessToken: `strict-${owner}` } });
const response = value => new Response(JSON.stringify(value), { status: 200, headers: { 'Content-Type': 'application/json' } });
const strictWrapper = (lifecycle, ready = true) => ({ children }) => <TerminalSessionProvider authLifecycle={lifecycle} strictReady={ready}>{children}</TerminalSessionProvider>;

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem('terminal_access_token', 'legacy-secret');
  vi.stubGlobal('fetch', vi.fn(async url => response(String(url).includes('/api/terminal') ? { sessions: [{ id: 'terminal-a', isActive: true }] } : [])));
});
afterEach(() => { setActiveEnvironment(null); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('strict terminal session provider', () => {
  it.each([null, undefined])('never hydrates or sends via legacy credentials when strict authority is missing', async lifecycle => {
    const { result } = renderHook(() => useTerminalSession(), { wrapper: strictWrapper(lifecycle, false) });
    await waitFor(() => expect(result.current.loadingSessions).toBe(false));
    expect(fetch).not.toHaveBeenCalled();
    await expect(result.current.createSession({ cwd: '/fixture' })).rejects.toThrow(/authentication|sign.in|unavailable/i);
    await expect(result.current.sendToSession('terminal-a', 'unsent draft')).rejects.toThrow(/authentication|sign.in|unavailable/i);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('does not fall back when readiness is asserted without a lifecycle', async () => {
    const { result } = renderHook(() => useTerminalSession(), { wrapper: strictWrapper(undefined, true) });
    await waitFor(() => expect(result.current.loadingSessions).toBe(false));
    expect(result.current.sessionLoadError).toMatch(/authentication/i);
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    { status: 'unavailable' },
    { ...active(), refreshReserved: true },
    { ...active(), user: { id: 'foreign' } },
    { ...active(), pair: { ...active().pair, home: 'https://foreign.invalid/' } },
  ])('does not fetch when the authority snapshot is invalid', async snapshot => {
    const lifecycle = { read: vi.fn(async () => snapshot), refresh: vi.fn() };
    const { result } = renderHook(() => useTerminalSession(), { wrapper: strictWrapper(lifecycle) });
    await waitFor(() => expect(result.current.loadingSessions).toBe(false));
    expect(fetch).not.toHaveBeenCalled();
    expect(result.current.sessionLoadError).toMatch(/authentication/i);
  });

  it('hydrates only with the strict token and refuses unsupported writes or raw senders', async () => {
    const lifecycle = { read: vi.fn(async () => active()), refresh: vi.fn() };
    const { result } = renderHook(() => useTerminalSession(), { wrapper: strictWrapper(lifecycle) });
    await waitFor(() => expect(result.current.sessions.map(item => item.id)).toEqual(['terminal-a']));
    expect(fetch.mock.calls.map(([, options]) => options.headers.get('Authorization'))).toEqual(['Bearer strict-account-a', 'Bearer strict-account-a']);
    const sender = vi.fn();
    act(() => result.current.registerTerminalSender('terminal-a', sender));
    for (const action of [
      () => result.current.createSession({ cwd: '/fixture' }),
      () => result.current.createStructuredSession({ cwd: '/fixture', provider: 'v4' }),
      () => result.current.renameSession('terminal-a', 'new title'),
      () => result.current.closeSession('terminal-a'),
      () => result.current.sendToSession('terminal-a', 'unsent draft'),
      () => result.current.sendRawToSession('terminal-a', 'unsent draft'),
      () => result.current.navigateSession('terminal-a', '/fixture'),
      () => result.current.restoreSession('terminal-a'),
      () => result.current.updateStructuredSessionSelection('ss-a', { model: 'fixture' }),
      () => result.current.updateStructuredSessionAccess('ss-a', 'read-only'),
      () => result.current.updateThreadMetadata('terminal-a', { pinned: true }),
      () => result.current.pinSession('terminal-a'),
      () => result.current.unpinSession('terminal-a'),
      () => result.current.archiveSession('terminal-a'),
      () => result.current.unarchiveSession('terminal-a'),
      () => result.current.updateSessionTopic('terminal-a', 'topic'),
      () => result.current.generateSessionTopic('terminal-a'),
      () => result.current.detectSessionProject('terminal-a'),
      () => result.current.refreshSessionGitStats('terminal-a'),
      () => result.current.listSessionGitBranches('terminal-a'),
      () => result.current.checkoutSessionGitBranch('terminal-a', 'fixture'),
    ]) await expect(action()).rejects.toThrow(/authentication|sign.in|unavailable/i);
    expect([fetch.mock.calls.length, sender.mock.calls.length]).toEqual([2, 0]);
  });

  it('does not apply a delayed old-account inventory after another login wins', async () => {
    let current = active();
    const lifecycle = { read: vi.fn(async () => current), refresh: vi.fn() };
    let release;
    fetch.mockImplementation(url => String(url).includes('/api/terminal')
      ? new Promise(resolve => { release = resolve; }) : Promise.resolve(response([])));
    const { result } = renderHook(() => useTerminalSession(), { wrapper: strictWrapper(lifecycle) });
    await waitFor(() => expect(release).toBeTypeOf('function'));
    current = active('account-b');
    await act(async () => release(response({ sessions: [{ id: 'old-account-terminal', isActive: true }] })));
    await waitFor(() => expect(result.current.loadingSessions).toBe(false));
    expect(result.current.sessions).toEqual([]);
    expect(fetch.mock.calls.every(([, options]) => options.headers.get('Authorization') !== 'Bearer legacy-secret')).toBe(true);
  });

  it('keeps a mounted draft and retires in-flight work when readiness is lost', async () => {
    const lifecycle = { read: vi.fn(async () => active()), refresh: vi.fn() };
    let release;
    fetch.mockImplementation(url => String(url).includes('/api/terminal')
      ? new Promise(resolve => { release = resolve; }) : Promise.resolve(response([])));
    function Draft() { return <textarea aria-label="Unsent draft" defaultValue="keep this" />; }
    const view = render(<TerminalSessionProvider authLifecycle={lifecycle} strictReady><Draft /></TerminalSessionProvider>);
    await waitFor(() => expect(release).toBeTypeOf('function'));
    const draft = screen.getByLabelText('Unsent draft');
    draft.value = 'still unsent';
    view.rerender(<TerminalSessionProvider authLifecycle={lifecycle} strictReady={false}><Draft /></TerminalSessionProvider>);
    await act(async () => release(response({ sessions: [{ id: 'stale', isActive: true }] })));
    expect(screen.getByLabelText('Unsent draft')).toBe(draft);
    expect(draft.value).toBe('still unsent');
    expect(fetch.mock.calls.every(([, options]) => options.headers.get('Authorization') === 'Bearer strict-account-a')).toBe(true);
  });

  it('discards a delayed inventory after the environment changes', async () => {
    const lifecycle = { read: vi.fn(async () => active()), refresh: vi.fn() };
    let release;
    fetch.mockImplementation(url => String(url).includes('/api/terminal')
      ? new Promise(resolve => { release = resolve; }) : Promise.resolve(response([])));
    const { result } = renderHook(() => useTerminalSession(), { wrapper: strictWrapper(lifecycle) });
    await waitFor(() => expect(release).toBeTypeOf('function'));
    act(() => setActiveEnvironment({ id: 'another-environment' }));
    await act(async () => release(response({ sessions: [{ id: 'old-environment', isActive: true }] })));
    await waitFor(() => expect(result.current.loadingSessions).toBe(false));
    expect(result.current.sessions).toEqual([]);
  });

  it('keeps the original identity pinned when a different login appears later', async () => {
    let current = active();
    const lifecycle = { read: vi.fn(async () => current), refresh: vi.fn() };
    const { result } = renderHook(() => useTerminalSession(), { wrapper: strictWrapper(lifecycle) });
    await waitFor(() => expect(result.current.sessions.map(item => item.id)).toEqual(['terminal-a']));
    current = active('account-b');
    await act(async () => { await result.current.retryLoadSessions(); });
    expect(result.current.sessions.map(item => item.id)).toEqual(['terminal-a']);
    expect(result.current.sessionLoadError).toMatch(/authentication changed/i);
    expect(fetch.mock.calls.map(([, options]) => options.headers.get('Authorization'))).toEqual(['Bearer strict-account-a', 'Bearer strict-account-a']);
  });

  it('retains known conversations if a later inventory endpoint disappears', async () => {
    const lifecycle = { read: vi.fn(async () => active()), refresh: vi.fn() };
    let missing = false;
    fetch.mockImplementation(async url => String(url).includes('/api/terminal')
      ? response({ sessions: [] })
      : missing ? new Response(null, { status: 404 }) : response([{ id: 'ss-fixture', provider: 'v4', cwd: '/fixture' }]));
    const { result } = renderHook(() => useTerminalSession(), { wrapper: strictWrapper(lifecycle) });
    await waitFor(() => expect(result.current.sessions.map(item => item.id)).toEqual(['ss-fixture']));
    missing = true;
    await act(async () => { await result.current.retryLoadSessions(); });
    expect(result.current.sessions.map(item => item.id)).toEqual(['ss-fixture']);
    expect(result.current.sessionLoadError).toMatch(/confirm existing conversations/i);
  });
});
