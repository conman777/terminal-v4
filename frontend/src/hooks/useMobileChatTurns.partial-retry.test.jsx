import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useMobileChatTurns } from './useMobileChatTurns';

vi.mock('../utils/api', () => ({ apiFetch: vi.fn(async () => ({ json: async () => ({ turns: [] }) })) }));
let testId = 0;

describe('terminal command retry receipts', () => {
  beforeEach(() => { localStorage.clear(); testId += 1; });

  it('retries the full text after a confirmed first-write rejection', async () => {
    const { result } = renderHook(() => useMobileChatTurns({ sessionId: `first-${testId}`, chatMode: false }));
    const sender = vi.fn().mockRejectedValueOnce(Object.assign(new Error('Text rejected'), { definitelyRejected: true })).mockResolvedValue(true);
    act(() => result.current.handleRegisterSendText(sender));
    let first;
    act(() => { first = result.current.handleChatSend('echo first'); });
    await act(async () => { await expect(first.completion).rejects.toThrow('Text rejected'); });
    let retry;
    act(() => { retry = result.current.handleChatSend('echo first'); });
    await act(async () => { await retry.completion; });
    expect(sender.mock.calls.map(([input]) => [input])).toEqual([['echo first'], ['echo first'], ['\r']]);
  });

  it('retries only Enter after acknowledged text and a confirmed Enter rejection', async () => {
    const { result } = renderHook(() => useMobileChatTurns({ sessionId: `partial-${testId}`, chatMode: false }));
    const sender = vi.fn()
      .mockResolvedValueOnce(true)
      .mockRejectedValueOnce(Object.assign(new Error('Enter rejected (403)'), { definitelyRejected: true }))
      .mockResolvedValue(true);
    act(() => result.current.handleRegisterSendText(sender));
    let first;
    act(() => { first = result.current.handleChatSend('echo retry_marker'); });
    await act(async () => { await expect(first.completion).rejects.toThrow(); });
    let retry;
    act(() => { retry = result.current.handleChatSend('echo retry_marker'); });
    await act(async () => { await retry.completion; });
    expect(sender.mock.calls.map(([input]) => [input])).toEqual([['echo retry_marker'], ['\r'], ['\r']]);
  });

  it('keeps Enter-only recovery attached to the original session through a session switch', async () => {
    const sessionId = `switch-${testId}`;
    const view = renderHook(({ id }) => useMobileChatTurns({ sessionId: id, chatMode: false }), { initialProps: { id: sessionId } });
    const original = vi.fn().mockResolvedValueOnce(true).mockRejectedValueOnce(Object.assign(new Error('Enter rejected'), { definitelyRejected: true }));
    act(() => view.result.current.handleRegisterSendText(original));
    let first;
    act(() => { first = view.result.current.handleChatSend('echo original'); });
    await act(async () => { await expect(first.completion).rejects.toThrow('Enter was rejected'); });
    view.rerender({ id: `other-${testId}` });
    const other = vi.fn(() => true);
    act(() => view.result.current.handleRegisterSendText(other));
    let second;
    act(() => { second = view.result.current.handleChatSend('echo other'); });
    await act(async () => { await second.completion; });
    view.rerender({ id: sessionId });
    const retrySender = vi.fn(() => true);
    act(() => view.result.current.handleRegisterSendText(retrySender));
    expect(() => view.result.current.handleChatSend('edited draft')).toThrow('unchanged draft');
    let retry;
    act(() => { retry = view.result.current.handleChatSend('echo original'); });
    await act(async () => { await retry.completion; });
    expect({ original: original.mock.calls.map(([input]) => [input]), other: other.mock.calls.map(([input]) => [input]), retry: retrySender.mock.calls.map(([input]) => [input]) }).toEqual({
      original: [['echo original'], ['\r']], other: [['echo other'], ['\r']], retry: [['\r']],
    });
  });

  it('does not resend text after an unknown text outcome', async () => {
    const { result } = renderHook(() => useMobileChatTurns({ sessionId: `lost-text-${testId}`, chatMode: false }));
    const sender = vi.fn().mockRejectedValue(new TypeError('Response lost'));
    act(() => result.current.handleRegisterSendText(sender));
    let first;
    act(() => { first = result.current.handleChatSend('echo uncertain'); });
    await act(async () => { await expect(first.completion).rejects.toThrow('could not be confirmed'); });
    expect(() => result.current.handleChatSend('echo uncertain')).toThrow('replay is blocked');
    expect(sender.mock.calls.map(([input]) => [input])).toEqual([['echo uncertain']]);
  });

  it('allows an edited command after a confirmed text rejection with no accepted input', async () => {
    const { result } = renderHook(() => useMobileChatTurns({ sessionId: `edit-${testId}`, chatMode: false }));
    const sender = vi.fn().mockRejectedValueOnce(Object.assign(new Error('Text rejected'), { definitelyRejected: true })).mockResolvedValue(true);
    act(() => result.current.handleRegisterSendText(sender));
    let first;
    act(() => { first = result.current.handleChatSend('original text'); });
    await act(async () => { await expect(first.completion).rejects.toThrow('Text rejected'); });
    let edited;
    act(() => { edited = result.current.handleChatSend('edited text'); });
    await act(async () => { await edited.completion; });
    expect(sender.mock.calls.map(([input]) => [input])).toEqual([['original text'], ['edited text'], ['\r']]);
  });

  it('sends no input when its pre-dispatch recovery marker cannot be saved', () => {
    const { result } = renderHook(() => useMobileChatTurns({ sessionId: `storage-${testId}`, chatMode: false }));
    const sender = vi.fn(() => true);
    act(() => result.current.handleRegisterSendText(sender));
    const save = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('Synthetic quota failure'); });
    try {
      expect(() => result.current.handleChatSend('echo keep draft')).toThrow('progress could not be saved');
      expect(sender.mock.calls.map(([input]) => [input])).toEqual([]);
    } finally { save.mockRestore(); }
  });

  it('blocks a retry after an unknown Enter outcome, retaining the recovery requirement across remount', async () => {
    const sessionId = `unknown-${testId}`;
    const view = renderHook(() => useMobileChatTurns({ sessionId, chatMode: false }));
    const sender = vi.fn().mockResolvedValueOnce(true).mockRejectedValueOnce(new TypeError('Response lost'));
    act(() => view.result.current.handleRegisterSendText(sender));
    let first;
    act(() => { first = view.result.current.handleChatSend('echo uncertain'); });
    await act(async () => { await expect(first.completion).rejects.toThrow(/could not be confirmed/i); });
    view.unmount();
    const second = renderHook(() => useMobileChatTurns({ sessionId, chatMode: false }));
    const retrySender = vi.fn(() => true);
    act(() => second.result.current.handleRegisterSendText(retrySender));
    expect(() => second.result.current.handleChatSend('echo uncertain')).toThrow(/inspect the terminal/i);
    expect(retrySender.mock.calls.map(([input]) => [input])).toEqual([]);
  });
});
