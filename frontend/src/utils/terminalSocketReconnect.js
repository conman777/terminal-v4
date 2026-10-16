export function shouldReuseTerminalSocket({ existingReadyState, isConnecting, force = false }) {
  if (force) {
    return false;
  }

  return isConnecting || existingReadyState === WebSocket.CONNECTING || existingReadyState === WebSocket.OPEN;
}

export function reconnectDelay(attempt, random = Math.random) {
  return Math.min(30000, Math.round(1000 * (2 ** Math.min(Math.max(0, attempt), 5)) * (0.8 + random() * 0.4)));
}

export function isPermanentSocketClose(event, remote = false) {
  return event?.code === 1008 || event?.code === 4403
    || (remote && (event?.code === 4401 || event?.code === 4404));
}

export function createTerminalReconnectController(onReconnect, {
  online = () => navigator.onLine !== false,
  eventTarget = window,
  random = Math.random,
} = {}) {
  let timerId = null;
  let nextAttemptId = 0;
  let activeAttemptId = 0;
  let retryCount = 0;
  let pending = null;
  let stopped = false;

  const clearScheduledReconnect = () => {
    if (timerId !== null) clearTimeout(timerId);
    timerId = null;
    pending = null;
  };
  const arm = () => {
    if (!pending || stopped || !online() || timerId !== null) return;
    timerId = setTimeout(() => {
      timerId = null;
      if (!online()) return;
      const options = pending?.options;
      pending = null;
      if (!stopped && options) onReconnect(options);
    }, pending.delay);
  };
  eventTarget?.addEventListener('online', arm);
  return {
    beginAttempt() {
      clearScheduledReconnect();
      activeAttemptId = ++nextAttemptId;
      return activeAttemptId;
    },
    isCurrentAttempt(attemptId) {
      return !stopped && attemptId === activeAttemptId;
    },
    scheduleReconnect(delay, options = {}) {
      if (delay === undefined && pending) return;
      clearScheduledReconnect();
      if (stopped) return;
      pending = { delay: delay === undefined ? reconnectDelay(retryCount++, random) : Math.max(0, delay), options };
      arm();
    },
    markConnected() { retryCount = 0; clearScheduledReconnect(); },
    isStopped() { return stopped; },
    stop() { stopped = true; clearScheduledReconnect(); activeAttemptId = 0; },
    clearScheduledReconnect,
    dispose() {
      this.stop();
      eventTarget?.removeEventListener('online', arm);
    }
  };
}
