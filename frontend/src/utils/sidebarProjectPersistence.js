export function persistSidebarProject(addSidebarProject, explicitPath, session) {
  if (typeof addSidebarProject !== 'function') {
    return false;
  }

  const projectPath = (
    explicitPath
    || session?.thread?.projectPath
    || session?.cwd
    || ''
  ).trim();

  if (!projectPath) {
    return false;
  }

  addSidebarProject(projectPath);
  return true;
}
