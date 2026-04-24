import { describe, expect, it } from 'vitest';
import {
  createWorkspaceAutoStartKey,
  resolveStartupWorkspacePath,
  shouldAutoStartWorkspaceSession,
} from './startupWorkspace';

describe('resolveStartupWorkspacePath', () => {
  it('prefers the active project cwd when available', () => {
    expect(resolveStartupWorkspacePath('C:\\repo\\active', ['C:\\repo\\recent'])).toBe('C:\\repo\\active');
  });

  it('falls back to the first recent folder when there is no active project cwd', () => {
    expect(resolveStartupWorkspacePath('', ['C:\\repo\\recent', 'C:\\repo\\older'])).toBe('C:\\repo\\recent');
  });

  it('returns an empty string when neither source provides a workspace', () => {
    expect(resolveStartupWorkspacePath(null, [])).toBe('');
  });
});

describe('createWorkspaceAutoStartKey', () => {
  it('scopes auto-start attempts to a desktop and workspace path', () => {
    expect(createWorkspaceAutoStartKey('desktop-2', '/repo/app')).toBe('desktop-2:/repo/app');
  });

  it('returns an empty key when there is no workspace path', () => {
    expect(createWorkspaceAutoStartKey('desktop-2', '   ')).toBe('');
  });
});

describe('shouldAutoStartWorkspaceSession', () => {
  it('starts when the current desktop has no visible sessions', () => {
    expect(shouldAutoStartWorkspaceSession({
      loadingSessions: false,
      visibleSessionCount: 0,
      autoStartKey: 'desktop-1:/repo/app',
      lastAutoStartKey: '',
    })).toBe(true);
  });

  it('does not use hidden sessions on other desktops as a blocker', () => {
    expect(shouldAutoStartWorkspaceSession({
      loadingSessions: false,
      visibleSessionCount: 0,
      autoStartKey: 'desktop-1:/repo/app',
      lastAutoStartKey: 'desktop-2:/repo/app',
    })).toBe(true);
  });

  it('does not start while loading, without a workspace, after a retry, or when a session is visible', () => {
    expect([
      shouldAutoStartWorkspaceSession({
        loadingSessions: true,
        visibleSessionCount: 0,
        autoStartKey: 'desktop-1:/repo/app',
        lastAutoStartKey: '',
      }),
      shouldAutoStartWorkspaceSession({
        loadingSessions: false,
        visibleSessionCount: 0,
        autoStartKey: '',
        lastAutoStartKey: '',
      }),
      shouldAutoStartWorkspaceSession({
        loadingSessions: false,
        visibleSessionCount: 0,
        autoStartKey: 'desktop-1:/repo/app',
        lastAutoStartKey: 'desktop-1:/repo/app',
      }),
      shouldAutoStartWorkspaceSession({
        loadingSessions: false,
        visibleSessionCount: 1,
        autoStartKey: 'desktop-1:/repo/app',
        lastAutoStartKey: '',
      }),
    ]).toEqual([false, false, false, false]);
  });
});
