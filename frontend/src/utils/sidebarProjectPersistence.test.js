import { describe, expect, it, vi } from 'vitest';
import { persistSidebarProject } from './sidebarProjectPersistence';

describe('persistSidebarProject', () => {
  it('persists the explicit folder path when provided', () => {
    const addSidebarProject = vi.fn();

    const persisted = persistSidebarProject(addSidebarProject, 'C:\\repo\\uplifting', {
      cwd: 'C:\\repo\\fallback'
    });

    expect(persisted).toBe(true);
    expect(addSidebarProject).toHaveBeenCalledWith('C:\\repo\\uplifting');
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
