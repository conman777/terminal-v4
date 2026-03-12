import { describe, expect, it, vi } from 'vitest';
import { focusElementWithoutScroll } from './focusElementWithoutScroll';

describe('focusElementWithoutScroll', () => {
  it('prefers preventScroll when the browser supports it', () => {
    const focus = vi.fn();
    const element = { focus };

    expect(focusElementWithoutScroll(element)).toBe(true);
    expect(focus).toHaveBeenCalledWith({ preventScroll: true });
  });

  it('falls back to plain focus when preventScroll is unsupported', () => {
    const focus = vi
      .fn()
      .mockImplementationOnce(() => {
        throw new Error('unsupported');
      })
      .mockImplementationOnce(() => {});
    const element = { focus };

    expect(focusElementWithoutScroll(element)).toBe(true);
    expect(focus.mock.calls).toEqual([[{ preventScroll: true }], []]);
  });

  it('returns false when there is no focusable element', () => {
    expect(focusElementWithoutScroll(null)).toBe(false);
    expect(focusElementWithoutScroll({})).toBe(false);
  });
});
