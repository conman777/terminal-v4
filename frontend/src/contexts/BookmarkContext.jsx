import { getActiveEnvironment, subscribeEnvironment } from '../utils/remoteEnvironments';
import { captureAuthScope, isAuthScopeCurrent, subscribeAuth } from '../utils/auth';
import { createContext, useContext, useState, useCallback, useRef, useEffect } from 'react';
import { apiFetch } from '../utils/api';
import { isStructuredSessionId } from '../utils/structuredSessions';
import { useTerminalSession } from './TerminalSessionContext';

const BookmarkContext = createContext(null);

export function BookmarkProvider({ children }) {
  const [bookmarks, setBookmarks] = useState([]);
  const [bookmarksLoadStatus, setLoadStatus] = useState('loading');
  const [bookmarksLoadError, setLoadError] = useState('');
  const [bookmarksScopeKey, setScopeKey] = useState(0);
  const isMountedRef = useRef(false);
  const scopeVersion = useRef(0);
  const authIdentity = useRef(null);
  const scopeController = useRef(new AbortController());
  const readVersion = useRef(0);
  const readController = useRef(null);
  const { activeSessionId } = useTerminalSession();

  const reloadBookmarks = useCallback(async () => {
    if (!isMountedRef.current) return false;
    const request = ++readVersion.current;
    readController.current?.abort();
    if (getActiveEnvironment()) {
      setBookmarks([]); setLoadError(''); setLoadStatus('unavailable'); return false;
    }
    const controller = new AbortController();
    readController.current = controller;
    const version = scopeVersion.current;
    const authScope = authIdentity.current;
    if (!authScope || !isAuthScopeCurrent(authScope) || authScope.userId !== captureAuthScope().userId) return false;
    const current = () => isMountedRef.current && !controller.signal.aborted && request === readVersion.current
      && version === scopeVersion.current && isAuthScopeCurrent(authScope) && authScope.userId === captureAuthScope().userId && !getActiveEnvironment();
    setLoadStatus('loading'); setLoadError('');
    try {
      const response = await apiFetch('/api/bookmarks', { home: true, signal: controller.signal });
      if (!response.ok) throw new Error(`Failed to load bookmarks (${response.status})`);
      const data = await response.json();
      if (!Array.isArray(data?.bookmarks)) throw new Error('Unable to read the bookmarks list');
      if (!current()) return false;
      setBookmarks(data.bookmarks); setLoadStatus('ready');
      return true;
    } catch (error) {
      if (current()) { setLoadError(error.message || 'Unable to load bookmarks'); setLoadStatus('error'); }
      return false;
    }
  }, []);

  useEffect(() => {
    isMountedRef.current = true;
    const invalidate = () => {
      authIdentity.current = captureAuthScope();
      scopeVersion.current += 1;
      scopeController.current.abort(); scopeController.current = new AbortController();
      readVersion.current += 1; readController.current?.abort();
      setScopeKey(scopeVersion.current); setBookmarks([]); setLoadError('');
      void reloadBookmarks();
    };
    const unsubscribeAuth = subscribeAuth(() => {
      const previous = authIdentity.current;
      const current = captureAuthScope();
      if (!previous || !isAuthScopeCurrent(previous) || previous.userId !== current.userId) invalidate();
    });
    const unsubscribeEnvironment = subscribeEnvironment(invalidate);
    invalidate();
    return () => {
      isMountedRef.current = false; scopeVersion.current += 1;
      scopeController.current.abort(); readController.current?.abort();
      unsubscribeAuth(); unsubscribeEnvironment();
    };
  }, [reloadBookmarks]);

  const mutate = useCallback(async (url, options, failureMessage) => {
    const version = bookmarksScopeKey;
    const authScope = authIdentity.current;
    const assertCurrent = () => {
      if (!isMountedRef.current || version !== scopeVersion.current || !authScope || !isAuthScopeCurrent(authScope) || authScope.userId !== captureAuthScope().userId) throw new Error('Bookmark scope changed. Reopen the editor before saving.');
      if (getActiveEnvironment()) throw new Error('Bookmarks are available on This server. Switch back before making changes.');
    };
    assertCurrent();
    const response = await apiFetch(url, { ...options, home: true, signal: scopeController.current.signal });
    assertCurrent();
    if (!response.ok) throw new Error(`${failureMessage} (${response.status})`);
    await reloadBookmarks();
    assertCurrent();
  }, [bookmarksScopeKey, reloadBookmarks]);

  const addBookmark = useCallback((name, command, category) => mutate('/api/bookmarks', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, command, category }),
  }, 'Failed to create bookmark'), [mutate]);
  const updateBookmark = useCallback((id, updates) => mutate(`/api/bookmarks/${id}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(updates),
  }, 'Failed to update bookmark'), [mutate]);
  const deleteBookmark = useCallback(id => mutate(`/api/bookmarks/${id}`, { method: 'DELETE' }, 'Failed to delete bookmark'), [mutate]);
  const executeBookmark = useCallback(async (command) => {
    const authScope = authIdentity.current;
    if (!isMountedRef.current || bookmarksScopeKey !== scopeVersion.current || !authScope || !isAuthScopeCurrent(authScope) || authScope.userId !== captureAuthScope().userId) throw new Error('Bookmark scope changed. Reopen the editor.');
    if (!activeSessionId || isStructuredSessionId(activeSessionId)) {
      throw new Error('Select a PTY terminal session to execute bookmarks. Commands cannot run in a structured conversation.');
    }

    const response = await apiFetch(`/api/terminal/${activeSessionId}/input`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ command: command + '\r' })
    });
    if (!isMountedRef.current || bookmarksScopeKey !== scopeVersion.current || !authScope || !isAuthScopeCurrent(authScope) || authScope.userId !== captureAuthScope().userId) throw new Error('Bookmark scope changed. Reopen the editor.');
    if (!response.ok) {
      throw new Error(`Failed to execute bookmark command (${response.status})`);
    }
  }, [activeSessionId, bookmarksScopeKey]);


  const value = {
    bookmarks, addBookmark, updateBookmark, deleteBookmark, executeBookmark,
    bookmarksLoadStatus, bookmarksLoadError, reloadBookmarks, bookmarksScopeKey,
  };
  return <BookmarkContext.Provider value={value}>{children}</BookmarkContext.Provider>;
}

export function useBookmarks() {
  const context = useContext(BookmarkContext);
  if (!context) throw new Error('useBookmarks must be used within a BookmarkProvider');
  return context;
}
