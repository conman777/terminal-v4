import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useMediaQuery } from './useMediaQuery';

const original = window.matchMedia;
afterEach(() => { window.matchMedia = original; });

describe('useMediaQuery', () => {
  it('follows the media query as the window changes', () => {
    let listener;
    const query = { matches: false, addEventListener: (_, fn) => { listener = fn; }, removeEventListener: vi.fn() };
    window.matchMedia = vi.fn(() => query);
    const { result } = renderHook(() => useMediaQuery('(min-width: 1280px)'));
    const before = result.current;
    act(() => { query.matches = true; listener(); });
    expect([before, result.current]).toEqual([false, true]);
  });

  it('assumes a wide screen when the browser cannot answer', () => {
    window.matchMedia = undefined;
    expect(renderHook(() => useMediaQuery('(min-width: 1280px)')).result.current).toBe(true);
  });
});
