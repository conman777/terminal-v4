import { useEffect, useState } from 'react';
import { apiGet } from '../utils/api';
import { isWindowActive, subscribeWindowActivity } from '../utils/windowActivity';

const POLL_INTERVAL_MS = 5000;

const subscribers = new Set();
let latestStats = null;
let pollTimer = null;
let visibilityListenerAttached = false;
let windowActive = true;
let unsubscribeWindowActivity = null;
let pendingRequest = null;

function notifySubscribers(value) {
  subscribers.forEach((listener) => {
    try {
      listener(value);
    } catch {
      // Ignore subscriber errors to avoid breaking polling.
    }
  });
}

async function pollSystemStats() {
  if (!windowActive || subscribers.size === 0 || pendingRequest) {
    return;
  }
  const request = new AbortController();
  pendingRequest = request;
  try {
    const { stats } = await apiGet('/api/system/stats', { signal: request.signal });
    if (pendingRequest !== request || request.signal.aborted) return;
    latestStats = stats;
    notifySubscribers(stats);
  } catch {
    // Ignore transient failures.
  } finally {
    if (pendingRequest === request) {
      pendingRequest = null;
      if (windowActive && subscribers.size > 0) {
        pollTimer = setTimeout(() => {
          pollTimer = null;
          void pollSystemStats();
        }, POLL_INTERVAL_MS);
      }
    }
  }
}

function pausePolling() {
  if (pollTimer) {
    clearTimeout(pollTimer);
    pollTimer = null;
  }
  pendingRequest?.abort();
  pendingRequest = null;
}

function stopPolling() {
  pausePolling();
  latestStats = null;
  if (visibilityListenerAttached) {
    unsubscribeWindowActivity?.();
    unsubscribeWindowActivity = null;
    visibilityListenerAttached = false;
  }
}

function ensurePolling() {
  if (!visibilityListenerAttached) {
    windowActive = isWindowActive();
    unsubscribeWindowActivity = subscribeWindowActivity(handleVisibilityChange);
    visibilityListenerAttached = true;
  }
  if (pollTimer || pendingRequest || subscribers.size === 0 || !windowActive) return;
  void pollSystemStats();
}

function handleVisibilityChange() {
  windowActive = isWindowActive();
  if (!windowActive) {
    pausePolling();
    return;
  }
  if (subscribers.size > 0) {
    ensurePolling();
  }
}

export function useSystemStatsPolling(enabled = true) {
  const [stats, setStats] = useState(latestStats);

  useEffect(() => {
    if (!enabled) return undefined;
    windowActive = isWindowActive();
    subscribers.add(setStats);
    if (latestStats !== null) {
      setStats(latestStats);
    }
    ensurePolling();
    return () => {
      subscribers.delete(setStats);
      if (subscribers.size === 0) {
        stopPolling();
      }
    };
  }, [enabled]);

  return stats;
}
