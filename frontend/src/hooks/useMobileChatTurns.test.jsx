import { renderHook, act } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useMobileChatTurns } from './useMobileChatTurns';

const apiFetchMock = vi.fn();

vi.mock('../utils/api', () => ({
  apiFetch: (...args) => apiFetchMock(...args),
}));

describe('useMobileChatTurns', () => {
  beforeEach(() => {
    apiFetchMock.mockReset();
    apiFetchMock.mockResolvedValue({
      json: async () => ({ turns: [] }),
    });
  });

  it('queues chat input until terminal sender is registered', () => {
    const { result } = renderHook(() => useMobileChatTurns({ sessionId: 'session-1', chatMode: true }));
    const sender = vi.fn();

    act(() => {
      result.current.handleChatSend('claude');
      result.current.handleInterrupt();
    });

    expect(sender).not.toHaveBeenCalled();
    expect(result.current.isSendReady).toBe(false);

    act(() => {
      result.current.handleRegisterSendText(sender);
    });

    expect(result.current.isSendReady).toBe(true);
    expect(sender.mock.calls).toEqual([
      ['claude\r'],
      ['\x03'],
    ]);
  });

  it('re-queues input when sender rejects it and flushes on next sender', () => {
    const { result } = renderHook(() => useMobileChatTurns({ sessionId: 'session-1', chatMode: true }));
    const rejectingSender = vi.fn(() => false);
    const readySender = vi.fn(() => true);

    act(() => {
      result.current.handleRegisterSendText(rejectingSender);
    });

    let sendResult;
    act(() => {
      sendResult = result.current.handleChatSend('claude');
    });

    expect(sendResult).toEqual({ queued: true });
    expect(rejectingSender).toHaveBeenCalledWith('claude\r');

    act(() => {
      result.current.handleRegisterSendText(readySender);
    });

    expect(readySender).toHaveBeenCalledWith('claude\r');
  });

  it('retries queued input without requiring sender re-registration', async () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useMobileChatTurns({ sessionId: 'session-1', chatMode: true }));
    const sender = vi.fn()
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(true);

    act(() => {
      result.current.handleRegisterSendText(sender);
    });

    let sendResult;
    act(() => {
      sendResult = result.current.handleChatSend('hey');
    });

    expect(sendResult).toEqual({ queued: true });
    expect(sender).toHaveBeenCalledWith('hey\r');

    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });

    expect(sender).toHaveBeenCalledTimes(2);
    expect(sender.mock.calls[1]).toEqual(['hey\r']);
    vi.useRealTimers();
  });
});
