import { getActiveEnvironment, subscribeEnvironment } from '../utils/remoteEnvironments';
import { captureAuthScope, isAuthScopeCurrent, subscribeAuth } from '../utils/auth';
import { createContext, useContext, useState, useCallback, useRef, useEffect } from 'react';
import { apiFetch } from '../utils/api';
import { readStrictResponseMetadata, validateStrictResponse } from '../utils/strictAuthenticatedFetch';
import { isStructuredSessionId } from '../utils/structuredSessions';
import { useTerminalSession } from './TerminalSessionContext';
import { useOptionalAuth } from './AuthContext';

const BookmarkContext = createContext(null);
const STRICT_UNAVAILABLE = 'Bookmarks are unavailable in this secure session. Keep your draft and check any in-progress change before retrying.';
const UNCERTAIN_SAVE = 'The bookmark change may have completed. Check its status before trying again.';
const UNCERTAIN_COMMAND = 'The bookmark command may have run. Check the terminal before trying again.';
const uncertainSave = (message = UNCERTAIN_SAVE) => Object.assign(new Error(message), { outcomeUncertain: true });
const OWNERSHIP_CONFLICT = 'Bookmark storage ownership is ambiguous. Administrator review is required.';
async function ownershipConflict(response, status = response.status) {
  if (status !== 409 || typeof response.json !== 'function') return null;
  try {
    const body = await response.json();
    return body?.error === OWNERSHIP_CONFLICT ? OWNERSHIP_CONFLICT : null;
  } catch (error) {
    if (error?.outcomeUncertain || error?.message === 'Authentication changed') throw error;
    return null;
  }
}

