import { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { apiFetch } from '../utils/api';
import { useTerminalSession } from './TerminalSessionContext';

const ClaudeCodeContext = createContext(null);

export function ClaudeCodeProvider({ children }) {
  const { activeSessionId: activeTerminalSessionId, projectInfo, addRecentFolder, navigateSession } = useTerminalSession();
  // Claude Code state - restore from localStorage
  const [leftPanelMode, setLeftPanelMode] = useState(() => {
    try {
      return localStorage.getItem('leftPanelMode') || 'terminal';
    } catch {
      return 'terminal';
    }
  });

  const [claudeCodeSessions, setClaudeCodeSessions] = useState([]);

  const [activeClaudeCodeId, setActiveClaudeCodeId] = useState(() => {
    try {
      return localStorage.getItem('lastActiveClaudeCodeId') || null;
    } catch {
      return null;
    }
  });

  // Persist Claude Code state to localStorage
  useEffect(() => {
    try {
      localStorage.setItem('leftPanelMode', leftPanelMode);
    } catch (e) {
      console.error('Failed to save leftPanelMode', e);
    }
  }, [leftPanelMode]);

  useEffect(() => {
    try {
      if (activeClaudeCodeId) {
        localStorage.setItem('lastActiveClaudeCodeId', activeClaudeCodeId);
      }
    } catch (e) {
      console.error('Failed to save lastActiveClaudeCodeId', e);
    }
  }, [activeClaudeCodeId]);

  // Update sessions from app state (called by parent)
  const updateSessions = useCallback((sessions) => {
    setClaudeCodeSessions(Array.isArray(sessions) ? sessions : []);
  }, []);

  // Start a new Claude Code session
  const startClaudeCode = useCallback(async (model = 'sonnet') => {
    const cwd = projectInfo?.cwd || '.';

    try {
      const res = await apiFetch('/api/claude-code/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cwd, model })
      });
      const session = await res.json();
      setClaudeCodeSessions(prev => [session, ...prev]);
      setActiveClaudeCodeId(session.id);
      setLeftPanelMode('claude-code');
      return session;
    } catch (error) {
      console.error('Failed to start Claude Code:', error);
      throw error;
    }
  }, [projectInfo]);

  // Select a Claude Code session
  const selectClaudeCode = useCallback(async (id) => {
    const session = claudeCodeSessions.find(s => s.id === id);
    if (session && !session.isActive) {
      try {
        await apiFetch(`/api/claude-code/${id}/restore`, { method: 'POST' });
      } catch (error) {
        console.error('Failed to restore session:', error);
      }
    }
    setActiveClaudeCodeId(id);
    setLeftPanelMode('claude-code');
  }, [claudeCodeSessions]);

  // Delete a Claude Code session
  const deleteClaudeCode = useCallback(async (id) => {
    try {
      await apiFetch(`/api/claude-code/${id}`, { method: 'DELETE' });
      setClaudeCodeSessions(prev => prev.filter(s => s.id !== id));
      if (activeClaudeCodeId === id) {
        setActiveClaudeCodeId(null);
        setLeftPanelMode('terminal');
      }
    } catch (error) {
      console.error('Failed to delete session:', error);
    }
  }, [activeClaudeCodeId]);

  // Handle model change
  const handleModelChange = useCallback((updatedSession) => {
    setClaudeCodeSessions(prev =>
      prev.map(s => s.id === updatedSession.id ? updatedSession : s)
    );
  }, []);

  // Handle folder change from Claude Code panel - syncs both Claude Code and Terminal
  const handleFolderChange = useCallback(async (newPath) => {
    // 1. Send cd command to active Terminal session
    if (activeTerminalSessionId && navigateSession) {
      navigateSession(activeTerminalSessionId, newPath);
    }

    // 2. Update Claude Code session's cwd (persist to backend)
    if (activeClaudeCodeId) {
      try {
        const res = await apiFetch(`/api/claude-code/${activeClaudeCodeId}/cwd`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ cwd: newPath })
        });
        if (res.ok) {
          const updatedSession = await res.json();
          setClaudeCodeSessions(prev =>
            prev.map(s => s.id === activeClaudeCodeId ? { ...s, cwd: updatedSession.cwd } : s)
          );
        }
      } catch (error) {
        console.error('Failed to update Claude Code cwd:', error);
      }
    }

    // 3. Add to recent folders
    if (addRecentFolder) {
      addRecentFolder(newPath);
    }
  }, [activeTerminalSessionId, activeClaudeCodeId, navigateSession, addRecentFolder]);

  // Switch to terminal mode
  const switchToTerminal = useCallback(() => {
    setLeftPanelMode('terminal');
  }, []);

  // Switch to Claude Code mode
  const switchToClaudeCode = useCallback(() => {
    setLeftPanelMode('claude-code');
  }, []);

  const value = {
    // State
    leftPanelMode,
    claudeCodeSessions,
    activeClaudeCodeId,

    // Mode switching
    setLeftPanelMode,
    switchToTerminal,
    switchToClaudeCode,

    // Session actions
    startClaudeCode,
    selectClaudeCode,
    deleteClaudeCode,
    handleModelChange,
    handleFolderChange,

    // Update from app state
    updateSessions
  };

  return (
    <ClaudeCodeContext.Provider value={value}>
      {children}
    </ClaudeCodeContext.Provider>
  );
}

export function useClaudeCode() {
  const context = useContext(ClaudeCodeContext);
  if (!context) {
    throw new Error('useClaudeCode must be used within a ClaudeCodeProvider');
  }
  return context;
}
