import { getActiveEnvironment, subscribeEnvironment } from '../utils/remoteEnvironments';
import { captureAuthScope, isAuthScopeCurrent, subscribeAuth } from '../utils/auth';
import { createContext, useContext, useState, useCallback, useRef, useEffect } from 'react';
import { apiFetch } from '../utils/api';
import { readStrictResponseMetadata, validateStrictResponse } from '../utils/strictAuthenticatedFetch';
import { useOptionalAuth } from './AuthContext';

const NotesContext = createContext(null);
const STRICT_UNAVAILABLE = 'Notes are unavailable in this secure session. Keep a copy of your draft; if a save was in progress, check whether it completed before retrying.';
const UNCERTAIN_SAVE = 'The note save may have completed. Check its status before trying again.';
const uncertainSave = (message = UNCERTAIN_SAVE) => Object.assign(new Error(message), { outcomeUncertain: true });
const OWNERSHIP_CONFLICT = 'Note storage ownership is ambiguous. Administrator review is required.';
async function ownershipConflict(response, status) {
  if (status !== 409 || typeof response?.json !== 'function') return null;
  const body = await response.json().catch(() => null);
  return body?.error === OWNERSHIP_CONFLICT ? OWNERSHIP_CONFLICT : null;
}

export function NotesProvider({ children }) {
  const auth = useOptionalAuth();
  const strictRef = useRef(false);
  if (auth && Object.hasOwn(auth, 'authLifecycle')) strictRef.current = true;
  const strict = strictRef.current;
  const startedLegacy = useRef(!strict);
  const initialStrictOwner = useRef(strict ? auth?.user?.id || null : null);
  const bindingRef = useRef(null);
  bindingRef.current = { lifecycle: auth?.authLifecycle, ready: auth?.strictReady, userId: auth?.user?.id };
  const strictScope = useRef(null);
  const [notes, setNotes] = useState([]);
  const [notesLoadStatus, setLoadStatus] = useState('loading');
  const [notesLoadError, setLoadError] = useState('');
  const [ownershipHold, setOwnershipHold] = useState(false);
  const [notesScopeKey, setScopeKey] = useState(0);
  const isMountedRef = useRef(false);
  const scopeVersion = useRef(0);
  const authIdentity = useRef(null);
  const scopeController = useRef(new AbortController());
  const readVersion = useRef(0);
  const readController = useRef(null);

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

  const reloadNotes = useCallback(async () => {
    if (!isMountedRef.current) return false;
    if (strictRef.current) {
      const binding = bindingRef.current;
      const request = ++readVersion.current;
      readController.current?.abort();
      const controller = new AbortController();
      readController.current = controller;
      const stillRequest = () => !controller.signal.aborted && request === readVersion.current && isMountedRef.current;
      const current = () => stillRequest()
        && bindingRef.current?.ready === true && bindingRef.current.lifecycle === binding.lifecycle && bindingRef.current.userId === binding.userId;
      setLoadStatus('loading'); setLoadError('');
      try {
        await checkStrictScope(binding);
        const response = await apiFetch('/api/notes', { home: true, signal: controller.signal, authLifecycle: binding.lifecycle });
        const metadata = await readStrictResponseMetadata(response);
        if (!metadata.ok) throw new Error(await ownershipConflict(response, metadata.status) || `Failed to load notes (${metadata.status})`);
        const data = await response.json();
        if (!Array.isArray(data?.notes)) throw new Error('Unable to read the notes list');
        await validateStrictResponse(response, { required: true });
        await checkStrictScope(binding);
        if (!current()) return false;
        setNotes(data.notes); setOwnershipHold(false); setLoadStatus('ready');
        return true;
      } catch (error) {
        if (stillRequest()) {
          if (current() && error.message === OWNERSHIP_CONFLICT) setOwnershipHold(true);
          setLoadError(error.message || STRICT_UNAVAILABLE); setLoadStatus('error');
        }
        return false;
      }
    }
    const request = ++readVersion.current;
    readController.current?.abort();
    if (getActiveEnvironment()) {
      setNotes([]); setLoadError(''); setLoadStatus('unavailable'); return false;
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
      const response = await apiFetch('/api/notes', { home: true, signal: controller.signal });
      if (!response.ok) throw new Error(await ownershipConflict(response, response.status) || `Failed to load notes (${response.status})`);
      const data = await response.json();
      if (!Array.isArray(data?.notes)) throw new Error('Unable to read the notes list');
      if (!current()) return false;
      setNotes(data.notes); setOwnershipHold(false); setLoadStatus('ready');
      return true;
    } catch (error) {
      if (current()) {
        if (error.message === OWNERSHIP_CONFLICT) setOwnershipHold(true);
        setLoadError(error.message || 'Unable to load notes'); setLoadStatus('error');
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
      setScopeKey(scopeVersion.current); setNotes([]); setOwnershipHold(false); setLoadError('');
      void reloadNotes();
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
  }, [reloadNotes, strict]);

  useEffect(() => {
    if (!strict) return;
    readVersion.current += 1; readController.current?.abort();
    if (bindingRef.current.ready === true) void reloadNotes();
    else { setLoadStatus('error'); setLoadError(STRICT_UNAVAILABLE); }
  }, [strict, auth?.authLifecycle, auth?.strictReady, auth?.user?.id, reloadNotes]);

  const mutate = useCallback(async (url, options, failureMessage) => {
    if (strictRef.current) {
      const binding = bindingRef.current;
      await checkStrictScope(binding);
      let response;
      try { response = await apiFetch(url, { ...options, home: true, signal: scopeController.current.signal, authLifecycle: binding.lifecycle }); }
      catch { throw uncertainSave(); }
      try {
        const metadata = await readStrictResponseMetadata(response);
        if (!metadata.ok) {
          if (metadata.status >= 500) throw uncertainSave();
          const conflict = await ownershipConflict(response, metadata.status);
          if (conflict) {
            await checkStrictScope(binding);
            setOwnershipHold(true); setLoadError(conflict); setLoadStatus('error');
          }
          throw new Error(conflict || `${failureMessage} (${metadata.status})`);
        }
        await validateStrictResponse(response, { required: true });
        await checkStrictScope(binding);
        if (!await reloadNotes()) throw uncertainSave();
        await checkStrictScope(binding);
        return;
      } catch (error) {
        if (error.message.startsWith(failureMessage) || error.message === OWNERSHIP_CONFLICT) throw error;
        throw uncertainSave();
      }
    }
    const version = notesScopeKey;
    const authScope = authIdentity.current;
    const assertCurrent = () => {
      if (strictRef.current) throw new Error(STRICT_UNAVAILABLE);
      if (!isMountedRef.current || version !== scopeVersion.current || !authScope || !isAuthScopeCurrent(authScope) || authScope.userId !== captureAuthScope().userId) throw new Error('Note scope changed. Reopen the editor before saving.');
      if (getActiveEnvironment()) throw new Error('Notes are available on This server. Switch back before making changes.');
    };
    assertCurrent();
    let response;
    try { response = await apiFetch(url, { ...options, home: true, signal: scopeController.current.signal }); }
    catch (error) {
      if (strictRef.current) throw uncertainSave();
      if (!isAuthScopeCurrent(authScope) || version !== scopeVersion.current) throw uncertainSave('Note scope changed. The save may have completed; check its status before retrying.');
      throw uncertainSave();
    }
    if (strictRef.current) throw uncertainSave();
    try { assertCurrent(); } catch (error) { throw Object.assign(error, { outcomeUncertain: true }); }
    if (!response.ok) {
      if (response.status >= 500) throw uncertainSave(`${failureMessage} (${response.status}). ${UNCERTAIN_SAVE}`);
      const conflict = await ownershipConflict(response, response.status);
      if (conflict) {
        assertCurrent();
        setOwnershipHold(true); setLoadError(conflict); setLoadStatus('error');
      }
      throw new Error(conflict || `${failureMessage} (${response.status})`);
    }
    await reloadNotes();
    if (strictRef.current) throw uncertainSave();
    try { assertCurrent(); } catch (error) { throw Object.assign(error, { outcomeUncertain: true }); }
  }, [notesScopeKey, reloadNotes, checkStrictScope]);

  const addNote = useCallback((title, content, category) => mutate('/api/notes', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title, content, category }),
  }, 'Failed to create note'), [mutate]);
  const updateNote = useCallback((id, updates) => mutate(`/api/notes/${id}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(updates),
  }, 'Failed to update note'), [mutate]);
  const deleteNote = useCallback(id => mutate(`/api/notes/${id}`, { method: 'DELETE' }, 'Failed to delete note'), [mutate]);

  const owner = strictScope.current?.owner || (startedLegacy.current ? authIdentity.current?.userId : null) || initialStrictOwner.current;
  const accountHeld = Boolean(strict && owner && auth?.user?.id !== owner);
  const notesScopeHeld = accountHeld || ownershipHold;
  const value = {
    notes: notesScopeHeld ? [] : notes, notesScopeHeld,
    notesScopeHoldMessage: accountHeld ? 'Return to the original account to view its notes and retained draft.' : OWNERSHIP_CONFLICT,
    notesScopeHoldCanRetry: ownershipHold && !accountHeld,
    addNote, updateNote, deleteNote,
    notesLoadStatus, notesLoadError, reloadNotes, notesScopeKey,
  };
  return <NotesContext.Provider value={value}>{children}</NotesContext.Provider>;
}

export function useNotes() {
  const context = useContext(NotesContext);
  if (!context) throw new Error('useNotes must be used within a NotesProvider');
  return context;
}
