import { describe, expect, it } from 'vitest';
import {
  initializeActivePaneWithSessionState,
  updateActiveDesktopLayout
} from './PaneLayoutContext';

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

describe('initializeActivePaneWithSessionState', () => {
  it('preserves state identity when the active pane already owns the session', () => {
    const state = buildState();

    const nextState = initializeActivePaneWithSessionState(state, 'session-1');

    expect(nextState).toBe(state);
  });

  it('assigns the active pane and adds the session to the active desktop ownership list', () => {
    const state = buildState();

    const nextState = initializeActivePaneWithSessionState(state, 'session-3');

    expect(nextState).toEqual({
      ...state,
      desktops: [
        {
          ...state.desktops[0],
          paneLayout: {
            ...state.desktops[0].paneLayout,
            root: { type: 'pane', id: 'pane-1', sessionId: 'session-3' }
          },
          ownedSessionIds: ['session-1', 'session-3']
        },
        state.desktops[1]
      ]
    });
    expect(nextState.desktops[1]).toBe(state.desktops[1]);
  });
});