export function BookmarkProvider({ children }) {
  const auth = useOptionalAuth();
  const strictRef = useRef(false);
  if (auth && Object.hasOwn(auth, 'authLifecycle')) strictRef.current = true;
  const strict = strictRef.current;
  const startedLegacy = useRef(!strict);
  const initialStrictOwner = useRef(strict ? auth?.user?.id || null : null);
  const bindingRef = useRef(null);
  bindingRef.current = { lifecycle: auth?.authLifecycle, ready: auth?.strictReady, userId: auth?.user?.id };
  const strictScope = useRef(null);
  const [bookmarks, setBookmarks] = useState([]);
  const [bookmarksLoadStatus, setLoadStatus] = useState('loading');
  const [bookmarksLoadError, setLoadError] = useState('');
  const [ownershipHeld, setScopeHeld] = useState(false);
  const ownershipHold = useRef(false);
  const [bookmarksScopeKey, setScopeKey] = useState(0);
  const isMountedRef = useRef(false);
  const scopeVersion = useRef(0);
  const authIdentity = useRef(null);
  const scopeController = useRef(new AbortController());
  const readVersion = useRef(0);
  const readController = useRef(null);
  const { activeSessionId } = useTerminalSession();

  const checkStrictScope = useCallback(async (binding) => {
    const currentBinding = () => isMountedRef.current && strictRef.current && bindingRef.current?.ready === true
      && bindingRef.current.lifecycle === binding.lifecycle && bindingRef.current.userId === binding.userId && !getActiveEnvironment();
    if (startedLegacy.current || !currentBinding() || binding.userId !== initialStrictOwner.current || typeof binding.lifecycle?.read !== 'function' || typeof binding.lifecycle?.refresh !== 'function') throw new Error(STRICT_UNAVAILABLE);
    const snapshot = await binding.lifecycle.read();
    if (!currentBinding() || snapshot?.status !== 'active' || snapshot.refreshReserved || !snapshot.incarnation
      || !snapshot.pair?.session || !snapshot.pair.home || snapshot.pair.owner !== binding.userId || snapshot.user?.id !== binding.userId) throw new Error(STRICT_UNAVAILABLE);
    const scope = { incarnation: snapshot.incarnation, owner: snapshot.pair.owner, session: snapshot.pair.session, home: snapshot.pair.home };
    if (!strictScope.current) strictScope.current = scope;
    if (Object.keys(scope).some(key => strictScope.current[key] !== scope[key])) throw new Error(STRICT_UNAVAILABLE);
    return scope;
  }, []);

  const reloadBookmarks = useCallback(async () => {
    if (!isMountedRef.current) return false;
    if (strictRef.current) {
      const binding = bindingRef.current;
      const request = ++readVersion.current;
      readController.current?.abort();
      const controller = new AbortController();
      readController.current = controller;
      const stillRequest = () => !controller.signal.aborted && request === readVersion.current && isMountedRef.current;
      const current = () => stillRequest() && bindingRef.current?.ready === true
        && bindingRef.current.lifecycle === binding.lifecycle && bindingRef.current.userId === binding.userId;
      setLoadStatus('loading'); setLoadError('');
      try {
        await checkStrictScope(binding);
        const response = await apiFetch('/api/bookmarks', { home: true, signal: controller.signal, authLifecycle: binding.lifecycle });
        const metadata = await readStrictResponseMetadata(response);
        if (!metadata.ok) throw new Error(await ownershipConflict(response, metadata.status) || `Failed to load bookmarks (${metadata.status})`);
        const data = await response.json();
        if (!Array.isArray(data?.bookmarks)) throw new Error('Unable to read the bookmarks list');
        await validateStrictResponse(response, { required: true });
        await checkStrictScope(binding);
        if (!current()) return false;
        ownershipHold.current = false; setScopeHeld(false);
        setBookmarks(data.bookmarks); setLoadStatus('ready');
        return true;
      } catch (error) {
        if (stillRequest()) {
          if (current() && error.message === OWNERSHIP_CONFLICT) { ownershipHold.current = true; setScopeHeld(true); }
          setLoadError(error.message || STRICT_UNAVAILABLE); setLoadStatus('error');
        }
        return false;
      }
    }
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
    const current = () => isMountedRef.current && !strictRef.current && !controller.signal.aborted && request === readVersion.current
      && version === scopeVersion.current && isAuthScopeCurrent(authScope) && authScope.userId === captureAuthScope().userId && !getActiveEnvironment();
    setLoadStatus('loading'); setLoadError('');
    try {
      const response = await apiFetch('/api/bookmarks', { home: true, signal: controller.signal });
      if (!response.ok) throw new Error(await ownershipConflict(response) || `Failed to load bookmarks (${response.status})`);
      const data = await response.json();
      if (!Array.isArray(data?.bookmarks)) throw new Error('Unable to read the bookmarks list');
      if (!current()) return false;
      ownershipHold.current = false; setScopeHeld(false);
      setBookmarks(data.bookmarks); setLoadStatus('ready');
      return true;
    } catch (error) {
      if (current()) {
        if (error.message === OWNERSHIP_CONFLICT) { ownershipHold.current = true; setScopeHeld(true); }
        setLoadError(error.message || 'Unable to load bookmarks'); setLoadStatus('error');
      }
      return false;
    }
  }, [checkStrictScope]);

  useEffect(() => {
    isMountedRef.current = true;
    if (strict) {
      scopeVersion.current += 1;
      scopeController.current.abort(); scopeController.current = new AbortController();
      readVersion.current += 1; readController.current?.abort();
      setLoadStatus('error'); setLoadError(STRICT_UNAVAILABLE);
      return () => {
        isMountedRef.current = false; scopeVersion.current += 1;
        scopeController.current.abort(); readController.current?.abort();
      };
    }
    const invalidate = () => {
      if (strictRef.current) return;
      authIdentity.current = captureAuthScope();
      scopeVersion.current += 1;
      scopeController.current.abort(); scopeController.current = new AbortController();
      readVersion.current += 1; readController.current?.abort();
      ownershipHold.current = false; setScopeHeld(false);
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
  }, [reloadBookmarks, strict]);

  useEffect(() => {
    if (!strict) return;
    readVersion.current += 1; readController.current?.abort();
    if (bindingRef.current.ready === true) void reloadBookmarks();
    else { setLoadStatus('error'); setLoadError(STRICT_UNAVAILABLE); }
  }, [strict, auth?.authLifecycle, auth?.strictReady, auth?.user?.id, reloadBookmarks]);

  const mutate = useCallback(async (url, options, failureMessage) => {
    if (strictRef.current) {
      const binding = bindingRef.current;
      await checkStrictScope(binding);
      if (ownershipHold.current) throw new Error(OWNERSHIP_CONFLICT);
      let response;
      try { response = await apiFetch(url, { ...options, home: true, signal: scopeController.current.signal, authLifecycle: binding.lifecycle }); }
      catch { throw uncertainSave(); }
      try {
        const metadata = await readStrictResponseMetadata(response);
        if (!metadata.ok) {
          if (metadata.status >= 500) throw uncertainSave(`${failureMessage} (${metadata.status}). ${UNCERTAIN_SAVE}`);
          const conflict = await ownershipConflict(response, metadata.status);
          await checkStrictScope(binding);
          if (conflict) { ownershipHold.current = true; setScopeHeld(true); setLoadError(conflict); setLoadStatus('error'); }
          throw new Error(conflict || `${failureMessage} (${metadata.status})`);
        }
        await validateStrictResponse(response, { required: true });
        await checkStrictScope(binding);
        if (!await reloadBookmarks()) throw uncertainSave();
        await checkStrictScope(binding);
        return;
      } catch (error) {
        if (error?.message?.startsWith(failureMessage) || error?.message === OWNERSHIP_CONFLICT) throw error;
        throw uncertainSave();
      }
    }
    const version = bookmarksScopeKey;
    const authScope = authIdentity.current;
    const assertCurrent = () => {
      if (strictRef.current) throw new Error(STRICT_UNAVAILABLE);
      if (!isMountedRef.current || version !== scopeVersion.current || !authScope || !isAuthScopeCurrent(authScope) || authScope.userId !== captureAuthScope().userId) throw new Error('Bookmark scope changed. Reopen the editor before saving.');
      if (getActiveEnvironment()) throw new Error('Bookmarks are available on This server. Switch back before making changes.');
      if (ownershipHold.current) throw new Error(OWNERSHIP_CONFLICT);
    };
    assertCurrent();
    let response;
    try { response = await apiFetch(url, { ...options, home: true, signal: scopeController.current.signal }); }
    catch { throw uncertainSave(); }
    if (strictRef.current) throw uncertainSave();
    try { assertCurrent(); } catch (error) { throw Object.assign(error, { outcomeUncertain: true }); }
    if (!response.ok) {
      if (response.status >= 500) throw uncertainSave(`${failureMessage} (${response.status}). ${UNCERTAIN_SAVE}`);
      const conflict = await ownershipConflict(response);
      try { assertCurrent(); } catch (error) { throw Object.assign(error, { outcomeUncertain: true }); }
      if (conflict) { ownershipHold.current = true; setScopeHeld(true); setLoadError(conflict); setLoadStatus('error'); }
      throw new Error(conflict || `${failureMessage} (${response.status})`);
    }
    await reloadBookmarks();
    if (strictRef.current) throw uncertainSave();
    try { assertCurrent(); } catch (error) { throw Object.assign(error, { outcomeUncertain: true }); }
  }, [bookmarksScopeKey, reloadBookmarks, checkStrictScope]);

  const addBookmark = useCallback((name, command, category) => mutate('/api/bookmarks', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, command, category }),
  }, 'Failed to create bookmark'), [mutate]);
  const updateBookmark = useCallback((id, updates) => mutate(`/api/bookmarks/${id}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(updates),
  }, 'Failed to update bookmark'), [mutate]);
  const deleteBookmark = useCallback(id => mutate(`/api/bookmarks/${id}`, { method: 'DELETE' }, 'Failed to delete bookmark'), [mutate]);
  const executeBookmark = useCallback(async (command) => {
    if (strictRef.current) throw new Error(STRICT_UNAVAILABLE);
    if (ownershipHold.current) throw new Error(OWNERSHIP_CONFLICT);
    const authScope = authIdentity.current;
    if (!isMountedRef.current || bookmarksScopeKey !== scopeVersion.current || !authScope || !isAuthScopeCurrent(authScope) || authScope.userId !== captureAuthScope().userId) throw new Error('Bookmark scope changed. Reopen the editor.');
    if (!activeSessionId || isStructuredSessionId(activeSessionId)) {
      throw new Error('Select a PTY terminal session to execute bookmarks. Commands cannot run in a structured conversation.');
    }

    let response;
    try {
      response = await apiFetch(`/api/terminal/${activeSessionId}/input`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command: command + '\r' })
      });
    } catch (error) { if (strictRef.current) throw new Error(UNCERTAIN_COMMAND); throw error; }
    if (strictRef.current) throw new Error(UNCERTAIN_COMMAND);
    if (!isMountedRef.current || bookmarksScopeKey !== scopeVersion.current || !authScope || !isAuthScopeCurrent(authScope) || authScope.userId !== captureAuthScope().userId) throw new Error('Bookmark scope changed. Reopen the editor.');
    if (!response.ok) {
      throw new Error(`Failed to execute bookmark command (${response.status})`);
    }
  }, [activeSessionId, bookmarksScopeKey]);


  const owner = strictScope.current?.owner || (startedLegacy.current ? authIdentity.current?.userId : null) || initialStrictOwner.current;
  const accountHeld = Boolean(strict && owner && auth?.user?.id !== owner);
  const bookmarksScopeHeld = accountHeld || ownershipHeld;
  const value = {
    bookmarks: bookmarksScopeHeld ? [] : bookmarks, bookmarksScopeHeld,
    bookmarksScopeHoldMessage: accountHeld ? 'Return to the original account to view its bookmarks and retained draft.' : bookmarksLoadError || OWNERSHIP_CONFLICT,
    bookmarksScopeHoldCanRetry: ownershipHeld && !accountHeld,
    bookmarksExecutionUnavailable: strict ? 'Running bookmark commands is unavailable in this secure session.' : '',
    bookmarksSaveUnavailable: strict && (startedLegacy.current || auth?.strictReady !== true || typeof auth?.authLifecycle?.read !== 'function' || typeof auth?.authLifecycle?.refresh !== 'function') ? STRICT_UNAVAILABLE : '',
    addBookmark, updateBookmark, deleteBookmark, executeBookmark,
    bookmarksLoadStatus, bookmarksLoadError, reloadBookmarks, bookmarksScopeKey,
  };
  return <BookmarkContext.Provider value={value}>{children}</BookmarkContext.Provider>;
}

export function useBookmarks() {
  const context = useContext(BookmarkContext);
  if (!context) throw new Error('useBookmarks must be used within a BookmarkProvider');
  return context;
}
