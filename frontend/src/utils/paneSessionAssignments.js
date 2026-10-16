export function reconcilePaneSessionIds(panes, visibleSessionIds) {
  const remainingSessionIds = [...visibleSessionIds];
  const usedSessionIds = new Set();

  const nextPanes = panes.map((pane) => {
    const sessionId = pane.sessionId ?? null;
    if (!sessionId) {
      return { ...pane, sessionId: null };
    }

    if (!remainingSessionIds.includes(sessionId) || usedSessionIds.has(sessionId)) {
      return { ...pane, sessionId: null };
    }

    usedSessionIds.add(sessionId);
    remainingSessionIds.splice(remainingSessionIds.indexOf(sessionId), 1);
    return { ...pane, sessionId };
  });

  return nextPanes.map((pane) => {
    if (pane.sessionId || remainingSessionIds.length === 0) {
      return pane;
    }

    const sessionId = remainingSessionIds.shift() ?? null;
    return { ...pane, sessionId };
  });
}

export function shouldInitializeWorkspacePane(activeSessionId, layout, visibleSessionIds) {
  if (!activeSessionId || !visibleSessionIds.includes(activeSessionId)) return false;
  const panes = layout?.panes || [];
  const activePane = panes.find(pane => pane.id === layout?.activePaneId);
  if (!activePane || activePane.sessionId === activeSessionId) return false;
  if (panes.length > 1 && activePane.sessionId) return false;
  return !panes.some(pane => pane.id !== activePane.id && pane.sessionId === activeSessionId);
}
