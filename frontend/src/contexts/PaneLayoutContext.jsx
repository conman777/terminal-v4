import { createContext, useContext, useState, useEffect, useCallback } from 'react';

const PaneLayoutContext = createContext(null);

export function PaneLayoutProvider({ children }) {
  // Split pane layout state
  const [paneLayout, setPaneLayout] = useState(() => {
    try {
      const saved = localStorage.getItem('paneLayout');
      if (saved) {
        return JSON.parse(saved);
      }
    } catch {}
    return {
      type: 'single',
      panes: [{ id: 'pane-1', sessionId: null }],
      activePaneId: 'pane-1'
    };
  });

  // Fullscreen pane state (not persisted - temporary)
  const [fullscreenPaneId, setFullscreenPaneId] = useState(null);

  // Split handle dragging state
  const [splitPosition, setSplitPosition] = useState(50);
  const [isDragging, setIsDragging] = useState(false);

  // Save pane layout to localStorage when it changes
  useEffect(() => {
    try {
      localStorage.setItem('paneLayout', JSON.stringify(paneLayout));
    } catch {}
  }, [paneLayout]);

  // Initialize first pane with active session if not set (called from App)
  const initializePaneWithSession = useCallback((sessionId) => {
    if (sessionId && paneLayout.panes[0]?.sessionId === null) {
      setPaneLayout(prev => ({
        ...prev,
        panes: prev.panes.map((pane, i) =>
          i === 0 ? { ...pane, sessionId } : pane
        )
      }));
    }
  }, [paneLayout.panes]);

  // Handle session selection in a specific pane
  const setPaneSession = useCallback((paneId, sessionId) => {
    setPaneLayout(prev => ({
      ...prev,
      panes: prev.panes.map(pane =>
        pane.id === paneId ? { ...pane, sessionId } : pane
      )
    }));
    return sessionId;
  }, []);

  // Handle pane focus
  const focusPane = useCallback((paneId) => {
    setPaneLayout(prev => ({
      ...prev,
      activePaneId: paneId
    }));
    const pane = paneLayout.panes.find(p => p.id === paneId);
    return pane?.sessionId || null;
  }, [paneLayout.panes]);

  // Handle pane split
  const splitPane = useCallback((paneId, direction) => {
    setPaneLayout(prev => {
      if (prev.panes.length >= 4) return prev;

      const newPaneId = `pane-${Date.now()}`;
      let newType = prev.type;
      let newPanes = [...prev.panes];

      if (prev.type === 'single') {
        newType = direction === 'horizontal' ? 'horizontal' : 'vertical';
        newPanes.push({ id: newPaneId, sessionId: null });
      } else if (prev.type === 'horizontal' && direction === 'vertical') {
        newType = 'grid';
        newPanes.push({ id: newPaneId, sessionId: null });
      } else if (prev.type === 'vertical' && direction === 'horizontal') {
        newType = 'grid';
        newPanes.push({ id: newPaneId, sessionId: null });
      } else if (prev.type === 'horizontal' || prev.type === 'vertical') {
        newType = 'grid';
        newPanes.push({ id: newPaneId, sessionId: null });
      } else if (prev.type === 'grid' && prev.panes.length < 4) {
        newPanes.push({ id: newPaneId, sessionId: null });
      }

      return {
        ...prev,
        type: newType,
        panes: newPanes
      };
    });
  }, []);

  // Handle pane close
  const closePane = useCallback((paneId) => {
    // Exit fullscreen if closing the fullscreen pane
    if (paneId === fullscreenPaneId) {
      setFullscreenPaneId(null);
    }

    setPaneLayout(prev => {
      if (prev.panes.length <= 1) return prev;

      const newPanes = prev.panes.filter(p => p.id !== paneId);
      let newType = prev.type;

      if (newPanes.length === 1) {
        newType = 'single';
      } else if (newPanes.length === 2) {
        newType = prev.type === 'vertical' ? 'vertical' : 'horizontal';
      } else if (newPanes.length === 3) {
        newType = 'grid';
      }

      let newActivePaneId = prev.activePaneId;
      if (paneId === prev.activePaneId) {
        newActivePaneId = newPanes[0]?.id || 'pane-1';
      }

      return {
        type: newType,
        panes: newPanes,
        activePaneId: newActivePaneId
      };
    });
  }, [fullscreenPaneId]);

  // Handle pane fullscreen toggle
  const toggleFullscreen = useCallback((paneId) => {
    setFullscreenPaneId(prev => prev === paneId ? null : paneId);
  }, []);

  // Exit fullscreen
  const exitFullscreen = useCallback(() => {
    setFullscreenPaneId(null);
  }, []);

  // Escape key to exit fullscreen
  useEffect(() => {
    if (!fullscreenPaneId) return;

    const handleKeyDown = (e) => {
      if (e.key === 'Escape') {
        setFullscreenPaneId(null);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [fullscreenPaneId]);

  // Split handle drag start
  const startDragging = useCallback((e) => {
    e.preventDefault();
    setIsDragging(true);
  }, []);

  // Handle drag position update (called from parent with container ref)
  const updateSplitPosition = useCallback((newPosition) => {
    setSplitPosition(Math.min(80, Math.max(20, newPosition)));
  }, []);

  // Stop dragging
  const stopDragging = useCallback(() => {
    setIsDragging(false);
  }, []);

  const value = {
    // Pane layout state
    paneLayout,
    fullscreenPaneId,
    splitPosition,
    isDragging,

    // Pane actions
    initializePaneWithSession,
    setPaneSession,
    focusPane,
    splitPane,
    closePane,
    toggleFullscreen,
    exitFullscreen,

    // Split handle actions
    startDragging,
    updateSplitPosition,
    stopDragging,
    setIsDragging
  };

  return (
    <PaneLayoutContext.Provider value={value}>
      {children}
    </PaneLayoutContext.Provider>
  );
}

export function usePaneLayout() {
  const context = useContext(PaneLayoutContext);
  if (!context) {
    throw new Error('usePaneLayout must be used within a PaneLayoutProvider');
  }
  return context;
}
