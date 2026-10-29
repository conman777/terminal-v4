import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useTerminalScrolling } from './useTerminalScrolling';
import { claimTerminalCommand, prepareTerminalInput } from '../utils/terminalCommandDelivery';

const sessionId = 'synthetic-tmux-lease';
const command = 'echo tmux_marker';
const xtermRef = () => ({ current: { buffer: { active: { baseY: 0 } }, rows: 24 } });

describe('tmux history exit and terminal command delivery', () => {
  beforeEach(() => { localStorage.clear(); vi.useFakeTimers(); });
  afterEach(() => vi.useRealTimers());

  it('keeps the composer lease through its owned history exit and subsequent command', () => {
    const writes = [];
    const sender = vi.fn((text, delivery) => { prepareTerminalInput(sessionId, delivery); writes.push(text); return true; });
    const { result } = renderHook(() => useTerminalScrolling(xtermRef(), sender, { current: true }));
    act(() => result.current.scrollByWheel(-48, 0, 24));
    const lease = claimTerminalCommand(sessionId, command);
    lease.beforeSend();
    act(() => result.current.exitCopyModeIfActive(lease));
    sender(command, lease);
    lease.acceptText(); lease.beforeSend(); sender('\r', lease); lease.complete();
    expect(writes).toEqual(['\x02[' + '\x1b[A'.repeat(3), 'q', command, '\r']);
    expect(sender.mock.calls[1]).toEqual(['q', lease]);
    expect(result.current.inCopyModeRef.current).toBe(false);
  });

  it('continues to invalidate recovery for a separately requested history exit', () => {
    const sender = vi.fn((text, delivery) => { prepareTerminalInput(sessionId, delivery); return true; });
    const { result } = renderHook(() => useTerminalScrolling(xtermRef(), sender, { current: true }));
    act(() => result.current.scrollByWheel(-48, 0, 24));
    const lease = claimTerminalCommand(sessionId, command);
    lease.beforeSend(); lease.acceptText();
    act(() => result.current.exitCopyModeIfActive());
    expect(sender.mock.calls[1]).toEqual(['q']);
    expect(() => claimTerminalCommand(sessionId, command)).toThrow('replay is blocked');
  });

  it.each(['accepted', 'unknown'])('returns an %s history-exit receipt without queuing another q', async outcome => {
    let resolve, reject;
    const sender = vi.fn().mockReturnValueOnce(true).mockImplementationOnce(() => new Promise((yes, no) => { resolve = yes; reject = no; }));
    const { result } = renderHook(() => useTerminalScrolling(xtermRef(), sender, { current: true }));
    act(() => result.current.scrollByWheel(-48, 0, 24));
    const lease = claimTerminalCommand(sessionId, command); lease.beforeSend();
    let receipt;
    act(() => { receipt = result.current.exitCopyModeIfActive(lease); });
    expect(receipt).toBeInstanceOf(Promise);
    expect(result.current.inCopyModeRef.current).toBe(false);
    act(() => result.current.exitCopyModeIfActive());
    expect(sender.mock.calls).toEqual([['\x02[' + '\x1b[A'.repeat(3)], ['q', lease]]);
    await act(async () => {
      if (outcome === 'accepted') { resolve(true); await expect(receipt).resolves.toBe(true); }
      else { reject(new TypeError('Synthetic lost exit receipt')); await expect(receipt).rejects.toThrow('lost exit receipt'); }
    });
    expect(result.current.inCopyModeRef.current).toBe(false);
    if (outcome === 'unknown') expect(() => claimTerminalCommand(sessionId, command)).toThrow('replay is blocked');
    act(() => result.current.resetCopyModeState());
  });

  it('keeps copy mode active when its exit was not accepted', () => {
    const sender = vi.fn().mockReturnValueOnce(true).mockReturnValueOnce(false);
    const { result } = renderHook(() => useTerminalScrolling(xtermRef(), sender, { current: true }));
    act(() => result.current.scrollByWheel(-48, 0, 24));
    let receipt;
    act(() => { receipt = result.current.exitCopyModeIfActive(); });
    expect({ receipt, inCopyMode: result.current.inCopyModeRef.current }).toEqual({ receipt: false, inCopyMode: true });
    act(() => result.current.resetCopyModeState());
  });

  it('does not queue a second q while exit is pending, and separate input still invalidates the lease', async () => {
    let accept;
    const writes = [];
    const sender = vi.fn((text, delivery) => {
      prepareTerminalInput(sessionId, delivery); writes.push(text);
      return text === 'q' ? new Promise(resolve => { accept = resolve; }) : true;
    });
    const { result } = renderHook(() => useTerminalScrolling(xtermRef(), sender, { current: true }));
    act(() => result.current.scrollByWheel(-48, 0, 24));
    const lease = claimTerminalCommand(sessionId, command); lease.beforeSend();
    let ownedExit, separateExit;
    act(() => {
      ownedExit = result.current.exitCopyModeIfActive(lease);
      separateExit = result.current.exitCopyModeIfActive();
      sender('_edit');
    });
    expect(separateExit).toBeUndefined();
    await act(async () => { accept(true); await ownedExit; });
    expect(() => sender(command, lease)).toThrow('replay is blocked');
    expect(writes).toEqual(['\x02[' + '\x1b[A'.repeat(3), 'q', '_edit']);
  });

  it.each(['unchanged', 'reset', 'cleanup'])('restores a definitely rejected exit only in its original copy-mode generation (%s)', async boundary => {
    let reject;
    const sender = vi.fn().mockReturnValueOnce(true).mockImplementationOnce(() => new Promise((_, no) => { reject = no; }));
    const { result } = renderHook(() => useTerminalScrolling(xtermRef(), sender, { current: true }));
    act(() => result.current.scrollByWheel(-48, 0, 24));
    const lease = claimTerminalCommand(sessionId, command); lease.beforeSend();
    let receipt;
    act(() => { receipt = result.current.exitCopyModeIfActive(lease); });
    if (boundary !== 'unchanged') act(() => result.current[boundary === 'reset' ? 'resetCopyModeState' : 'cleanup']());
    await act(async () => {
      reject(Object.assign(new Error('Synthetic exit never sent'), { definitelyRejected: true }));
      await expect(receipt).rejects.toThrow('never sent');
    });
    expect(result.current.inCopyModeRef.current).toBe(boundary === 'unchanged');
    expect(sender.mock.calls).toEqual([['\x02[' + '\x1b[A'.repeat(3)], ['q', lease]]);
    act(() => result.current.resetCopyModeState());
  });
});
