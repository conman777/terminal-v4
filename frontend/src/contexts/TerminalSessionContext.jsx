import { createContext, useContext, useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { apiFetch, apiGet } from '../utils/api';

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

  // Folder state
  const [recentFolders, setRecentFolders] = useState(() => {
    try {
      const stored = localStorage.getItem('recentFolders');
      return stored ? JSON.parse(stored) : [];
    } catch {
      return [];
    }
  });

  const [pinnedFolders, setPinnedFolders] = useState(() => {
    try {
      const stored = localStorage.getItem('pinnedFolders');
      return stored ? JSON.parse(stored) : [];
    } catch {
      return [];
    }
  });

  // Projects state
  const [projects, setProjects] = useState([]);
  const [projectsLoading, setProjectsLoading] = useState(false);

  // Bookmarks state
  const [bookmarks, setBookmarks] = useState([]);

  // Notes state
  const [notes, setNotes] = useState([]);

  // Refs
  const isMountedRef = useRef(true);
  const restoreInFlightRef = useRef(new Set());
  const lastActivityRef = useRef(Date.now());
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

  const activeSessionsForThreads = useMemo(
    () => sessions.filter((session) => session.isActive),
    [sessions]
  );

  // Group sessions by project path for Threads sidebar
  const sessionsGroupedByProject = useMemo(() => {
    const groups = new Map();

    // Helper to get project name from path
    const getProjectName = (path) => {
      if (!path) return 'Unknown';
      const parts = path.replace(/\/$/, '').split('/');
      return parts[parts.length - 1] || 'Unknown';
    };

    // Process all sessions (both active and inactive)
    activeSessionsForThreads.forEach((session) => {
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
  }, [activeSessionsForThreads]);

  // Get pinned sessions across all projects
  const pinnedSessions = useMemo(
    () => activeSessionsForThreads.filter((session) => session.thread?.pinned),
    [activeSessionsForThreads]
  );

  // Get archived sessions
  const archivedSessions = useMemo(
    () => activeSessionsForThreads.filter((session) => session.thread?.archived),
    [activeSessionsForThreads]
  );

  // Add a folder to recent list (max 10, no duplicates)
  const addRecentFolder = useCallback((folder) => {
    if (!folder) return;
    setRecentFolders(prev => {
      const filtered = prev.filter(f => f.toLowerCase() !== folder.toLowerCase());
      const updated = [folder, ...filtered].slice(0, 10);
      try {
        localStorage.setItem('recentFolders', JSON.stringify(updated));
      } catch (e) {
        console.error('Failed to save recent folders', e);
      }
      return updated;
    });
  }, []);

  // Pin a folder (max 20)
  const pinFolder = useCallback((folder) => {
    if (!folder) return;
    setPinnedFolders(prev => {
      if (prev.some(f => f.toLowerCase() === folder.toLowerCase())) {
        return prev;
      }
      const updated = [...prev, folder].slice(0, 20);
      try {
        localStorage.setItem('pinnedFolders', JSON.stringify(updated));
      } catch (e) {
        console.error('Failed to save pinned folders', e);
      }
      return updated;
    });
  }, []);

  // Unpin a folder
  const unpinFolder = useCallback((folder) => {
    setPinnedFolders(prev => {
      const updated = prev.filter(f => f.toLowerCase() !== folder.toLowerCase());
      try {
        localStorage.setItem('pinnedFolders', JSON.stringify(updated));
      } catch (e) {
        console.error('Failed to save pinned folders', e);
      }
      return updated;
    });
  }, []);

  // Load sessions
  const loadSessions = useCallback(async () => {
    if (!isMountedRef.current) return;
    setLoadingSessions(true);
    setSessionLoadError(null);
    try {
      const response = await apiFetch('/api/terminal');
      if (!response.ok) {
        throw new Error(`Failed to load sessions (${response.status})`);
      }
      const data = await response.json();
      if (isMountedRef.current) {
        setSessions(Array.isArray(data.sessions) ? data.sessions : []);
      }
    } catch (error) {
      console.error('Failed to load sessions', error);
      if (isMountedRef.current) {
        setSessionLoadError(error.message || 'Failed to load terminals');
      }
    } finally {
      if (isMountedRef.current) {
        setLoadingSessions(false);
      }
    }
  }, []);

  // Load bookmarks
  const loadBookmarks = useCallback(async () => {
    if (!isMountedRef.current) return;
    try {
      const response = await apiFetch('/api/bookmarks');
      if (!response.ok) {
        throw new Error(`Failed to load bookmarks (${response.status})`);
      }
      const data = await response.json();
      if (isMountedRef.current) {
        setBookmarks(Array.isArray(data.bookmarks) ? data.bookmarks : []);
      }
    } catch (error) {
      console.error('Failed to load bookmarks', error);
    }
  }, []);

  // Load notes
  const loadNotes = useCallback(async () => {
    if (!isMountedRef.current) return;
    try {
      const response = await apiFetch('/api/notes');
      if (!response.ok) {
        throw new Error(`Failed to load notes (${response.status})`);
      }
      const data = await response.json();
      if (isMountedRef.current) {
        setNotes(Array.isArray(data.notes) ? data.notes : []);
      }
    } catch (error) {
      console.error('Failed to load notes', error);
    }
  }, []);

  // Load projects
  const loadProjects = useCallback(async () => {
    setProjectsLoading(true);
    try {
      const response = await apiFetch('/api/projects/scan');
      if (response.ok) {
        const data = await response.json();
        setProjects(data.projects || []);
      }
    } catch (error) {
      console.error('Failed to load projects', error);
    } finally {
      setProjectsLoading(false);
    }
  }, []);

  // Add scan folder
  const handleAddScanFolder = useCallback(async () => {
    const folderPath = prompt('Enter folder path to scan for git repositories:');
    if (!folderPath || !folderPath.trim()) return;

    setProjectsLoading(true);
    try {
      const response = await apiFetch('/api/projects/scan-dirs', {
        method: 'POST',
        body: { path: folderPath.trim() }
      });
      if (response.ok) {
        const data = await response.json();
        if (data.projects) {
          setProjects(data.projects);
        }
      }
    } catch (error) {
      console.error('Failed to add scan folder', error);
    } finally {
      setProjectsLoading(false);
    }
  }, []);

  // Consolidated state fetcher
  const fetchAppState = useCallback(async () => {
    if (!isMountedRef.current) return;

    try {
      const url = activeSessionId
        ? `/api/state?sessionId=${activeSessionId}`
        : '/api/state';

      const response = await apiFetch(url);
      if (!response.ok) {
        throw new Error(`Failed to fetch app state (${response.status})`);
      }

      const data = await response.json();

      if (data.sessions && isMountedRef.current) {
        setSessions(Array.isArray(data.sessions) ? data.sessions : []);
      }

      if (data.projectInfo && isMountedRef.current) {
        setProjectInfo(data.projectInfo);
        if (data.projectInfo.cwd && data.projectInfo.cwd !== lastCwdRef.current) {
          lastCwdRef.current = data.projectInfo.cwd;
          addRecentFolder(data.projectInfo.cwd);
        }
      } else if (!activeSessionId && isMountedRef.current) {
        setProjectInfo(null);
        lastCwdRef.current = null;
      }
    } catch (error) {
      console.error('Failed to fetch app state:', error);
    }
  }, [activeSessionId, addRecentFolder]);

  // Session CRUD operations
  const createSession = useCallback(async (options = {}) => {
    try {
      const requestBody = {};
      if (options.cwd) {
        requestBody.cwd = options.cwd;
      } else if (recentFolders.length > 0) {
        requestBody.cwd = recentFolders[0];
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
      await loadSessions();
      throw error;
    }
  }, [loadSessions]);

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
      await apiFetch(`/api/terminal/${sessionId}`, {
        method: 'DELETE'
      });

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

  // Bookmark handlers
  const addBookmark = useCallback(async (name, command, category) => {
    try {
      const response = await apiFetch('/api/bookmarks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, command, category })
      });

      if (!response.ok) {
        throw new Error(`Failed to create bookmark (${response.status})`);
      }

      await loadBookmarks();
    } catch (error) {
      console.error('Failed to create bookmark', error);
    }
  }, [loadBookmarks]);

  const updateBookmark = useCallback(async (id, updates) => {
    try {
      const response = await apiFetch(`/api/bookmarks/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updates)
      });

      if (!response.ok) {
        throw new Error(`Failed to update bookmark (${response.status})`);
      }

      await loadBookmarks();
    } catch (error) {
      console.error('Failed to update bookmark', error);
    }
  }, [loadBookmarks]);

  const deleteBookmark = useCallback(async (id) => {
    try {
      const response = await apiFetch(`/api/bookmarks/${id}`, {
        method: 'DELETE'
      });

      if (!response.ok) {
        throw new Error(`Failed to delete bookmark (${response.status})`);
      }

      await loadBookmarks();
    } catch (error) {
      console.error('Failed to delete bookmark', error);
    }
  }, [loadBookmarks]);

  const executeBookmark = useCallback(async (command) => {
    if (!activeSessionId) {
      alert('Please select a terminal session first');
      return;
    }

    try {
      await apiFetch(`/api/terminal/${activeSessionId}/input`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command: command + '\r' })
      });
    } catch (error) {
      console.error('Failed to execute bookmark command', error);
      alert('Failed to execute command');
    }
  }, [activeSessionId]);

  // Note handlers
  const addNote = useCallback(async (title, content, category) => {
    try {
      const response = await apiFetch('/api/notes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title, content, category })
      });

      if (!response.ok) {
        throw new Error(`Failed to create note (${response.status})`);
      }

      await loadNotes();
    } catch (error) {
      console.error('Failed to create note', error);
    }
  }, [loadNotes]);

  const updateNote = useCallback(async (id, updates) => {
    try {
      const response = await apiFetch(`/api/notes/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updates)
      });

      if (!response.ok) {
        throw new Error(`Failed to update note (${response.status})`);
      }

      await loadNotes();
    } catch (error) {
      console.error('Failed to update note', error);
    }
  }, [loadNotes]);

  const deleteNote = useCallback(async (id) => {
    try {
      const response = await apiFetch(`/api/notes/${id}`, {
        method: 'DELETE'
      });

      if (!response.ok) {
        throw new Error(`Failed to delete note (${response.status})`);
      }

      await loadNotes();
    } catch (error) {
      console.error('Failed to delete note', error);
    }
  }, [loadNotes]);

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
      await loadSessions();
      await loadBookmarks();
      await loadNotes();

      const lastSessionId = localStorage.getItem('lastActiveSession');
      if (lastSessionId) {
        try {
          const response = await apiFetch('/api/terminal');
          if (response.ok) {
            const data = await response.json();
            const sessionList = Array.isArray(data.sessions) ? data.sessions : [];
            const lastSession = sessionList.find(s => s.id === lastSessionId);

            if (lastSession) {
              if (!lastSession.isActive) {
                const restoreResponse = await apiFetch(`/api/terminal/${lastSessionId}/restore`, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({})
                });
                if (restoreResponse.ok) {
                  await loadSessions();
                }
              }
            } else {
              const activeSession = sessionList.find(s => s.isActive);
              if (activeSession) {
                setActiveSessionId(activeSession.id);
                localStorage.setItem('lastActiveSession', activeSession.id);
              } else {
                localStorage.removeItem('lastActiveSession');
                setActiveSessionId(null);
              }
            }
          }
        } catch (error) {
          console.error('Failed to restore last session', error);
        }
      } else {
        try {
          const response = await apiFetch('/api/terminal');
          if (response.ok) {
            const data = await response.json();
            const sessionList = Array.isArray(data.sessions) ? data.sessions : [];
            const activeSession = sessionList.find(s => s.isActive);
            if (activeSession) {
              setActiveSessionId(activeSession.id);
              localStorage.setItem('lastActiveSession', activeSession.id);
            }
          }
        } catch (error) {
          console.error('Failed to find active session', error);
        }
      }
    };

    initializeSessions();
    loadProjects();

    // Visibility-aware polling
    let pollTimeoutId = null;

    const getPollingInterval = () => {
      if (document.visibilityState === 'hidden') return null;
      const idleTime = Date.now() - lastActivityRef.current;
      const hasLiveTerminalConnection = liveTerminalCountRef.current > 0;
      if (hasLiveTerminalConnection) {
        if (idleTime > 60000) return 60000;
        if (idleTime > 30000) return 30000;
        return 15000;
      }
      if (idleTime > 60000) return 30000;
      if (idleTime > 30000) return 15000;
      return 5000;
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

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        lastActivityRef.current = Date.now();
        fetchAppState();
        schedulePoll();
      } else {
        if (pollTimeoutId) clearTimeout(pollTimeoutId);
      }
    };

    window.addEventListener('mousemove', handleActivity, { passive: true });
    window.addEventListener('keydown', handleActivity, { passive: true });
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      isMountedRef.current = false;
      pollRescheduleRef.current = null;
      if (pollTimeoutId) clearTimeout(pollTimeoutId);
      window.removeEventListener('mousemove', handleActivity);
      window.removeEventListener('keydown', handleActivity);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [loadSessions, loadBookmarks, loadNotes, loadProjects, fetchAppState]);

  // Auto-restore inactive sessions
  useEffect(() => {
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
  }, [activeSessionId, sessions, restoreSession]);

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
    detectSessionProject,
    refreshSessionGitStats,

    // Folder state
    recentFolders,
    pinnedFolders,
    addRecentFolder,
    pinFolder,
    unpinFolder,

    // Projects state
    projects,
    projectsLoading,
    loadProjects,
    handleAddScanFolder,

    // Bookmarks
    bookmarks,
    addBookmark,
    updateBookmark,
    deleteBookmark,
    executeBookmark,

    // Notes
    notes,
    addNote,
    updateNote,
    deleteNote,

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
