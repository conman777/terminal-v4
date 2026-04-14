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

  it('treats blurred documents as inactive even when visible', () => {
    mockWindowState({ hidden: false, hasFocus: false });
    expect(isWindowActive()).toBe(false);
  });

  it('treats focused text entry as active even when document.hasFocus() is false', () => {
    mockWindowState({ hidden: false, hasFocus: false });
    const input = document.createElement('textarea');
    document.body.appendChild(input);
    input.focus();

    expect(isWindowActive()).toBe(true);

    input.remove();
  });

  it('notifies subscribers for blur and focus transitions', () => {
    mockWindowState({ hidden: false, hasFocus: true });
    const listener = vi.fn();
    const unsubscribe = subscribeWindowActivity(listener);

    document.hasFocus = vi.fn(() => false);
    window.dispatchEvent(new Event('blur'));
    expect(listener).toHaveBeenLastCalledWith(false);

    document.hasFocus = vi.fn(() => true);
    window.dispatchEvent(new Event('focus'));
    expect(listener).toHaveBeenLastCalledWith(true);

    unsubscribe();
  });

  it('keeps subscribers active when blur happens during focused text entry', () => {
    mockWindowState({ hidden: false, hasFocus: true });
    const input = document.createElement('textarea');
    document.body.appendChild(input);
    input.focus();

    const listener = vi.fn();
    const unsubscribe = subscribeWindowActivity(listener);

    document.hasFocus = vi.fn(() => false);
    window.dispatchEvent(new Event('blur'));
    expect(listener).toHaveBeenLastCalledWith(true);

    unsubscribe();
    input.remove();
  });
});
