export function persistSidebarProject(addSidebarProject, explicitPath, session) {
  if (typeof addSidebarProject !== 'function') {
    return false;
  }

  const projectPath = (
    session?.thread?.projectPath
    || session?.cwd
    || explicitPath
    || ''
  ).trim();

  if (!projectPath) {
    return false;
  }

  addSidebarProject(projectPath);
  return true;
}
