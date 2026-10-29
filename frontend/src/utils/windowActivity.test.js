import { afterEach, describe, expect, it, vi } from 'vitest';
import { isWindowActive, subscribeWindowActivity } from './windowActivity';

const originalHasFocus = document.hasFocus;
const hiddenDescriptor = Object.getOwnPropertyDescriptor(document, 'hidden');
const visibilityDescriptor = Object.getOwnPropertyDescriptor(document, 'visibilityState');

function mockWindowState({ hasFocus = true, hidden = false, visibilityState = hidden ? 'hidden' : 'visible' } = {}) {
  Object.defineProperty(document, 'hidden', {
    configurable: true,
    get: () => hidden
  });
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => visibilityState
  });
  document.hasFocus = vi.fn(() => hasFocus);
}

describe('windowActivity', () => {
  afterEach(() => {
    if (hiddenDescriptor) {
      Object.defineProperty(document, 'hidden', hiddenDescriptor);
    } else {
      delete document.hidden;
    }
    if (visibilityDescriptor) {
      Object.defineProperty(document, 'visibilityState', visibilityDescriptor);
    } else {
      delete document.visibilityState;
    }
    document.hasFocus = originalHasFocus;
    vi.restoreAllMocks();
  });

  it('treats hidden documents as inactive', () => {
    mockWindowState({ hidden: true, hasFocus: true });
    expect(isWindowActive()).toBe(false);
  });

  it('keeps a visible document active without focus so live terminals stay connected', () => {
    mockWindowState({ hidden: false, hasFocus: false });
    expect(isWindowActive()).toBe(true);
  });

  it('notifies subscribers when visibility changes and stays active across blur', () => {
    mockWindowState({ hidden: false, hasFocus: true });
    const listener = vi.fn();
    const unsubscribe = subscribeWindowActivity(listener);

    document.hasFocus = vi.fn(() => false);
    window.dispatchEvent(new Event('blur'));
    const afterBlur = listener.mock.lastCall[0];

    mockWindowState({ hidden: true, hasFocus: false });
    document.dispatchEvent(new Event('visibilitychange'));
    const afterHide = listener.mock.lastCall[0];

    mockWindowState({ hidden: false, hasFocus: true });
    document.dispatchEvent(new Event('visibilitychange'));
    expect([afterBlur, afterHide, listener.mock.lastCall[0]]).toEqual([true, false, true]);

    unsubscribe();
  });
});
