import { describe, expect, it, vi } from 'vitest';
import { installAbortCompatibility } from './abortCompatibility';

function legacyEnvironment() {
  class LegacySignal extends EventTarget {
    aborted = false;
  }
  class LegacyController {
    signal = new LegacySignal();
    abort() {
      if (this.signal.aborted) return;
      this.signal.aborted = true;
      this.signal.dispatchEvent(new Event('abort'));
    }
  }
  return { AbortController: LegacyController, AbortSignal: LegacySignal, DOMException, WeakRef, setTimeout, clearTimeout };
}

describe('abort compatibility', () => {
  it('preserves native methods rather than replacing them', () => {
    const target = { AbortController, AbortSignal, DOMException, WeakRef, setTimeout, clearTimeout };
    const originals = [AbortSignal.any, AbortSignal.timeout, AbortSignal.prototype.throwIfAborted, AbortController.prototype.abort];
    installAbortCompatibility(target);
    expect([AbortSignal.any, AbortSignal.timeout, AbortSignal.prototype.throwIfAborted, AbortController.prototype.abort]).toEqual(originals);
  });

  it('propagates the first reason and removes listeners from every source', () => {
    const target = legacyEnvironment(); installAbortCompatibility(target);
    const one = new target.AbortController(), two = new target.AbortController();
    const removeOne = vi.spyOn(one.signal, 'removeEventListener');
    const removeTwo = vi.spyOn(two.signal, 'removeEventListener');
    const combined = target.AbortSignal.any([one.signal, two.signal]);
    const reason = new Error('cancelled');
    two.abort(reason); one.abort(new Error('later'));
    expect([combined.aborted, combined.reason, removeOne.mock.calls.length, removeTwo.mock.calls.length]).toEqual([true, reason, 1, 1]);
    expect(() => combined.throwIfAborted()).toThrow(reason);
  });

  it('returns the first already-aborted signal reason without attaching listeners', () => {
    const target = legacyEnvironment(); installAbortCompatibility(target);
    const one = new target.AbortController(), two = new target.AbortController();
    one.abort('first'); two.abort('second');
    const add = vi.spyOn(two.signal, 'addEventListener');
    const signal = target.AbortSignal.any([one.signal, two.signal]);
    expect([signal.aborted, signal.reason, add.mock.calls.length]).toEqual([true, 'first', 0]);
  });

  it('keeps an empty composition un-aborted and rejects invalid later members', () => {
    const target = legacyEnvironment(); installAbortCompatibility(target);
    const signal = target.AbortSignal.any([]);
    expect([signal.aborted, signal.reason]).toEqual([false, undefined]);
    const controller = new target.AbortController(); controller.abort('first');
    expect(() => target.AbortSignal.any([controller.signal, null])).toThrow(TypeError);
  });

  it('also detaches every source after abort when WeakRef is unavailable', () => {
    const target = legacyEnvironment(); target.WeakRef = undefined; installAbortCompatibility(target);
    const one = new target.AbortController(), two = new target.AbortController();
    const removeOne = vi.spyOn(one.signal, 'removeEventListener');
    const removeTwo = vi.spyOn(two.signal, 'removeEventListener');
    const signal = target.AbortSignal.any([one.signal, two.signal]);
    one.abort('stop');
    expect([signal.reason, removeOne.mock.calls.length, removeTwo.mock.calls.length]).toEqual(['stop', 1, 1]);
  });

  it('supplies a timeout reason, handles zero asynchronously, and validates arguments', () => {
    vi.useFakeTimers();
    try {
      const target = legacyEnvironment(); installAbortCompatibility(target);
      const signal = target.AbortSignal.timeout(0);
      expect(signal.aborted).toBe(false);
      vi.runAllTimers();
      expect([signal.aborted, signal.reason.name, vi.getTimerCount()]).toEqual([true, 'TimeoutError', 0]);
      expect(() => target.AbortSignal.timeout(-1)).toThrow();
      expect(() => target.AbortSignal.timeout(Infinity)).toThrow();
      expect(() => target.AbortSignal.timeout(Number.MAX_SAFE_INTEGER + 1)).toThrow();
    } finally { vi.useRealTimers(); }
  });

  it('does not fire a large timeout early when timers have a 32-bit delay limit', () => {
    vi.useFakeTimers();
    try {
      const target = legacyEnvironment(); installAbortCompatibility(target);
      const signal = target.AbortSignal.timeout(2147483648);
      vi.advanceTimersByTime(2147483647);
      expect(signal.aborted).toBe(false);
      vi.advanceTimersByTime(1);
      expect([signal.aborted, signal.reason.name]).toEqual([true, 'TimeoutError']);
    } finally { vi.useRealTimers(); }
  });

  it('keeps a stable default reason, leaves an un-aborted signal alone, and rejects invalid inputs', () => {
    const target = legacyEnvironment(); installAbortCompatibility(target);
    const controller = new target.AbortController();
    expect(() => controller.signal.throwIfAborted()).not.toThrow();
    controller.abort();
    expect([controller.signal.reason.name, controller.signal.reason === controller.signal.reason]).toEqual(['AbortError', true]);
    expect(() => target.AbortSignal.any([null])).toThrow(TypeError);
  });
});
