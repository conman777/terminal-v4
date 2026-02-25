import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useChatTurns } from './useChatTurns';

describe('useChatTurns', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('adds a user turn when handleUserSend is called', () => {
    const { result } = renderHook(() => useChatTurns());

    act(() => {
      result.current.handleUserSend('hello');
    });

    expect(result.current.turns).toEqual([
      expect.objectContaining({ role: 'user', content: 'hello' }),
    ]);
  });

  it('accumulates output chunks into streamingContent', () => {
    const { result } = renderHook(() => useChatTurns());

    act(() => {
      result.current.handleOutputChunk('Hello ');
      result.current.handleOutputChunk('world');
    });

    expect(result.current.streamingContent).toBe('Hello world');
  });

  it('flushes streaming content into an assistant turn after idle timeout', () => {
    const { result } = renderHook(() => useChatTurns());

    act(() => {
      result.current.handleOutputChunk('Claude response');
    });

    act(() => {
      vi.advanceTimersByTime(800);
    });

    expect(result.current.turns).toEqual([
      expect.objectContaining({ role: 'assistant', content: 'Claude response' }),
    ]);
    expect(result.current.streamingContent).toBe('');
  });

  it('flushes assistant turn immediately when user sends a new message', () => {
    const { result } = renderHook(() => useChatTurns());

    act(() => {
      result.current.handleOutputChunk('partial response');
    });

    act(() => {
      result.current.handleUserSend('follow up');
    });

    expect(result.current.turns).toEqual([
      expect.objectContaining({ role: 'assistant', content: 'partial response' }),
      expect.objectContaining({ role: 'user', content: 'follow up' }),
    ]);
  });

  it('strips ANSI codes from output chunks', () => {
    const { result } = renderHook(() => useChatTurns());

    act(() => {
      result.current.handleOutputChunk('\x1b[32mGreen text\x1b[0m');
    });

    act(() => {
      vi.advanceTimersByTime(800);
    });

    expect(result.current.turns[0].content).toBe('Green text');
  });
});
