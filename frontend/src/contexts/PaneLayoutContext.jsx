import { createContext, useContext, useState, useEffect, useCallback } from 'react';

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

export function PaneLayoutProvider({ children }) {
  // Tree-based layout state
  const [paneLayout, setPaneLayout] = useState(() => {
    try {
      const saved = localStorage.getItem('paneLayout');
      if (saved) {
        return migrateLayout(JSON.parse(saved));
      }
    } catch {}
    return {
      root: { type: 'pane', id: 'pane-1', sessionId: null },
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
    if (!sessionId) return;

    setPaneLayout(prev => {
      const newRoot = cloneNode(prev.root);
      const found = findPaneInTree(newRoot, prev.activePaneId);
      if (found) {
        found.node.sessionId = sessionId;
      }
      return { ...prev, root: newRoot };
    });
  }, []);

  // Handle session selection in a specific pane
  const setPaneSession = useCallback((paneId, sessionId) => {
    setPaneLayout(prev => {
      const newRoot = cloneNode(prev.root);
      const found = findPaneInTree(newRoot, paneId);
      if (found) {
        found.node.sessionId = sessionId;
      }
      return { ...prev, root: newRoot };
    });
    return sessionId;
  }, []);

  // Handle pane focus
  const focusPane = useCallback((paneId) => {
    setPaneLayout(prev => ({ ...prev, activePaneId: paneId }));
    const panes = getAllPanes(paneLayout.root);
    const pane = panes.find(p => p.id === paneId);
    return pane?.sessionId || null;
  }, [paneLayout.root]);

  // Handle pane split
  const splitPane = useCallback((paneId, direction) => {
    setPaneLayout(prev => {
      const paneCount = countPanes(prev.root);
      if (paneCount >= MAX_PANES) return prev;

      const newRoot = cloneNode(prev.root);
      const found = findPaneInTree(newRoot, paneId);
      if (!found) return prev;

      const newPaneId = `pane-${Date.now()}`;
      const newPane = { type: 'pane', id: newPaneId, sessionId: null };

      // If this is the root pane (no parent), create a new split
      if (!found.parent) {
        return {
          ...prev,
          root: {
            type: 'split',
            direction,
            children: [found.node, newPane]
          }
        };
      }

      // If parent split direction matches, add sibling
      if (found.parent.direction === direction) {
        found.parent.children.splice(found.index + 1, 0, newPane);
      } else {
        // Replace pane with a new split containing original + new pane
        found.parent.children[found.index] = {
          type: 'split',
          direction,
          children: [found.node, newPane]
        };
      }

      return { ...prev, root: simplifyTree(newRoot) };
    });
  }, []);

  // Handle pane close
  const closePane = useCallback((paneId) => {
    // Exit fullscreen if closing the fullscreen pane
    if (paneId === fullscreenPaneId) {
      setFullscreenPaneId(null);
    }

    setPaneLayout(prev => {
      const paneCount = countPanes(prev.root);
      if (paneCount <= 1) return prev;

      const newRoot = removePaneFromTree(cloneNode(prev.root), paneId);
      if (!newRoot) return prev;

      // Update active pane if needed
      let newActivePaneId = prev.activePaneId;
      if (paneId === prev.activePaneId) {
        const panes = getAllPanes(newRoot);
        newActivePaneId = panes[0]?.id || 'pane-1';
      }

      return {
        root: newRoot,
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
    countPanes: () => countPanes(paneLayout.root)
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
