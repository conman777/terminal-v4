import { createContext, useContext, useState, useCallback, useRef, useEffect } from 'react';
import { apiFetch } from '../utils/api';
import { useTerminalSession } from './TerminalSessionContext';

const BookmarkContext = createContext(null);

export function BookmarkProvider({ children }) {
  const [bookmarks, setBookmarks] = useState([]);
  const isMountedRef = useRef(true);
  const { activeSessionId } = useTerminalSession();

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

  useEffect(() => {
    isMountedRef.current = true;
    loadBookmarks();
    return () => {
      isMountedRef.current = false;
    };
  }, [loadBookmarks]);

  const value = {
    bookmarks,
    addBookmark,
    updateBookmark,
    deleteBookmark,
    executeBookmark,
  };

  return (
    <BookmarkContext.Provider value={value}>
      {children}
    </BookmarkContext.Provider>
  );
}

export function useBookmarks() {
  const context = useContext(BookmarkContext);
  if (!context) {
    throw new Error('useBookmarks must be used within a BookmarkProvider');
  }
  return context;
}
