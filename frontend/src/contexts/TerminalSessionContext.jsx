import { createContext, useContext, useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { apiFetch, apiGet } from '../utils/api';
import { areEquivalentTerminalStates } from '../utils/terminalStateEquality';
import { isWindowActive, subscribeWindowActivity } from '../utils/windowActivity';
import { useFolders } from './FolderContext';

const TerminalSessionContext = createContext(null);

export function TerminalSessionProvider({ children }) {
  const [sessions, setSessions] = useState([]);
  const [activeSessionId, setActiveSessionId] = useState(() => {
    try {
      return localStorage.getItem('lastActiveSession') || null;
    } catch {
      return null;
    }
  });
  const [loadingSessions, setLoadingSessions] = useState(true);
  const [sessionLoadError, setSessionLoadError] = useState(null);
  const [restoringSessionId, setRestoringSessionId] = useState(null);
  const [projectInfo, setProjectInfo] = useState(null);

  // Get folder state from FolderContext
  const { recentFolders, addRecentFolder } = useFolders();

  // Refs
  const isMountedRef = useRef(true);
  const restoreInFlightRef = useRef(new Set());
  const lastActivityRef = useRef(Date.now());
  const activeSessionIdRef = useRef(activeSessionId);
  const lastCwdRef = useRef(null);
  const terminalSendersRef = useRef(new Map());
  const liveTerminalCountRef = useRef(0);
  const pollRescheduleRef = useRef(null);
  const projectDetectInFlightRef = useRef(new Set());
  const projectDetectAttemptedRef = useRef(new Set());

  // Derived state
  const activeSessions = useMemo(
    () => sessions.filter((session) => session.isActive),
    [sessions]
  );
  const inactiveSessions = useMemo(
    () => sessions.filter((session) => !session.isActive),
    [sessions]
  );

  const threadSessions = useMemo(
    () => sessions.filter((session) => !session.thread?.archived),
    [sessions]
  );

  // Group sessions by project path for Threads sidebar
  const sessionsGroupedByProject = useMemo(() => {
    const groups = new Map();

    // Helper to get project name from path
    const getProjectName = (path) => {
      if (!path) return 'Unknown';
      const normalizedPath = String(path).replace(/[\\/]+$/, '').replace(/\\/g, '/');
      const parts = normalizedPath.split('/').filter(Boolean);
      return parts[parts.length - 1] || 'Unknown';
    };

    // Process all sessions (both active and inactive)
    threadSessions.forEach((session) => {
      const projectPath = session.thread?.projectPath || session.groupPath || session.cwd || null;
      const projectName = getProjectName(projectPath);

      if (!groups.has(projectPath)) {
        groups.set(projectPath, {
          projectPath,
          projectName,
          sessions: []
        });
      }

      groups.get(projectPath).sessions.push(session);
    });

    // Convert to array and sort groups by most recent activity
    const groupArray = Array.from(groups.values());
    groupArray.sort((a, b) => {
      const aLatest = Math.max(...a.sessions.map(s => {
        const threadTime = s.thread?.lastActivityAt ? new Date(s.thread.lastActivityAt).getTime() : 0;
        const updateTime = s.updatedAt ? new Date(s.updatedAt).getTime() : 0;
        return Math.max(threadTime, updateTime);
      }));
      const bLatest = Math.max(...b.sessions.map(s => {
        const threadTime = s.thread?.lastActivityAt ? new Date(s.thread.lastActivityAt).getTime() : 0;
        const updateTime = s.updatedAt ? new Date(s.updatedAt).getTime() : 0;
        return Math.max(threadTime, updateTime);
      }));
      return bLatest - aLatest;
    });

    // Sort sessions within each group by pinned first, then by lastActivityAt
    groupArray.forEach((group) => {
      group.sessions.sort((a, b) => {
        // Pinned sessions first
        if (a.thread?.pinned && !b.thread?.pinned) return -1;
        if (!a.thread?.pinned && b.thread?.pinned) return 1;
        // Then by activity time
        const aTime = a.thread?.lastActivityAt ? new Date(a.thread.lastActivityAt).getTime() : new Date(a.updatedAt).getTime();
        const bTime = b.thread?.lastActivityAt ? new Date(b.thread.lastActivityAt).getTime() : new Date(b.updatedAt).getTime();
        return bTime - aTime;
      });
    });

    return groupArray;
  }, [threadSessions]);

  // Get pinned sessions across all projects
  const pinnedSessions = useMemo(
    () => threadSessions.filter((session) => session.thread?.pinned),
    [threadSessions]
  );

  // Get archived sessions
  const archivedSessions = useMemo(
    () => sessions.filter((session) => session.thread?.archived),
    [sessions]
  );

  useEffect(() => {
    activeSessionIdRef.current = activeSessionId;
  }, [activeSessionId]);

  // Load sessions
  const hasLoadedOnceRef = useRef(false);
  const loadSessions = useCallback(async () => {
    if (!isMountedRef.current) return [];
    // Only show loading indicator on first load to avoid flashing the terminal
    if (!hasLoadedOnceRef.current) {
      setLoadingSessions(true);
    }
    setSessionLoadError(null);
    try {
      const response = await apiFetch('/api/terminal');
      if (!response.ok) {
        throw new Error(`Failed to load sessions (${response.status})`);
      }
      const data = await response.json();
      const nextSessions = Array.isArray(data.sessions) ? data.sessions : [];
      if (isMountedRef.current) {
        setSessions((prevSessions) => (
          areEquivalentTerminalStates(prevSessions, nextSessions)
            ? prevSessions
            : nextSessions
        ));
      }
      hasLoadedOnceRef.current = true;
      return nextSessions;
    } catch (error) {
      console.error('Failed to load sessions', error);
      if (isMountedRef.current) {
        setSessionLoadError(error.message || 'Failed to load terminals');
      }
      return [];
    } finally {
      if (isMountedRef.current) {
        setLoadingSessions(false);
      }
    }
  }, []);

  // Consolidated state fetcher
  const fetchAppState = useCallback(async () => {
    if (!isMountedRef.current) return;

    try {
      const selectedSessionId = activeSessionIdRef.current;
      const url = selectedSessionId
        ? `/api/state?sessionId=${selectedSessionId}`
        : '/api/state';

      const response = await apiFetch(url);
      if (!response.ok) {
        throw new Error(`Failed to fetch app state (${response.status})`);
      }

      const data = await response.json();

      if (data.sessions && isMountedRef.current) {
        const nextSessions = Array.isArray(data.sessions) ? data.sessions : [];
        setSessions((prevSessions) => (
          areEquivalentTerminalStates(prevSessions, nextSessions)
            ? prevSessions
            : nextSessions
        ));
      }

      if (data.projectInfo && isMountedRef.current) {
        setProjectInfo((prevProjectInfo) => (
          areEquivalentTerminalStates(prevProjectInfo, data.projectInfo)
            ? prevProjectInfo
            : data.projectInfo
        ));
        if (data.projectInfo.cwd && data.projectInfo.cwd !== lastCwdRef.current) {
          lastCwdRef.current = data.projectInfo.cwd;
          addRecentFolder(data.projectInfo.cwd);
        }
      } else if (!selectedSessionId && isMountedRef.current) {
        setProjectInfo(null);
        lastCwdRef.current = null;
      }
    } catch (error) {
      console.error('Failed to fetch app state:', error);
    }
  }, [addRecentFolder]);

  // Session CRUD operations
  const createSession = useCallback(async (options = {}) => {
    try {
      const requestBody = {};
      if (options.cwd) {
        requestBody.cwd = options.cwd;
      } else if (recentFolders.length > 0) {
        requestBody.cwd = recentFolders[0];
      }
      if (options.title) {
        requestBody.title = options.title;
      }
      if (options.sandboxMode) {
        requestBody.sandboxMode = options.sandboxMode;
      }
      if (options.workspaceRoot) {
        requestBody.workspaceRoot = options.workspaceRoot;
      }
      if (options.initialCommand) {
        requestBody.initialCommand = options.initialCommand;
      }

      const response = await apiFetch('/api/terminal', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody)
      });

      if (!response.ok) {
        throw new Error(`Failed to create session (${response.status})`);
      }

      const data = await response.json();
      setActiveSessionId(data.session.id);
      await loadSessions();
      return data.session;
    } catch (error) {
      console.error('Failed to create session', error);
      throw error;
    }
  }, [loadSessions, recentFolders]);

  const selectSession = useCallback((sessionId) => {
    setActiveSessionId(sessionId);
    try {
      localStorage.setItem('lastActiveSession', sessionId);
    } catch (error) {
      console.error('Failed to save last active session', error);
    }
  }, []);

  const restoreSession = useCallback(async (sessionId) => {
    try {
      const response = await apiFetch(`/api/terminal/${sessionId}/restore`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({})
      });

      if (!response.ok) {
        throw new Error(`Failed to restore session (${response.status})`);
      }

      setActiveSessionId(sessionId);
      await loadSessions();

      try {
        localStorage.setItem('lastActiveSession', sessionId);
      } catch (error) {
        console.error('Failed to save last active session', error);
      }
    } catch (error) {
      console.error('Failed to restore session', error);
      // Refresh sessions without triggering loading state to avoid flash loop
      try {
        const response = await apiFetch('/api/terminal');
        if (response.ok) {
          const data = await response.json();
          const nextSessions = Array.isArray(data.sessions) ? data.sessions : [];
          setSessions(nextSessions);
        }
      } catch (_) { /* best-effort refresh */ }
      throw error;
    }
  }, []);

  const renameSession = useCallback(async (sessionId, title) => {
    const trimmed = title.trim().slice(0, 60);
    if (!trimmed) return;
    const currentTitle = sessions.find((session) => session.id === sessionId)?.title;
    if (currentTitle === trimmed) return;

    try {
      const response = await apiFetch(`/api/terminal/${sessionId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: trimmed })
      });

      if (!response.ok) {
        throw new Error(`Failed to rename session (${response.status})`);
      }

      const data = await response.json();
      const updated = data.session;
      setSessions((currentSessions) =>
        currentSessions.map((session) =>
          session.id === sessionId ? { ...session, title: updated.title, updatedAt: updated.updatedAt } : session
        )
      );
    } catch (error) {
      console.error('Failed to rename session', error);
    }
  }, [sessions]);

  const closeSession = useCallback(async (sessionId) => {
    try {
      const response = await apiFetch(`/api/terminal/${sessionId}`, {
        method: 'DELETE'
      });
      if (!response.ok) {
        throw new Error(`Failed to close session (${response.status})`);
      }

      setSessions((currentSessions) => {
        const remainingSessions = currentSessions.filter((s) => s.id !== sessionId);
        setActiveSessionId((currentActiveId) => {
          if (sessionId === currentActiveId) {
            const nextActive = remainingSessions.find((session) => session.isActive);
            return nextActive ? nextActive.id : null;
          }
          return currentActiveId;
        });
        return remainingSessions;
      });

      await loadSessions();
    } catch (error) {
      console.error('Failed to close session', error);
      await loadSessions();
    }
  }, [loadSessions]);

  // Navigate session to path
  const navigateSession = useCallback(async (sessionId, path) => {
    if (!sessionId || !path) return;

    try {
      const cdCommand = `cd "${path}"\r`;
      await apiFetch(`/api/terminal/${sessionId}/input`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command: cdCommand })
      });
      addRecentFolder(path);
    } catch (error) {
      console.error('Failed to navigate session', error);
    }
  }, [addRecentFolder]);

  // Track activity for polling
  const trackActivity = useCallback(() => {
    lastActivityRef.current = Date.now();
  }, []);

  // Thread metadata actions
  const updateThreadMetadata = useCallback(async (sessionId, updates) => {
    if (!sessionId) return;

    try {
      const response = await apiFetch(`/api/terminal/${sessionId}/thread`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updates)
      });

      if (!response.ok) {
        throw new Error(`Failed to update thread metadata (${response.status})`);
      }

      const data = await response.json();

      // Update local state
      setSessions((currentSessions) =>
        currentSessions.map((session) =>
          session.id === sessionId
            ? { ...session, thread: data.thread }
            : session
        )
      );

      return data.thread;
    } catch (error) {
      console.error('Failed to update thread metadata', error);
      throw error;
    }
  }, []);

  const pinSession = useCallback(async (sessionId) => {
    return updateThreadMetadata(sessionId, { pinned: true });
  }, [updateThreadMetadata]);

  const unpinSession = useCallback(async (sessionId) => {
    return updateThreadMetadata(sessionId, { pinned: false });
  }, [updateThreadMetadata]);

  const archiveSession = useCallback(async (sessionId) => {
    return updateThreadMetadata(sessionId, { archived: true });
  }, [updateThreadMetadata]);

  const unarchiveSession = useCallback(async (sessionId) => {
    return updateThreadMetadata(sessionId, { archived: false });
  }, [updateThreadMetadata]);

  const updateSessionTopic = useCallback(async (sessionId, topic, autoGenerated = false) => {
    return updateThreadMetadata(sessionId, {
      topic,
      topicAutoGenerated: autoGenerated
    });
  }, [updateThreadMetadata]);

  // Update local session thread state without an API call (for WebSocket-pushed updates)
  const syncSessionThread = useCallback((sessionId, thread) => {
    if (!sessionId || !thread) return;
    setSessions((currentSessions) =>
      currentSessions.map((session) =>
        session.id === sessionId
          ? { ...session, thread: { ...(session.thread || {}), ...thread } }
          : session
      )
    );
  }, []);

  const generateSessionTopic = useCallback(async (sessionId) => {
    if (!sessionId) return;
    try {
      const response = await apiFetch(`/api/terminal/${sessionId}/generate-topic`, {
        method: 'POST'
      });
      if (!response.ok) return false;
      const data = await response.json();
      if (data?.topic) {
        setSessions((current) =>
          current.map((s) =>
            s.id === sessionId
              ? { ...s, thread: data.thread || { ...(s.thread || {}), topic: data.topic, topicAutoGenerated: true } }
              : s
          )
        );
        return true;
      }
      return false;
    } catch {
      // Topic generation is non-critical
      return false;
    }
  }, [setSessions]);

  const detectSessionProject = useCallback(async (sessionId) => {
    if (!sessionId) return null;

    try {
      const response = await apiFetch(`/api/terminal/${sessionId}/detect-project`, {
        method: 'POST'
      });

      if (!response.ok) {
        throw new Error(`Failed to detect project (${response.status})`);
      }

      const data = await response.json();

      // Update local state
      setSessions((currentSessions) =>
        currentSessions.map((session) =>
          session.id === sessionId
            ? {
                ...session,
                thread: {
                  ...(session.thread || {}),
                  projectPath: data.projectPath
                }
              }
            : session
        )
      );

      return data.projectPath;
    } catch (error) {
      console.error('Failed to detect project', error);
      return null;
    }
  }, []);

  const refreshSessionGitStats = useCallback(async (sessionId) => {
    if (!sessionId) return null;

    try {
      const response = await apiFetch(`/api/terminal/${sessionId}/git-stats`);

      if (!response.ok) {
        throw new Error(`Failed to get git stats (${response.status})`);
      }

      const data = await response.json();

      // Update local state
      setSessions((currentSessions) =>
        currentSessions.map((session) =>
          session.id === sessionId
            ? {
                ...session,
                thread: {
                  ...(session.thread || {}),
                  gitStats: data.gitStats,
                  projectPath: data.projectPath
                }
              }
            : session
        )
      );

      return data;
    } catch (error) {
      console.error('Failed to refresh git stats', error);
      return null;
    }
  }, []);

  const listSessionGitBranches = useCallback(async (sessionId) => {
    if (!sessionId) return null;

    try {
      const response = await apiFetch(`/api/terminal/${sessionId}/git-branches`);
      if (response.status === 404) {
        return null;
      }
      if (!response.ok) {
        throw new Error(`Failed to get git branches (${response.status})`);
      }
      return await response.json();
    } catch (error) {
      console.error('Failed to list git branches', error);
      return null;
    }
  }, []);

  const checkoutSessionGitBranch = useCallback(async (sessionId, branch) => {
    if (!sessionId || !branch) return null;

    try {
      const response = await apiFetch(`/api/terminal/${sessionId}/git-checkout`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ branch })
      });
      if (!response.ok) {
        throw new Error(`Failed to checkout git branch (${response.status})`);
      }
      const data = await response.json();
      await refreshSessionGitStats(sessionId);
      return data;
    } catch (error) {
      console.error('Failed to checkout git branch', error);
      return null;
    }
  }, [refreshSessionGitStats]);

  useEffect(() => {
    sessions.forEach((session) => {
      if (session.thread?.projectPath) return;
      if (!session.cwd) return;

      const attemptKey = `${session.id}:${session.cwd}`;
      if (projectDetectAttemptedRef.current.has(attemptKey)) return;
      if (projectDetectInFlightRef.current.has(attemptKey)) return;

      projectDetectAttemptedRef.current.add(attemptKey);
      projectDetectInFlightRef.current.add(attemptKey);
      detectSessionProject(session.id).finally(() => {
        projectDetectInFlightRef.current.delete(attemptKey);
      });
    });
  }, [sessions, detectSessionProject]);

  const registerTerminalSender = useCallback((sessionId, sender) => {
    if (!sessionId || typeof sender !== 'function') return;
    const previousSize = terminalSendersRef.current.size;
    terminalSendersRef.current.set(sessionId, sender);
    if (terminalSendersRef.current.size !== previousSize) {
      liveTerminalCountRef.current = terminalSendersRef.current.size;
      lastActivityRef.current = Date.now();
      pollRescheduleRef.current?.();
    }
  }, []);

  const unregisterTerminalSender = useCallback((sessionId, sender) => {
    if (!sessionId) return;
    const current = terminalSendersRef.current.get(sessionId);
    if (!current || current === sender) {
      const previousSize = terminalSendersRef.current.size;
      terminalSendersRef.current.delete(sessionId);
      if (terminalSendersRef.current.size !== previousSize) {
        liveTerminalCountRef.current = terminalSendersRef.current.size;
        pollRescheduleRef.current?.();
      }
    }
  }, []);

  const sendToSession = useCallback(async (sessionId, data) => {
    if (!sessionId || data === undefined || data === null) return;
    const payload = typeof data === 'string' ? data : String(data);
    const sender = terminalSendersRef.current.get(sessionId);
    if (sender) {
      sender(payload);
      return;
    }

    try {
      await apiFetch(`/api/terminal/${sessionId}/input`, {
        method: 'POST',
        body: { command: payload }
      });
    } catch (error) {
      console.error('Failed to send terminal input', error);
    }
  }, []);

  // Initial load and polling setup
  useEffect(() => {
    isMountedRef.current = true;

    const initializeSessions = async () => {
      const initialSessions = await loadSessions();
      if (!isMountedRef.current) return;

      const lastSessionId = localStorage.getItem('lastActiveSession');
      if (lastSessionId) {
        try {
          const lastSession = initialSessions.find((session) => session.id === lastSessionId);

          if (lastSession) {
            setActiveSessionId(lastSession.id);
            localStorage.setItem('lastActiveSession', lastSession.id);
            return;
          }

          const activeSession = initialSessions.find((session) => session.isActive);
          if (activeSession) {
            setActiveSessionId(activeSession.id);
            localStorage.setItem('lastActiveSession', activeSession.id);
          } else {
            localStorage.removeItem('lastActiveSession');
            setActiveSessionId(null);
          }
        } catch (error) {
          console.error('Failed to restore last session', error);
        }
      } else {
        try {
          const activeSession = initialSessions.find((session) => session.isActive);
          if (activeSession) {
            setActiveSessionId(activeSession.id);
            localStorage.setItem('lastActiveSession', activeSession.id);
          }
        } catch (error) {
          console.error('Failed to find active session', error);
        }
      }
    };

    initializeSessions();

    // Visibility-aware polling
    let pollTimeoutId = null;

    const getPollingInterval = () => {
      if (!isWindowActive()) return null;
      const idleTime = Date.now() - lastActivityRef.current;
      const hasLiveTerminalConnection = liveTerminalCountRef.current > 0;
      const hasActiveSelection = Boolean(activeSessionIdRef.current);
      if (hasLiveTerminalConnection) {
        if (idleTime > 300000) return 60000;
        if (idleTime > 120000) return 30000;
        if (idleTime > 30000) return 15000;
        return 8000;
      }
      if (!hasActiveSelection) {
        return 30000;
      }
      if (idleTime > 120000) return 30000;
      if (idleTime > 30000) return 15000;
      return 8000;
    };

    const schedulePoll = () => {
      if (pollTimeoutId) clearTimeout(pollTimeoutId);
      const interval = getPollingInterval();
      if (interval !== null) {
        pollTimeoutId = setTimeout(() => {
          fetchAppState();
          schedulePoll();
        }, interval);
      }
    };

    pollRescheduleRef.current = schedulePoll;
    schedulePoll();

    const handleActivity = () => {
      lastActivityRef.current = Date.now();
    };

    const handleWindowActivityChange = (windowIsActive) => {
      if (windowIsActive) {
        lastActivityRef.current = Date.now();
        fetchAppState();
        schedulePoll();
      } else {
        if (pollTimeoutId) clearTimeout(pollTimeoutId);
      }
    };

    window.addEventListener('mousemove', handleActivity, { passive: true });
    window.addEventListener('keydown', handleActivity, { passive: true });
    const unsubscribeWindowActivity = subscribeWindowActivity(handleWindowActivityChange);

    return () => {
      isMountedRef.current = false;
      pollRescheduleRef.current = null;
      if (pollTimeoutId) clearTimeout(pollTimeoutId);
      window.removeEventListener('mousemove', handleActivity);
      window.removeEventListener('keydown', handleActivity);
      unsubscribeWindowActivity();
    };
  }, [loadSessions, fetchAppState]);

  // Auto-restore inactive sessions
  useEffect(() => {
    if (loadingSessions) return;
    if (!activeSessionId) return;
    const activeSnapshot = sessions.find((session) => session.id === activeSessionId);
    if (!activeSnapshot || activeSnapshot.isActive) return;
    if (restoreInFlightRef.current.has(activeSessionId)) return;

    restoreInFlightRef.current.add(activeSessionId);
    setRestoringSessionId(activeSessionId);
    const retryTimeout = setTimeout(() => {
      restoreInFlightRef.current.delete(activeSessionId);
    }, 10000);

    restoreSession(activeSessionId)
      .catch((error) => {
        console.error('Session restore failed, clearing selection:', error);
        setActiveSessionId(null);
      })
      .finally(() => {
        clearTimeout(retryTimeout);
        restoreInFlightRef.current.delete(activeSessionId);
      });
  }, [activeSessionId, loadingSessions, sessions, restoreSession]);

  // Clear restoring state when session becomes active
  useEffect(() => {
    if (!activeSessionId) {
      setRestoringSessionId(null);
      return;
    }
    const activeSnapshot = sessions.find((session) => session.id === activeSessionId);
    if (!activeSnapshot || activeSnapshot.isActive) {
      setRestoringSessionId(null);
    }
  }, [activeSessionId, sessions]);

  const value = {
    // Session state
    sessions,
    activeSessionId,
    activeSessions,
    inactiveSessions,
    loadingSessions,
    sessionLoadError,
    restoringSessionId,
    projectInfo,

    // Thread/grouped session state
    sessionsGroupedByProject,
    pinnedSessions,
    archivedSessions,

    // Session actions
    createSession,
    selectSession,
    restoreSession,
    renameSession,
    closeSession,
    navigateSession,
    retryLoadSessions: loadSessions,
    registerTerminalSender,
    unregisterTerminalSender,
    sendToSession,

    // Thread actions
    updateThreadMetadata,
    pinSession,
    unpinSession,
    archiveSession,
    unarchiveSession,
    updateSessionTopic,
    syncSessionThread,
    generateSessionTopic,
    detectSessionProject,
    refreshSessionGitStats,
    listSessionGitBranches,
    checkoutSessionGitBranch,

    // Activity tracking
    trackActivity
  };

  return (
    <TerminalSessionContext.Provider value={value}>
      {children}
    </TerminalSessionContext.Provider>
  );
}

export function useTerminalSession() {
  const context = useContext(TerminalSessionContext);
  if (!context) {
    throw new Error('useTerminalSession must be used within a TerminalSessionProvider');
  }
  return context;
}
