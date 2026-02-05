import { createContext, useContext, useState, useCallback, useRef, useEffect } from 'react';
import { apiFetch } from '../utils/api';

const NotesContext = createContext(null);

export function NotesProvider({ children }) {
  const [notes, setNotes] = useState([]);
  const isMountedRef = useRef(true);

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

  useEffect(() => {
    isMountedRef.current = true;
    loadNotes();
    return () => {
      isMountedRef.current = false;
    };
  }, [loadNotes]);

  const value = {
    notes,
    addNote,
    updateNote,
    deleteNote,
  };

  return (
    <NotesContext.Provider value={value}>
      {children}
    </NotesContext.Provider>
  );
}

export function useNotes() {
  const context = useContext(NotesContext);
  if (!context) {
    throw new Error('useNotes must be used within a NotesProvider');
  }
  return context;
}
