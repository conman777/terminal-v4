import { describe, expect, it } from 'vitest';
import { resolveWorktreeOrigin, worktreeParentFor } from './worktreeOrigin';

const sessions = [{ id: 'ss-a', cwd: '/repo/wt', thread: { projectPath: '/repo' } }, { id: 'pty-1', cwd: '/repo' }, { id: 'ss-nopath' }];

describe('resolveWorktreeOrigin', () => {
  it('describes the active thread and its folders', () => {
    expect(resolveWorktreeOrigin(sessions, 'ss-a')).toEqual({ id: 'ss-a', paths: ['/repo/wt', '/repo'] });
  });
  it.each([['a terminal', 'pty-1'], ['an unknown thread', 'ss-x'], ['a thread without folders', 'ss-nopath'], ['no active session', null]])('has no origin for %s', (_name, id) => {
    expect(resolveWorktreeOrigin(sessions, id)).toBeNull();
  });
});

describe('worktreeParentFor', () => {
  const origin = { id: 'ss-a', paths: ['/repo'] };
  it('returns the origin thread for a child started in its project', () => {
    expect(worktreeParentFor(origin, '/repo', 'ss-new')).toBe('ss-a');
  });
  it.each([['another project', origin, '/other', 'ss-new'], ['no origin', null, '/repo', 'ss-new'], ['no child', origin, '/repo', undefined], ['the same thread', origin, '/repo', 'ss-a']])('has no parent for %s', (_name, o, path, child) => {
    expect(worktreeParentFor(o, path, child)).toBeNull();
  });
});
