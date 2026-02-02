import { useEffect, useState } from 'react';
import { apiGet } from '../utils/api';

const POLL_INTERVAL_MS = 5000;

const subscribers = new Set();
let latestStats = null;
let pollTimer = null;
let visibilityListenerAttached = false;

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
  if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
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
  if (visibilityListenerAttached && typeof document !== 'undefined') {
    document.removeEventListener('visibilitychange', handleVisibilityChange);
    visibilityListenerAttached = false;
  }
}

function ensurePolling() {
  if (pollTimer || subscribers.size === 0) return;
  pollSystemStats();
  pollTimer = setInterval(pollSystemStats, POLL_INTERVAL_MS);
  if (!visibilityListenerAttached && typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', handleVisibilityChange);
    visibilityListenerAttached = true;
  }
}

function handleVisibilityChange() {
  if (document.visibilityState === 'visible') {
    void pollSystemStats();
  }
}

export function useSystemStatsPolling(enabled = true) {
  const [stats, setStats] = useState(latestStats);

  useEffect(() => {
    if (!enabled) return undefined;
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
