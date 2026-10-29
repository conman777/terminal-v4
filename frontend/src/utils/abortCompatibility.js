// Install only missing Abort APIs before the application imports its async flows.
// Older WebKit supports AbortController but not signal reasons or composition.
export function installAbortCompatibility(target = globalThis) {
  const Controller = target.AbortController;
  const Signal = target.AbortSignal;
  if (!Controller || !Signal) return;

  const exception = (message, name) => new target.DOMException(message, name);
  if (!('reason' in Signal.prototype)) {
    const reasons = new WeakMap();
    const originalAbort = Controller.prototype.abort;
    Object.defineProperty(Signal.prototype, 'reason', {
      configurable: true,
      get() {
        if (!this.aborted) return undefined;
        if (!reasons.has(this)) reasons.set(this, exception('The operation was aborted.', 'AbortError'));
        return reasons.get(this);
      },
    });
    Controller.prototype.abort = function abort(reason) {
      if (!this.signal.aborted) reasons.set(this.signal, reason === undefined ? exception('The operation was aborted.', 'AbortError') : reason);
      return originalAbort.call(this, reason);
    };
  }

  if (typeof Signal.prototype.throwIfAborted !== 'function') {
    Signal.prototype.throwIfAborted = function throwIfAborted() {
      if (this.aborted) throw this.reason;
    };
  }

  // The returned signal keeps its controller alive. Weak references keep a
  // long-lived source from retaining an abandoned combined signal forever.
  const controllers = new WeakMap();
  const finalizer = typeof target.FinalizationRegistry === 'function'
    ? new target.FinalizationRegistry(cleanup => cleanup()) : null;
  function retain(controller) {
    controllers.set(controller.signal, controller);
    return typeof target.WeakRef === 'function'
      ? new target.WeakRef(controller) : { deref: () => controller };
  }

  if (typeof Signal.any !== 'function') {
    Signal.any = function any(signals) {
      const sources = Array.from(signals);
      for (const source of sources) {
        if (!source || typeof source.aborted !== 'boolean' || typeof source.addEventListener !== 'function'
          || typeof source.removeEventListener !== 'function') throw new TypeError('Expected abort signals');
      }
      const controller = new Controller();
      const first = sources.find(source => source.aborted);
      if (first) { controller.abort(first.reason); return controller.signal; }

      const reference = retain(controller);
      const registrations = [];
      const token = {};
      const cleanup = () => {
        for (const [source, listener] of registrations) source.removeEventListener('abort', listener);
        registrations.length = 0;
        finalizer?.unregister(token);
      };
      for (const source of sources) {
        const listener = () => {
          const active = reference.deref();
          cleanup();
          if (active && !active.signal.aborted) active.abort(source.reason);
        };
        registrations.push([source, listener]);
        source.addEventListener('abort', listener, { once: true });
      }
      if (finalizer && typeof target.WeakRef === 'function') finalizer.register(controller.signal, cleanup, token);
      return controller.signal;
    };
  }

  if (typeof Signal.timeout !== 'function') {
    Signal.timeout = function timeout(milliseconds) {
      if (!Number.isSafeInteger(milliseconds) || milliseconds < 0) throw new RangeError('Invalid timeout');
      const controller = new Controller();
      const reference = retain(controller);
      let remaining = milliseconds;
      const tick = () => {
        const active = reference.deref();
        if (!active || active.signal.aborted) return;
        if (remaining > 0) {
          const delay = Math.min(remaining, 2147483647);
          remaining -= delay;
          target.setTimeout(tick, delay);
        } else active.abort(exception('The operation timed out.', 'TimeoutError'));
      };
      if (remaining === 0) target.setTimeout(tick, 0); else tick();
      return controller.signal;
    };
  }
}

installAbortCompatibility();
