export function resolveStartupWorkspacePath(projectCwd, recentFolders = []) {
  if (typeof projectCwd === 'string' && projectCwd.trim()) {
    return projectCwd;
  }

  if (Array.isArray(recentFolders)) {
    const firstRecentFolder = recentFolders.find((folderPath) => typeof folderPath === 'string' && folderPath.trim());
    if (firstRecentFolder) {
      return firstRecentFolder;
    }
  }

  return '';
}

export function createWorkspaceAutoStartKey(activeDesktopId, workspacePath) {
  const path = typeof workspacePath === 'string' ? workspacePath.trim() : '';
  if (!path) return '';
  return `${activeDesktopId || 'default'}:${path}`;
}

export function shouldAutoStartWorkspaceSession({
  loadingSessions,
  visibleSessionCount,
  autoStartKey,
  lastAutoStartKey,
}) {
  if (loadingSessions) return false;
  if ((visibleSessionCount || 0) > 0) return false;
  if (!autoStartKey) return false;
  return autoStartKey !== lastAutoStartKey;
}
