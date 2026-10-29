import { isStructuredSessionId } from './structuredSessions';

export function resolveWorktreeOrigin(sessions, activeSessionId) {
  if (!isStructuredSessionId(activeSessionId)) return null;
  const session = (Array.isArray(sessions) ? sessions : []).find(item => item?.id === activeSessionId);
  if (!session) return null;
  const paths = [session.cwd, session.thread?.projectPath].filter(path => typeof path === 'string' && path);
  return paths.length ? { id: session.id, paths } : null;
}

export function worktreeParentFor(origin, selectedPath, childId) {
  return origin?.id && childId && origin.id !== childId && origin.paths?.includes(selectedPath) ? origin.id : null;
}
