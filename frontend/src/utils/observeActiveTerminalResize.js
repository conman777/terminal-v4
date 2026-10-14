/**
 * stable-terminal resize observer for one visible xterm host.
 *
 * Inactive terminals should not call this — their DOM/PTY stay mounted without
 * paying for ResizeObserver work or FitAddon. The first animation frame owns
 * activation and ignores the observer's initial delivery; later resize bursts
 * are coalesced to one fit per frame.
 */
export function observeActiveTerminalResize(host, { fitOnActivate = true, onActivate, onFit } = {}) {
  if (!host || typeof ResizeObserver === 'undefined') {
    const frame = typeof requestAnimationFrame === 'function'
      ? requestAnimationFrame(() => {
          if (fitOnActivate) onFit?.();
          onActivate?.();
        })
      : 0;
    if (!frame && fitOnActivate) onFit?.();
    if (!frame) onActivate?.();
    return () => {
      if (frame && typeof cancelAnimationFrame === 'function') {
        cancelAnimationFrame(frame);
      }
    };
  }

  let activated = false;
  let frame = 0;
  let initialResizeDelivered = false;
  let stopped = false;

  const scheduleFit = () => {
    if (!activated || stopped || frame !== 0) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      if (!stopped) onFit?.();
    });
  };

  const observer = new ResizeObserver(() => {
    // Initial delivery is async and may race the activation rAF. Activation
    // already fits the current box, so absorb that first delivery either way.
    if (!initialResizeDelivered) {
      initialResizeDelivered = true;
      return;
    }
    scheduleFit();
  });

  observer.observe(host);

  frame = requestAnimationFrame(() => {
    frame = 0;
    if (stopped) return;
    activated = true;
    if (fitOnActivate) onFit?.();
    onActivate?.();
  });

  return () => {
    stopped = true;
    observer.disconnect();
    if (frame !== 0) {
      cancelAnimationFrame(frame);
      frame = 0;
    }
  };
}
