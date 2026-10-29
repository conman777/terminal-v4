import { describe, it, expect, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useTerminalScrolling } from './useTerminalScrolling';

describe('useTerminalScrolling', () => {
  it('falls back to line-wise arrow keys when not using tmux and xterm scrollback is exhausted', () => {
    const scrollLines = vi.fn();
    const xtermRef = {
      current: {
        buffer: {
          active: {
            baseY: 0
          }
        },
        scrollLines
      }
    };
    const sendToTerminal = vi.fn();
    const usesTmuxRef = { current: false };

    const { result } = renderHook(() => useTerminalScrolling(xtermRef, sendToTerminal, usesTmuxRef));

    act(() => {
      result.current.scrollByWheel(-48, 0, 24);
    });

    expect(scrollLines).not.toHaveBeenCalled();
    expect(sendToTerminal).toHaveBeenCalledWith('\x1b[A'.repeat(3));
  });
  it.each([false, true])('exposes mobile line scrolling with tmux=%s', (tmux) => {
    const sender = vi.fn();
    const { result } = renderHook(() => useTerminalScrolling({ current: { buffer: { active: { baseY: 0 } } } }, sender, { current: tmux }));
    act(() => result.current.scrollByLines('up', 3));
    expect(sender.mock.calls).toEqual([[`${tmux ? '\x02[' : ''}${'\x1b[A'.repeat(3)}`]]);
    act(() => result.current.cleanup());
  });

});
