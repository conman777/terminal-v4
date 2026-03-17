function buildVisibleSessionIdSet(activeSessions) {
  return new Set(
    (activeSessions || [])
      .map((session) => session?.id)
      .filter(Boolean)
  );
}

function filterSessionsById(sessions, visibleIds) {
  return (sessions || []).filter((session) => visibleIds.has(session?.id));
}

export function scopeThreadsSidebarData({
  sessionsGroupedByProject,
  pinnedSessions,
  archivedSessions,
  activeSessions
}) {
  const visibleIds = buildVisibleSessionIdSet(activeSessions);

  return {
    sessionsGroupedByProject: (sessionsGroupedByProject || [])
      .map((group) => ({
        ...group,
        sessions: filterSessionsById(group.sessions, visibleIds)
      }))
      .filter((group) => group.sessions.length > 0),
    pinnedSessions: filterSessionsById(pinnedSessions, visibleIds),
    archivedSessions: filterSessionsById(archivedSessions, visibleIds)
  };
}
