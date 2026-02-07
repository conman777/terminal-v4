import { useCallback, useRef, useState } from 'react';

/**
 * Hook to track activity state across terminal sessions.
 * Tracks which sessions have unread content (received output while not focused).
 */
export function useSessionActivity() {
  // Activity state: { [sessionId]: { hasUnread, lastActivity, isBusy } }
  const [activity, setActivity] = useState({});

  // Track the currently focused session to avoid marking it as unread
  const focusedSessionRef = useRef(null);

  // Mark a session as having new activity
  const markActivity = useCallback((sessionId) => {
    if (!sessionId) return;

    setActivity(prev => {
      const current = prev[sessionId] || { hasUnread: false, lastActivity: 0, isBusy: false };
      const isFocused = focusedSessionRef.current === sessionId;

      return {
        ...prev,
        [sessionId]: {
          ...current,
          hasUnread: isFocused ? false : true,
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
          isBusy: false
        }
      };
    });
  }, []);

  // Set focus to a session (clears its unread state)
  const setFocusedSession = useCallback((sessionId) => {
    focusedSessionRef.current = sessionId;
    if (!sessionId) return;

    setActivity(prev => {
      const current = prev[sessionId] || { hasUnread: false, lastActivity: 0, isBusy: false };
      return {
        ...prev,
        [sessionId]: {
          ...current,
          hasUnread: false,
          lastActivity: Date.now()
        }
      };
    });
  }, []);

  // Get activity state for a specific session
  const getActivity = useCallback((sessionId) => {
    return activity[sessionId] || { hasUnread: false, lastActivity: 0, isBusy: false };
  }, [activity]);

  // Track busy/ready command execution state for each session
  const setBusy = useCallback((sessionId, isBusy) => {
    if (!sessionId) return;
    const busy = Boolean(isBusy);
    setActivity(prev => {
      const current = prev[sessionId] || { hasUnread: false, lastActivity: 0, isBusy: false };
      if (current.isBusy === busy) return prev;
      return {
        ...prev,
        [sessionId]: {
          ...current,
          isBusy: busy,
          lastActivity: busy ? Date.now() : current.lastActivity
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
