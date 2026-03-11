import { describe, expect, it } from 'vitest';
import { updateActiveDesktopLayout } from './PaneLayoutContext';

function buildState() {
  const activeLayout = {
    root: { type: 'pane', id: 'pane-1', sessionId: 'session-1' },
    activePaneId: 'pane-1'
  };
  const inactiveLayout = {
    root: { type: 'pane', id: 'pane-2', sessionId: 'session-2' },
    activePaneId: 'pane-2'
  };

  return {
    activeDesktopId: 'desktop-1',
    desktops: [
      {
        id: 'desktop-1',
        name: 'Desktop 1',
        paneLayout: activeLayout,
        ownedSessionIds: ['session-1']
      },
      {
        id: 'desktop-2',
        name: 'Desktop 2',
        paneLayout: inactiveLayout,
        ownedSessionIds: ['session-2']
      }
    ]
  };
}

describe('updateActiveDesktopLayout', () => {
  it('preserves state identity when the active layout is unchanged', () => {
    const state = buildState();

    const nextState = updateActiveDesktopLayout(state, (layout) => layout);

    expect(nextState).toBe(state);
  });

  it('updates only the active desktop when the layout changes', () => {
    const state = buildState();
    const nextLayout = {
      ...state.desktops[0].paneLayout,
      activePaneId: 'pane-9'
    };

    const nextState = updateActiveDesktopLayout(state, () => nextLayout);

    expect(nextState).toEqual({
      ...state,
      desktops: [
        {
          ...state.desktops[0],
          paneLayout: nextLayout
        },
        state.desktops[1]
      ]
    });
    expect(nextState).not.toBe(state);
    expect(nextState.desktops[1]).toBe(state.desktops[1]);
  });
});
