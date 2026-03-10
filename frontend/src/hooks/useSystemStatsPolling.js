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
  if (!windowActive) {
    return;
  }
  try {
    const stats = await apiGet('/api/system/stats');
    latestStats = stats;
    notifySubscribers(stats);
  } catch {
    // Ignore transient failures.
  }
}

function stopPolling() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
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
  if (pollTimer || subscribers.size === 0 || !windowActive) return;
  pollSystemStats();
  pollTimer = setInterval(pollSystemStats, POLL_INTERVAL_MS);
}

function handleVisibilityChange() {
  windowActive = isWindowActive();
  if (!windowActive) {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
    return;
  }
  if (subscribers.size > 0) {
    void pollSystemStats();
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
