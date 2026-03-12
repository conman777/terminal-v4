import { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { reconcilePaneSessionIds } from '../utils/paneSessionAssignments';

const PaneLayoutContext = createContext(null);

const MAX_PANES = 8;

// Helper: Count total panes in tree
function countPanes(node) {
  if (!node) return 0;
  if (node.type === 'pane') return 1;
  return node.children.reduce((sum, child) => sum + countPanes(child), 0);
}

// Helper: Get all panes as flat array
function getAllPanes(node, result = []) {
  if (!node) return result;
  if (node.type === 'pane') {
    result.push(node);
  } else if (node.children) {
    node.children.forEach(child => getAllPanes(child, result));
  }
  return result;
}

// Helper: Find pane and its parent in tree
function findPaneInTree(node, paneId, parent = null, index = -1) {
  if (!node) return null;
  if (node.type === 'pane' && node.id === paneId) {
    return { node, parent, index };
  }
  if (node.children) {
    for (let i = 0; i < node.children.length; i++) {
      const result = findPaneInTree(node.children[i], paneId, node, i);
      if (result) return result;
    }
  }
  return null;
}

// Helper: Deep clone a node
function cloneNode(node) {
  if (!node) return null;
  if (node.type === 'pane') {
    return { ...node };
  }
  return {
    ...node,
    children: node.children.map(cloneNode)
  };
}

// Helper: Simplify tree (remove single-child splits)
function simplifyTree(node) {
  if (!node || node.type === 'pane') return node;

  // Recursively simplify children first
  node.children = node.children.map(simplifyTree);

  // If split has only one child, replace with that child
  if (node.children.length === 1) {
    return node.children[0];
  }

  // Flatten nested splits with same direction
  const newChildren = [];
  for (const child of node.children) {
    if (child.type === 'split' && child.direction === node.direction) {
      newChildren.push(...child.children);
    } else {
      newChildren.push(child);
    }
  }
  node.children = newChildren;

  return node;
}

// Helper: Remove pane from tree
function removePaneFromTree(root, paneId) {
  if (!root) return null;
  if (root.type === 'pane') {
    return root.id === paneId ? null : root;
  }

  const newChildren = root.children
    .map(child => removePaneFromTree(child, paneId))
    .filter(Boolean);

  if (newChildren.length === 0) return null;

  return simplifyTree({ ...root, children: newChildren });
}

// Migrate old flat layout to tree structure
function migrateLayout(saved) {
  // Already tree-based
  if (saved.root) return saved;

  // Old flat structure: { type, panes, activePaneId }
  const { type, panes, activePaneId } = saved;

  if (!panes || panes.length === 0) {
    return {
      root: { type: 'pane', id: 'pane-1', sessionId: null },
      activePaneId: 'pane-1'
    };
  }

  if (panes.length === 1) {
    return {
      root: { type: 'pane', id: panes[0].id, sessionId: panes[0].sessionId },
      activePaneId: activePaneId || panes[0].id
    };
  }

  // Multiple panes - create appropriate split
  let direction = 'horizontal';
  if (type === 'vertical') direction = 'vertical';
  else if (type === 'grid') direction = 'vertical'; // Grid becomes vertical split of horizontal rows

  if (type === 'grid' && panes.length >= 2) {
    // Convert grid to nested structure: 2 columns per row
    const rows = [];
    for (let i = 0; i < panes.length; i += 2) {
      if (i + 1 < panes.length) {
        rows.push({
          type: 'split',
          direction: 'horizontal',
          children: [
            { type: 'pane', id: panes[i].id, sessionId: panes[i].sessionId },
            { type: 'pane', id: panes[i + 1].id, sessionId: panes[i + 1].sessionId }
          ]
        });
      } else {
        rows.push({ type: 'pane', id: panes[i].id, sessionId: panes[i].sessionId });
      }
    }

    return {
      root: rows.length === 1 ? rows[0] : { type: 'split', direction: 'vertical', children: rows },
      activePaneId: activePaneId || panes[0].id
    };
  }

  // Horizontal or vertical - simple linear split
  return {
    root: {
      type: 'split',
      direction,
      children: panes.map(p => ({ type: 'pane', id: p.id, sessionId: p.sessionId }))
    },
    activePaneId: activePaneId || panes[0].id
  };
}

function defaultPaneLayout() {
  return {
    root: { type: 'pane', id: 'pane-1', sessionId: null },
    activePaneId: 'pane-1'
  };
}

function loadDesktopsFromStorage() {
  try {
    const saved = localStorage.getItem('desktops');
    if (saved) {
      const parsed = JSON.parse(saved);
      // Migrate: add ownedSessionIds if not yet present (derived from pane assignments)
      return {
        ...parsed,
        desktops: parsed.desktops.map(d => ({
          ...d,
          ownedSessionIds: d.ownedSessionIds || getAllPanes((d.paneLayout || defaultPaneLayout()).root).map(p => p.sessionId).filter(Boolean)
        }))
      };
    }

    // Migrate old single layout
    const oldLayout = localStorage.getItem('paneLayout');
    let paneLayout;
    if (oldLayout) {
      paneLayout = migrateLayout(JSON.parse(oldLayout));
      localStorage.removeItem('paneLayout');
    } else {
      paneLayout = defaultPaneLayout();
    }

    return {
      activeDesktopId: 'desktop-1',
      desktops: [{
        id: 'desktop-1',
        name: 'Desktop 1',
        paneLayout,
        ownedSessionIds: getAllPanes(paneLayout.root).map(p => p.sessionId).filter(Boolean)
      }]
    };
  } catch {
    return {
      activeDesktopId: 'desktop-1',
      desktops: [{
        id: 'desktop-1',
        name: 'Desktop 1',
        paneLayout: defaultPaneLayout(),
        ownedSessionIds: []
      }]
    };
  }
}

// Helper to update active desktop's paneLayout immutably
export function updateActiveDesktopLayout(desktopsState, updater) {
  const { activeDesktopId, desktops } = desktopsState;
  let changed = false;

  const nextDesktops = desktops.map((desktop) => {
    if (desktop.id !== activeDesktopId) {
      return desktop;
    }

    const nextLayout = updater(desktop.paneLayout);
    if (nextLayout === desktop.paneLayout) {
      return desktop;
    }

    changed = true;
    return { ...desktop, paneLayout: nextLayout };
  });

  if (!changed) {
    return desktopsState;
  }

  return {
    ...desktopsState,
    desktops: nextDesktops
  };
}

export function PaneLayoutProvider({ children }) {
  // Multi-desktop state
  const [desktopsState, setDesktopsState] = useState(() => loadDesktopsFromStorage());

  // Fullscreen pane state (not persisted - temporary)
  const [fullscreenPaneId, setFullscreenPaneId] = useState(null);

  // Split handle dragging state
  const [splitPosition, setSplitPosition] = useState(50);
  const [isDragging, setIsDragging] = useState(false);

  // Derive active desktop and its paneLayout
  const activeDesktop = desktopsState.desktops.find(d => d.id === desktopsState.activeDesktopId)
    || desktopsState.desktops[0];
  const paneLayout = activeDesktop.paneLayout;

  // Save desktops state to localStorage on every change
  useEffect(() => {
    try {
      localStorage.setItem('desktops', JSON.stringify(desktopsState));
    } catch {}
  }, [desktopsState]);

  // Initialize first pane with active session if not set (called from App)
  const initializePaneWithSession = useCallback((sessionId) => {
    if (!sessionId) return;

    setDesktopsState(prev => {
      const { activeDesktopId, desktops } = prev;
      return {
        ...prev,
        desktops: desktops.map(d => {
          if (d.id !== activeDesktopId) return d;
          const layout = d.paneLayout;
          const newRoot = cloneNode(layout.root);
          const found = findPaneInTree(newRoot, layout.activePaneId);
          if (found) found.node.sessionId = sessionId;
          const owned = d.ownedSessionIds || [];
          return {
            ...d,
            paneLayout: { ...layout, root: newRoot },
            ownedSessionIds: owned.includes(sessionId) ? owned : [...owned, sessionId]
          };
        })
      };
    });
  }, []);

  // Add a session to the active desktop's owned list (without pane assignment)
  const addSessionToDesktop = useCallback((sessionId) => {
    if (!sessionId) return;
    setDesktopsState(prev => {
      const { activeDesktopId, desktops } = prev;
      return {
        ...prev,
        desktops: desktops.map(d => {
          if (d.id !== activeDesktopId) return d;
          const owned = d.ownedSessionIds || [];
          if (owned.includes(sessionId)) return d;
          return { ...d, ownedSessionIds: [...owned, sessionId] };
        })
      };
    });
  }, []);

  // Handle session selection in a specific pane
  const setPaneSession = useCallback((paneId, sessionId) => {
    setDesktopsState(prev => updateActiveDesktopLayout(prev, (layout) => {
      const newRoot = cloneNode(layout.root);
      const found = findPaneInTree(newRoot, paneId);
      if (!found) {
        return layout;
      }

      if ((found.node.sessionId ?? null) === (sessionId ?? null)) {
        return layout;
      }

      found.node.sessionId = sessionId;
      return { ...layout, root: newRoot };
    }));
    return sessionId;
  }, []);

  const reconcilePaneSessions = useCallback((visibleSessionIds) => {
    setDesktopsState(prev => updateActiveDesktopLayout(prev, (layout) => {
      const newRoot = cloneNode(layout.root);
      const panes = getAllPanes(newRoot);
      const nextAssignments = reconcilePaneSessionIds(panes, visibleSessionIds);
      let changed = false;

      panes.forEach((pane, index) => {
        const nextSessionId = nextAssignments[index]?.sessionId ?? null;
        if ((pane.sessionId ?? null) !== nextSessionId) {
          pane.sessionId = nextSessionId;
          changed = true;
        }
      });

      if (!changed) {
        return layout;
      }

      return { ...layout, root: newRoot };
    }));
  }, []);

  // Handle pane focus
  const focusPane = useCallback((paneId) => {
    setDesktopsState(prev => updateActiveDesktopLayout(prev, (layout) => {
      if (layout.activePaneId === paneId) {
        return layout;
      }

      return {
        ...layout,
        activePaneId: paneId
      };
    }));
    const panes = getAllPanes(paneLayout.root);
    const pane = panes.find(p => p.id === paneId);
    return pane?.sessionId || null;
  }, [paneLayout.root]);

  // Handle pane split
  const splitPane = useCallback((paneId, direction) => {
    setDesktopsState(prev => updateActiveDesktopLayout(prev, (layout) => {
      const paneCount = countPanes(layout.root);
      if (paneCount >= MAX_PANES) return layout;

      const newRoot = cloneNode(layout.root);
      const found = findPaneInTree(newRoot, paneId);
      if (!found) return layout;

      const newPaneId = `pane-${Date.now()}`;
      const newPane = { type: 'pane', id: newPaneId, sessionId: null };

      if (!found.parent) {
        return {
          ...layout,
          root: {
            type: 'split',
            direction,
            children: [found.node, newPane]
          }
        };
      }

      if (found.parent.direction === direction) {
        found.parent.children.splice(found.index + 1, 0, newPane);
      } else {
        found.parent.children[found.index] = {
          type: 'split',
          direction,
          children: [found.node, newPane]
        };
      }

      return { ...layout, root: simplifyTree(newRoot) };
    }));
  }, []);

  // Handle pane close (only on active desktop)
  const closePane = useCallback((paneId) => {
    if (paneId === fullscreenPaneId) {
      setFullscreenPaneId(null);
    }

    setDesktopsState(prev => updateActiveDesktopLayout(prev, (layout) => {
      const paneCount = countPanes(layout.root);
      if (paneCount <= 1) return layout;

      const newRoot = removePaneFromTree(cloneNode(layout.root), paneId);
      if (!newRoot) return layout;

      let newActivePaneId = layout.activePaneId;
      if (paneId === layout.activePaneId) {
        const panes = getAllPanes(newRoot);
        newActivePaneId = panes[0]?.id || 'pane-1';
      }

      return { root: newRoot, activePaneId: newActivePaneId };
    }));
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

  // ── Desktop management actions ──

  const createDesktop = useCallback(() => {
    const newId = `desktop-${Date.now()}`;
    setDesktopsState(prev => {
      const newDesktop = {
        id: newId,
        name: `Desktop ${prev.desktops.length + 1}`,
        paneLayout: defaultPaneLayout(),
        ownedSessionIds: []
      };
      return {
        activeDesktopId: newId,
        desktops: [...prev.desktops, newDesktop]
      };
    });
  }, []);

  const switchDesktop = useCallback((id) => {
    setDesktopsState(prev => {
      if (!prev.desktops.find(d => d.id === id)) return prev;
      return { ...prev, activeDesktopId: id };
    });
    // Exit fullscreen when switching desktops
    setFullscreenPaneId(null);
  }, []);

  const deleteDesktop = useCallback((id) => {
    setDesktopsState(prev => {
      if (prev.desktops.length <= 1) return prev;
      const remaining = prev.desktops.filter(d => d.id !== id);
      const newActiveId = prev.activeDesktopId === id ? remaining[0].id : prev.activeDesktopId;
      return { activeDesktopId: newActiveId, desktops: remaining };
    });
    setFullscreenPaneId(null);
  }, []);

  const renameDesktop = useCallback((id, name) => {
    const trimmed = (name || '').trim();
    if (!trimmed) return;
    setDesktopsState(prev => ({
      ...prev,
      desktops: prev.desktops.map(d =>
        d.id === id ? { ...d, name: trimmed } : d
      )
    }));
  }, []);

  const moveSessionToDesktop = useCallback((sessionId, sourcePaneId, targetDesktopId) => {
    setDesktopsState(prev => {
      const { activeDesktopId, desktops } = prev;
      if (targetDesktopId === activeDesktopId) return prev;

      // 1. Remove pane from source desktop (active desktop) and revoke ownership
      let newDesktops = desktops.map(d => {
        if (d.id !== activeDesktopId) return d;
        const layout = d.paneLayout;
        const paneCount = countPanes(layout.root);
        const newOwned = (d.ownedSessionIds || []).filter(id => id !== sessionId);
        if (paneCount <= 1) {
          // Can't remove the last pane — just clear its session
          const newRoot = cloneNode(layout.root);
          const found = findPaneInTree(newRoot, sourcePaneId);
          if (found) found.node.sessionId = null;
          return { ...d, paneLayout: { ...layout, root: newRoot }, ownedSessionIds: newOwned };
        }
        const newRoot = removePaneFromTree(cloneNode(layout.root), sourcePaneId);
        if (!newRoot) return d;
        let newActivePaneId = layout.activePaneId;
        if (sourcePaneId === layout.activePaneId) {
          const panes = getAllPanes(newRoot);
          newActivePaneId = panes[0]?.id || 'pane-1';
        }
        return { ...d, paneLayout: { root: newRoot, activePaneId: newActivePaneId }, ownedSessionIds: newOwned };
      });

      // 2. Add session to target desktop (pane + ownership)
      newDesktops = newDesktops.map(d => {
        if (d.id !== targetDesktopId) return d;
        const layout = d.paneLayout;
        const panes = getAllPanes(layout.root);
        // Transfer ownership
        const owned = d.ownedSessionIds || [];
        const newOwned = owned.includes(sessionId) ? owned : [...owned, sessionId];
        // If there's an empty pane, use it
        const emptyPane = panes.find(p => !p.sessionId);
        if (emptyPane) {
          const newRoot = cloneNode(layout.root);
          const found = findPaneInTree(newRoot, emptyPane.id);
          if (found) found.node.sessionId = sessionId;
          return { ...d, paneLayout: { ...layout, root: newRoot }, ownedSessionIds: newOwned };
        }
        // Otherwise split the active pane
        const activePaneInTarget = panes.find(p => p.id === layout.activePaneId) || panes[0];
        if (!activePaneInTarget) return { ...d, ownedSessionIds: newOwned };
        const newPaneId = `pane-${Date.now()}`;
        const newPane = { type: 'pane', id: newPaneId, sessionId };
        const newRoot = cloneNode(layout.root);
        const found = findPaneInTree(newRoot, activePaneInTarget.id);
        if (!found) return { ...d, ownedSessionIds: newOwned };
        if (!found.parent) {
          return {
            ...d,
            paneLayout: {
              root: { type: 'split', direction: 'horizontal', children: [found.node, newPane] },
              activePaneId: newPaneId
            },
            ownedSessionIds: newOwned
          };
        }
        found.parent.children.splice(found.index + 1, 0, newPane);
        return { ...d, paneLayout: { root: simplifyTree(newRoot), activePaneId: newPaneId }, ownedSessionIds: newOwned };
      });

      return { activeDesktopId: targetDesktopId, desktops: newDesktops };
    });
    setFullscreenPaneId(null);
  }, []);

  // Compute legacy-compatible layout object for components that need it
  const legacyLayout = {
    type: paneLayout.root.type === 'pane' ? 'single' : paneLayout.root.direction,
    panes: getAllPanes(paneLayout.root),
    activePaneId: paneLayout.activePaneId
  };

  const value = {
    // Tree-based layout
    paneLayout,
    // Legacy flat layout for backward compatibility
    legacyLayout,

    fullscreenPaneId,
    splitPosition,
    isDragging,

    // Pane actions
    initializePaneWithSession,
    setPaneSession,
    reconcilePaneSessions,
    focusPane,
    splitPane,
    closePane,
    toggleFullscreen,
    exitFullscreen,

    // Split handle actions
    startDragging,
    updateSplitPosition,
    stopDragging,
    setIsDragging,

    // Helpers
    getAllPanes: () => getAllPanes(paneLayout.root),
    countPanes: () => countPanes(paneLayout.root),

    // Desktop management
    desktops: desktopsState.desktops,
    activeDesktopId: desktopsState.activeDesktopId,
    createDesktop,
    switchDesktop,
    deleteDesktop,
    renameDesktop,
    moveSessionToDesktop,
    addSessionToDesktop,
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
