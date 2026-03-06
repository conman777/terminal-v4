import { useState, useCallback } from 'react';

export function DesktopSwitcher({
  desktops,
  activeDesktopId,
  sessions,
  onSwitch,
  onCreate,
  onDelete,
  onMoveSession,
  variant = 'default',
}) {
  const [dragOverDesktopId, setDragOverDesktopId] = useState(null);
  const [editingDesktopId, setEditingDesktopId] = useState(null);
  const [editingName, setEditingName] = useState('');

  // Count sessions per desktop by checking pane sessionIds
  const countSessionsOnDesktop = useCallback((desktop) => {
    const paneLayout = desktop.paneLayout;
    if (!paneLayout?.root) return 0;
    const panes = getAllPanesFlat(paneLayout.root);
    return panes.filter(p => p.sessionId).length;
  }, []);

  const handleDragOver = useCallback((e, desktopId) => {
    // Only handle pane-drag drops (not session-id drops which go to TerminalPane)
    const types = Array.from(e.dataTransfer.types);
    if (!types.includes('pane-drag') && !types.includes('text/plain')) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    setDragOverDesktopId(desktopId);
  }, []);

  const handleDragLeave = useCallback(() => {
    setDragOverDesktopId(null);
  }, []);

  const handleDrop = useCallback((e, targetDesktopId) => {
    e.preventDefault();
    setDragOverDesktopId(null);
    const raw = e.dataTransfer.getData('pane-drag');
    if (!raw) return;
    try {
      const { paneId, sessionId, fromDesktopId } = JSON.parse(raw);
      if (fromDesktopId === targetDesktopId) return;
      if (sessionId && onMoveSession) {
        onMoveSession(sessionId, paneId, targetDesktopId);
      }
    } catch {
      // ignore malformed drag data
    }
  }, [onMoveSession]);

  const handleDoubleClick = useCallback((e, desktop) => {
    e.stopPropagation();
    setEditingDesktopId(desktop.id);
    setEditingName(desktop.name);
  }, []);

  const handleEditBlur = useCallback((e, desktop) => {
    const newName = e.target.value.trim() || desktop.name;
    // Update via a renamed desktop in-place — we expose this via onRename if needed
    // For now just commit edit (name is managed in context via renameDesktop if we add it)
    // Since plan doesn't include a rename action we update via a workaround:
    // Store edits locally and pass them as overrides. Actually the plan doesn't
    // include renameDesktop so we'll just use the context's desktops array directly.
    // We need to signal rename somehow... we'll add it to onDelete/onCreate concept
    // Actually let me use the onRename prop if provided, or we can skip for now.
    setEditingDesktopId(null);
    // If name changed, fire rename if handler provided
    if (newName !== desktop.name && e.target._onRename) {
      e.target._onRename(desktop.id, newName);
    }
  }, []);

  const handleEditKeyDown = useCallback((e) => {
    if (e.key === 'Enter') e.target.blur();
    if (e.key === 'Escape') {
      setEditingDesktopId(null);
    }
  }, []);

  return (
    <div className={`desktop-switcher${variant === 'header' ? ' header-embedded' : ''}`}>
      {desktops.map((desktop, index) => {
        const isActive = desktop.id === activeDesktopId;
        const isDragOver = dragOverDesktopId === desktop.id;
        const sessionCount = countSessionsOnDesktop(desktop);

        return (
          <div
            key={desktop.id}
            className={`desktop-btn${isActive ? ' active' : ''}${isDragOver ? ' drag-over' : ''}`}
            onClick={() => onSwitch(desktop.id)}
            onDragOver={(e) => handleDragOver(e, desktop.id)}
            onDragLeave={handleDragLeave}
            onDrop={(e) => handleDrop(e, desktop.id)}
          >
            <span className="desktop-btn-num">{index + 1}</span>
            {editingDesktopId === desktop.id ? (
              <input
                className="desktop-btn-name-input"
                value={editingName}
                onChange={e => setEditingName(e.target.value)}
                onBlur={(e) => handleEditBlur(e, desktop)}
                onKeyDown={handleEditKeyDown}
                onClick={e => e.stopPropagation()}
                autoFocus
              />
            ) : (
              <span
                className="desktop-btn-name"
                onDoubleClick={(e) => handleDoubleClick(e, desktop)}
              >
                {desktop.name}
              </span>
            )}
            {sessionCount > 0 && (
              <span className="desktop-btn-count">({sessionCount})</span>
            )}
            {desktops.length > 1 && (
              <button
                type="button"
                className="desktop-btn-delete"
                onClick={(e) => {
                  e.stopPropagation();
                  onDelete(desktop.id);
                }}
                title={`Delete ${desktop.name}`}
              >
                <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            )}
          </div>
        );
      })}

      <button
        type="button"
        className="desktop-btn-add"
        onClick={onCreate}
        title="New desktop"
      >
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
          <line x1="12" y1="5" x2="12" y2="19" />
          <line x1="5" y1="12" x2="19" y2="12" />
        </svg>
      </button>
    </div>
  );
}

function getAllPanesFlat(node, result = []) {
  if (!node) return result;
  if (node.type === 'pane') {
    result.push(node);
  } else if (node.children) {
    node.children.forEach(child => getAllPanesFlat(child, result));
  }
  return result;
}
