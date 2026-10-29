import { useCallback, useEffect, useRef, useState } from 'react';

const BUSY_STALE_MS = 8000;
const EMPTY_ACTIVITY_STATE = Object.freeze({
  hasUnread: false,
  needsAttention: false,
  lastActivity: 0,
  isBusy: false
});

function normalizeActivityState(value = {}) {
  return {
    hasUnread: Boolean(value.hasUnread),
    needsAttention: Boolean(value.hasUnread || value.needsAttention),
    lastActivity: value.lastActivity || 0,
    isBusy: Boolean(value.isBusy)
  };
}

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
 *
 * State model:
 *   isBusy  = true  → session is actively processing (blue indicator)
 *   isBusy  = false → session is idle (gray indicator)
 *
 * Busy auto-clears after BUSY_STALE_MS with no new activity heartbeat.
 */
export function useSessionActivity() {
  const [activity, setActivity] = useState({});
  const focusedSessionRef = useRef(null);
  const persistentBusyRef = useRef(new Set());
  const lifecycleRef = useRef(new Map());
  const hasBusySessions = Object.values(activity).some((state) => state?.isBusy);

  // Auto-clear stale busy sessions only while something is actually busy.
  useEffect(() => {
    if (!hasBusySessions) {
      return undefined;
    }
    const interval = setInterval(() => {
      const now = Date.now();
      setActivity(prev => {
        let changed = false;
        const next = {};
        for (const [id, state] of Object.entries(prev)) {
          if (state.isBusy && !persistentBusyRef.current.has(id) && state.lastActivity > 0 && now - state.lastActivity > BUSY_STALE_MS) {
            next[id] = normalizeActivityState({ ...state, isBusy: false });
            changed = true;
          } else {
            next[id] = state;
          }
        }
        return changed ? next : prev;
      });
    }, 2000);
    return () => clearInterval(interval);
  }, [hasBusySessions]);

  const markUnread = useCallback((sessionId) => {
    if (!sessionId) return;
    setActivity(prev => ({
      ...prev,
      [sessionId]: normalizeActivityState({ ...normalizeActivityState(prev[sessionId]), hasUnread: true, needsAttention: true }),
    }));
  }, []);

  const markActivity = useCallback((sessionId) => {
    if (!sessionId) return;
    setActivity(prev => {
      const current = normalizeActivityState(prev[sessionId]);
      const isFocused = focusedSessionRef.current === sessionId;
      return {
        ...prev,
        [sessionId]: normalizeActivityState({
          ...current,
          hasUnread: !isFocused,
          needsAttention: !isFocused,
          lastActivity: Date.now()
        })
      };
    });
  }, []);

  const clearUnread = useCallback((sessionId) => {
    if (!sessionId) return;
    focusedSessionRef.current = sessionId;
    setActivity(prev => {
      const current = prev[sessionId] ? normalizeActivityState(prev[sessionId]) : null;
      if (!current) return prev;
      if (!current.hasUnread && !current.needsAttention) return prev;
      return {
        ...prev,
        [sessionId]: normalizeActivityState({
          ...current,
          hasUnread: false,
          needsAttention: false
        })
      };
    });
  }, []);

  const setFocusedSession = useCallback((sessionId) => {
    focusedSessionRef.current = sessionId;
    if (!sessionId) return;
    setActivity(prev => {
      const current = normalizeActivityState(prev[sessionId]);
      if (!current.hasUnread && !current.needsAttention) return prev;
      return {
        ...prev,
        [sessionId]: normalizeActivityState({
          ...current,
          hasUnread: false,
          needsAttention: false,
          lastActivity: Date.now()
        })
      };
    });
  }, []);

  const getActivity = useCallback((sessionId) => {
    return activity[sessionId] || EMPTY_ACTIVITY_STATE;
  }, [activity]);

  const setBusy = useCallback((sessionId, isBusy, options = {}) => {
    if (!sessionId) return;
    const now = Date.now();
    const busy = Boolean(isBusy);
    const activityTs = toTimestamp(options.lastActivityAt);
    const statusSeq = options.persistent === true && Number.isSafeInteger(options.statusSeq) && options.statusSeq >= 0 ? options.statusSeq : null;

    setActivity(prev => {
      const current = normalizeActivityState(prev[sessionId]);
      const lifecycle = lifecycleRef.current.get(sessionId);
      if (statusSeq !== null) {
        if (lifecycle && (statusSeq < lifecycle.seq || (statusSeq === lifecycle.seq && lifecycle.localChange))) return prev;
        lifecycleRef.current.set(sessionId, { seq: statusSeq, localChange: false });
      } else {
        if (activityTs > 0 && current.lastActivity > activityTs) return prev;
        if (options.persistent === true && current.isBusy !== busy) {
          lifecycleRef.current.set(sessionId, { seq: lifecycle?.seq ?? -1, localChange: true });
        }
      }
      if (options.persistent === true && busy) persistentBusyRef.current.add(sessionId);
      else if (options.persistent === false || !busy) persistentBusyRef.current.delete(sessionId);

      const nextLastActivity = activityTs || now;
      const completedOffscreen = current.isBusy && !busy && focusedSessionRef.current !== sessionId;

      if (!busy && !current.isBusy && !completedOffscreen && activityTs === 0) {
        return prev;
      }

      if (
        current.isBusy === busy
        && current.lastActivity === nextLastActivity
        && (!completedOffscreen || current.hasUnread)
      ) {
        return prev;
      }

      return {
        ...prev,
        [sessionId]: normalizeActivityState({
          ...current,
          hasUnread: completedOffscreen ? true : current.hasUnread,
          isBusy: busy,
          lastActivity: nextLastActivity
        })
      };
    });
  }, []);

  const hasAnyUnread = useCallback(() => {
    return Object.values(activity).some(a => a.hasUnread);
  }, [activity]);

  const removeSession = useCallback((sessionId) => {
    persistentBusyRef.current.delete(sessionId);
    lifecycleRef.current.delete(sessionId);
    setActivity(prev => {
      const { [sessionId]: removed, ...rest } = prev;
      return rest;
    });
  }, []);

  return {
    markUnread,
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
