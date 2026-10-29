import { describe, expect, it } from 'vitest';
import { scopeThreadsSidebarData } from './sidebarSessionScope';

function buildSession(id, title) {
  return { id, title };
}

describe('scopeThreadsSidebarData', () => {
  it('keeps only currently active app sessions in the sidebar data', () => {
    const activeSession = buildSession('session-1', 'Active');
    const inactiveSession = buildSession('session-2', 'Inactive');
    const pinnedInactive = buildSession('session-3', 'Pinned inactive');

    const scoped = scopeThreadsSidebarData({
      activeSessions: [activeSession],
      sessionsGroupedByProject: [
        {
          projectName: 'terminal v4',
          projectPath: 'C:\\repo',
          sessions: [activeSession, inactiveSession]
        }
      ],
      pinnedSessions: [pinnedInactive],
      archivedSessions: [inactiveSession]
    });

    expect(scoped).toEqual({
      sessionsGroupedByProject: [
        {
          projectName: 'terminal v4',
          projectPath: 'C:\\repo',
          sessions: [activeSession]
        }
      ],
      pinnedSessions: [],
      archivedSessions: []
    });
  });

  it('drops empty project groups after inactive sessions are removed', () => {
    const scoped = scopeThreadsSidebarData({
      activeSessions: [buildSession('session-1', 'Active')],
      sessionsGroupedByProject: [
        {
          projectName: 'other-project',
          projectPath: 'C:\\other',
          sessions: [buildSession('session-9', 'Inactive only')]
        }
      ],
      pinnedSessions: [],
      archivedSessions: []
    });

    expect(scoped.sessionsGroupedByProject).toEqual([]);
  });

  it('hides drawer terminals that belong to a conversation', () => {
    const conversation = buildSession('ss-chat', 'Chat');
    const drawer = { ...buildSession('pty-drawer', 'Terminal'), thread: { companionOf: 'ss-chat' } };
    const scoped = scopeThreadsSidebarData({
      activeSessions: [conversation, drawer],
      sessionsGroupedByProject: [{ projectName: 'repo', projectPath: '/repo', sessions: [conversation, drawer] }],
      pinnedSessions: [drawer],
      archivedSessions: [drawer],
    });
    expect(scoped).toEqual({ sessionsGroupedByProject: [{ projectName: 'repo', projectPath: '/repo', sessions: [conversation] }], pinnedSessions: [], archivedSessions: [] });
  });
});

