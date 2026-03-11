import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import { SplitPaneContainer } from './SplitPaneContainer';

let terminalPaneCalls = [];

vi.mock('./TerminalPane', () => ({
  TerminalPane: (props) => {
    terminalPaneCalls.push(props);
    return <div data-testid={`terminal-pane-${props.pane.id}`} />;
  }
}));

function buildProps(overrides = {}) {
  return {
    layout: {
      type: 'horizontal',
      activePaneId: 'pane-1',
      panes: [{ id: 'pane-1', sessionId: 'session-1' }]
    },
    sessions: [{ id: 'session-1', title: 'Session 1' }],
    onPaneSessionSelect: vi.fn(),
    onPaneSplit: vi.fn(),
    onPaneClose: vi.fn(),
    onPaneFocus: vi.fn(),
    onPaneFullscreen: vi.fn(),
    fullscreenPaneId: null,
    showPreview: false,
    onMinimizeMainTerminal: vi.fn(),
    keybarOpen: false,
    viewportHeight: 900,
    onUrlDetected: vi.fn(),
    fontSize: 14,
    webglEnabled: false,
    desktopAllowTerminalInput: true,
    sessionActivity: {},
    onSessionBusyChange: vi.fn(),
    projectInfo: { cwd: 'C:\\repo' },
    sessionAiTypes: {},
    customAiProviders: [],
    onSetSessionAiType: vi.fn(),
    onAddCustomAiProvider: vi.fn(),
    paneLayout: null,
    currentDesktopId: 'desktop-1',
    fitSignal: 0,
    ...overrides
  };
}

describe('SplitPaneContainer', () => {
  beforeEach(() => {
    terminalPaneCalls = [];
  });

  it('passes desktopAllowTerminalInput through the tree layout path', () => {
    render(
      <SplitPaneContainer
        {...buildProps({
          paneLayout: {
            activePaneId: 'pane-1',
            root: { type: 'pane', id: 'pane-1', sessionId: 'session-1' }
          }
        })}
      />
    );

    expect(terminalPaneCalls).toHaveLength(1);
    expect(terminalPaneCalls[0]?.desktopAllowTerminalInput).toBe(true);
  });

  it('passes desktopAllowTerminalInput through the legacy fallback path', () => {
    render(<SplitPaneContainer {...buildProps()} />);

    expect(terminalPaneCalls).toHaveLength(1);
    expect(terminalPaneCalls[0]?.desktopAllowTerminalInput).toBe(true);
  });
});
