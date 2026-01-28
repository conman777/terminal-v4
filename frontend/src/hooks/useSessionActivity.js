import { useCallback, useRef, useState } from 'react';

/**
 * Hook to track activity state across terminal sessions.
 * Tracks which sessions have unread content (received output while not focused).
 */
export function useSessionActivity() {
  // Activity state: { [sessionId]: { hasUnread, lastActivity } }
  const [activity, setActivity] = useState({});

  // Track the currently focused session to avoid marking it as unread
  const focusedSessionRef = useRef(null);

  // Mark a session as having new activity
  const markActivity = useCallback((sessionId) => {
    if (!sessionId) return;

    setActivity(prev => {
      const current = prev[sessionId] || { hasUnread: false, lastActivity: 0 };
      const isFocused = focusedSessionRef.current === sessionId;

      return {
        ...prev,
        [sessionId]: {
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
          hasUnread: false
        }
      };
    });
  }, []);

  // Set focus to a session (clears its unread state)
  const setFocusedSession = useCallback((sessionId) => {
    focusedSessionRef.current = sessionId;
    if (!sessionId) return;

    setActivity(prev => {
      const current = prev[sessionId] || { hasUnread: false, lastActivity: 0 };
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
    return activity[sessionId] || { hasUnread: false, lastActivity: 0 };
  }, [activity]);

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
    getActivity,
    hasAnyUnread,
    removeSession
  };
}
