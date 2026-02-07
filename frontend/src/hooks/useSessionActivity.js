import { useCallback, useRef, useState } from 'react';

const RECENT_DONE_WINDOW_MS = 60000;

function toTimestamp(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const ts = Date.parse(value);
    return Number.isFinite(ts) ? ts : 0;
  }
  return 0;
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

    setActivity(prev => {
      const current = prev[sessionId];
      if (!current || !current.hasUnread) return prev;

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
  }, []);

  // Set focus to a session (clears its unread state)
  const setFocusedSession = useCallback((sessionId) => {
    focusedSessionRef.current = sessionId;
    if (!sessionId) return;

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
  }, []);

  // Get activity state for a specific session
  const getActivity = useCallback((sessionId) => {
    return activity[sessionId] || { hasUnread: false, lastActivity: 0, isBusy: false, isDone: false };
  }, [activity]);

  // Track busy/ready command execution state for each session
  const setBusy = useCallback((sessionId, isBusy, options = {}) => {
    if (!sessionId) return;
    const busy = Boolean(isBusy);
    const activityTs = toTimestamp(options.lastActivityAt);
    const now = Date.now();
    setActivity(prev => {
      const current = prev[sessionId] || { hasUnread: false, lastActivity: 0, isBusy: false, isDone: false };
      const isFocused = focusedSessionRef.current === sessionId;
      const effectiveLastActivity = activityTs || current.lastActivity;
      const hasRecentActivity = effectiveLastActivity > 0 && now - effectiveLastActivity <= RECENT_DONE_WINDOW_MS;

      if (current.isBusy === busy) {
        // Preserve a recent "done" signal across refreshes even when we didn't
        // observe the exact busy->ready transition locally.
        const inferredDone = !busy && !isFocused && hasRecentActivity;
        const nextIsDone = inferredDone ? true : current.isDone;
        if (nextIsDone === current.isDone && (!busy || effectiveLastActivity === current.lastActivity)) {
          return prev;
        }
        return {
          ...prev,
          [sessionId]: {
            ...current,
            isDone: nextIsDone,
            lastActivity: busy ? now : effectiveLastActivity
          }
        };
      }

      const justFinished = current.isBusy && !busy;
      return {
        ...prev,
        [sessionId]: {
          ...current,
          isBusy: busy,
          isDone: busy ? false : (justFinished ? !isFocused : (!isFocused && hasRecentActivity)),
          lastActivity: busy ? now : effectiveLastActivity
        }
      };
    });
  }, []);

  // Check if any session has unread content
  const hasAnyUnread = useCallback(() => {
    return Object.values(activity).some(a => a.hasUnread);
  }, [activity]);

  // Remove activity tracking for a closed session
  const removeSession = useCallback((sessionId) => {
    setActivity(prev => {
      const { [sessionId]: removed, ...rest } = prev;
      return rest;
    });
  }, []);

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
