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
      ['claude'],
      ['\r'],
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
    expect(rejectingSender.mock.calls).toEqual([
      ['claude'],
      ['\r'],
    ]);

    act(() => {
      result.current.handleRegisterSendText(readySender);
    });

    expect(readySender.mock.calls).toEqual([
      ['claude'],
      ['\r'],
    ]);
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
    expect(sender.mock.calls).toEqual([
      ['hey'],
      ['\r'],
    ]);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });

    expect(sender).toHaveBeenCalledTimes(3);
    expect(sender.mock.calls[2]).toEqual(['hey']);
    vi.useRealTimers();
  });

  it('sends terminal-first prompts as separate text and submit writes', () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useMobileChatTurns({ sessionId: 'session-1', chatMode: true }));
    const sender = vi.fn(() => true);

    act(() => {
      result.current.handleRegisterSendText(sender);
      result.current.handleChatSend('hello');
    });

    expect(sender.mock.calls).toEqual([['hello']]);

    act(() => {
      vi.advanceTimersByTime(40);
    });

    expect(sender.mock.calls).toEqual([
      ['hello'],
      ['\r'],
    ]);
    vi.useRealTimers();
  });

  it('sends raw passthrough data for interactive key forwarding', () => {
    const { result } = renderHook(() => useMobileChatTurns({ sessionId: 'session-1', chatMode: true }));
    const sender = vi.fn(() => true);

    act(() => {
      result.current.handleRegisterSendText(sender);
      result.current.handleRawSend('\x1b[B');
    });

    expect(sender).toHaveBeenCalledWith('\x1b[B');
  });

  it('adds an optimistic user turn when chat input is sent', () => {
    const { result } = renderHook(() => useMobileChatTurns({ sessionId: 'session-1', chatMode: true }));
    const sender = vi.fn(() => true);

    act(() => {
      result.current.handleRegisterSendText(sender);
      result.current.handleChatSend('Implement the fix');
    });

    expect(result.current.turns).toEqual([
      expect.objectContaining({ role: 'user', content: 'Implement the fix' })
    ]);
  });

  it('translates slash agent aliases before sending them to the shell', () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useMobileChatTurns({ sessionId: 'session-1', chatMode: true }));
    const sender = vi.fn(() => true);

    act(() => {
      result.current.handleRegisterSendText(sender);
      result.current.handleChatSend('/codex');
    });

    expect(sender.mock.calls).toEqual([['codex --yolo']]);
    expect(result.current.turns).toEqual([
      expect.objectContaining({ role: 'user', content: 'codex --yolo' })
    ]);

    act(() => {
      vi.advanceTimersByTime(40);
    });

    expect(sender.mock.calls).toEqual([
      ['codex --yolo'],
      ['\r'],
    ]);
    vi.useRealTimers();
  });

  it('supports the /gemni alias for gemini launches', () => {
    const { result } = renderHook(() => useMobileChatTurns({ sessionId: 'session-1', chatMode: true }));
    const sender = vi.fn(() => true);

    act(() => {
      result.current.handleRegisterSendText(sender);
      result.current.handleChatSend('/gemni');
    });

    expect(sender).toHaveBeenCalledWith('gemini --yolo');
    expect(result.current.turns).toEqual([
      expect.objectContaining({ role: 'user', content: 'gemini --yolo' })
    ]);
  });

  it('deduplicates optimistic user turns when the same turn arrives from terminal metadata', () => {
    const { result } = renderHook(() => useMobileChatTurns({ sessionId: 'session-1', chatMode: true }));
    const sender = vi.fn(() => true);

    act(() => {
      result.current.handleRegisterSendText(sender);
      result.current.handleChatSend('Implement the fix');
    });

    act(() => {
      result.current.handleTurn({ role: 'user', content: 'Implement the fix', ts: 1234 });
    });

    expect(result.current.turns).toEqual([
      { role: 'user', content: 'Implement the fix', ts: 1234 }
    ]);
  });

  it('deduplicates matching fetched and pending turns during initial seed', async () => {
    apiFetchMock.mockResolvedValueOnce({
      json: async () => ({
        turns: [
          { role: 'assistant', content: 'Ready.', ts: 1000 }
        ]
      }),
    });

    const { result } = renderHook(() => useMobileChatTurns({ sessionId: 'session-1', chatMode: true }));

    act(() => {
      result.current.handleTurn({ role: 'assistant', content: 'Ready.', ts: 1001 });
    });

    await act(async () => {});

    expect(result.current.turns).toEqual([
      { role: 'assistant', content: 'Ready.', ts: 1000 }
    ]);
  });
});
