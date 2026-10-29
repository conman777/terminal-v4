import { describe, expect, it, vi } from 'vitest';
import { persistSidebarProject } from './sidebarProjectPersistence';

describe('persistSidebarProject', () => {
  it('uses the terminal server canonical directory rather than creating a duplicate alias project', () => {
    const addSidebarProject = vi.fn();
    expect(persistSidebarProject(addSidebarProject, '/var/folders/owned-workspace', { id: 'owned-pty', cwd: '/private/var/folders/owned-workspace' })).toBe(true);
    expect(addSidebarProject).toHaveBeenCalledWith('/private/var/folders/owned-workspace');
  });

  it('uses the V4 server workspace identity instead of adding its requested path alias', () => {
    const addSidebarProject = vi.fn();
    expect(persistSidebarProject(addSidebarProject, '/tmp/own-workspace', {
      runtime: 'v4', cwd: '/private/tmp/own-workspace', thread: { projectPath: '/private/tmp/own-workspace' },
    })).toBe(true);
    expect(addSidebarProject).toHaveBeenCalledWith('/private/tmp/own-workspace');
  });

  it('retains the requested V4 path only when the server has no workspace identity', () => {
    const addSidebarProject = vi.fn();
    expect(persistSidebarProject(addSidebarProject, '/own-requested-workspace', { runtime: 'v4' })).toBe(true);
    expect(addSidebarProject).toHaveBeenCalledWith('/own-requested-workspace');
  });
  it('prefers the server directory when it resolves a different requested path', () => {
    const addSidebarProject = vi.fn();

    const persisted = persistSidebarProject(addSidebarProject, 'C:\\repo\\uplifting', {
      cwd: 'C:\\repo\\fallback'
    });

    expect(persisted).toBe(true);
    expect(addSidebarProject).toHaveBeenCalledWith('C:\\repo\\fallback');
  });

  it('falls back to the session project path when the explicit path is missing', () => {
    const addSidebarProject = vi.fn();

    const persisted = persistSidebarProject(addSidebarProject, '', {
      thread: { projectPath: 'C:\\repo\\terminal-v4' }
    });

    expect(persisted).toBe(true);
    expect(addSidebarProject).toHaveBeenCalledWith('C:\\repo\\terminal-v4');
  });

  it('does nothing when no project path can be resolved', () => {
    const addSidebarProject = vi.fn();

    const persisted = persistSidebarProject(addSidebarProject, '', {});

    expect(persisted).toBe(false);
    expect(addSidebarProject).not.toHaveBeenCalled();
  });
});
