import { describe, expect, it } from 'vitest';
import { reconcilePaneSessionIds } from './paneSessionAssignments';

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
