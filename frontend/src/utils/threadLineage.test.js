import { describe, expect, it } from 'vitest';
import { buildThreadLineage } from './threadLineage';

const t = (id, extra = {}) => ({ id, title: id, cwd: '/repo', thread: { topic: id, projectPath: '/repo' }, ...extra });
const view = lineage => ({
  parent: lineage.parent && [lineage.parent.id, lineage.parent.kind, Boolean(lineage.parent.session)],
  forks: lineage.forks.map(item => item.id),
  delegated: lineage.delegated.map(item => item.id),
  worktrees: lineage.worktrees.map(item => item.id),
});

describe('buildThreadLineage', () => {
  it('reports no relations for an unrelated thread', () => {
    expect(view(buildThreadLineage({ threadId: 'a', sessions: [t('a'), t('b')], links: [], tasks: [] }))).toEqual({ parent: null, forks: [], delegated: [], worktrees: [] });
  });

  it('finds the fork parent and fork children from saved links', () => {
    const links = [{ childId: 'b', parentId: 'a', kind: 'fork' }, { childId: 'c', parentId: 'a', kind: 'fork' }];
    const sessions = [t('a'), t('b'), t('c')];
    expect(view(buildThreadLineage({ threadId: 'b', sessions, links, tasks: [] })).parent).toEqual(['a', 'fork', true]);
    expect(view(buildThreadLineage({ threadId: 'a', sessions, links, tasks: [] })).forks).toEqual(['b', 'c']);
  });

  it('maps delegated task children onto their ss- thread ids and finds the delegating parent', () => {
    const tasks = [{ id: 'k1', parentSessionId: 'ss-parent', childSessionId: '1111' }, { id: 'k2', parentSessionId: 'ss-parent', childSessionId: null }];
    const sessions = [t('ss-parent'), t('ss-1111')];
    expect(view(buildThreadLineage({ threadId: 'ss-parent', sessions, links: [], tasks })).delegated).toEqual(['ss-1111']);
    expect(view(buildThreadLineage({ threadId: 'ss-1111', sessions, links: [], tasks })).parent).toEqual(['ss-parent', 'delegated', true]);
  });

  it('keeps a related thread that is not in the list as unavailable rather than dropping it', () => {
    const lineage = buildThreadLineage({ threadId: 'b', sessions: [t('b')], links: [{ childId: 'b', parentId: 'gone', kind: 'fork' }], tasks: [] });
    expect(lineage.parent).toEqual({ id: 'gone', kind: 'fork', session: null });
  });

  it('lists worktree siblings that share a project but not a folder, and worktree-linked threads', () => {
    const sessions = [t('main'), t('wt1', { cwd: '/repo-wt1' }), t('wt2', { cwd: '/repo-wt2' }), t('other', { cwd: '/x', thread: { projectPath: '/x' } })];
    expect(view(buildThreadLineage({ threadId: 'main', sessions, links: [], tasks: [] })).worktrees).toEqual(['wt1', 'wt2']);
    const linked = [{ childId: 'other', parentId: 'main', kind: 'worktree' }];
    expect(view(buildThreadLineage({ threadId: 'main', sessions, links: linked, tasks: [] })).worktrees).toEqual(['wt1', 'wt2', 'other']);
  });

  it('never lists the thread itself or archived duplicates twice', () => {
    const links = [{ childId: 'a', parentId: 'a', kind: 'fork' }];
    expect(view(buildThreadLineage({ threadId: 'a', sessions: [t('a')], links, tasks: [] }))).toEqual({ parent: null, forks: [], delegated: [], worktrees: [] });
  });
});
