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
