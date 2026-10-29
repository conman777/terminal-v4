import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useThreadDrawerTerminal } from './useThreadDrawerTerminal';
import { setActiveEnvironment } from '../utils/remoteEnvironments';
import { setUser } from '../utils/auth';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const companion = (id, createdAt) => ({ id, createdAt, thread: { companionOf: 'ss-1' } });

beforeEach(() => sessionStorage.clear());

describe('useThreadDrawerTerminal', () => {
  it('lists the thread\'s terminals, switches between them and adds more', async () => {
    const createSession = vi.fn().mockResolvedValue({ id: 'pty-3' });
    const updateThreadMetadata = vi.fn().mockResolvedValue({ companionOf: 'ss-1' });
    const sessions = [companion('pty-2', '2026-01-02'), companion('pty-1', '2026-01-01'), { id: 'other' }];
    const { result } = renderHook(() => useThreadDrawerTerminal({ threadId: 'ss-1', cwd: '/work', open: true, sessions, createSession, updateThreadMetadata }));
    const initial = [result.current.terminals.map(t => t.id), result.current.terminalId];
    act(() => result.current.select('pty-2'));
    const switched = result.current.terminalId;
    await act(async () => { await result.current.addTerminal(); });
    await waitFor(() => expect(result.current.terminalId).toBe('pty-3'));
    expect([initial, switched, createSession.mock.calls, updateThreadMetadata.mock.calls]).toEqual([
      [['pty-1', 'pty-2'], 'pty-1'], 'pty-2',
      [[{ cwd: '/work', title: 'Terminal 3', select: false, requestId: expect.stringMatching(UUID), companionOf: 'ss-1' }]], [['pty-3', { companionOf: 'ss-1' }]],
    ]);
  });

  it('opens the first terminal in the thread folder when the drawer opens', async () => {
    const createSession = vi.fn().mockResolvedValue({ id: 'pty-1' });
    const updateThreadMetadata = vi.fn().mockResolvedValue({ companionOf: 'ss-1' });
    const { result, rerender } = renderHook(({ open }) => useThreadDrawerTerminal({ threadId: 'ss-1', cwd: '/work', open, sessions: [], createSession, updateThreadMetadata }), { initialProps: { open: false } });
    const before = createSession.mock.calls.length;
    rerender({ open: true });
    await waitFor(() => expect(result.current.terminalId).toBe('pty-1'));
    expect([before, createSession.mock.calls, updateThreadMetadata.mock.calls]).toEqual([0, [[{ cwd: '/work', title: 'Terminal', select: false, requestId: expect.stringMatching(UUID), companionOf: 'ss-1' }]], [['pty-1', { companionOf: 'ss-1' }]]]);
  });

  it('reuses a created terminal when linking it to the thread needs retrying', async () => {
    const createSession = vi.fn().mockResolvedValue({ id: 'pty-created' });
    const updateThreadMetadata = vi.fn().mockRejectedValueOnce(new Error('Link failed')).mockResolvedValueOnce({ companionOf: 'ss-1' });
    const { result } = renderHook(() => useThreadDrawerTerminal({ threadId: 'ss-1', cwd: '/work', open: true, sessions: [], createSession, updateThreadMetadata }));
    await waitFor(() => expect(result.current.error).toBe('Link failed'));
    await act(async () => { await result.current.retry(); });
    expect([createSession.mock.calls, updateThreadMetadata.mock.calls, result.current.terminalId]).toEqual([
      [[{ cwd: '/work', title: 'Terminal', select: false, requestId: expect.stringMatching(UUID), companionOf: 'ss-1' }]],
      [['pty-created', { companionOf: 'ss-1' }], ['pty-created', { companionOf: 'ss-1' }]], 'pty-created',
    ]);
  });

  it('restarts a drawer terminal whose shell ended, like after a server restart', async () => {
    const restoreSession = vi.fn().mockResolvedValue({ restored: true });
    const sessions = [{ ...companion('pty-1', '2026-01-01'), isActive: false }];
    renderHook(() => useThreadDrawerTerminal({ threadId: 'ss-1', cwd: '/work', open: true, sessions, createSession: vi.fn(), updateThreadMetadata: vi.fn(), restoreSession }));
    await waitFor(() => expect(restoreSession.mock.calls).toEqual([['pty-1', { automatic: true, select: false }]]));
  });

  it('restores the same terminal again after it ran and ended a second time', async () => {
    const restoreSession = vi.fn().mockResolvedValue({ restored: true });
    const { rerender } = renderHook(({ active }) => useThreadDrawerTerminal({ threadId: 'ss-1', cwd: '/work', open: true,
      sessions: [{ ...companion('pty-1', '2026-01-01'), isActive: active }], createSession: vi.fn(), restoreSession }),
    { initialProps: { active: false } });
    await waitFor(() => expect(restoreSession).toHaveBeenCalledTimes(1));
    rerender({ active: true });
    rerender({ active: false });
    await waitFor(() => expect(restoreSession).toHaveBeenCalledTimes(2));
  });

  it('does not overlap restores when the shell starts and exits before the first restore returns', async () => {
    let finish;
    const restoreSession = vi.fn().mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }))
      .mockResolvedValueOnce({ restored: true });
    const { rerender } = renderHook(({ active }) => useThreadDrawerTerminal({ threadId: 'ss-1', cwd: '/work', open: true,
      sessions: [{ ...companion('pty-1', '2026-01-01'), isActive: active }], createSession: vi.fn(), restoreSession }),
    { initialProps: { active: false } });
    await waitFor(() => expect(restoreSession).toHaveBeenCalledTimes(1));
    rerender({ active: true });
    rerender({ active: false });
    expect(restoreSession).toHaveBeenCalledTimes(1);
    await act(async () => finish({ restored: true }));
    await waitFor(() => expect(restoreSession).toHaveBeenCalledTimes(2));
  });

  it('clears a restore error if the terminal becomes active independently', async () => {
    const restoreSession = vi.fn().mockRejectedValueOnce(new Error('offline'));
    const { result, rerender } = renderHook(({ active }) => useThreadDrawerTerminal({ threadId: 'ss-1', cwd: '/work', open: true,
      sessions: [{ ...companion('pty-1', '2026-01-01'), isActive: active }], createSession: vi.fn(), restoreSession }),
    { initialProps: { active: false } });
    await waitFor(() => expect(result.current.canRetry).toBe(true));
    rerender({ active: true });
    await waitFor(() => expect([result.current.error, result.current.canRetry]).toEqual(['', false]));
  });

  it('does not display a late restore error after the terminal became active', async () => {
    let rejectRestore;
    const restoreSession = vi.fn(() => new Promise((resolve, reject) => { rejectRestore = reject; }));
    const { result, rerender } = renderHook(({ active }) => useThreadDrawerTerminal({ threadId: 'ss-1', cwd: '/work', open: true,
      sessions: [{ ...companion('pty-1', '2026-01-01'), isActive: active }], createSession: vi.fn(), restoreSession }),
    { initialProps: { active: false } });
    await waitFor(() => expect(restoreSession).toHaveBeenCalledOnce());
    rerender({ active: true });
    await act(async () => rejectRestore(new Error('late failure')));
    expect([result.current.error, result.current.canRetry]).toEqual(['', false]);
  });

  it('retries a failed restore only when requested and keeps a different terminal usable', async () => {
    let finishRetry;
    const restoreSession = vi.fn().mockRejectedValueOnce(new Error('offline'))
      .mockImplementationOnce(() => new Promise(resolve => { finishRetry = resolve; }));
    const sessions = [{ ...companion('pty-1', '2026-01-01'), isActive: false },
      { ...companion('pty-2', '2026-01-02'), isActive: true }];
    const { result } = renderHook(() => useThreadDrawerTerminal({ threadId: 'ss-1', cwd: '/work', open: true, sessions, createSession: vi.fn(), updateThreadMetadata: vi.fn(), restoreSession }));
    await waitFor(() => expect(result.current.error).toBe('This terminal could not be restarted.'));
    act(() => result.current.select('pty-2'));
    expect([result.current.terminalId, result.current.error]).toEqual(['pty-2', '']);
    act(() => result.current.select('pty-1'));
    expect(result.current.canRetry).toBe(true);
    await act(async () => { void result.current.retry(); void result.current.retry(); });
    expect(restoreSession).toHaveBeenCalledTimes(2);
    await act(async () => finishRetry({ restored: true }));
    expect([result.current.terminalId, result.current.error]).toEqual(['pty-1', '']);
  });

  it('keeps late restore failures with their own threads and retries the selected thread', async () => {
    const pending = {};
    const restoreSession = vi.fn(id => new Promise((resolve, reject) => { pending[id] = { resolve, reject }; }));
    const sessions = [
      { id: 'pty-a', isActive: false, thread: { companionOf: 'ss-a' } },
      { id: 'pty-b', isActive: false, thread: { companionOf: 'ss-b' } },
    ];
    const { result, rerender } = renderHook(({ threadId }) => useThreadDrawerTerminal({ threadId, cwd: '/work', open: true,
      sessions, createSession: vi.fn(), restoreSession }), { initialProps: { threadId: 'ss-a' } });
    await waitFor(() => expect(restoreSession).toHaveBeenCalledWith('pty-a', { automatic: true, select: false }));
    rerender({ threadId: 'ss-b' });
    await waitFor(() => expect(restoreSession).toHaveBeenCalledWith('pty-b', { automatic: true, select: false }));
    await act(async () => pending['pty-b'].reject(new Error('B failed')));
    expect([result.current.terminalId, result.current.canRetry, result.current.error]).toEqual(['pty-b', true, 'This terminal could not be restarted.']);
    await act(async () => pending['pty-a'].reject(new Error('A failed late')));
    expect([result.current.terminalId, result.current.canRetry, result.current.error]).toEqual(['pty-b', true, 'This terminal could not be restarted.']);
    rerender({ threadId: 'ss-a' });
    expect([result.current.terminalId, result.current.canRetry, result.current.error]).toEqual(['pty-a', true, 'This terminal could not be restarted.']);
    await act(async () => { void result.current.retry(); });
    expect(restoreSession).toHaveBeenCalledTimes(3);
    await act(async () => pending['pty-a'].resolve({ restored: true }));
    expect(result.current.error).toBe('');
    rerender({ threadId: 'ss-b' });
    expect([result.current.canRetry, result.current.error]).toEqual([true, 'This terminal could not be restarted.']);
  });

  it('keeps independent failures when two terminal tabs fail out of order', async () => {
    const pending = {};
    const restoreSession = vi.fn(id => new Promise((resolve, reject) => { pending[id] = { resolve, reject }; }));
    const sessions = [{ ...companion('pty-1', '2026-01-01'), isActive: false }, { ...companion('pty-2', '2026-01-02'), isActive: false }];
    const { result } = renderHook(() => useThreadDrawerTerminal({ threadId: 'ss-1', cwd: '/work', open: true, sessions, createSession: vi.fn(), restoreSession }));
    await waitFor(() => expect(restoreSession).toHaveBeenCalledTimes(1));
    act(() => result.current.select('pty-2'));
    await waitFor(() => expect(restoreSession).toHaveBeenCalledTimes(2));
    await act(async () => pending['pty-2'].reject(new Error('second failed')));
    await act(async () => pending['pty-1'].reject(new Error('first failed late')));
    expect([result.current.terminalId, result.current.canRetry, result.current.error]).toEqual(['pty-2', true, 'This terminal could not be restarted.']);
    act(() => result.current.select('pty-1'));
    expect([result.current.canRetry, result.current.error]).toEqual([true, 'This terminal could not be restarted.']);
  });

  it('keeps a failed restore retry when another terminal is being created', async () => {
    let finishCreate;
    const restoreSession = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce({ restored: true });
    const createSession = vi.fn(() => new Promise(resolve => { finishCreate = resolve; }));
    const updateThreadMetadata = vi.fn().mockResolvedValue({ companionOf: 'ss-1' });
    const sessions = [{ ...companion('pty-ended', '2026-01-01'), isActive: false }];
    const { result } = renderHook(() => useThreadDrawerTerminal({ threadId: 'ss-1', cwd: '/work', open: true,
      sessions, createSession, updateThreadMetadata, restoreSession }));
    await waitFor(() => expect(result.current.canRetry).toBe(true));
    act(() => { void result.current.addTerminal(); });
    expect([result.current.canRetry, result.current.error]).toEqual([true, 'This terminal could not be restarted.']);
    await act(async () => finishCreate({ id: 'pty-new' }));
    expect(result.current.terminalId).toBe('pty-new');
    act(() => result.current.select('pty-ended'));
    expect([result.current.canRetry, result.current.error]).toEqual([true, 'This terminal could not be restarted.']);
    await act(async () => { await result.current.retry(); });
    expect(restoreSession).toHaveBeenCalledTimes(2);
    expect(result.current.error).toBe('');
  });

  it('keeps an existing terminal usable when adding another terminal fails', async () => {
    const createSession = vi.fn().mockRejectedValueOnce(new Error('Cannot add terminal')).mockResolvedValueOnce({ id: 'pty-new' });
    const updateThreadMetadata = vi.fn().mockResolvedValue({ companionOf: 'ss-1' });
    const sessions = [{ ...companion('pty-running', '2026-01-01'), isActive: true }];
    const { result } = renderHook(() => useThreadDrawerTerminal({ threadId: 'ss-1', cwd: '/work', open: true, sessions, createSession, updateThreadMetadata }));
    await act(async () => { await result.current.addTerminal(); });
    expect([result.current.terminalId, result.current.error, result.current.canRetryCreate, result.current.canStartAgainAfterReview]).toEqual(['pty-running', '', false, true]);
    expect(result.current.createError).toMatch(/Cannot add terminal.*may already exist/);
    await act(async () => { await result.current.startAgainAfterReview(); });
    expect([result.current.terminalId, result.current.createError]).toEqual(['pty-new', '']);
  });

  it('reuses the created terminal if linking a second terminal fails', async () => {
    const createSession = vi.fn().mockResolvedValue({ id: 'pty-created' });
    const updateThreadMetadata = vi.fn().mockRejectedValueOnce(new Error('Link failed')).mockResolvedValueOnce({ companionOf: 'ss-1' });
    const sessions = [{ ...companion('pty-running', '2026-01-01'), isActive: true }];
    const { result } = renderHook(() => useThreadDrawerTerminal({ threadId: 'ss-1', cwd: '/work', open: true, sessions, createSession, updateThreadMetadata }));
    await act(async () => { await result.current.addTerminal(); });
    expect([result.current.terminalId, result.current.error, result.current.createError]).toEqual(['pty-running', '', 'Link failed']);
    await act(async () => { await result.current.retryCreate(); });
    expect([createSession.mock.calls.length, updateThreadMetadata.mock.calls, result.current.terminalId]).toEqual([
      1, [['pty-created', { companionOf: 'ss-1' }], ['pty-created', { companionOf: 'ss-1' }]], 'pty-created',
    ]);
  });

  it('dismisses an add-terminal failure without discarding the existing terminal', async () => {
    const createSession = vi.fn().mockRejectedValueOnce(new Error('Cannot add terminal'));
    const sessions = [{ ...companion('pty-running', '2026-01-01'), isActive: true }];
    const { result } = renderHook(() => useThreadDrawerTerminal({ threadId: 'ss-1', cwd: '/work', open: true, sessions, createSession }));
    await act(async () => { await result.current.addTerminal(); });
    act(() => result.current.dismissCreateError());
    expect([result.current.terminalId, result.current.error, result.current.createError]).toEqual(['pty-running', '', '']);
  });

  it('bounds a long terminal creation error so the usable terminal is not crowded out', async () => {
    const createSession = vi.fn().mockRejectedValueOnce(new Error('x'.repeat(1000)));
    const sessions = [{ ...companion('pty-running', '2026-01-01'), isActive: true }];
    const { result } = renderHook(() => useThreadDrawerTerminal({ threadId: 'ss-1', cwd: '/work', open: true, sessions, createSession }));
    await act(async () => { await result.current.addTerminal(); });
    expect(result.current.terminalId).toBe('pty-running');
    expect(result.current.createError).toMatch(/^x{80}… .*may already exist/);
  });

  it('offers retry when a failed restore becomes stale after switching threads', async () => {
    let finishRestore;
    const restoreSession = vi.fn().mockImplementationOnce(() => new Promise(resolve => { finishRestore = resolve; }))
      .mockResolvedValueOnce({ restored: true });
    const sessions = [
      { id: 'pty-a', isActive: false, thread: { companionOf: 'ss-a' } },
      { id: 'pty-b', isActive: true, thread: { companionOf: 'ss-b' } },
    ];
    const { result, rerender } = renderHook(({ threadId }) => useThreadDrawerTerminal({ threadId, cwd: '/work', open: true,
      sessions, createSession: vi.fn(), restoreSession }), { initialProps: { threadId: 'ss-a' } });
    await waitFor(() => expect(restoreSession).toHaveBeenCalledTimes(1));
    rerender({ threadId: 'ss-b' });
    await act(async () => finishRestore({ restored: false, isCurrent: () => false }));
    expect(result.current.error).toBe('');
    rerender({ threadId: 'ss-a' });
    expect([result.current.canRetry, result.current.error]).toEqual([true, 'This terminal could not be restarted.']);
    await act(async () => { await result.current.retry(); });
    expect(restoreSession).toHaveBeenCalledTimes(2);
    expect(result.current.error).toBe('');
  });

  it('keeps late terminal creation failures with their own threads', async () => {
    const pending = {};
    const createSession = vi.fn(({ cwd }) => new Promise((resolve, reject) => { pending[cwd] = { resolve, reject }; }));
    const { result, rerender } = renderHook(({ threadId, cwd }) => useThreadDrawerTerminal({ threadId, cwd, open: true,
      sessions: [], createSession }), { initialProps: { threadId: 'ss-a', cwd: '/a' } });
    await waitFor(() => expect(createSession).toHaveBeenCalledTimes(1));
    rerender({ threadId: 'ss-b', cwd: '/b' });
    await waitFor(() => expect(createSession).toHaveBeenCalledTimes(2));
    await act(async () => pending['/b'].reject(new Error('B failed')));
    await act(async () => pending['/a'].reject(new Error('A failed late')));
    expect([result.current.canRetry, result.current.canStartAgainAfterReview]).toEqual([false, true]);
    expect(result.current.error).toMatch(/B failed.*may already exist/);
    rerender({ threadId: 'ss-a', cwd: '/a' });
    expect([result.current.canRetry, result.current.canStartAgainAfterReview]).toEqual([false, true]);
    expect(result.current.error).toMatch(/A failed late.*may already exist/);
    expect(createSession).toHaveBeenCalledTimes(2);
  });

  it('does not attach a terminal created on a previous environment to the new environment', async () => {
    let finish;
    const createSession = vi.fn(() => new Promise(resolve => { finish = resolve; }));
    const updateThreadMetadata = vi.fn();
    const { unmount, rerender } = renderHook(({ open }) => useThreadDrawerTerminal({ threadId: 'ss-1', cwd: '/work', open, sessions: [], createSession, updateThreadMetadata }), { initialProps: { open: true } });
    await waitFor(() => expect(createSession).toHaveBeenCalledOnce());
    const finishOld = finish;
    act(() => setActiveEnvironment({ id: 'other-server' }));
    await act(async () => { finishOld({ id: 'old-terminal' }); });
    expect(updateThreadMetadata).not.toHaveBeenCalled();
    expect(createSession).toHaveBeenCalledOnce();
    rerender({ open: false });
    rerender({ open: true });
    await waitFor(() => expect(createSession).toHaveBeenCalledTimes(2));
    unmount();
    act(() => setActiveEnvironment(null));
  });

  it('does not expose a previously listed terminal after an environment change while open', () => {
    const { result, unmount } = renderHook(() => useThreadDrawerTerminal({ threadId: 'ss-1', cwd: '/work', open: true,
      sessions: [{ ...companion('pty-old', '2026-01-01'), isActive: true }], createSession: vi.fn() }));
    expect(result.current.terminalId).toBe('pty-old');
    act(() => setActiveEnvironment({ id: 'other-server', capabilities: { terminalInput: true } }));
    expect({ terminalId: result.current.terminalId, terminals: result.current.terminals, error: result.current.error }).toEqual({
      terminalId: null, terminals: [], error: 'The account or environment changed. Close and reopen the terminal.',
    });
    unmount();
    act(() => setActiveEnvironment(null));
  });

  it('does not expose a previously listed terminal after changing accounts while open', () => {
    act(() => setUser({ id: 'drawer-owner' }));
    const { result, unmount } = renderHook(() => useThreadDrawerTerminal({ threadId: 'ss-1', cwd: '/work', open: true,
      sessions: [{ ...companion('pty-owner', '2026-01-01'), isActive: true }], createSession: vi.fn() }));
    expect(result.current.terminalId).toBe('pty-owner');
    act(() => setUser({ id: 'another-drawer-owner' }));
    expect({ terminalId: result.current.terminalId, terminals: result.current.terminals, error: result.current.error }).toEqual({
      terminalId: null, terminals: [], error: 'The account or environment changed. Close and reopen the terminal.',
    });
    unmount();
    act(() => setUser(null));
  });

  it('does not create or restore terminals while closed or without a workspace', async () => {
    const createSession = vi.fn();
    const restoreSession = vi.fn();
    const { result, rerender } = renderHook(({ open, cwd }) => useThreadDrawerTerminal({ threadId: 'ss-1', cwd, open,
      sessions: [{ ...companion('pty-ended', '2026-01-01'), isActive: false }], createSession, restoreSession }),
    { initialProps: { open: false, cwd: '/work' } });
    await act(async () => { expect(await result.current.addTerminal()).toBeNull(); });
    expect({ terminalId: result.current.terminalId, terminals: result.current.terminals, create: createSession.mock.calls, restore: restoreSession.mock.calls })
      .toEqual({ terminalId: null, terminals: [], create: [], restore: [] });
    rerender({ open: true, cwd: '' });
    await act(async () => { expect(await result.current.addTerminal()).toBeNull(); });
    expect({ terminalId: result.current.terminalId, terminals: result.current.terminals, create: createSession.mock.calls, restore: restoreSession.mock.calls })
      .toEqual({ terminalId: null, terminals: [], create: [], restore: [] });
  });

  it('keeps an existing terminal available without restoring it while the workspace is covered', async () => {
    const restoreSession = vi.fn();
    const { result, rerender } = renderHook(({ active }) => useThreadDrawerTerminal({ threadId: 'ss-1', cwd: '/work', open: true, active,
      sessions: [{ ...companion('pty-ended', '2026-01-01'), isActive: false }], createSession: vi.fn(), restoreSession }),
    { initialProps: { active: false } });
    expect(result.current.terminalId).toBe('pty-ended');
    expect(restoreSession).not.toHaveBeenCalled();
    rerender({ active: true });
    await waitFor(() => expect(restoreSession).toHaveBeenCalledWith('pty-ended', { automatic: true, select: false }));
  });

  it('waits until the workspace is visible before creating its first terminal', async () => {
    const createSession = vi.fn().mockResolvedValue({ id: 'pty-visible' });
    const updateThreadMetadata = vi.fn().mockResolvedValue({ companionOf: 'ss-1' });
    const { result, rerender } = renderHook(({ active }) => useThreadDrawerTerminal({ threadId: 'ss-1', cwd: '/work', open: true, active,
      sessions: [], createSession, updateThreadMetadata }), { initialProps: { active: false } });
    expect(createSession).not.toHaveBeenCalled();
    await act(async () => { expect(await result.current.addTerminal()).toBeNull(); });
    rerender({ active: true });
    await waitFor(() => expect(result.current.terminalId).toBe('pty-visible'));
    expect(createSession).toHaveBeenCalledOnce();
  });

  it('does not link a newly created terminal while its environment permission is revoked', async () => {
    let finish;
    const createSession = vi.fn(() => new Promise(resolve => { finish = resolve; }));
    const updateThreadMetadata = vi.fn().mockResolvedValue({ companionOf: 'ss-1' });
    const { result, rerender } = renderHook(({ allowed }) => useThreadDrawerTerminal({ threadId: 'ss-1', cwd: '/work',
      open: allowed, enabled: allowed, sessions: [], createSession, updateThreadMetadata }), { initialProps: { allowed: true } });
    await waitFor(() => expect(createSession).toHaveBeenCalledOnce());
    rerender({ allowed: false });
    await act(async () => finish({ id: 'pty-pending-permission' }));
    expect(updateThreadMetadata).not.toHaveBeenCalled();
    expect(result.current.terminalId).toBeNull();
    rerender({ allowed: true });
    expect(result.current.error).toBe('Terminal access changed before it could be linked. Retry when access is restored.');
    await act(async () => { await result.current.retry(); });
    expect(createSession).toHaveBeenCalledOnce();
    expect(updateThreadMetadata).toHaveBeenCalledWith('pty-pending-permission', { companionOf: 'ss-1' });
    expect(result.current.terminalId).toBe('pty-pending-permission');
  });

  it('does not attach a terminal to a different signed-in account', async () => {
    let finish;
    const createSession = vi.fn(() => new Promise(resolve => { finish = resolve; }));
    const updateThreadMetadata = vi.fn();
    const { unmount } = renderHook(() => useThreadDrawerTerminal({ threadId: 'ss-1', cwd: '/work', open: true, sessions: [], createSession, updateThreadMetadata }));
    await waitFor(() => expect(createSession).toHaveBeenCalledOnce());
    act(() => setUser({ id: 'another-test-user' }));
    await act(async () => { finish({ id: 'old-terminal' }); });
    expect(updateThreadMetadata).not.toHaveBeenCalled();
    expect(createSession).toHaveBeenCalledOnce();
    unmount();
    act(() => setUser(null));
  });

  it('does not create a second terminal when returning to a thread while its first terminal is opening', async () => {
    const pending = {};
    const createSession = vi.fn(({ cwd }) => new Promise(resolve => { pending[cwd] = resolve; }));
    const updateThreadMetadata = vi.fn().mockResolvedValue({ companionOf: 'ss-1' });
    const { rerender } = renderHook(({ threadId, cwd }) => useThreadDrawerTerminal({ threadId, cwd, open: true, sessions: [], createSession, updateThreadMetadata }), { initialProps: { threadId: 'ss-1', cwd: '/one' } });
    rerender({ threadId: 'ss-2', cwd: '/two' });
    rerender({ threadId: 'ss-1', cwd: '/one' });
    expect(createSession.mock.calls).toEqual([[{ cwd: '/one', title: 'Terminal', select: false, requestId: expect.stringMatching(UUID), companionOf: 'ss-1' }], [{ cwd: '/two', title: 'Terminal', select: false, requestId: expect.stringMatching(UUID), companionOf: 'ss-2' }]]);
    await act(async () => { pending['/one']({ id: 'pty-one' }); pending['/two']({ id: 'pty-two' }); });
  });
});
