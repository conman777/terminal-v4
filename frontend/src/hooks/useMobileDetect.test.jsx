import { afterEach, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useMobileDetect } from './useMobileDetect';

const originalTouchPoints = Object.getOwnPropertyDescriptor(navigator, 'maxTouchPoints');
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); if (originalTouchPoints) Object.defineProperty(navigator, 'maxTouchPoints', originalTouchPoints); else delete navigator.maxTouchPoints; });
it.each([[1024, true, false], [800, false, false], [768, true, true], [390, true, true]])('selects navigation layout at %spx with touch=%s', (width, touch, expected) => {
  vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(width);
  vi.stubGlobal('visualViewport', { ...window.visualViewport, width });
  vi.spyOn(document.documentElement, 'clientWidth', 'get').mockReturnValue(width);
  Object.defineProperty(navigator, 'maxTouchPoints', { configurable: true, value: touch ? 1 : 0 });
  const { result } = renderHook(() => useMobileDetect());
  expect(result.current).toBe(expected);
});
