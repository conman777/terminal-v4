import { useCallback, useRef, useState } from 'react';

const RECENT_DONE_WINDOW_MS = 60000;
const DONE_STATE_STORAGE_KEY = 'terminalSessionDoneStateV2';

function toTimestamp(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const ts = Date.parse(value);
    return Number.isFinite(ts) ? ts : 0;
  }
  return 0;
}

function loadDoneState() {
  if (typeof window === 'undefined') return {};
  try {
    const raw = window.localStorage.getItem(DONE_STATE_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const now = Date.now();
    const cleaned = {};
    for (const [sessionId, ts] of Object.entries(parsed)) {
      const value = toTimestamp(ts);
      if (value > 0 && now - value <= RECENT_DONE_WINDOW_MS) {
        cleaned[sessionId] = value;
      }
    }
    return cleaned;
  } catch {
    return {};
  }
}

function saveDoneState(state) {
  if (typeof window === 'undefined') return;
  try {
    if (!state || Object.keys(state).length === 0) {
      window.localStorage.removeItem(DONE_STATE_STORAGE_KEY);
      return;
    }
    window.localStorage.setItem(DONE_STATE_STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Ignore persistence failures.
  }
}

/**
 * Hook to track activity state across terminal sessions.
 * Tracks which sessions have unread content (received output while not focused).
 */
export function useSessionActivity() {
  // Activity state: { [sessionId]: { hasUnread, lastActivity, isBusy, isDone } }
  const [activity, setActivity] = useState({});

  // Track the currently focused session to avoid marking it as unread
  const focusedSessionRef = useRef(null);
  const doneStateRef = useRef(loadDoneState());

  const pruneDoneState = useCallback((now = Date.now()) => {
    const current = doneStateRef.current;
    let changed = false;
    for (const [sessionId, ts] of Object.entries(current)) {
      const value = toTimestamp(ts);
      if (!value || now - value > RECENT_DONE_WINDOW_MS) {
        delete current[sessionId];
        changed = true;
      }
    }
    if (changed) {
      saveDoneState(current);
    }
  }, []);

  const clearDoneState = useCallback((sessionId) => {
    if (!sessionId) return;
    if (sessionId in doneStateRef.current) {
      delete doneStateRef.current[sessionId];
      saveDoneState(doneStateRef.current);
    }
  }, []);

  const markDoneState = useCallback((sessionId, ts = Date.now()) => {
    if (!sessionId) return;
    doneStateRef.current[sessionId] = ts;
    saveDoneState(doneStateRef.current);
  }, []);

  // Mark a session as having new activity
  const markActivity = useCallback((sessionId) => {
    if (!sessionId) return;

    setActivity(prev => {
      const current = prev[sessionId] || { hasUnread: false, lastActivity: 0, isBusy: false, isDone: false };
      const isFocused = focusedSessionRef.current === sessionId;

      return {
        ...prev,
        [sessionId]: {
          ...current,
          hasUnread: isFocused ? false : true,
          isDone: false,
          lastActivity: Date.now()
        }
      };
    });
  }, []);

  // Clear unread flag when session is focused
  const clearUnread = useCallback((sessionId) => {
    if (!sessionId) return;

    focusedSessionRef.current = sessionId;
    clearDoneState(sessionId);

    setActivity(prev => {
      const current = prev[sessionId];
      if (!current) return prev;
      if (!current.hasUnread && !current.isDone && !current.isBusy) return prev;

      return {
        ...prev,
        [sessionId]: {
          ...current,
          hasUnread: false,
          isBusy: false,
          isDone: false
        }
      };
    });
  }, [clearDoneState]);

  // Set focus to a session (clears its unread state)
  const setFocusedSession = useCallback((sessionId) => {
    focusedSessionRef.current = sessionId;
    if (!sessionId) return;
    clearDoneState(sessionId);

    setActivity(prev => {
      const current = prev[sessionId] || { hasUnread: false, lastActivity: 0, isBusy: false, isDone: false };
      return {
        ...prev,
        [sessionId]: {
          ...current,
          hasUnread: false,
          isDone: false,
          lastActivity: Date.now()
        }
      };
    });
  }, [clearDoneState]);

  // Get activity state for a specific session
  const getActivity = useCallback((sessionId) => {
    return activity[sessionId] || { hasUnread: false, lastActivity: 0, isBusy: false, isDone: false };
  }, [activity]);

  // Track busy/ready command execution state for each session
  const setBusy = useCallback((sessionId, isBusy, options = {}) => {
    if (!sessionId) return;
    const now = Date.now();
    pruneDoneState(now);

    const busy = Boolean(isBusy);
    const activityTs = toTimestamp(options.lastActivityAt);

    setActivity(prev => {
      const current = prev[sessionId] || { hasUnread: false, lastActivity: 0, isBusy: false, isDone: false };
      const isFocused = focusedSessionRef.current === sessionId;
      const effectiveLastActivity = activityTs || current.lastActivity;
      const persistedDoneAt = toTimestamp(doneStateRef.current[sessionId]);
      const hasPersistedDone = persistedDoneAt > 0 && now - persistedDoneAt <= RECENT_DONE_WINDOW_MS;
      const justFinished = current.isBusy && !busy;

      let nextIsDone = current.isDone;
      if (busy) {
        nextIsDone = false;
      } else if (justFinished) {
        nextIsDone = !isFocused;
      } else if (!current.isBusy && !current.isDone && hasPersistedDone && !isFocused) {
        nextIsDone = true;
      }

      const nextLastActivity = busy ? now : effectiveLastActivity;
      if (
        current.isBusy === busy &&
        current.isDone === nextIsDone &&
        current.lastActivity === nextLastActivity
      ) {
        return prev;
      }

      if (busy || isFocused || !nextIsDone) {
        clearDoneState(sessionId);
      } else if (justFinished && nextIsDone) {
        markDoneState(sessionId, now);
      }

      return {
        ...prev,
        [sessionId]: {
          ...current,
          isBusy: busy,
          isDone: nextIsDone,
          lastActivity: nextLastActivity
        }
      };
    });
  }, [clearDoneState, markDoneState, pruneDoneState]);

  // Check if any session has unread content
  const hasAnyUnread = useCallback(() => {
    return Object.values(activity).some(a => a.hasUnread);
  }, [activity]);

  // Remove activity tracking for a closed session
  const removeSession = useCallback((sessionId) => {
    clearDoneState(sessionId);
    setActivity(prev => {
      const { [sessionId]: removed, ...rest } = prev;
      return rest;
    });
  }, [clearDoneState]);

  return {
    activity,
    markActivity,
    clearUnread,
    setFocusedSession,
    setBusy,
    getActivity,
    hasAnyUnread,
    removeSession
  };
}
