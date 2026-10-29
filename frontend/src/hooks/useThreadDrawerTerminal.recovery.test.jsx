import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearTokens, setUser } from '../utils/auth';
import { setActiveEnvironment, setEnvironmentIdentity } from '../utils/remoteEnvironments';
import { useThreadDrawerTerminal } from './useThreadDrawerTerminal';

beforeEach(() => {
  sessionStorage.clear();
  localStorage.clear();
  setUser({ id: 'terminal-recovery-owner' });
  setEnvironmentIdentity('terminal-recovery-owner', window.location.origin);
  setActiveEnvironment(null);
});
afterEach(() => {
  vi.restoreAllMocks();
  clearTokens(true);
  setEnvironmentIdentity(null);
  sessionStorage.clear();
  localStorage.clear();
});

describe('thread terminal creation recovery', () => {
  it('retains a confirmed but unlinked terminal across unmount and links it only after retry', async () => {
    const createSession = vi.fn().mockResolvedValue({ id: 'pty-recovered', cwd: '/work' });
    const updateThreadMetadata = vi.fn().mockRejectedValueOnce(new Error('Link unavailable')).mockResolvedValueOnce({ companionOf: 'ss-thread' });
    const options = { threadId: 'ss-thread', cwd: '/work', open: true, sessions: [], createSession, updateThreadMetadata };
    const first = renderHook(() => useThreadDrawerTerminal(options));
    await waitFor(() => expect(first.result.current.error).toBe('Link unavailable'));
    first.unmount();

    const second = renderHook(() => useThreadDrawerTerminal({ ...options, sessions: [{ id: 'pty-recovered', cwd: '/work', thread: {} }] }));
    await waitFor(() => expect(second.result.current.error).toMatch(/created.*link/i));
    expect(createSession).toHaveBeenCalledTimes(1);
    expect(updateThreadMetadata).toHaveBeenCalledTimes(1);
    await act(async () => { await second.result.current.retry(); });
    expect(updateThreadMetadata).toHaveBeenLastCalledWith('pty-recovered', { companionOf: 'ss-thread' });
    expect(createSession).toHaveBeenCalledTimes(1);
    expect(second.result.current.terminalId).toBe('pty-recovered');
  });

  it('holds an unconfirmed creation across unmount until the user explicitly starts again', async () => {
    const createSession = vi.fn().mockImplementationOnce(() => new Promise(() => {})).mockResolvedValueOnce({ id: 'pty-new', cwd: '/work' });
    const updateThreadMetadata = vi.fn().mockResolvedValue({ companionOf: 'ss-unknown' });
    const options = { threadId: 'ss-unknown', cwd: '/work', open: true, sessions: [], createSession, updateThreadMetadata };
    const first = renderHook(() => useThreadDrawerTerminal(options));
    await waitFor(() => expect(createSession).toHaveBeenCalledTimes(1));
    first.unmount();
    const second = renderHook(() => useThreadDrawerTerminal(options));
    await waitFor(() => expect(second.result.current.error).toMatch(/may already exist/i));
    expect(second.result.current.canRetry).toBe(false);
    expect(createSession).toHaveBeenCalledTimes(1);
    await act(async () => { await second.result.current.startAgainAfterReview(); });
    await waitFor(() => expect(second.result.current.terminalId).toBe('pty-new'));
    expect(createSession).toHaveBeenCalledTimes(2);
  });

  it('does not create a terminal when a durable intent cannot be saved', async () => {
    const original = Storage.prototype.setItem;
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (key, value) {
      if (this === sessionStorage && key.includes('threadTerminalRecovery:')) throw new Error('storage unavailable');
      return original.call(this, key, value);
    });
    const createSession = vi.fn();
    const result = renderHook(() => useThreadDrawerTerminal({ threadId: 'ss-storage', cwd: '/work', open: true, sessions: [], createSession, updateThreadMetadata: vi.fn() }));
    await waitFor(() => expect(result.result.current.error).toMatch(/could not be saved/i));
    expect(createSession).not.toHaveBeenCalled();
  });

  it('retains the created terminal when a link response does not confirm the thread', async () => {
    const createSession = vi.fn().mockResolvedValue({ id: 'pty-unconfirmed', cwd: '/work' });
    const updateThreadMetadata = vi.fn().mockResolvedValue({});
    const result = renderHook(() => useThreadDrawerTerminal({ threadId: 'ss-thread', cwd: '/work', open: true, sessions: [], createSession, updateThreadMetadata }));
    await waitFor(() => expect(result.result.current.error).toMatch(/link could not be confirmed/i));
    expect(result.result.current.terminalId).toBeNull();
    expect(createSession).toHaveBeenCalledTimes(1);
  });

  it('does not relink a recovered terminal now owned by another thread', async () => {
    const createSession = vi.fn().mockResolvedValue({ id: 'pty-existing', cwd: '/work' });
    const updateThreadMetadata = vi.fn().mockRejectedValue(new Error('Connection lost'));
    const options = { threadId: 'ss-thread', cwd: '/work', open: true, sessions: [], createSession, updateThreadMetadata };
    const first = renderHook(() => useThreadDrawerTerminal(options));
    await waitFor(() => expect(first.result.current.error).toBe('Connection lost'));
    first.unmount();
    const second = renderHook(() => useThreadDrawerTerminal({ ...options, sessions: [{ id: 'pty-existing', cwd: '/work', thread: { companionOf: 'ss-other' } }] }));
    expect(second.result.current.canRetry).toBe(false);
    expect(second.result.current.error).toMatch(/could not be verified/i);
    await act(async () => { await second.result.current.retry(); });
    expect(updateThreadMetadata).toHaveBeenCalledTimes(1);
    expect(createSession).toHaveBeenCalledTimes(1);
  });

  it('reconciles an already linked terminal after a lost link response without another write', async () => {
    const createSession = vi.fn().mockResolvedValue({ id: 'pty-linked', cwd: '/work' });
    const updateThreadMetadata = vi.fn().mockRejectedValue(new Error('Connection lost'));
    const options = { threadId: 'ss-thread', cwd: '/work', open: true, sessions: [], createSession, updateThreadMetadata };
    const first = renderHook(() => useThreadDrawerTerminal(options));
    await waitFor(() => expect(first.result.current.error).toBe('Connection lost'));
    first.unmount();
    const second = renderHook(() => useThreadDrawerTerminal({ ...options, sessions: [{ id: 'pty-linked', cwd: '/work', thread: { companionOf: 'ss-thread' } }] }));
    await waitFor(() => expect(second.result.current.terminalId).toBe('pty-linked'));
    expect(createSession).toHaveBeenCalledTimes(1);
    expect(updateThreadMetadata).toHaveBeenCalledTimes(1);
  });

  it('does not overwrite a newer intent when the earlier create resolves late', async () => {
    let finishFirst;
    const createSession = vi.fn().mockImplementationOnce(() => new Promise(resolve => { finishFirst = resolve; }))
      .mockResolvedValueOnce({ id: 'pty-new', cwd: '/work' });
    const updateThreadMetadata = vi.fn().mockResolvedValue({ companionOf: 'ss-thread' });
    const options = { threadId: 'ss-thread', cwd: '/work', open: true, sessions: [], createSession, updateThreadMetadata };
    const first = renderHook(() => useThreadDrawerTerminal(options));
    await waitFor(() => expect(createSession).toHaveBeenCalledTimes(1));
    first.unmount();
    const second = renderHook(() => useThreadDrawerTerminal(options));
    await act(async () => { await second.result.current.startAgainAfterReview(); });
    await act(async () => { finishFirst({ id: 'pty-old', cwd: '/work' }); });
    expect(updateThreadMetadata).toHaveBeenCalledTimes(1);
    expect(updateThreadMetadata).toHaveBeenCalledWith('pty-new', { companionOf: 'ss-thread' });
    expect(second.result.current.terminalId).toBe('pty-new');
  });

  it('skips the link write and clears recovery when the server linked the terminal as it created it', async () => {
    const createSession = vi.fn(async options => ({ id: 'pty-atomic', cwd: '/work', requestId: options.requestId, companionOf: options.companionOf }));
    const updateThreadMetadata = vi.fn();
    const result = renderHook(() => useThreadDrawerTerminal({ threadId: 'ss-atomic', cwd: '/work', open: true, sessions: [], createSession, updateThreadMetadata }));
    await waitFor(() => expect(result.result.current.terminalId).toBe('pty-atomic'));
    const leftovers = Object.keys(sessionStorage).filter(key => key.startsWith('threadTerminalRecovery:'));
    expect([updateThreadMetadata.mock.calls, leftovers]).toEqual([[], []]);
  });

  it('still writes the link when the create response does not echo this request', async () => {
    const createSession = vi.fn(async () => ({ id: 'pty-plain', cwd: '/work', requestId: 'a-different-request', companionOf: 'ss-plain' }));
    const updateThreadMetadata = vi.fn().mockResolvedValue({ companionOf: 'ss-plain' });
    const result = renderHook(() => useThreadDrawerTerminal({ threadId: 'ss-plain', cwd: '/work', open: true, sessions: [], createSession, updateThreadMetadata }));
    await waitFor(() => expect(result.result.current.terminalId).toBe('pty-plain'));
    expect(updateThreadMetadata.mock.calls).toEqual([['pty-plain', { companionOf: 'ss-plain' }]]);
  });

  it('gives two tabs opening the same empty thread one request id so the server creates one terminal', async () => {
    const serverTerminals = new Map();
    const createSession = vi.fn(async options => {
      if (!serverTerminals.has(options.requestId)) serverTerminals.set(options.requestId, { id: `pty-${serverTerminals.size + 1}`, cwd: '/work', requestId: options.requestId, companionOf: options.companionOf });
      return serverTerminals.get(options.requestId);
    });
    const updateThreadMetadata = vi.fn();
    const options = { threadId: 'ss-shared', cwd: '/work', open: true, sessions: [], createSession, updateThreadMetadata };
    const firstTab = renderHook(() => useThreadDrawerTerminal(options));
    await waitFor(() => expect(firstTab.result.current.terminalId).toBe('pty-1'));
    sessionStorage.clear();
    const secondTab = renderHook(() => useThreadDrawerTerminal(options));
    await waitFor(() => expect(secondTab.result.current.terminalId).toBe('pty-1'));
    expect([createSession.mock.calls[0][0].requestId === createSession.mock.calls[1][0].requestId, serverTerminals.size]).toEqual([true, 1]);
  });

  it('uses distinct request ids for different threads, and a new one for an added terminal', async () => {
    const createSession = vi.fn(async options => ({ id: `pty-${createSession.mock.calls.length}`, cwd: '/work', requestId: options.requestId, companionOf: options.companionOf }));
    const first = renderHook(() => useThreadDrawerTerminal({ threadId: 'ss-a', cwd: '/work', open: true, sessions: [], createSession }));
    await waitFor(() => expect(first.result.current.terminalId).toBe('pty-1'));
    const second = renderHook(() => useThreadDrawerTerminal({ threadId: 'ss-b', cwd: '/work', open: true, sessions: [], createSession }));
    await waitFor(() => expect(second.result.current.terminalId).toBe('pty-2'));
    const withTerminal = renderHook(() => useThreadDrawerTerminal({ threadId: 'ss-a', cwd: '/work', open: true, sessions: [{ id: 'pty-1', cwd: '/work', thread: { companionOf: 'ss-a' } }], createSession }));
    await act(async () => { await withTerminal.result.current.addTerminal(); });
    const ids = createSession.mock.calls.map(([call]) => call.requestId);
    expect(new Set(ids).size).toBe(3);
  });

  it('does not adopt a terminal that another tab created but has not linked', async () => {
    const createSession = vi.fn().mockResolvedValue({ id: 'pty-mine', cwd: '/work' });
    const updateThreadMetadata = vi.fn().mockResolvedValue({ companionOf: 'ss-thread' });
    const otherTabsTerminal = { id: 'pty-theirs', cwd: '/work', thread: {} };
    const result = renderHook(() => useThreadDrawerTerminal({ threadId: 'ss-thread', cwd: '/work', open: true, sessions: [otherTabsTerminal], createSession, updateThreadMetadata }));
    await waitFor(() => expect(result.result.current.terminalId).toBe('pty-mine'));
    expect(updateThreadMetadata.mock.calls).toEqual([['pty-mine', { companionOf: 'ss-thread' }]]);
  });

  it('offers the link retry once the created terminal appears in a later session list', async () => {
    const createSession = vi.fn().mockResolvedValue({ id: 'pty-late', cwd: '/work' });
    const updateThreadMetadata = vi.fn().mockRejectedValueOnce(new Error('Link unavailable')).mockResolvedValueOnce({ companionOf: 'ss-thread' });
    const options = { threadId: 'ss-thread', cwd: '/work', open: true, createSession, updateThreadMetadata };
    const first = renderHook(() => useThreadDrawerTerminal({ ...options, sessions: [] }));
    await waitFor(() => expect(first.result.current.error).toBe('Link unavailable'));
    first.unmount();
    const reloaded = renderHook(({ sessions }) => useThreadDrawerTerminal({ ...options, sessions }), { initialProps: { sessions: [] } });
    const beforeList = reloaded.result.current.canRetry;
    reloaded.rerender({ sessions: [{ id: 'pty-late', cwd: '/work', thread: {} }] });
    await waitFor(() => expect(reloaded.result.current.canRetry).toBe(true));
    await act(async () => { await reloaded.result.current.retry(); });
    expect([beforeList, reloaded.result.current.terminalId, createSession.mock.calls.length]).toEqual([false, 'pty-late', 1]);
  });

  it('does not let a late response from an earlier attempt rewrite a newer attempt that shares its operation id', async () => {
    let finishFirst;
    const createSession = vi.fn().mockImplementationOnce(() => new Promise(resolve => { finishFirst = resolve; }))
      .mockResolvedValueOnce({ id: 'pty-new', cwd: '/work' });
    const updateThreadMetadata = vi.fn().mockResolvedValue({ companionOf: 'ss-thread' });
    const options = { threadId: 'ss-thread', cwd: '/work', open: true, sessions: [], createSession, updateThreadMetadata };
    const first = renderHook(() => useThreadDrawerTerminal(options));
    await waitFor(() => expect(createSession).toHaveBeenCalledTimes(1));
    first.unmount();
    const second = renderHook(() => useThreadDrawerTerminal(options));
    await act(async () => { await second.result.current.startAgainAfterReview(); });
    await act(async () => { finishFirst({ id: 'pty-old', cwd: '/work' }); });
    expect(createSession.mock.calls[0][0].requestId).not.toBe(createSession.mock.calls[1][0].requestId);
    expect(updateThreadMetadata.mock.calls).toEqual([['pty-new', { companionOf: 'ss-thread' }]]);
  });
});
