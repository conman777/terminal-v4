import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
vi.mock('../utils/api', () => ({ apiFetch: vi.fn(async () => ({ json: async () => ({ turns: [] }) })) }));
import { useMobileChatTurns } from './useMobileChatTurns';

describe('PTY composer API aliases', () => {
  it('rejects before text, submit, optimistic turn or queue mutation and leaves native alias delivery usable', async () => {
    const hook = renderHook(() => useMobileChatTurns({ sessionId: 'api-alias-rejection', chatMode: true }));
    const sender = vi.fn(() => true);
    act(() => hook.result.current.handleRegisterSendText(sender));
    expect(() => hook.result.current.handleChatSend('/deepseek')).toThrow(/agent picker/i);
    expect(sender.mock.calls).toEqual([]);
    expect(hook.result.current.turns).toEqual([]);
    await act(async () => {
      await hook.result.current.handleChatSend('/codex').completion;
    });
    expect(sender.mock.calls.map(([input]) => input)).toEqual(['codex --yolo', '\r']);
    hook.unmount();
  });
});
