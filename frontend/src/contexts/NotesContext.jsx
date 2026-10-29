import { getActiveEnvironment, subscribeEnvironment } from '../utils/remoteEnvironments';
import { captureAuthScope, isAuthScopeCurrent, subscribeAuth } from '../utils/auth';
import { createContext, useContext, useState, useCallback, useRef, useEffect } from 'react';
import { apiFetch } from '../utils/api';

const NotesContext = createContext(null);

export function NotesProvider({ children }) {
  const [notes, setNotes] = useState([]);
  const [notesLoadStatus, setLoadStatus] = useState('loading');
  const [notesLoadError, setLoadError] = useState('');
  const [notesScopeKey, setScopeKey] = useState(0);
  const isMountedRef = useRef(false);
  const scopeVersion = useRef(0);
  const authIdentity = useRef(null);
  const scopeController = useRef(new AbortController());
  const readVersion = useRef(0);
  const readController = useRef(null);

  const reloadNotes = useCallback(async () => {
    if (!isMountedRef.current) return false;
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
    const current = () => isMountedRef.current && !controller.signal.aborted && request === readVersion.current
      && version === scopeVersion.current && isAuthScopeCurrent(authScope) && authScope.userId === captureAuthScope().userId && !getActiveEnvironment();
    setLoadStatus('loading'); setLoadError('');
    try {
      const response = await apiFetch('/api/notes', { home: true, signal: controller.signal });
      if (!response.ok) throw new Error(`Failed to load notes (${response.status})`);
      const data = await response.json();
      if (!Array.isArray(data?.notes)) throw new Error('Unable to read the notes list');
      if (!current()) return false;
      setNotes(data.notes); setLoadStatus('ready');
      return true;
    } catch (error) {
      if (current()) { setLoadError(error.message || 'Unable to load notes'); setLoadStatus('error'); }
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
      setScopeKey(scopeVersion.current); setNotes([]); setLoadError('');
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
  }, [reloadNotes]);

  const mutate = useCallback(async (url, options, failureMessage) => {
    const version = notesScopeKey;
    const authScope = authIdentity.current;
    const assertCurrent = () => {
      if (!isMountedRef.current || version !== scopeVersion.current || !authScope || !isAuthScopeCurrent(authScope) || authScope.userId !== captureAuthScope().userId) throw new Error('Note scope changed. Reopen the editor before saving.');
      if (getActiveEnvironment()) throw new Error('Notes are available on This server. Switch back before making changes.');
    };
    assertCurrent();
    const response = await apiFetch(url, { ...options, home: true, signal: scopeController.current.signal });
    assertCurrent();
    if (!response.ok) throw new Error(`${failureMessage} (${response.status})`);
    await reloadNotes();
    assertCurrent();
  }, [notesScopeKey, reloadNotes]);

  const addNote = useCallback((title, content, category) => mutate('/api/notes', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title, content, category }),
  }, 'Failed to create note'), [mutate]);
  const updateNote = useCallback((id, updates) => mutate(`/api/notes/${id}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(updates),
  }, 'Failed to update note'), [mutate]);
  const deleteNote = useCallback(id => mutate(`/api/notes/${id}`, { method: 'DELETE' }, 'Failed to delete note'), [mutate]);

  const value = {
    notes, addNote, updateNote, deleteNote,
    notesLoadStatus, notesLoadError, reloadNotes, notesScopeKey,
  };
  return <NotesContext.Provider value={value}>{children}</NotesContext.Provider>;
}

export function useNotes() {
  const context = useContext(NotesContext);
  if (!context) throw new Error('useNotes must be used within a NotesProvider');
  return context;
}
