export function shouldReuseTerminalSocket({ existingReadyState, isConnecting, force = false }) {
  if (force) {
    return false;
  }

  return isConnecting || existingReadyState === WebSocket.CONNECTING || existingReadyState === WebSocket.OPEN;
}

export function createTerminalReconnectController(onReconnect) {
  let timerId = null;
  let nextAttemptId = 0;
  let activeAttemptId = 0;

  const clearScheduledReconnect = () => {
    if (timerId) {
      clearTimeout(timerId);
      timerId = null;
    }
  };

  return {
    beginAttempt() {
      clearScheduledReconnect();
      activeAttemptId = ++nextAttemptId;
      return activeAttemptId;
    },
    isCurrentAttempt(attemptId) {
      return attemptId === activeAttemptId;
    },
    scheduleReconnect(delay = 0, options = {}) {
      clearScheduledReconnect();
      timerId = setTimeout(() => {
        timerId = null;
        onReconnect(options);
      }, Math.max(0, delay));
    },
    clearScheduledReconnect,
    dispose() {
      clearScheduledReconnect();
      activeAttemptId = 0;
    }
  };
}
