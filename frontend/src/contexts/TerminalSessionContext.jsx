import { environmentAllows, requireEnvironmentCapability } from '../utils/runtimePermissions';
import { isCompanionSession } from '../utils/sidebarSessionScope';
import { getEnvironmentStorage, getActiveEnvironment, getEnvironmentSignal, getEnvironmentCacheScope } from '../utils/remoteEnvironments';
import { createContext, useContext, useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { apiFetch } from '../utils/api';
import { resolveHomeApiUrl } from '../utils/apiBase';
import { captureAuthScope, isAuthScopeCurrent } from '../utils/auth';
import { readStrictResponseMetadata, validateStrictResponse } from '../utils/strictAuthenticatedFetch';
import { getComposerDraftStore } from '../utils/composerDraftStore';
import { createUuid } from '../utils/createUuid';
import { sendRawInput } from '../utils/supervisedRawInputController';
import { areEquivalentTerminalStates } from '../utils/terminalStateEquality';
import { terminalNavigationCommand } from '../utils/terminalNavigation';
import {
  buildStructuredSession,
  isStructuredSessionId,
  mergeSessionCollections,
  structuredSessionOrigin,
} from '../utils/structuredSessions';
import { isWindowActive, subscribeWindowActivity } from '../utils/windowActivity';
import { useFolders } from './FolderContext';

const TerminalSessionContext = createContext(null);
const STRUCTURED_SESSION_METADATA_STORAGE_KEY = 'structuredSessionMetadata';
const inFlightRenames = new Map();

function renameRecoveryKey(auth, sessionId) {
  const scope = getEnvironmentCacheScope();
  return `structuredRenameRecovery:v1:${[auth.home, auth.userId || '', scope.identity, scope.environment, sessionId].map(encodeURIComponent).join(':')}`;
}

function readRenameMarker(key) {
  const marker = sessionStorage.getItem(key);
  if (marker !== null && !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(marker)) {
    throw new Error('The saved title recovery record is invalid. Check device storage before renaming.');
  }
  return marker;
}

function clearRenameMarker(key, marker) {
  if (readRenameMarker(key) !== marker) throw new Error('The title recovery record changed. Check the thread before retrying.');
  sessionStorage.removeItem(key);
}

function readStructuredSessionMetadata(storage = getEnvironmentStorage()) {
  try {
    const parsed = JSON.parse(storage.getItem(STRUCTURED_SESSION_METADATA_STORAGE_KEY) || '{}');
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

// Drawer terminals belong to a conversation and are never chosen as the selected thread on their own.
const isFallbackSession = session => session.isActive && !isCompanionSession(session);

export function TerminalSessionProvider(props) {
  return Object.hasOwn(props, 'authLifecycle')
    ? <StrictTerminalSessionProvider {...props} />
    : <LegacyTerminalSessionProvider {...props} />;
}

function StrictTerminalSessionProvider({ children, authLifecycle, strictReady }) {
  const [sessions, setSessions] = useState([]);
  const sessionsRef = useRef(sessions);
  sessionsRef.current = sessions;
  const [activeSessionId, setActiveSessionId] = useState(null);
  const [loadingSessions, setLoadingSessions] = useState(strictReady === true);
  const [sessionLoadError, setSessionLoadError] = useState(null);
  const currentRef = useRef({ authLifecycle, strictReady });
  currentRef.current = { authLifecycle, strictReady };
  const mountedRef = useRef(false);
  const requestRef = useRef({ sequence: 0, controller: null });
  const pinnedScope = useRef(null);
  const environment = useRef({ signal: getEnvironmentSignal(), value: JSON.stringify(getActiveEnvironment()) });

  const loadSessions = useCallback(async () => {
    const lifecycle = currentRef.current.authLifecycle;
    const signal = environment.current.signal;
    const sequence = ++requestRef.current.sequence;
    requestRef.current.controller?.abort();
    const controller = new AbortController();
    requestRef.current.controller = controller;
    const current = () => mountedRef.current && sequence === requestRef.current.sequence
      && !controller.signal.aborted && !signal.aborted && getEnvironmentSignal() === signal
      && JSON.stringify(getActiveEnvironment()) === environment.current.value
      && currentRef.current.authLifecycle === lifecycle && currentRef.current.strictReady === true;
    const same = (a, b) => a.owner === b.owner && a.session === b.session && a.incarnation === b.incarnation && a.home === b.home;
    const readScope = async () => {
      if (!current() || typeof lifecycle?.read !== 'function' || typeof lifecycle?.refresh !== 'function') throw new Error('Authentication is unavailable.');
      const snapshot = await lifecycle.read();
      if (!current()) throw new Error('Authentication is unavailable.');
      const pair = snapshot?.pair;
      let home;
      try { home = new URL(pair?.home).href; } catch { throw new Error('Authentication is unavailable.'); }
      if (snapshot?.status !== 'active' || snapshot.refreshReserved || !snapshot.incarnation
        || !pair?.owner || snapshot.user?.id !== pair.owner || !pair.session || !pair.accessToken
        || home !== new URL(resolveHomeApiUrl('/'), window.location.origin).href) throw new Error('Authentication is unavailable.');
      const scope = { owner: pair.owner, session: pair.session, incarnation: snapshot.incarnation, home };
      if (pinnedScope.current && !same(pinnedScope.current, scope)) throw new Error('Authentication changed. Save any unsent drafts and reopen the workspace.');
      pinnedScope.current ||= scope;
      return { snapshot, scope };
    };
    try {
      if (!current()) throw new Error('Authentication is unavailable.');
      setLoadingSessions(true);
      const initial = await readScope();
      const scopedLifecycle = {
        read: async () => {
          const value = await readScope();
          if (!same(initial.scope, value.scope)) throw new Error('Authentication changed.');
          return value.snapshot;
        },
        refresh: async (scope, options) => {
          if (!same(initial.scope, scope) || !current()) throw new Error('Authentication changed.');
          return lifecycle.refresh(scope, options);
        },
      };
      const options = { authLifecycle: scopedLifecycle, signal: controller.signal, cache: 'no-store' };
      const [terminal, structured] = await Promise.all([
        apiFetch('/api/terminal', options),
        apiFetch('/api/structured/sessions?view=inventory', options),
      ]);
      const [terminalMeta, structuredMeta] = await Promise.all([readStrictResponseMetadata(terminal), readStrictResponseMetadata(structured)]);
      if (!terminalMeta.ok || (!structuredMeta.ok && structuredMeta.status !== 404)) throw new Error('Could not load sessions.');
      if (structuredMeta.status === 404 && sessionsRef.current.some(item => isStructuredSessionId(item.id))) throw new Error('Could not confirm existing conversations.');
      const [terminalData, structuredData] = await Promise.all([
        terminal.json(), structuredMeta.status === 404 ? Promise.resolve([]) : structured.json(),
      ]);
      if (!Array.isArray(terminalData?.sessions) || !Array.isArray(structuredData)) throw new Error('Invalid session inventory.');
      await Promise.all([validateStrictResponse(terminal, { required: true }), validateStrictResponse(structured, { required: true })]);
      const latest = await readScope();
      if (!current() || !same(initial.scope, latest.scope)) throw new Error('Authentication changed.');
      const next = mergeSessionCollections(terminalData.sessions, structuredData, {});
      setSessions(next);
      setActiveSessionId(previous => next.some(item => item.id === previous && !isCompanionSession(item))
        ? previous : next.find(isFallbackSession)?.id || null);
      setSessionLoadError(null);
      return next;
    } catch (error) {
      if (mountedRef.current && sequence === requestRef.current.sequence && !controller.signal.aborted) {
        setSessionLoadError(error.message || 'Authentication is unavailable.');
        setLoadingSessions(false);
      }
      controller.abort();
      return null;
    } finally {
      if (mountedRef.current && sequence === requestRef.current.sequence && !controller.signal.aborted) setLoadingSessions(false);
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; requestRef.current.sequence += 1; requestRef.current.controller?.abort(); };
  }, []);
  useEffect(() => {
    if (strictReady === true) void loadSessions();
    else { setLoadingSessions(false); setSessionLoadError('Authentication is unavailable. Save any unsent drafts.'); }
    return () => { requestRef.current.sequence += 1; requestRef.current.controller?.abort(); };
  }, [authLifecycle, strictReady, loadSessions]);

  const activeSessions = useMemo(() => sessions.filter(item => item.isActive), [sessions]);
  const inactiveSessions = useMemo(() => sessions.filter(item => !item.isActive), [sessions]);
  const pinnedSessions = useMemo(() => sessions.filter(item => item.thread?.pinned && !item.thread?.archived), [sessions]);
  const archivedSessions = useMemo(() => sessions.filter(item => item.thread?.archived), [sessions]);
  const sessionsGroupedByProject = useMemo(() => {
    const groups = new Map();
    for (const session of sessions.filter(item => !item.thread?.archived)) {
      const projectPath = session.thread?.projectPath || session.groupPath || session.cwd || null;
      if (!groups.has(projectPath)) groups.set(projectPath, { projectPath, projectName: projectPath?.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || 'Unknown', sessions: [] });
      groups.get(projectPath).sessions.push(session);
    }
    return [...groups.values()];
  }, [sessions]);
  const selected = sessions.find(item => item.id === activeSessionId);
  const unavailable = useCallback(async () => { throw new Error('This action is unavailable while strict authentication integration is incomplete. Your draft was kept.'); }, []);
  const noop = useCallback(() => {}, []);
  const selectSession = useCallback(id => {
    if (id === null || (currentRef.current.strictReady === true && sessionsRef.current.some(item => item.id === id))) setActiveSessionId(id);
  }, []);
  const value = {
    sessions, activeSessionId, activeSessions, inactiveSessions, loadingSessions, sessionLoadError,
    restoringSessionId: null, projectInfo: selected?.cwd ? { cwd: selected.cwd, projectType: 'unknown' } : null,
    sessionsGroupedByProject, pinnedSessions, archivedSessions,
    createSession: unavailable, createStructuredSession: unavailable, updateStructuredSessionSelection: unavailable,
    updateStructuredSessionAccess: unavailable, selectSession, restoreSession: unavailable,
    renameSession: unavailable, closeSession: unavailable, navigateSession: unavailable, retryLoadSessions: loadSessions,
    registerTerminalSender: noop, unregisterTerminalSender: noop, sendToSession: unavailable, sendRawToSession: unavailable,
    updateThreadMetadata: unavailable, pinSession: unavailable, unpinSession: unavailable, archiveSession: unavailable,
    unarchiveSession: unavailable, updateSessionTopic: unavailable, syncSessionThread: noop,
    generateSessionTopic: unavailable, detectSessionProject: unavailable, refreshSessionGitStats: unavailable,
    listSessionGitBranches: unavailable, checkoutSessionGitBranch: unavailable, trackActivity: noop,
  };
  return <TerminalSessionContext.Provider value={value}>{children}</TerminalSessionContext.Provider>;
}

function LegacyTerminalSessionProvider({ children }) {
  const environmentSignal = useRef(getEnvironmentSignal());
  const storage = useMemo(() => getEnvironmentStorage(), []);
  const [sessions, setSessions] = useState([]);
  const sessionsRef = useRef(sessions);
  sessionsRef.current = sessions;
  const [activeSessionId, setActiveSessionId] = useState(() => {
    try {
      return storage.getItem('lastActiveSession') || null;
    } catch {
      return null;
    }
  });
  const [loadingSessions, setLoadingSessions] = useState(true);
  const [sessionLoadError, setSessionLoadError] = useState(null);
  const [restoringSessionId, setRestoringSessionId] = useState(null);
  const [terminalProjectInfo, setTerminalProjectInfo] = useState(null);
  const [structuredSessionMetadata, setStructuredSessionMetadata] = useState(() => readStructuredSessionMetadata(storage));

  // Get folder state from FolderContext
  const { recentFolders, addRecentFolder } = useFolders();

  // Refs
  const isMountedRef = useRef(true);
  const restoreInFlightRef = useRef(new Set());
  const lastActivityRef = useRef(Date.now());
  const activeSessionIdRef = useRef(activeSessionId);
  const structuredSessionMetadataRef = useRef(structuredSessionMetadata);
  const lastCwdRef = useRef(null);
  const terminalSendersRef = useRef(new Map());
  const liveTerminalCountRef = useRef(0);
  const pollRescheduleRef = useRef(null);
  const projectDetectInFlightRef = useRef(new Set());
  const projectDetectAttemptedRef = useRef(new Set());
  const selectionGenerationRef = useRef(0);
  const inventoryGenerationRef = useRef(0);
  const inventorySeqRef = useRef(0);
  const loadRequestRef = useRef(0);
  const appliedInventorySeqRef = useRef(0);
  const initialSelectionHandledRef = useRef(false);
  const initialSelectionGenerationRef = useRef(selectionGenerationRef.current);

  const captureSelection = useCallback(() => {
    const generation = selectionGenerationRef.current;
    return { isCurrent: () => isMountedRef.current && !environmentSignal.current.aborted && selectionGenerationRef.current === generation };
  }, []);
  const beginSelectionIntent = useCallback(() => {
    selectionGenerationRef.current += 1;
    inventoryGenerationRef.current += 1;
    setTerminalProjectInfo(null);
    return captureSelection();
  }, [captureSelection]);

  const setSelectedSession = useCallback((value) => {
    const next = typeof value === 'function' ? value(activeSessionIdRef.current) : value;
    if (next !== activeSessionIdRef.current) {
      selectionGenerationRef.current += 1;
      inventoryGenerationRef.current += 1;
      setTerminalProjectInfo(null);
    }
    activeSessionIdRef.current = next;
    setActiveSessionId(next);
    return captureSelection();
  }, [captureSelection]);

  const projectInfo = useMemo(() => {
    const selected = sessions.find(session => session.id === activeSessionId);
    if (!selected) return null;
    const base = selected.cwd ? { cwd: selected.cwd, projectType: 'unknown' } : null;
    if (isStructuredSessionId(selected.id)) return base;
    const metadata = terminalProjectInfo?.sessionId === selected.id
      && terminalProjectInfo.selectionGeneration === selectionGenerationRef.current
      ? terminalProjectInfo.info : null;
    if (metadata?.cwd && (!selected.cwd || metadata.cwd === selected.cwd)) {
      return { projectType: 'unknown', ...metadata };
    }
    return base;
  }, [activeSessionId, sessions, terminalProjectInfo]);

  useEffect(() => {
    const cwd = projectInfo?.cwd || null;
    if (cwd && cwd !== lastCwdRef.current) addRecentFolder(cwd);
    lastCwdRef.current = cwd;
  }, [addRecentFolder, projectInfo?.cwd]);

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
    try {
      if (activeSessionId) storage.setItem('lastActiveSession', activeSessionId);
      else storage.removeItem('lastActiveSession');
    } catch { /* Session selection still works without browser storage. */ }
  }, [activeSessionId, storage]);

  useEffect(() => {
    structuredSessionMetadataRef.current = structuredSessionMetadata;
  }, [structuredSessionMetadata]);

  const persistStructuredSessionMetadata = useCallback((nextMetadata) => {
    structuredSessionMetadataRef.current = nextMetadata;
    setStructuredSessionMetadata(nextMetadata);
    try {
      storage.setItem(STRUCTURED_SESSION_METADATA_STORAGE_KEY, JSON.stringify(nextMetadata));
    } catch (error) {
      console.error('Failed to persist structured session metadata', error);
    }
  }, []);

  const patchStructuredSessionMetadata = useCallback((sessionId, patch) => {
    if (!sessionId || !patch || typeof patch !== 'object') {
      return structuredSessionMetadataRef.current[sessionId] || {};
    }

    const currentMetadata = structuredSessionMetadataRef.current;
    const currentSessionMetadata = currentMetadata[sessionId] || {};
    const nextSessionMetadata = {
      ...currentSessionMetadata,
      ...patch,
      thread: patch.thread
        ? { ...(currentSessionMetadata.thread || {}), ...patch.thread }
        : currentSessionMetadata.thread
    };
    const nextMetadata = {
      ...currentMetadata,
      [sessionId]: nextSessionMetadata
    };

    persistStructuredSessionMetadata(nextMetadata);
    return nextSessionMetadata;
  }, [persistStructuredSessionMetadata]);

  const removeStructuredSessionMetadata = useCallback((sessionId) => {
    if (!sessionId || !structuredSessionMetadataRef.current[sessionId]) {
      return;
    }

    const nextMetadata = { ...structuredSessionMetadataRef.current };
    delete nextMetadata[sessionId];
    persistStructuredSessionMetadata(nextMetadata);
  }, [persistStructuredSessionMetadata]);

  const loadStructuredSessionSnapshots = useCallback(async () => {
    const response = await apiFetch('/api/structured/sessions?view=inventory', { cache: 'no-store' });
    if (response.status === 404 && !sessionsRef.current.some(session => isStructuredSessionId(session.id))) {
      return [];
    }
    if (!response.ok) {
      throw new Error(`Failed to load structured sessions (${response.status})`);
    }

    const data = await response.json();
    if (!Array.isArray(data)) throw new Error('Invalid structured session inventory');
    return data;
  }, []);

  const mergeLoadedSessions = useCallback((terminalSessions, structuredSnapshots) => (
    mergeSessionCollections(
      terminalSessions,
      structuredSnapshots,
      structuredSessionMetadataRef.current
    )
  ), []);

  // Load sessions
  const hasLoadedOnceRef = useRef(false);
  const loadSessions = useCallback(async (options = {}) => {
    if (!isMountedRef.current || environmentSignal.current.aborted) return null;
    const auth = captureAuthScope();
    const inventoryGeneration = ++inventoryGenerationRef.current;
    const inventorySeq = ++inventorySeqRef.current;
    const selectionGeneration = selectionGenerationRef.current;
    const isInitialLoad = !hasLoadedOnceRef.current;
    const loadRequest = ++loadRequestRef.current;
    const current = () => isMountedRef.current && !environmentSignal.current.aborted && isAuthScopeCurrent(auth)
      && appliedInventorySeqRef.current <= inventorySeq
      && (isInitialLoad
        ? loadRequestRef.current === loadRequest
        : inventoryGenerationRef.current === inventoryGeneration && selectionGenerationRef.current === selectionGeneration);
    // Only show loading indicator on first load to avoid flashing the terminal
    if (!hasLoadedOnceRef.current) {
      setLoadingSessions(true);
    }
    try {
      const response = await apiFetch('/api/terminal');
      if (!response.ok) {
        throw new Error(`Failed to load sessions (${response.status})`);
      }
      const data = await response.json();
      const nextTerminalSessions = Array.isArray(data.sessions) ? data.sessions : [];
      const structuredSnapshots = await loadStructuredSessionSnapshots();
      let authoritativeTitle;
      if (options?.requireStructuredTitleFor) {
        const matches = structuredSnapshots.filter(snapshot => snapshot?.id === options.requireStructuredTitleFor);
        if (matches.length !== 1 || typeof matches[0].title !== 'string' || !matches[0].title.trim()) {
          throw new Error('The current thread title could not be confirmed.');
        }
        authoritativeTitle = matches[0].title;
      }
      const nextSessions = mergeLoadedSessions(nextTerminalSessions, structuredSnapshots);
      if (!current()) return null;
      appliedInventorySeqRef.current = inventorySeq;
      if (isMountedRef.current) {
        setSessions((prevSessions) => (
          areEquivalentTerminalStates(prevSessions, nextSessions)
            ? prevSessions
            : nextSessions
        ));
      }
      hasLoadedOnceRef.current = true;
      setSessionLoadError(null);
      return options?.requireStructuredTitleFor ? { authoritativeTitle } : nextSessions;
    } catch (error) {
      console.error('Failed to load sessions', error);
      if (current()) {
        setSessionLoadError(error.message || 'Failed to load terminals');
      }
      return null;
    } finally {
      if (current()) {
        setLoadingSessions(false);
      }
    }
  }, [loadStructuredSessionSnapshots, mergeLoadedSessions]);

  // Consolidated state fetcher. Refreshes do not invalidate one another when
  // they start: a response applies unless an explicit invalidation happened or
  // a later-started request already applied, so slow overlapping polls still land.
  const fetchAppState = useCallback(async () => {
    if (!isMountedRef.current || environmentSignal.current.aborted) return;
    const auth = captureAuthScope();
    const inventoryGeneration = inventoryGenerationRef.current;
    const inventorySeq = ++inventorySeqRef.current;
    const selectionGeneration = selectionGenerationRef.current;
    const current = () => isMountedRef.current && !environmentSignal.current.aborted
      && isAuthScopeCurrent(auth)
      && inventoryGenerationRef.current === inventoryGeneration
      && appliedInventorySeqRef.current <= inventorySeq
      && selectionGenerationRef.current === selectionGeneration;

    try {
      const selectedSessionId = activeSessionIdRef.current;
      const url = selectedSessionId
        && !isStructuredSessionId(selectedSessionId)
        ? `/api/state?sessionId=${selectedSessionId}`
        : '/api/state';

      const [response, structuredSnapshots] = await Promise.all([
        apiFetch(url),
        loadStructuredSessionSnapshots()
      ]);
      if (!response.ok) {
        throw new Error(`Failed to fetch app state (${response.status})`);
      }

      const data = await response.json();
      if (!current()) return;
      appliedInventorySeqRef.current = inventorySeq;

      if (data.sessions && isMountedRef.current) {
        const nextSessions = mergeLoadedSessions(
          Array.isArray(data.sessions) ? data.sessions : [],
          structuredSnapshots
        );
        setSessions((prevSessions) => (
          areEquivalentTerminalStates(prevSessions, nextSessions)
            ? prevSessions
            : nextSessions
        ));
        hasLoadedOnceRef.current = true;
        setSessionLoadError(null);
        setLoadingSessions(false);
      }

      setTerminalProjectInfo(selectedSessionId && !isStructuredSessionId(selectedSessionId)
        ? { sessionId: selectedSessionId, selectionGeneration, info: data.projectInfo || null }
        : null);
    } catch (error) {
      console.error('Failed to fetch app state:', error);
      if (current()) {
        setSessionLoadError(error.message || 'Failed to load terminals');
        setLoadingSessions(false);
      }
    }
  }, [loadStructuredSessionSnapshots, mergeLoadedSessions]);

  // Session CRUD operations
  const createSession = useCallback(async (options = {}) => {
    if (environmentSignal.current.aborted) throw new Error('The active environment changed. Open the workspace again.');
    requireEnvironmentCapability('terminalInput', 'terminal input');
    const selection = beginSelectionIntent();
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
      if (options.requestId) {
        requestBody.requestId = options.requestId;
      }
      if (options.companionOf) {
        requestBody.companionOf = options.companionOf;
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
      if (environmentSignal.current.aborted || !isMountedRef.current) return data.session;
      if (options.select !== false && selection.isCurrent()) setSelectedSession(data.session.id);
      await loadSessions();
      return data.session;
    } catch (error) {
      console.error('Failed to create session', error);
      throw error;
    }
  }, [beginSelectionIntent, loadSessions, recentFolders, setSelectedSession]);

  const createStructuredSession = useCallback(async (options = {}) => {
    if (environmentSignal.current.aborted) throw new Error('The active environment changed. Open the workspace again.');
    requireEnvironmentCapability('agentExecute', 'agent execution');
    const selection = beginSelectionIntent();
    try {
      const cwd = options.cwd || recentFolders[0];
      if (!cwd) {
        throw new Error('Structured sessions require a working directory');
      }

      const requestBody = {
        cwd,
        provider: options.provider,
        ...(options.model ? { model: options.model } : {}),
        ...(options.reasoning ? { reasoning: options.reasoning } : {}),
        ...(options.serviceTier !== undefined ? { serviceTier: options.serviceTier } : {}),
        ...(options.title ? { title: options.title } : {}),
        ...(options.startRequestId ? { requestId: options.startRequestId } : {})
      };
      const response = await apiFetch(options.startRequestId ? '/api/structured/start-requests' : '/api/structured/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody)
      });

      if (!response.ok) {
        if (options.startRequestId && response.status === 404) throw new Error('This server does not support recoverable image starts. Your draft was kept.');
        throw new Error(`Failed to create structured session (${response.status})`);
      }

      let snapshot = await response.json();
      if (options.startRequestId) {
        const selection = snapshot?.selection;
        if (snapshot?.requestId !== options.startRequestId || !selection || typeof selection.cwd !== 'string'
          || typeof selection.provider !== 'string') throw new Error('Conversation request identity could not be confirmed.');
        if (response.status === 202 || snapshot?.status === 'pending') throw new Error('Conversation creation is still unconfirmed. Your original request is held.');
        if (snapshot?.status !== 'created' || typeof snapshot.sessionId !== 'string' || !isStructuredSessionId(snapshot.sessionId)) throw new Error('Conversation creation could not be confirmed.');
        const id = snapshot.sessionId;
        const read = await apiFetch(`/api/structured/sessions/${encodeURIComponent(id)}`, { signal: environmentSignal.current });
        if (!read.ok) throw new Error('The created conversation is unavailable. Your request is held for review.');
        snapshot = await read.json();
        if (snapshot?.id !== id || snapshot.cwd !== selection.cwd || snapshot.provider !== selection.provider
          || (snapshot.model ?? null) !== (selection.model ?? null)) {
          throw new Error('The created conversation did not match the saved request.');
        }
      }
      const session = buildStructuredSession(
        snapshot,
        structuredSessionMetadataRef.current[snapshot.id]
      );
      if (environmentSignal.current.aborted || !isMountedRef.current) return session;
      // Callers that transfer a draft must finish before selecting the session;
      // mounting the composer first can promote the empty draft into its image store.
      await options.prepareSession?.(session);
      if (environmentSignal.current.aborted || !isMountedRef.current) return session;
      sessionsRef.current = [session, ...sessionsRef.current.filter(item => item.id !== session.id)];
      setSessions(previous => [session, ...previous.filter(item => item.id !== session.id)]);
      if (selection.isCurrent() && (options.shouldSelectSession?.() ?? true)) {
        setSelectedSession(session.id);
        options.onSelected?.(session);
      }
      await loadSessions();
      return session;
    } catch (error) {
      console.error('Failed to create structured session', error);
      throw error;
    }
  }, [beginSelectionIntent, loadSessions, recentFolders, setSelectedSession]);

  const refreshStructuredLifecycle = useCallback(async sessionId => {
    const auth = captureAuthScope();
    const signal = getEnvironmentSignal();
    const generation = ++inventoryGenerationRef.current;
    const currentScope = () => isMountedRef.current && !signal.aborted && isAuthScopeCurrent(auth) && generation === inventoryGenerationRef.current;
    try {
      const response = await apiFetch('/api/structured/sessions?view=inventory', { signal, cache: 'no-store' });
      if (!response.ok) throw new Error('Thread inventory unavailable');
      const inventory = await response.json();
      if (!currentScope()) return;
      const snapshot = Array.isArray(inventory) ? inventory.find(row => row.id === sessionId) : null;
      const refreshed = snapshot ? buildStructuredSession(snapshot, structuredSessionMetadataRef.current[sessionId]) : null;
      if (!refreshed?.threadLifecycle) throw new Error('Thread lifecycle unavailable');
      setSessions(current => current.map(session => {
        if (session.id !== sessionId || !session[structuredSessionOrigin] || signal.aborted || !isAuthScopeCurrent(auth)) return session;
        if (Number.isSafeInteger(session.statusSeq) && Number.isSafeInteger(refreshed.statusSeq)
          && session.statusSeq > refreshed.statusSeq) return session;
        if (session.statusSeq === refreshed.statusSeq
          && (Date.parse(session.updatedAt || '') || 0) > (Date.parse(refreshed.updatedAt || '') || 0)) return session;
        return { ...session, threadLifecycle: refreshed.threadLifecycle };
      }));
    } catch {
      if (currentScope()) setSessions(current => current.map(session => session.id === sessionId && session[structuredSessionOrigin] ? { ...session, threadLifecycle: undefined } : session));
    }
  }, []);

  const applyStructuredSnapshot = useCallback((sessionId, payload) => {
    if (payload?.id !== sessionId) throw new Error('The server returned an unexpected conversation update.');
    inventoryGenerationRef.current += 1;
    const updatedSession = buildStructuredSession(payload, structuredSessionMetadataRef.current[sessionId]);
    const replace = list => list.map(session => (session.id === sessionId && session[structuredSessionOrigin] ? updatedSession : session));
    sessionsRef.current = replace(sessionsRef.current);
    setSessions(replace);
    if (updatedSession.runtime === 'v4') void refreshStructuredLifecycle(sessionId);
    return updatedSession;
  }, [refreshStructuredLifecycle]);

  // Omitting serviceTier keeps the conversation's saved speed.
  const updateStructuredSessionSelection = useCallback(async (sessionId, { model, reasoning, serviceTier }) => {
    if (!isStructuredSessionId(sessionId)) throw new Error('Only agent conversations support model changes');
    requireEnvironmentCapability('agentExecute', 'agent execution');
    const response = await apiFetch(`/api/structured/sessions/${sessionId}/selection`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, reasoning: reasoning || null, ...(serviceTier !== undefined ? { serviceTier } : {}) })
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      const message = response.status === 409
        ? 'This conversation is busy. Wait for the current response to finish, then change the model.'
        : payload?.error || `Failed to change model (${response.status})`;
      throw Object.assign(new Error(message), { status: response.status });
    }
    return applyStructuredSnapshot(sessionId, payload);
  }, [applyStructuredSnapshot]);

  const updateStructuredSessionAccess = useCallback(async (sessionId, mode) => {
    if (!isStructuredSessionId(sessionId)) throw new Error('Only agent conversations have access modes');
    requireEnvironmentCapability('agentExecute', 'agent execution');
    const response = await apiFetch(`/api/structured/sessions/${sessionId}/access`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode })
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      const message = response.status === 409
        ? 'This conversation is busy. Wait for the current response to finish, then change access.'
        : payload?.error || `Failed to change access (${response.status})`;
      throw Object.assign(new Error(message), { status: response.status });
    }
    return applyStructuredSnapshot(sessionId, payload);
  }, [applyStructuredSnapshot]);

  const selectSession = useCallback((sessionId) => {
    beginSelectionIntent();
    const selection = setSelectedSession(sessionId);
    try {
      storage.setItem('lastActiveSession', sessionId);
    } catch (error) {
      console.error('Failed to save last active session', error);
    }
    return selection;
  }, [beginSelectionIntent, setSelectedSession]);

  const restoreSession = useCallback(async (sessionId, options = {}) => {
    let selection = options.automatic ? captureSelection() : beginSelectionIntent();
    if (isStructuredSessionId(sessionId)) {
      if (options.select !== false) selection = setSelectedSession(sessionId);
      return { restored: true, ...selection };
    }
    try {
      const response = await apiFetch(`/api/terminal/${sessionId}/restore`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({})
      });
      if (!response.ok) throw new Error(`Failed to restore session (${response.status})`);
      if (!selection.isCurrent()) return { restored: true, ...selection };
      if (options.select !== false) selection = setSelectedSession(sessionId);
      await loadSessions();
      return { restored: true, ...selection };
    } catch (error) {
      if (!selection.isCurrent()) return { restored: false, ...selection };
      console.error('Failed to restore session', error);
      await loadSessions();
      throw error;
    }
  }, [beginSelectionIntent, captureSelection, loadSessions, setSelectedSession]);

  const renameSession = useCallback(async (sessionId, title) => {
    const trimmed = title.trim();
    if (!trimmed) return;
    const characters = Array.from(trimmed);
    if (characters.length > 60) return { ok: false, error: new Error('Use 60 characters or fewer.') };
    if (characters.some(character => {
      const value = character.codePointAt(0);
      return value >= 0xd800 && value <= 0xdfff;
    })) return { ok: false, error: new Error('Enter a title with valid Unicode characters.') };
    const auth = captureAuthScope();
    const signal = environmentSignal.current;
    const scopeCurrent = () => isMountedRef.current && !signal.aborted
      && getEnvironmentSignal() === signal && isAuthScopeCurrent(auth);
    const scopeChanged = () => ({ ok: false, error: new Error('The account or environment changed. Check the original thread before trying again.') });
    if (!scopeCurrent()) return scopeChanged();
    const structured = isStructuredSessionId(sessionId);
    if (structured && new TextEncoder().encode(trimmed).length > 80) {
      return { ok: false, error: new Error('Use a shorter title: the limit is 80 UTF-8 bytes, and emoji can use multiple bytes.') };
    }
    const recoveryKey = structured ? renameRecoveryKey(auth, sessionId) : null;
    if (structured) {
      let marker;
      try { marker = readRenameMarker(recoveryKey); }
      catch { return { ok: false, error: new Error('Title recovery storage is unavailable or invalid. Check device storage before renaming.') }; }
      if (marker) {
        if (inFlightRenames.has(recoveryKey)) return { ok: false, error: new Error('A title change is still in progress. Wait for it to finish.') };
        const refreshed = await loadSessions({ requireStructuredTitleFor: sessionId });
        if (!scopeCurrent()) return scopeChanged();
        if (!refreshed) return { ok: false, error: new Error('The title may have been saved. Reload the thread before retrying.') };
        try { clearRenameMarker(recoveryKey, marker); }
        catch { return { ok: false, error: new Error('Title recovery storage is unavailable or changed. Check device storage before renaming.') }; }
        return { ok: false, error: new Error(`A previous title change may still finish. Current title: “${refreshed.authoritativeTitle}”. Review it before saving again.`) };
      }
    }
    const matchingSessions = sessions.filter((session) => session.id === sessionId);
    if (matchingSessions.length === 1 && matchingSessions[0].title === trimmed) return;

    if (structured) {
      const uncertainError = () => new Error('The title may have been saved. Reload the thread before retrying.');
      let marker;
      try {
        marker = createUuid();
        sessionStorage.setItem(recoveryKey, marker);
        if (readRenameMarker(recoveryKey) !== marker) throw new Error('Title recovery record changed');
        inFlightRenames.set(recoveryKey, marker);
      } catch {
        return { ok: false, error: new Error('Title recovery storage is unavailable. Check device storage before renaming.') };
      }
      try {
        const response = await apiFetch(`/api/structured/sessions/${sessionId}`, {
          method: 'PATCH',
          signal,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ title: trimmed })
        });

        if (!scopeCurrent()) return scopeChanged();

        if (!response.ok) {
          return { ok: false, error: new Error(`Failed to rename structured session (${response.status}). ${uncertainError().message}`) };
        }

        const snapshot = await response.json();
        if (!scopeCurrent()) return scopeChanged();
        if (!snapshot || typeof snapshot !== 'object' || snapshot.id !== sessionId || snapshot.title !== trimmed) throw uncertainError();
        const updatedSession = buildStructuredSession(
          snapshot,
          structuredSessionMetadataRef.current[sessionId]
        );
        clearRenameMarker(recoveryKey, marker);

        patchStructuredSessionMetadata(sessionId, {
          title: updatedSession.title,
          thread: updatedSession.thread
        });
        setSessions((currentSessions) => currentSessions.map((session) => {
          if (!scopeCurrent()) return session;
          if (session.id !== sessionId) return session;
          if (!session[structuredSessionOrigin]) return session;
          if ((Date.parse(session.updatedAt || '') || 0) > (Date.parse(updatedSession.updatedAt || '') || 0)) return session;
          return { ...session, title: updatedSession.title, updatedAt: updatedSession.updatedAt, thread: updatedSession.thread };
        }));
        if (updatedSession.runtime === 'v4') void refreshStructuredLifecycle(sessionId);
      } catch (error) {
        if (!scopeCurrent()) return scopeChanged();
        error = uncertainError();
        console.error('Failed to rename session', error);
        return { ok: false, error };
      } finally {
        if (inFlightRenames.get(recoveryKey) === marker) inFlightRenames.delete(recoveryKey);
      }
      return;
    }

    try {
      const response = await apiFetch(`/api/terminal/${sessionId}`, {
        method: 'PATCH',
        signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: trimmed })
      });

      if (!scopeCurrent()) return scopeChanged();

      if (!response.ok) {
        throw new Error(`Failed to rename session (${response.status})`);
      }

      const data = await response.json();
      if (!scopeCurrent()) return scopeChanged();
      const updated = data.session;
      setSessions((currentSessions) =>
        currentSessions.map((session) =>
          scopeCurrent() && session.id === sessionId ? { ...session, title: updated.title, updatedAt: updated.updatedAt } : session
        )
      );
    } catch (error) {
      if (!scopeCurrent()) return scopeChanged();
      console.error('Failed to rename session', error);
      return { ok: false, error };
    }
  }, [loadSessions, patchStructuredSessionMetadata, refreshStructuredLifecycle, sessions]);

  const closeSession = useCallback(async (sessionId) => {
    const auth = captureAuthScope();
    const signal = environmentSignal.current;
    const scopeCurrent = () => isMountedRef.current && !signal.aborted
      && getEnvironmentSignal() === signal && isAuthScopeCurrent(auth);
    const scopeChanged = () => ({ ok: false, error: new Error('The account or environment changed. Check the original terminal before trying again.') });
    if (!scopeCurrent()) return scopeChanged();
    if (isStructuredSessionId(sessionId)) {
      try {
        const response = await apiFetch(`/api/structured/sessions/${sessionId}`, {
          method: 'DELETE', signal
        });
        if (!scopeCurrent()) return scopeChanged();
        if (!response.ok) {
          throw new Error(`Failed to close structured session (${response.status})`);
        }

        removeStructuredSessionMetadata(sessionId);
        setSessions((currentSessions) => {
          if (!scopeCurrent()) return currentSessions;
          const remainingSessions = currentSessions.filter((session) => session.id !== sessionId);
          setSelectedSession((currentActiveId) => {
            if (!scopeCurrent()) return currentActiveId;
            if (sessionId === currentActiveId) {
              const nextActive = remainingSessions.find(isFallbackSession);
              return nextActive ? nextActive.id : null;
            }
            return currentActiveId;
          });
          return remainingSessions;
        });
      } catch (error) {
        if (!scopeCurrent()) return scopeChanged();
        console.error('Failed to close structured session', error);
        await loadSessions();
        if (!scopeCurrent()) return scopeChanged();
        return { ok: false, error };
      }
      return;
    }

    try {
      const response = await apiFetch(`/api/terminal/${sessionId}`, {
        method: 'DELETE', signal
      });
      if (!scopeCurrent()) return scopeChanged();
      if (!response.ok) {
        throw new Error(`Failed to close session (${response.status})`);
      }

      setSessions((currentSessions) => {
        if (!scopeCurrent()) return currentSessions;
        const remainingSessions = currentSessions.filter((s) => s.id !== sessionId);
        setSelectedSession((currentActiveId) => {
          if (!scopeCurrent()) return currentActiveId;
          if (sessionId === currentActiveId) {
            const nextActive = remainingSessions.find(isFallbackSession);
            return nextActive ? nextActive.id : null;
          }
          return currentActiveId;
        });
        return remainingSessions;
      });

      await loadSessions();
      if (!scopeCurrent()) return scopeChanged();
    } catch (error) {
      if (!scopeCurrent()) return scopeChanged();
      console.error('Failed to close session', error);
      await loadSessions();
      if (!scopeCurrent()) return scopeChanged();
      return { ok: false, error };
    }
  }, [loadSessions, removeStructuredSessionMetadata]);

  // Navigate session to path
  const navigateSession = useCallback(async (sessionId, path) => {
    if (!sessionId || !path) return;
    if (isStructuredSessionId(sessionId)) {
      throw new Error('This conversation has a fixed workspace. Create a new conversation in the selected folder.');
    }

    if (environmentSignal.current.aborted) throw new Error('The active environment changed.');
    requireEnvironmentCapability('terminalInput', 'terminal input');
    const session = sessionsRef.current.find(item => item.id === sessionId);
    const cdCommand = terminalNavigationCommand(path, session?.shell);
    const response = await apiFetch(`/api/terminal/${sessionId}/input`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ command: cdCommand })
    });
    if (!response.ok) throw new Error(`Failed to navigate session (${response.status})`);
    if (environmentSignal.current.aborted) return;
    addRecentFolder(path);
  }, [addRecentFolder]);

  // Track activity for polling
  const trackActivity = useCallback(() => {
    lastActivityRef.current = Date.now();
  }, []);

  // Thread metadata actions
  const updateThreadMetadata = useCallback(async (sessionId, updates) => {
    if (!sessionId) return;
    const auth = captureAuthScope();
    const signal = getEnvironmentSignal();
    const assertScope = () => {
      if (!isMountedRef.current || environmentSignal.current.aborted || signal.aborted
        || !isAuthScopeCurrent(auth) || captureAuthScope().userId !== auth.userId) {
        throw new Error('Account or environment changed. Check the original thread before retrying.');
      }
    };
    assertScope();

    if (isStructuredSessionId(sessionId)) {
      try {
        const response = await apiFetch(`/api/structured/sessions/${sessionId}/thread`, {
          method: 'PATCH',
          signal,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(updates)
        });

        if (!response.ok) {
          if (response.status === 409) {
            const detail = await response.json().catch(() => null);
            assertScope();
            if (typeof detail?.error === 'string' && detail.error) throw new Error(detail.error);
          }
          throw new Error(`Failed to update structured thread metadata (${response.status})`);
        }

        const data = await response.json();
        assertScope();
        const nextThread = data.thread;
        const isSnoozeChange = updates.snoozeForSeconds != null || updates.wakeSnooze === true;
        const isSettlementChange = typeof updates.settled === 'boolean';
        if (isSnoozeChange && (data.threadLifecycleVersion !== 1
          || (updates.snoozeForSeconds != null && (!Number.isSafeInteger(nextThread?.snooze?.untilMs) || !Number.isSafeInteger(nextThread?.snooze?.afterSeq)))
          || (updates.wakeSnooze === true && nextThread?.snooze))) {
          throw new Error('The server could not confirm this snooze change. Reload the thread before retrying.');
        }
        if (isSettlementChange && (data.threadSettlementVersion !== 1
          || (updates.settled && (!Number.isSafeInteger(nextThread?.settlement?.afterSeq) || !/^[a-f0-9]{64}$/.test(nextThread?.settlement?.queueFingerprint || '')))
          || (!updates.settled && nextThread?.settlement))) {
          throw new Error('The server could not confirm this settlement change. Reload the thread before retrying.');
        }

        if (isSnoozeChange || isSettlementChange) {
          const change = isSettlementChange ? 'Settlement' : 'Snooze';
          // A request or failure may have arrived after the PATCH was accepted.
          // Refresh its authoritative lifecycle instead of replaying the older response.
          const generation = ++inventoryGenerationRef.current;
          const response = await apiFetch('/api/structured/sessions?view=inventory', { signal, cache: 'no-store' });
          if (!response.ok) throw new Error(`${change} changed, but the current thread state could not be refreshed. Reload before retrying.`);
          const inventory = await response.json();
          assertScope();
          const snapshot = Array.isArray(inventory) ? inventory.find(row => row.id === sessionId) : null;
          const refreshed = snapshot ? buildStructuredSession(snapshot, structuredSessionMetadataRef.current[sessionId]) : null;
          if (!refreshed?.threadLifecycle) throw new Error(`${change} changed, but the current thread state could not be confirmed. Reload before retrying.`);
          if (generation !== inventoryGenerationRef.current) {
            throw new Error(`${change} changed, but a newer refresh replaced this check. Review the thread before retrying.`);
          }
          setSessions(currentSessions => {
            if (signal.aborted || !isAuthScopeCurrent(auth)) return currentSessions;
            return currentSessions.map(session => {
              if (session.id !== sessionId || !session[structuredSessionOrigin]) return session;
              if (Number.isSafeInteger(session.statusSeq) && Number.isSafeInteger(refreshed.statusSeq)
                && session.statusSeq > refreshed.statusSeq) return session;
              const currentUpdated = Date.parse(session.updatedAt || '') || 0;
              const refreshedUpdated = Date.parse(refreshed.updatedAt || '') || 0;
              if (session.statusSeq === refreshed.statusSeq && currentUpdated > refreshedUpdated) return session;
              return { ...session, ...refreshed };
            });
          });
          return nextThread;
        }

        patchStructuredSessionMetadata(sessionId, { thread: nextThread });
        setSessions((currentSessions) =>
          currentSessions.map((session) =>
            session.id === sessionId && session[structuredSessionOrigin]
              ? {
                  ...session,
                  updatedAt: nextThread?.lastActivityAt ?? session.updatedAt,
                  thread: {
                    ...(session.thread || {}),
                    ...(nextThread || {})
                  }
                }
              : session
          )
        );

        return nextThread;
      } catch (error) {
        console.error('Failed to update thread metadata', error);
        throw error;
      }
    }

    try {
      const response = await apiFetch(`/api/terminal/${sessionId}/thread`, {
        method: 'PATCH',
        signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updates)
      });

      if (!response.ok) {
        throw new Error(`Failed to update thread metadata (${response.status})`);
      }

      const data = await response.json();
      assertScope();

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
  }, [patchStructuredSessionMetadata]);

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
    if (isStructuredSessionId(sessionId)) {
      return false;
    }
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

    if (isStructuredSessionId(sessionId)) {
      const currentSession = sessions.find((session) => session.id === sessionId);
      const projectPath = currentSession?.thread?.projectPath || currentSession?.cwd || null;
      if (!projectPath) {
        return null;
      }

      setSessions((currentSessions) =>
        currentSessions.map((session) =>
          session.id === sessionId
            ? {
                ...session,
                thread: {
                  ...(session.thread || {}),
                  projectPath
                }
              }
            : session
        )
      );
      patchStructuredSessionMetadata(sessionId, {
        thread: { projectPath }
      });
      return projectPath;
    }

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
  }, [patchStructuredSessionMetadata, sessions]);

  const refreshSessionGitStats = useCallback(async (sessionId) => {
    if (!sessionId) return null;
    if (isStructuredSessionId(sessionId)) return null;

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
    if (isStructuredSessionId(sessionId)) return null;

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
    if (isStructuredSessionId(sessionId)) return null;

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
    if (!sessionId || data === undefined || data === null || environmentSignal.current.aborted) return;
    if (!environmentAllows(getActiveEnvironment(), isStructuredSessionId(sessionId) ? 'agentExecute' : 'terminalInput')) return false;
    const payload = typeof data === 'string' ? data : String(data);

    if (isStructuredSessionId(sessionId)) {
      if (payload.length === 0) return;

      if (['codex', 'v4'].includes(sessionsRef.current.find(session => session.id === sessionId)?.runtime)) {
        const text = payload.replace(/\r\n/g, '\n').replace(/[\r\n]+$/g, '').trim();
        if (!text) return { accepted: false };
        const signal = environmentSignal.current;
        const authority = captureAuthScope();
        const store = getComposerDraftStore(sessionId);
        const lease = store.claimSend();
        if (!lease) throw new Error('A message is already being sent to Codex. Try again after it is confirmed.');
        try {
          const pending = store.getSnapshot().pending;
          if (pending && pending.text !== text) throw new Error('Confirm the pending Codex message in the conversation before sending different context.');
          const revision = store.getSnapshot().revision;
          const intent = await store.prepareIntent(text);
          const response = await apiFetch(`/api/structured/sessions/${sessionId}/input`, {
            method: 'POST', body: { text, fallbackToMessage: true, requestId: intent.requestId }, signal,
          });
          const receipt = await response.json();
          if (!response.ok) throw new Error(receipt?.error || 'Codex did not accept this context.');
          if (receipt?.requestId !== intent.requestId || !receipt.turnId || !receipt.messageId || !Number.isSafeInteger(receipt.acceptedSeq) || receipt.acceptedSeq <= 0
            || !['accepted', 'running', 'completed', 'interrupted', 'failed', 'cancelled'].includes(receipt.status)) {
            throw new Error('Codex context delivery could not be confirmed. Retry the same context to check its saved request.');
          }
          if (signal.aborted || !isAuthScopeCurrent(authority) || captureAuthScope().userId !== authority.userId) return { accepted: false, stale: true };
          await store.confirmIntent(intent.requestId);
          store.clearIfUnchanged(revision, text);
          return { accepted: true, ...receipt };
        } catch (error) {
          if (!signal.aborted && isAuthScopeCurrent(authority) && !store.getSnapshot().text) store.setText(text);
          throw error;
        } finally {
          store.releaseSend(lease);
        }
      }

      try {
        // Per-turn agents (Claude Code) have no live process between turns; a real message starts one.
        const startsTurn = payload.trim().length > 0;
        const signal = environmentSignal.current;
        const authority = captureAuthScope();
        const response = await apiFetch(`/api/structured/sessions/${sessionId}/input`, {
          method: 'POST',
          body: startsTurn ? { text: payload, fallbackToMessage: true } : { text: payload },
          ...(startsTurn ? { signal } : {}),
        });
        if (!response.ok) throw new Error(`The agent did not accept this task (${response.status}).`);
        if (startsTurn) {
          const receipt = await response.json();
          if (signal.aborted || !isAuthScopeCurrent(authority) || captureAuthScope().userId !== authority.userId || response.status !== 202 || receipt?.status !== 'accepted') {
            throw new Error('The agent message could not be confirmed. Check the conversation before retrying.');
          }
          return { accepted: true };
        }
      } catch (error) {
        console.error('Failed to send structured session input', error);
        throw error;
      }
      return;
    }

    const sender = terminalSendersRef.current.get(sessionId);
    if (sender) {
      return sender(payload);
    }

    try {
      const response = await apiFetch(`/api/terminal/${sessionId}/input`, {
        method: 'POST',
        body: { command: payload }
      });
      if (!response.ok) throw new Error(`Terminal input was not accepted (${response.status}). Your input was kept.`);
      return { accepted: true };
    } catch (error) {
      console.error('Failed to send terminal input', error);
      throw error;
    }
  }, []);

  const loadSessionsRef = useRef(loadSessions);
  const fetchAppStateRef = useRef(fetchAppState);

  useEffect(() => {
    loadSessionsRef.current = loadSessions;
  }, [loadSessions]);

  useEffect(() => {
    fetchAppStateRef.current = fetchAppState;
  }, [fetchAppState]);

  useEffect(() => {
    if (loadingSessions || !hasLoadedOnceRef.current || initialSelectionHandledRef.current) return;
    initialSelectionHandledRef.current = true;
    if (selectionGenerationRef.current !== initialSelectionGenerationRef.current) return;

    try {
      const lastSessionId = storage.getItem('lastActiveSession');
      const lastSession = sessions.find((session) => session.id === lastSessionId && !isCompanionSession(session));
      const selected = lastSession || sessions.find(isFallbackSession);
      if (selected) {
        setSelectedSession(selected.id);
        storage.setItem('lastActiveSession', selected.id);
      } else if (lastSessionId) {
        storage.removeItem('lastActiveSession');
        setSelectedSession(null);
      }
    } catch (error) {
      console.error('Failed to restore last session', error);
    }
  }, [loadingSessions, sessions, setSelectedSession, storage]);

  // Initial load and polling setup
  useEffect(() => {
    isMountedRef.current = true;
    loadSessionsRef.current();

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
          fetchAppStateRef.current();
          schedulePoll();
        }, interval);
      }
    };

    pollRescheduleRef.current = schedulePoll;
    schedulePoll();

    const handleActivity = () => {
      const now = Date.now();
      const wasIdle = now - lastActivityRef.current > 30000;
      lastActivityRef.current = now;
      if (wasIdle && isWindowActive()) {
        fetchAppStateRef.current();
        schedulePoll();
      }
    };

    const handleWindowActivityChange = (windowIsActive) => {
      if (windowIsActive) {
        lastActivityRef.current = Date.now();
        fetchAppStateRef.current();
        schedulePoll();
      } else {
        if (pollTimeoutId) clearTimeout(pollTimeoutId);
      }
    };

    window.addEventListener('mousemove', handleActivity, { passive: true });
    window.addEventListener('keydown', handleActivity, { passive: true });
    window.addEventListener('pointerdown', handleActivity, { passive: true });
    window.addEventListener('touchstart', handleActivity, { passive: true });
    window.addEventListener('wheel', handleActivity, { passive: true });
    const unsubscribeWindowActivity = subscribeWindowActivity(handleWindowActivityChange);

    return () => {
      isMountedRef.current = false;
      pollRescheduleRef.current = null;
      if (pollTimeoutId) clearTimeout(pollTimeoutId);
      window.removeEventListener('mousemove', handleActivity);
      window.removeEventListener('keydown', handleActivity);
      window.removeEventListener('pointerdown', handleActivity);
      window.removeEventListener('touchstart', handleActivity);
      window.removeEventListener('wheel', handleActivity);
      unsubscribeWindowActivity();
    };
  }, []);

  // Auto-restore inactive sessions
  useEffect(() => {
    if (loadingSessions) return;
    if (!activeSessionId || activeSessionIdRef.current !== activeSessionId) return;
    const activeSnapshot = sessions.find((session) => session.id === activeSessionId);
    if (!activeSnapshot || activeSnapshot.isActive) return;
    if (restoreInFlightRef.current.has(activeSessionId)) return;

    restoreInFlightRef.current.add(activeSessionId);
    setRestoringSessionId(activeSessionId);
    const retryTimeout = setTimeout(() => {
      restoreInFlightRef.current.delete(activeSessionId);
    }, 10000);

    const selection = captureSelection();
    restoreSession(activeSessionId, { automatic: true })
      .catch((error) => {
        if (!selection.isCurrent()) return;
        console.error('Session restore failed, clearing selection:', error);
        setSelectedSession(null);
      })
      .finally(() => {
        clearTimeout(retryTimeout);
        restoreInFlightRef.current.delete(activeSessionId);
      });
  }, [activeSessionId, loadingSessions, sessions, restoreSession, captureSelection]);

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

  const sendRawToSession = useCallback(async (sessionId, data, options) => {
    if (!isStructuredSessionId(sessionId)) return sendToSession(sessionId, data);
    if (!sessionId || typeof data !== 'string' || !data || !environmentAllows(getActiveEnvironment(), 'agentExecute')) return false;
    const legacyRawInput = async (id, text) => {
      const signal = environmentSignal.current;
      const authority = captureAuthScope();
      try {
        const response = await apiFetch(`/api/structured/sessions/${id}/input`, {
          method: 'POST', body: { text, fallbackToMessage: false }, signal,
        });
        if (!response.ok) throw new Error('Terminal input may have been delivered. Check the terminal before continuing.');
        if (signal.aborted || !isAuthScopeCurrent(authority) || captureAuthScope().userId !== authority.userId) throw new Error('Terminal input may have been delivered. Check the terminal before continuing.');
        return { accepted: true };
      } catch {
        const error = new Error('Terminal input may have been delivered. Check the terminal before continuing.');
        error.deliveryUncertain = true;
        throw error;
      }
    };
    return sendRawInput(sessionId, data, legacyRawInput, options);
  }, [sendToSession]);

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
    createStructuredSession,
    updateStructuredSessionSelection,
    updateStructuredSessionAccess,
    selectSession,
    restoreSession,
    renameSession,
    closeSession,
    navigateSession,
    retryLoadSessions: loadSessions,
    registerTerminalSender,
    unregisterTerminalSender,
    sendToSession,
    sendRawToSession,

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
