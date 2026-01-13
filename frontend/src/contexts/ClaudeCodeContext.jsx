import { createContext, useContext, useState, useEffect, useCallback, useMemo } from 'react';
import { apiFetch } from '../utils/api';
import { useTerminalSession } from './TerminalSessionContext';

const ClaudeCodeContext = createContext(null);
const CLAUDE_SESSION_STORAGE_KEY = 'claudeCodeSessionIds';

function loadClaudeSessionIds() {
  try {
    const stored = localStorage.getItem(CLAUDE_SESSION_STORAGE_KEY);
    return stored ? JSON.parse(stored) : [];
  } catch {
    return [];
  }
}

function persistClaudeSessionIds(ids) {
  try {
    localStorage.setItem(CLAUDE_SESSION_STORAGE_KEY, JSON.stringify(ids));
  } catch (error) {
    console.error('Failed to save Claude Code session ids', error);
  }
}

export function ClaudeCodeProvider({ children }) {
  const {
    sessions: terminalSessions,
    loadingSessions,
    projectInfo
  } = useTerminalSession();
  // Claude Code state - restore from localStorage
  const [leftPanelMode, setLeftPanelMode] = useState(() => {
    try {
      return localStorage.getItem('leftPanelMode') || 'terminal';
    } catch {
      return 'terminal';
    }
  });

  const [claudeSessionIds, setClaudeSessionIds] = useState(() => loadClaudeSessionIds());

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
      } else {
        localStorage.removeItem('lastActiveClaudeCodeId');
      }
    } catch (e) {
      console.error('Failed to save lastActiveClaudeCodeId', e);
    }
  }, [activeClaudeCodeId]);

  useEffect(() => {
    persistClaudeSessionIds(claudeSessionIds);
  }, [claudeSessionIds]);

  // Keep Claude Code session ids in sync with terminal sessions
  useEffect(() => {
    if (loadingSessions) return;
    const existingIds = new Set(terminalSessions.map(session => session.id));
    let nextIds = claudeSessionIds.filter(id => existingIds.has(id));
    if (activeClaudeCodeId && existingIds.has(activeClaudeCodeId) && !nextIds.includes(activeClaudeCodeId)) {
      nextIds = [activeClaudeCodeId, ...nextIds];
    }
    const isSame =
      nextIds.length === claudeSessionIds.length &&
      nextIds.every((id, index) => id === claudeSessionIds[index]);
    if (!isSame) {
      setClaudeSessionIds(nextIds);
    }
    if (activeClaudeCodeId && !existingIds.has(activeClaudeCodeId)) {
      setActiveClaudeCodeId(nextIds[0] || null);
    }
  }, [terminalSessions, loadingSessions, claudeSessionIds, activeClaudeCodeId]);

  const claudeCodeSessions = useMemo(() => {
    if (claudeSessionIds.length === 0) return [];
    const sessionMap = new Map(terminalSessions.map(session => [session.id, session]));
    return claudeSessionIds
      .map(id => sessionMap.get(id))
      .filter(Boolean);
  }, [terminalSessions, claudeSessionIds]);

  // Start a new Claude Code session
  const startClaudeCode = useCallback(async () => {
    const cwd = projectInfo?.cwd || '.';

    try {
      const res = await apiFetch('/api/terminal', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          cwd,
          shell: 'claude',
          title: 'Claude Code'
        })
      });
      if (!res.ok) {
        throw new Error(`Failed to start Claude Code (${res.status})`);
      }
      const { session } = await res.json();
      setClaudeSessionIds(prev => (prev.includes(session.id) ? prev : [session.id, ...prev]));
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
    const session = terminalSessions.find(s => s.id === id);
    if (session && !session.isActive) {
      try {
        await apiFetch(`/api/terminal/${id}/restore`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({})
        });
      } catch (error) {
        console.error('Failed to restore session:', error);
      }
    }
    setClaudeSessionIds(prev => (prev.includes(id) ? prev : [id, ...prev]));
    setActiveClaudeCodeId(id);
    setLeftPanelMode('claude-code');
  }, [terminalSessions]);

  // Delete a Claude Code session
  const deleteClaudeCode = useCallback(async (id) => {
    try {
      await apiFetch(`/api/terminal/${id}`, { method: 'DELETE' });
      setClaudeSessionIds(prev => prev.filter(sessionId => sessionId !== id));
      if (activeClaudeCodeId === id) {
        setActiveClaudeCodeId(null);
        setLeftPanelMode('terminal');
      }
    } catch (error) {
      console.error('Failed to delete session:', error);
    }
  }, [activeClaudeCodeId]);

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
    deleteClaudeCode
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
