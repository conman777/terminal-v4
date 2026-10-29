import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useMobileChatTurns } from './useMobileChatTurns';
import { prepareTerminalInput } from '../utils/terminalCommandDelivery';

vi.mock('../utils/api', () => ({ apiFetch: vi.fn(async () => ({ json: async () => ({ turns: [] }) })) }));

describe('composer delivery and intervening terminal input', () => {
  beforeEach(() => localStorage.clear());

  it.each(['handleRawSend', 'handleInterrupt'])('blocks Enter-only retry after %s even if that write fails', async action => {
    const { result } = renderHook(() => useMobileChatTurns({ sessionId: 'synthetic-gap', chatMode: false }));
    const sender = vi.fn().mockResolvedValueOnce(true)
      .mockRejectedValueOnce(Object.assign(new Error('Enter rejected'), { definitelyRejected: true }))
      .mockRejectedValueOnce(new TypeError('Intervening input outcome unknown'));
    act(() => result.current.handleRegisterSendText(sender));
    let receipt;
    act(() => { receipt = result.current.handleChatSend('echo original'); });
    await act(async () => { await expect(receipt.completion).rejects.toThrow('Enter was rejected'); });
    let raw;
    act(() => { raw = result.current[action]('_edit'); });
    await act(async () => { await expect(raw.completion).rejects.toThrow('outcome unknown'); });
    expect(() => result.current.handleChatSend('echo original')).toThrow('replay is blocked');
    expect(sender.mock.calls.map(([input]) => input)).toEqual(['echo original', '\r', action === 'handleInterrupt' ? '\x03' : '_edit']);
  });

  it('does not submit after a direct terminal write invalidates an in-flight text receipt', async () => {
    const { result } = renderHook(() => useMobileChatTurns({ sessionId: 'synthetic-gap', chatMode: false }));
    let accept;
    const sender = vi.fn(() => new Promise(resolve => { accept = resolve; }));
    act(() => result.current.handleRegisterSendText(sender));
    let receipt;
    act(() => { receipt = result.current.handleChatSend('echo original'); });
    prepareTerminalInput('synthetic-gap');
    await act(async () => { accept(true); await expect(receipt.completion).rejects.toThrow(); });
    expect(() => result.current.handleChatSend('echo original')).toThrow('replay is blocked');
    expect(sender.mock.calls.map(([input]) => input)).toEqual(['echo original']);
  });

  it('forwards the same lease for text and Enter and leaves ordinary keys unleased', async () => {
    const { result } = renderHook(() => useMobileChatTurns({ sessionId: 'synthetic-gap', chatMode: false }));
    const sender = vi.fn(() => true);
    act(() => result.current.handleRegisterSendText(sender));
    let receipt;
    act(() => { receipt = result.current.handleChatSend('echo original'); });
    await act(async () => { await receipt.completion; });
    act(() => { result.current.handleRawSend('\x1b[B'); });
    const lease = sender.mock.calls[0][1];
    expect(sender.mock.calls).toEqual([['echo original', lease], ['\r', lease], ['\x1b[B']]);
    expect(lease).toEqual(expect.objectContaining({ phase: 'text', beforeSend: expect.any(Function) }));
  });
});
