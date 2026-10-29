import { afterEach, describe, expect, it } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import {
  initializeActivePaneWithSessionState,
  updateActiveDesktopLayout,
  PaneLayoutProvider,
  usePaneLayout,
} from './PaneLayoutContext';

afterEach(() => localStorage.clear());

function renderLayout(root) {
  const state = buildState();
  state.desktops[0].paneLayout.root = root;
  localStorage.setItem('desktops', JSON.stringify(state));
  return renderHook(() => usePaneLayout(), { wrapper: PaneLayoutProvider });
}

describe('PaneLayoutProvider current pane ownership', () => {
  const panes = [
    { type: 'pane', id: 'pane-1', sessionId: 'session-1' },
    { type: 'pane', id: 'closing-pane', sessionId: 'closing-session' },
  ];
  const root = { type: 'split', direction: 'horizontal', children: panes };

  it('ignores a retained focus callback after its pane closes without persisting a removed active ID', () => {
    const { result } = renderLayout(root);
    const focusPane = result.current.focusPane;
    act(() => result.current.focusPane('closing-pane'));
    act(() => result.current.closePane('closing-pane'));
    const previous = result.current.desktops;
    let sessionId;
    act(() => { sessionId = focusPane('closing-pane'); });
    expect(sessionId).toBeNull();
    expect(result.current.desktops).toBe(previous);
    expect(result.current.paneLayout).toEqual({ root: panes[0], activePaneId: 'pane-1' });
    expect(JSON.parse(localStorage.getItem('desktops')).desktops[0].paneLayout.activePaneId).toBe('pane-1');
  });

  it('validates focus against the queued latest tree when close and stale focus occur in one batch', () => {
    const { result } = renderLayout(root);
    const focusPane = result.current.focusPane;
    act(() => {
      result.current.closePane('closing-pane');
      focusPane('closing-pane');
    });
    expect(result.current.paneLayout).toEqual({ root: panes[0], activePaneId: 'pane-1' });
    expect(JSON.parse(localStorage.getItem('desktops')).desktops[0].paneLayout.activePaneId).toBe('pane-1');
  });

  it('reads the active desktop for retained focus callbacks after switching desktops', () => {
    const { result } = renderLayout(root);
    const focusPane = result.current.focusPane;
    act(() => result.current.switchDesktop('desktop-2'));
    const previous = result.current.desktops;
    let missingSessionId;
    let currentSessionId;
    act(() => {
      missingSessionId = focusPane('closing-pane');
      currentSessionId = focusPane('pane-2');
    });
    expect([missingSessionId, currentSessionId]).toEqual([null, 'session-2']);
    expect(result.current.desktops).toBe(previous);
    expect(result.current.paneLayout).toEqual({ root: { type: 'pane', id: 'pane-2', sessionId: 'session-2' }, activePaneId: 'pane-2' });
  });

  it('adds a delayed session to the requested desktop without switching the current desktop', () => {
    const { result } = renderLayout(root);
    const addSession = result.current.addSessionToDesktop;
    act(() => result.current.switchDesktop('desktop-2'));
    act(() => addSession('new-image-session', 'desktop-1'));
    expect(result.current.activeDesktopId).toBe('desktop-2');
    expect(result.current.desktops.map(desktop => desktop.ownedSessionIds)).toEqual([
      ['session-1', 'new-image-session'], ['session-2'],
    ]);
  });

  it('returns the latest session assignment when an existing pane is focused through a retained callback', () => {
    const { result } = renderLayout(root);
    const focusPane = result.current.focusPane;
    act(() => result.current.setPaneSession('closing-pane', 'replacement-session'));
    let sessionId;
    act(() => { sessionId = focusPane('closing-pane'); });
    expect(sessionId).toBe('replacement-session');
    expect(result.current.paneLayout.activePaneId).toBe('closing-pane');
  });

  it.each(['pane close', 'desktop switch'])('ignores stale fullscreen targets after %s and still toggles the current pane', reason => {
    const { result } = renderLayout(root);
    const toggleFullscreen = result.current.toggleFullscreen;
    act(() => toggleFullscreen('pane-1'));
    expect(result.current.fullscreenPaneId).toBe('pane-1');
    act(() => reason === 'pane close' ? result.current.closePane('closing-pane') : result.current.switchDesktop('desktop-2'));
    const currentPaneId = reason === 'pane close' ? 'pane-1' : 'pane-2';
    const previous = result.current.fullscreenPaneId;
    act(() => toggleFullscreen('closing-pane'));
    expect(result.current.fullscreenPaneId).toBe(previous);
    act(() => toggleFullscreen(currentPaneId));
    expect(result.current.fullscreenPaneId).toBe(previous === currentPaneId ? null : currentPaneId);
  });

  it('never exposes a removed fullscreen target when closing and toggling occur in one batch', () => {
    const { result } = renderLayout(root);
    act(() => {
      result.current.closePane('closing-pane');
      result.current.toggleFullscreen('closing-pane');
    });
    expect(result.current.fullscreenPaneId).toBeNull();
    act(() => result.current.toggleFullscreen('pane-1'));
    expect(result.current.fullscreenPaneId).toBe('pane-1');
  });
});

