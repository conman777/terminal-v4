import { describe, expect, it } from 'vitest';
import { reconcilePaneSessionIds, shouldInitializeWorkspacePane } from './paneSessionAssignments';

describe('reconcilePaneSessionIds', () => {
  it('drops invalid assignments and fills empty panes with visible sessions', () => {
    const panes = [
      { id: 'pane-1', sessionId: 'session-1' },
      { id: 'pane-2', sessionId: 'archived-session' },
      { id: 'pane-3', sessionId: null },
    ];

    const next = reconcilePaneSessionIds(panes, ['session-1', 'session-2']);

    expect(next).toEqual([
      { id: 'pane-1', sessionId: 'session-1' },
      { id: 'pane-2', sessionId: 'session-2' },
      { id: 'pane-3', sessionId: null },
    ]);
  });

  it('removes duplicate pane assignments', () => {
    const panes = [
      { id: 'pane-1', sessionId: 'session-1' },
      { id: 'pane-2', sessionId: 'session-1' },
    ];

    const next = reconcilePaneSessionIds(panes, ['session-1']);

    expect(next).toEqual([
      { id: 'pane-1', sessionId: 'session-1' },
      { id: 'pane-2', sessionId: null },
    ]);
  });
});


describe('shouldInitializeWorkspacePane', () => {
  const layout = { activePaneId: 'pane-one', panes: [{ id: 'pane-one', sessionId: null }] };
  it('waits for a newly active session to enter the visible desktop before assigning it', () => {
    expect([
      shouldInitializeWorkspacePane('new-session', layout, []),
      shouldInitializeWorkspacePane('new-session', layout, ['new-session']),
    ]).toEqual([false, true]);
  });
  it('preserves existing split assignments and ignores sessions already assigned elsewhere', () => {
    const split = { ...layout, panes: [{ id: 'pane-one', sessionId: 'existing' }, { id: 'pane-two', sessionId: 'other' }] };
    expect([
      shouldInitializeWorkspacePane('other', split, ['existing', 'other']),
      shouldInitializeWorkspacePane('new-session', split, ['existing', 'other', 'new-session']),
      shouldInitializeWorkspacePane('existing', split, ['existing', 'other']),
      shouldInitializeWorkspacePane(null, layout, []),
    ]).toEqual([false, false, false, false]);
  });
});
