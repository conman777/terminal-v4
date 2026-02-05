import { describe, expect, it } from 'vitest';
import { resolveSessionPaths } from '../src/terminal/session-resolver';

describe('resolveSessionPaths', () => {
  it('prefers thread project path for grouping when available', () => {
    const resolved = resolveSessionPaths({
      cwd: '/home/conor/projects/terminal-v4/src',
      metadataCwd: null,
      defaultCwd: '/home/conor',
      homeDir: '/home/conor',
      threadProjectPath: '/home/conor/projects/terminal-v4'
    });

    expect(resolved.cwd).toBe('/home/conor/projects/terminal-v4/src');
    expect(resolved.groupPath).toBe('/home/conor/projects/terminal-v4');
    expect(resolved.cwdSource).toBe('session');
  });

  it('falls back to top-level folder under home when no project path exists', () => {
    const resolved = resolveSessionPaths({
      cwd: '/home/conor/projects/terminal-v4/src',
      metadataCwd: null,
      defaultCwd: '/home/conor',
      homeDir: '/home/conor',
      threadProjectPath: null
    });

    expect(resolved.groupPath).toBe('/home/conor/projects/terminal-v4/src');
  });

  it('backfills cwd from metadata when missing', () => {
    const resolved = resolveSessionPaths({
      cwd: null,
      metadataCwd: '/home/conor/legacy',
      defaultCwd: '/home/conor',
      homeDir: '/home/conor',
      threadProjectPath: null
    });

    expect(resolved.cwd).toBe('/home/conor/legacy');
    expect(resolved.cwdSource).toBe('metadata');
  });

  it('uses default cwd when no other sources exist', () => {
    const resolved = resolveSessionPaths({
      cwd: null,
      metadataCwd: null,
      defaultCwd: '/home/conor',
      homeDir: '/home/conor',
      threadProjectPath: null
    });

    expect(resolved.cwd).toBe('/home/conor');
    expect(resolved.cwdSource).toBe('default');
    expect(resolved.groupPath).toBe('/home/conor');
  });
});