describe('PaneLayoutProvider split proportions', () => {
  const panes = Array.from({ length: 3 }, (_, index) => ({ type: 'pane', id: `pane-${index + 1}`, sessionId: `session-${index + 1}` }));
  const root = { type: 'split', direction: 'horizontal', children: panes, sizes: [0.2, 0.5, 0.3] };

  it('persists active desktop proportions and restores them without changing assignments or another desktop', () => {
    const view = renderLayout(root);
    const inactive = view.result.current.desktops[1];
    act(() => view.result.current.resizeSplit([], [0.3, 0.4, 0.3], panes.map(pane => pane.id)));
    expect(view.result.current.paneLayout.root).toEqual({ ...root, sizes: [0.3, 0.4, 0.3] });
    expect(view.result.current.desktops[1]).toBe(inactive);
    expect(JSON.parse(localStorage.getItem('desktops')).desktops[0].paneLayout.root).toEqual({ ...root, sizes: [0.3, 0.4, 0.3] });
    view.unmount();
    const restored = renderHook(() => usePaneLayout(), { wrapper: PaneLayoutProvider });
    expect(restored.result.current.paneLayout.root).toEqual({ ...root, sizes: [0.3, 0.4, 0.3] });
  });

  it('ignores stale split events after the active desktop switches', () => {
    const { result } = renderLayout(root);
    act(() => result.current.switchDesktop('desktop-2'));
    const previous = result.current.desktops;
    act(() => result.current.resizeSplit([], [0.3, 0.4, 0.3], panes.map(pane => pane.id)));
    expect(result.current.desktops).toBe(previous);
  });

  it('divides only the requested pane share when splitting along an existing axis', () => {
    const { result } = renderLayout(root);
    act(() => result.current.splitPane('pane-2', 'horizontal'));
    const next = result.current.paneLayout.root;
    expect(next.sizes).toEqual([0.2, 0.25, 0.25, 0.3]);
    expect(next.children.map(pane => pane.sessionId)).toEqual(['session-1', 'session-2', null, 'session-3']);
  });

  it('normalizes surviving shares when closing a pane and preserves nested split proportions', () => {
    const { result } = renderLayout({ type: 'split', direction: 'horizontal', sizes: [0.6, 0.4], children: [
      { type: 'split', direction: 'vertical', children: panes.slice(0, 2), sizes: [0.7, 0.3] }, panes[2],
    ] });
    act(() => result.current.closePane('pane-1'));
    expect(result.current.paneLayout.root).toEqual({ type: 'split', direction: 'horizontal', sizes: [0.6, 0.4], children: panes.slice(1) });
    act(() => result.current.closePane('pane-2'));
    expect(result.current.paneLayout.root).toEqual(panes[2]);
  });

  it('redistributes only the closed pane share among survivors', () => {
    const { result } = renderLayout(root);
    act(() => result.current.closePane('pane-2'));
    expect(result.current.paneLayout.root).toEqual({ ...root, children: [panes[0], panes[2]], sizes: [0.4, 0.6] });
  });

  it('preserves weighted area when closing a nested branch flattens same-axis splits', () => {
    const { result } = renderLayout({ type: 'split', direction: 'horizontal', sizes: [0.6, 0.4], children: [
      { type: 'split', direction: 'vertical', children: [
        panes[0], { type: 'split', direction: 'horizontal', sizes: [0.25, 0.75], children: panes.slice(1) },
      ] }, { type: 'pane', id: 'pane-4' },
    ] });
    act(() => result.current.closePane('pane-1'));
    expect(result.current.paneLayout.root.sizes).toEqual([0.15, expect.closeTo(0.45), 0.4]);
    expect(result.current.getAllPanes().map(pane => pane.id)).toEqual(['pane-2', 'pane-3', 'pane-4']);
  });

  it('keeps pane IDs unique during rapid splits and caps the layout at eight panes', () => {
    const { result } = renderLayout(panes[0]);
    act(() => {
      for (let index = 0; index < 10; index++) result.current.splitPane('pane-1', 'horizontal');
    });
    const ids = result.current.getAllPanes().map(pane => pane.id);
    expect(ids.length).toBe(8);
    expect(new Set(ids).size).toBe(8);
    expect(result.current.paneLayout.root.sizes.reduce((sum, size) => sum + size, 0)).toBeCloseTo(1);
  });
});

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
