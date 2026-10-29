import { normalizeProjectPath } from './projectPaths';

function threadPath(session) {
  return normalizeProjectPath(session.thread?.projectPath || session.cwd);
}

function delegatedThreadId(task, known) {
  const child = task?.childSessionId;
  if (typeof child !== 'string' || !child) return null;
  return known.has(child) || child.startsWith('ss-') ? child : `ss-${child}`;
}

export function buildThreadLineage({ threadId, sessions, links = [], tasks = [] }) {
  const known = new Map(sessions.map(session => [session.id, session]));
  const entry = (id, kind) => ({ id, kind, session: known.get(id) || null });
  const edges = [];
  for (const link of links) edges.push({ child: link.childId, parent: link.parentId, kind: link.kind });
  for (const task of tasks) {
    const child = delegatedThreadId(task, known);
    if (child && typeof task.parentSessionId === 'string' && task.parentSessionId) edges.push({ child, parent: task.parentSessionId, kind: 'delegated' });
  }
  const usable = edges.filter(edge => edge.child !== edge.parent);
  const seen = new Set();
  const childrenOf = kind => usable
    .filter(edge => edge.parent === threadId && edge.kind === kind && !seen.has(`${kind}:${edge.child}`) && seen.add(`${kind}:${edge.child}`))
    .map(edge => entry(edge.child, kind));
  const parentEdge = usable.find(edge => edge.child === threadId);
  const forks = childrenOf('fork');
  const delegated = childrenOf('delegated');
  const linkedWorktrees = childrenOf('worktree');

  const self = known.get(threadId);
  const selfPath = self ? threadPath(self) : '';
  const selfCwd = self ? normalizeProjectPath(self.cwd) : '';
  const claimed = new Set([threadId, ...forks.map(item => item.id), ...delegated.map(item => item.id), ...linkedWorktrees.map(item => item.id)]);
  const siblings = self && selfPath
    ? sessions.filter(session => !claimed.has(session.id) && threadPath(session) === selfPath && normalizeProjectPath(session.cwd) !== selfCwd).map(session => entry(session.id, 'worktree'))
    : [];

  return {
    parent: parentEdge ? entry(parentEdge.parent, parentEdge.kind) : null,
    forks,
    delegated,
    worktrees: [...siblings, ...linkedWorktrees],
  };
}
