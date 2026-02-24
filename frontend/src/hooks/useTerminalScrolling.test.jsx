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
});
