import { renderHook, act } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useMobileChatTurns } from './useMobileChatTurns';

const apiFetchMock = vi.fn();

vi.mock('../utils/api', () => ({
  apiFetch: (...args) => apiFetchMock(...args),
}));

describe('useMobileChatTurns', () => {
  beforeEach(() => {
    localStorage.clear();
    apiFetchMock.mockReset();
    apiFetchMock.mockResolvedValue({
      json: async () => ({ turns: [] }),
    });
  });

  it('does not submit queued chat input after an intervening queued interrupt', async () => {
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
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 50)); });
    expect(sender.mock.calls.map(([input]) => [input])).toEqual([['claude'], ['\x03']]);
  });

  it('re-queues input when sender rejects it and flushes on next sender', async () => {
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

    expect(sendResult).toEqual({ queued: true, completion: expect.any(Promise) });
    expect(rejectingSender.mock.calls.map(([input]) => [input])).toEqual([
      ['claude'],
    ]);

    act(() => {
      result.current.handleRegisterSendText(readySender);
    });

    await act(async () => { await new Promise(resolve => setTimeout(resolve, 50)); });
    expect(readySender.mock.calls.map(([input]) => [input])).toEqual([
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

    expect(sendResult).toEqual({ queued: true, completion: expect.any(Promise) });
    expect(sender.mock.calls.map(([input]) => [input])).toEqual([
      ['hey'],
    ]);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });

    expect(sender.mock.calls.map(([input]) => [input])).toEqual([['hey'], ['hey']]);
    await act(async () => { await vi.advanceTimersByTimeAsync(40); });
    expect(sender.mock.calls.map(([input]) => [input])).toEqual([['hey'], ['hey'], ['\r']]);
    vi.useRealTimers();
  });

  it('sends terminal-first prompts as separate text and submit writes', async () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useMobileChatTurns({ sessionId: 'session-1', chatMode: true }));
    const sender = vi.fn(() => true);

    act(() => {
      result.current.handleRegisterSendText(sender);
      result.current.handleChatSend('hello');
    });

    expect(sender.mock.calls.map(([input]) => [input])).toEqual([['hello']]);

    await act(async () => { await vi.advanceTimersByTimeAsync(40); });

    expect(sender.mock.calls.map(([input]) => [input])).toEqual([
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

  it('translates slash agent aliases before sending them to the shell', async () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useMobileChatTurns({ sessionId: 'session-1', chatMode: true }));
    const sender = vi.fn(() => true);

    act(() => {
      result.current.handleRegisterSendText(sender);
      result.current.handleChatSend('/codex');
    });

    expect(sender.mock.calls.map(([input]) => [input])).toEqual([['codex --yolo']]);
    expect(result.current.turns).toEqual([
      expect.objectContaining({ role: 'user', content: 'codex --yolo' })
    ]);

    await act(async () => { await vi.advanceTimersByTimeAsync(40); });

    expect(sender.mock.calls.map(([input]) => [input])).toEqual([
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

    expect(sender).toHaveBeenCalledWith('gemini --yolo', expect.objectContaining({ phase: 'text' }));
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
  it('waits for transport acceptance before Enter and exposes HTTP failure', async () => {
    const { result } = renderHook(() => useMobileChatTurns({ sessionId: 'session-1', chatMode: false }));
    let rejectText;
    const sender = vi.fn(() => new Promise((_resolve, reject) => { rejectText = reject; }));
    act(() => result.current.handleRegisterSendText(sender));
    let receipt;
    act(() => { receipt = result.current.handleChatSend('echo synthetic'); });
    expect(sender.mock.calls.map(([input]) => [input])).toEqual([['echo synthetic']]);
    await act(async () => { rejectText(Object.assign(new Error('HTTP 403 synthetic'), { definitelyRejected: true })); });
    await expect(receipt.completion).rejects.toThrow('HTTP 403');
    expect(sender.mock.calls.map(([input]) => [input])).toEqual([['echo synthetic']]);
  });

  it('does not submit an accepted command after the session changes', async () => {
    const { result, rerender } = renderHook(({ sessionId }) => useMobileChatTurns({ sessionId, chatMode: false }), { initialProps: { sessionId: 'session-1' } });
    let resolveText;
    const oldSender = vi.fn(() => new Promise(resolve => { resolveText = resolve; }));
    act(() => result.current.handleRegisterSendText(oldSender));
    let receipt;
    act(() => { receipt = result.current.handleChatSend('echo old'); });
    rerender({ sessionId: 'session-2' });
    const newSender = vi.fn(() => true);
    act(() => result.current.handleRegisterSendText(newSender));
    await act(async () => { resolveText(true); await new Promise(resolve => setTimeout(resolve, 50)); });
    await expect(receipt.completion).rejects.toThrow('session changed');
    expect(oldSender.mock.calls.map(([input]) => [input])).toEqual([['echo old']]);
    expect(newSender.mock.calls.map(([input]) => [input])).toEqual([]);
  });

  it('flushes a new session queue while the previous session transport is still pending', async () => {
    const { result, rerender } = renderHook(({ sessionId }) => useMobileChatTurns({ sessionId, chatMode: false }), { initialProps: { sessionId: 'session-old' } });
    let resolveOld;
    let oldReceipt;
    act(() => { oldReceipt = result.current.handleChatSend('old queued text'); });
    act(() => result.current.handleRegisterSendText(() => new Promise(resolve => { resolveOld = resolve; })));
    rerender({ sessionId: 'session-new' });
    let newReceipt;
    act(() => { newReceipt = result.current.handleChatSend('new queued text'); });
    const newSender = vi.fn(() => true);
    act(() => result.current.handleRegisterSendText(newSender));
    await act(async () => { await newReceipt.completion; });
    expect(newSender.mock.calls.map(([input]) => [input])).toEqual([['new queued text'], ['\r']]);
    await act(async () => { resolveOld(true); await new Promise(resolve => setTimeout(resolve, 50)); });
    await expect(oldReceipt.completion).rejects.toThrow('session changed');
    expect(newSender.mock.calls.map(([input]) => [input])).toEqual([['new queued text'], ['\r']]);
  });

});
