import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { shouldLockMobileHeaderForElement, useMobileHeaderInputLock } from './useMobileHeaderInputLock';

describe('shouldLockMobileHeaderForElement', () => {
  it('locks for the visible composer textarea', () => {
    const composer = document.createElement('textarea');
    composer.setAttribute('aria-label', 'Command composer');

    expect(shouldLockMobileHeaderForElement(composer)).toBe(true);
  });

  it('ignores the hidden terminal input textarea', () => {
    const terminalInput = document.createElement('textarea');
    terminalInput.setAttribute('aria-label', 'Terminal input');

    expect(shouldLockMobileHeaderForElement(terminalInput)).toBe(false);
  });
});

describe('useMobileHeaderInputLock', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    document.body.innerHTML = '';
    vi.useRealTimers();
  });

  it('tracks focus for non-terminal editable elements on mobile', () => {
    const composer = document.createElement('textarea');
    composer.setAttribute('aria-label', 'Command composer');
    document.body.appendChild(composer);

    const terminalInput = document.createElement('textarea');
    terminalInput.setAttribute('aria-label', 'Terminal input');
    document.body.appendChild(terminalInput);

    const { result } = renderHook(() => useMobileHeaderInputLock(true));
    expect(result.current).toBe(false);

    act(() => {
      composer.focus();
      vi.advanceTimersByTime(16);
    });
    expect(result.current).toBe(true);

    act(() => {
      terminalInput.focus();
      vi.advanceTimersByTime(16);
    });
    expect(result.current).toBe(false);
  });

  it('stays unlocked when disabled', () => {
    const composer = document.createElement('textarea');
    composer.setAttribute('aria-label', 'Command composer');
    document.body.appendChild(composer);

    const { result } = renderHook(() => useMobileHeaderInputLock(false));

    act(() => {
      composer.focus();
      vi.advanceTimersByTime(16);
    });

    expect(result.current).toBe(false);
  });
});
