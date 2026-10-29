import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useState } from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { SplitPaneContainer } from './SplitPaneContainer';
import { resizePaneTree } from '../utils/paneTree';

let terminalPaneCalls = [];
let paneInstances = 0;

vi.mock('./TerminalPane', () => ({
  TerminalPane: function SyntheticTerminalPane(props) {
    const [instance] = useState(() => ++paneInstances);
    const [draft, setDraft] = useState('');
    terminalPaneCalls.push(props);
    return <section
      data-testid={`terminal-pane-${props.pane.id}`}
      data-instance={instance}
      data-active={props.isActive}
      data-fullscreen={props.isFullscreen}
    >
      <input aria-label={`Draft ${props.pane.id}`} value={draft} onChange={event => setDraft(event.target.value)} />
      <div data-testid={`renderer-${props.pane.id}`} />
      <button onClick={props.onToggleBrowser}>Browser</button>
    </section>;
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
    paneInstances = 0;
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ left: 10, top: 20, width: 1006, height: 606 });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it.each(['horizontal', 'vertical'])('resizes a %s pair with bounded keyboard controls without leaking keys or replacing drafts', direction => {
    const onPaneResize = vi.fn();
    const backgroundInput = vi.fn();
    document.addEventListener('keydown', backgroundInput);
    function Harness() {
      const [root, setRoot] = useState({ type: 'split', direction, children: [
        { type: 'pane', id: 'pane-1' }, { type: 'pane', id: 'pane-2' },
      ] });
      return <SplitPaneContainer {...buildProps({ paneLayout: { activePaneId: 'pane-1', root }, onPaneResize: (...args) => {
        onPaneResize(...args);
        setRoot(previous => resizePaneTree(previous, ...args));
      } })} />;
    }
    const view = render(<Harness />);
    const input = screen.getByRole('textbox', { name: 'Draft pane-1' });
    const renderer = screen.getByTestId('renderer-pane-1');
    fireEvent.change(input, { target: { value: 'Unsent retained draft' } });
    const separator = screen.getByRole('separator', { name: direction === 'horizontal' ? 'Resize panes left and right 1' : 'Resize panes up and down 1' });
    expect(separator).toHaveAttribute('aria-orientation', direction === 'horizontal' ? 'vertical' : 'horizontal');
    expect(separator).toHaveAttribute('aria-valuenow', '50');
    expect(separator).toHaveAttribute('data-pane-resize-handle');
    const increase = direction === 'horizontal' ? 'ArrowRight' : 'ArrowDown';
    const decrease = direction === 'horizontal' ? 'ArrowLeft' : 'ArrowUp';
    for (const [key, shiftKey, expected] of [[increase, false, '55'], [decrease, true, '45'], ['Enter', false, '50']]) {
      expect(fireEvent.keyDown(separator, { key, shiftKey })).toBe(false);
      expect(separator).toHaveAttribute('aria-valuenow', expected);
    }
    fireEvent.keyDown(separator, { key: 'Home' });
    expect(Number(separator.getAttribute('aria-valuenow'))).toBeCloseTo(Number(separator.getAttribute('aria-valuemin')));
    fireEvent.keyDown(separator, { key: 'End' });
    expect(Number(separator.getAttribute('aria-valuenow'))).toBeCloseTo(Number(separator.getAttribute('aria-valuemax')));
    fireEvent.keyDown(separator, { key: 'a' });
    expect(backgroundInput).not.toHaveBeenCalled();
    document.removeEventListener('keydown', backgroundInput);
    expect(screen.getByRole('textbox', { name: 'Draft pane-1' })).toBe(input);
    expect(input).toHaveValue('Unsent retained draft');
    expect(screen.getByTestId('renderer-pane-1')).toBe(renderer);
    expect(paneInstances).toBe(2);
    expect(onPaneResize.mock.calls[0]).toEqual([[], [0.55, 0.45], ['pane-1', 'pane-2']]);
    expect(view.container.querySelector('[data-pane-host="pane-1"]')).not.toBeNull();
  });

  it('uses captured pointer movement for one adjacent pair and stops after release, cancel, or fullscreen', () => {
    vi.stubGlobal('PointerEvent', MouseEvent);
    const onPaneResize = vi.fn();
    const root = { type: 'split', direction: 'horizontal', children: [
      { type: 'pane', id: 'pane-1' }, { type: 'split', direction: 'vertical', children: [
        { type: 'pane', id: 'pane-2' }, { type: 'pane', id: 'pane-3' },
      ] },
    ] };
    const props = buildProps({ paneLayout: { activePaneId: 'pane-1', root }, onPaneResize });
    const view = render(<SplitPaneContainer {...props} />);
    const separator = screen.getByRole('separator', { name: 'Resize panes up and down 2' });
    separator.setPointerCapture = vi.fn();
    separator.releasePointerCapture = vi.fn();
    fireEvent.pointerDown(separator, { button: 0, clientY: 323 });
    fireEvent.pointerMove(window, { clientY: 383 });
    expect(onPaneResize.mock.calls[0]).toEqual([[1], [0.6, 0.4], ['pane-2', 'pane-3']]);
    fireEvent.pointerUp(window);
    fireEvent.pointerMove(window, { clientY: 423 });
    expect(onPaneResize).toHaveBeenCalledTimes(1);
    fireEvent.pointerDown(separator, { button: 0, clientY: 323 });
    fireEvent.pointerCancel(window);
    fireEvent.pointerMove(window, { clientY: 423 });
    expect(onPaneResize).toHaveBeenCalledTimes(1);
    fireEvent.pointerDown(separator, { button: 0, clientY: 323 });
    view.rerender(<SplitPaneContainer {...props} fullscreenPaneId="pane-2" />);
    fireEvent.pointerMove(window, { clientY: 423 });
    expect(screen.queryByRole('separator')).toBeNull();
    expect(onPaneResize).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
  });

  it('retains existing pane hosts, renderers, drafts and focus across split creation, reordering, legacy, collapse and fullscreen', () => {
    const panes = [1, 2, 3].map(index => ({ type: 'pane', id: `pane-${index}`, sessionId: `session-${index}` }));
    const props = buildProps({ paneLayout: { activePaneId: panes[0].id, root: panes[0] } });
    const view = render(<SplitPaneContainer {...props} />);
    const input = screen.getByRole('textbox', { name: 'Draft pane-1' });
    const renderer = screen.getByTestId('renderer-pane-1');
    const host = input.closest('[data-pane-host]');
    fireEvent.change(input, { target: { value: 'Draft before first split' } });
    input.focus();
    const roots = [
      { type: 'split', direction: 'horizontal', children: panes.slice(0, 2) },
      { type: 'split', direction: 'vertical', children: [panes[1], { type: 'split', direction: 'horizontal', children: [panes[2], panes[0]] }] },
      panes[0],
    ];
    for (const root of roots) {
      view.rerender(<SplitPaneContainer {...props} paneLayout={{ activePaneId: panes[0].id, root }} />);
      expect(screen.getByRole('textbox', { name: 'Draft pane-1' })).toBe(input);
      expect(input.closest('[data-pane-host]')).toBe(host);
      expect(screen.getByTestId('renderer-pane-1')).toBe(renderer);
      expect(input).toHaveFocus();
      expect(input).toHaveValue('Draft before first split');
    }
    view.rerender(<SplitPaneContainer {...props} paneLayout={null} layout={{ type: 'horizontal', panes: panes.slice(0, 2), activePaneId: panes[0].id }} />);
    expect(screen.getByRole('textbox', { name: 'Draft pane-1' })).toBe(input);
    view.rerender(<SplitPaneContainer {...props} fullscreenPaneId="pane-1" />);
    expect(screen.getByTestId('renderer-pane-1')).toBe(renderer);
    expect(input.closest('[data-pane-host]')).toBe(host);
    expect(input).toHaveValue('Draft before first split');
  });

  it('keeps the eight-pane split limit while rendering seven accessible dividers', () => {
    const panes = Array.from({ length: 8 }, (_, index) => ({ type: 'pane', id: `pane-${index + 1}` }));
    render(<SplitPaneContainer {...buildProps({ paneLayout: { activePaneId: panes[0].id, root: { type: 'split', direction: 'horizontal', children: panes } } })} />);
    expect(terminalPaneCalls.map(props => ({ canSplit: props.canSplit, canClose: props.canClose }))).toEqual(panes.map(() => ({ canSplit: false, canClose: true })));
    expect(screen.getAllByRole('separator')).toHaveLength(7);
  });

  it('restores saved proportions after temporary container shrink without persisting clamped geometry', () => {
    let observeResize;
    const disconnect = vi.fn();
    vi.stubGlobal('ResizeObserver', class {
      constructor(callback) { observeResize = callback; }
      observe() {}
      disconnect = disconnect;
    });
    const onPaneResize = vi.fn();
    const props = buildProps({ onPaneResize, paneLayout: { activePaneId: 'pane-1', root: {
      type: 'split', direction: 'horizontal', sizes: [0.7, 0.3], children: [
        { type: 'pane', id: 'pane-1' }, { type: 'pane', id: 'pane-2' },
      ],
    } } });
    const view = render(<SplitPaneContainer {...props} />);
    const input = screen.getByRole('textbox', { name: 'Draft pane-1' });
    const separator = screen.getByRole('separator');
    expect(separator).toHaveAttribute('aria-valuenow', '70');
    vi.mocked(HTMLElement.prototype.getBoundingClientRect).mockReturnValue({ left: 10, top: 20, width: 250, height: 606 });
    act(() => observeResize());
    expect(separator).toHaveAttribute('aria-valuenow', '50');
    expect([...view.container.querySelectorAll('[data-pane-host]')].map(node => node.style.width)).toEqual(['122px', '122px']);
    vi.mocked(HTMLElement.prototype.getBoundingClientRect).mockReturnValue({ left: 10, top: 20, width: 1006, height: 606 });
    act(() => observeResize());
    expect(separator).toHaveAttribute('aria-valuenow', '70');
    expect(onPaneResize).not.toHaveBeenCalled();
    expect(screen.getByRole('textbox', { name: 'Draft pane-1' })).toBe(input);
    view.unmount();
    expect(disconnect).toHaveBeenCalledOnce();
  });

  it.each(['tree change', 'desktop change', 'unmount', 'lost capture', 'window blur'])('cancels a drag on %s', reason => {
    vi.stubGlobal('PointerEvent', MouseEvent);
    const onPaneResize = vi.fn();
    const panes = [1, 2, 3].map(index => ({ type: 'pane', id: `pane-${index}` }));
    const props = buildProps({ onPaneResize, paneLayout: { activePaneId: 'pane-1', root: { type: 'split', direction: 'horizontal', children: panes.slice(0, 2) } } });
    const view = render(<SplitPaneContainer {...props} />);
    const separator = screen.getByRole('separator');
    fireEvent.pointerDown(separator, { button: 0, clientX: 513 });
    if (reason === 'tree change') view.rerender(<SplitPaneContainer {...props} paneLayout={{ activePaneId: 'pane-1', root: { ...props.paneLayout.root, children: [panes[0], panes[2]] } }} />);
    else if (reason === 'desktop change') view.rerender(<SplitPaneContainer {...props} currentDesktopId="desktop-2" />);
    else if (reason === 'unmount') view.unmount();
    else if (reason === 'lost capture') fireEvent.lostPointerCapture(separator);
    else fireEvent.blur(window);
    fireEvent.pointerMove(window, { clientX: 613 });
    expect(onPaneResize).not.toHaveBeenCalled();
  });

  it('changes only an adjacent pair in a three-way split and ignores secondary pointer buttons', () => {
    vi.stubGlobal('PointerEvent', MouseEvent);
    const onPaneResize = vi.fn();
    const props = buildProps({ onPaneResize, paneLayout: { activePaneId: 'pane-1', root: {
      type: 'split', direction: 'horizontal', sizes: [0.25, 0.5, 0.25], children: [1, 2, 3].map(index => ({ type: 'pane', id: `pane-${index}` })),
    } } });
    render(<SplitPaneContainer {...props} />);
    const separator = screen.getByRole('separator', { name: 'Resize panes left and right 2' });
    fireEvent.pointerDown(separator, { button: 2, clientX: 750 });
    fireEvent.pointerMove(window, { clientX: 850 });
    expect(onPaneResize).not.toHaveBeenCalled();
    fireEvent.keyDown(separator, { key: 'ArrowLeft' });
    expect(onPaneResize.mock.calls[0]).toEqual([[], [0.25, expect.closeTo(0.4625), expect.closeTo(0.2875)], ['pane-1', 'pane-2', 'pane-3']]);
    expect(screen.getByRole('separator', { name: 'Resize panes left and right 1' })).toHaveAttribute('aria-valuenow', '35.087719');
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

  it('passes input permission and desktop drag ownership through the legacy fallback path', () => {
    render(<SplitPaneContainer {...buildProps()} />);

    expect(terminalPaneCalls).toHaveLength(1);
    expect(terminalPaneCalls[0]?.desktopAllowTerminalInput).toBe(true);
    expect(terminalPaneCalls[0]?.currentDesktopId).toBe('desktop-1');
  });

  it.each(['legacy', 'split', 'fullscreen'])('connects the browser header control through the %s layout', mode => {
    const onToggleBrowser = vi.fn();
    const leaf = { type: 'pane', id: 'pane-1', sessionId: 'session-1' };
    const paneLayout = mode === 'legacy' ? null : { activePaneId: leaf.id, root: {
      type: 'split', direction: 'horizontal', children: [leaf, { type: 'pane', id: 'pane-2', sessionId: 'session-2' }],
    } };
    render(<SplitPaneContainer {...buildProps({ paneLayout, fullscreenPaneId: mode === 'fullscreen' ? leaf.id : null, showBrowser: true, onToggleBrowser })} />);
    expect(terminalPaneCalls.map(props => ({ visible: props.showBrowser, toggle: props.onToggleBrowser }))).toEqual(
      Array.from({ length: mode === 'legacy' ? 1 : 2 }, () => ({ visible: true, toggle: onToggleBrowser })),
    );
  });

  it.each(['legacy', 'single tree', 'nested tree'])('retains pane instances, renderers and drafts across %s fullscreen changes', mode => {
    const panes = Array.from({ length: mode === 'single tree' ? 1 : 4 }, (_, index) => ({
      type: 'pane', id: `pane-${index + 1}`, sessionId: `session-${index + 1}`,
    }));
    const props = buildProps({
      layout: { type: 'grid', activePaneId: panes[0].id, panes },
      paneLayout: mode === 'legacy' ? null : {
        activePaneId: panes[0].id,
        root: mode === 'single tree' ? panes[0] : {
          type: 'split', direction: 'horizontal', children: [panes[0], {
            type: 'split', direction: 'vertical', children: [panes[1], {
              type: 'split', direction: 'horizontal', children: panes.slice(2),
            }],
          }],
        },
      },
    });
    const view = render(<SplitPaneContainer {...props} />);
    const retained = panes.map(pane => {
      const input = screen.getByRole('textbox', { name: `Draft ${pane.id}` });
      fireEvent.change(input, { target: { value: `Unsent ${pane.id}` } });
      const node = screen.getByTestId(`terminal-pane-${pane.id}`);
      return { pane, input, node, instance: node.dataset.instance, renderer: screen.getByTestId(`renderer-${pane.id}`) };
    });
    const originalSplitStyles = [...view.container.querySelectorAll('.split-container')].map(node => node.getAttribute('style'));
    for (const selected of panes.slice(-2)) {
      view.rerender(<SplitPaneContainer {...props} fullscreenPaneId={selected.id} />);
      for (const { pane, node, input, instance, renderer } of retained) {
        expect(screen.getByTestId(`terminal-pane-${pane.id}`)).toBe(node);
        expect(screen.getByTestId(`renderer-${pane.id}`)).toBe(renderer);
        expect(node.dataset.instance).toBe(instance);
        expect(input).toHaveValue(`Unsent ${pane.id}`);
        expect(node).toHaveAttribute('data-active', String(pane.id === selected.id));
        expect(node).toHaveAttribute('data-fullscreen', String(pane.id === selected.id));
        if (pane.id === selected.id) {
          expect(node).toBeVisible();
          expect(node.closest('[inert], [aria-hidden="true"]')).toBeNull();
        } else {
          expect(node).not.toBeVisible();
          expect(node.closest('[inert]')).toHaveAttribute('aria-hidden', 'true');
          expect(screen.queryByRole('textbox', { name: `Draft ${pane.id}` })).toBeNull();
        }
      }
      expect(screen.getAllByRole('textbox')).toEqual([retained.find(({ pane }) => pane.id === selected.id).input]);
    }
    view.rerender(<SplitPaneContainer {...props} />);
    expect([...view.container.querySelectorAll('.split-container')].map(node => node.getAttribute('style'))).toEqual(originalSplitStyles);
    for (const { pane, node, input, instance, renderer } of retained) {
      expect(screen.getByRole('textbox', { name: `Draft ${pane.id}` })).toBe(input);
      expect(screen.getByTestId(`terminal-pane-${pane.id}`)).toBe(node);
      expect(screen.getByTestId(`renderer-${pane.id}`)).toBe(renderer);
      expect(node.dataset.instance).toBe(instance);
      expect(input).toHaveValue(`Unsent ${pane.id}`);
      expect(node).toBeVisible();
      expect(node.closest('[inert], [aria-hidden="true"]')).toBeNull();
      expect(node).toHaveAttribute('data-active', String(pane.id === panes[0].id));
      expect(node).toHaveAttribute('data-fullscreen', 'false');
    }
    expect(paneInstances).toBe(panes.length);
  });

  it.each(['legacy', 'tree'])('keeps %s panes available when the fullscreen target no longer exists', mode => {
    const props = buildProps({ paneLayout: mode === 'legacy' ? null : {
      activePaneId: 'pane-1', root: { type: 'pane', id: 'pane-1', sessionId: 'session-1' },
    } });
    const view = render(<SplitPaneContainer {...props} />);
    const input = screen.getByRole('textbox', { name: 'Draft pane-1' });
    view.rerender(<SplitPaneContainer {...props} fullscreenPaneId="missing-pane" />);
    expect(screen.getByRole('textbox', { name: 'Draft pane-1' })).toBe(input);
    expect(input).toBeVisible();
    expect(input.closest('[inert]')).toBeNull();
  });

  it('lets the fullscreen Browser control exit fullscreen without replacing retained panes', () => {
    function BrowserExitHarness() {
      const [fullscreenPaneId, setFullscreenPaneId] = useState('pane-2');
      const [showBrowser, setShowBrowser] = useState(false);
      return <SplitPaneContainer {...buildProps({
        paneLayout: { activePaneId: 'pane-1', root: { type: 'split', direction: 'horizontal', children: [
          { type: 'pane', id: 'pane-1', sessionId: 'session-1' },
          { type: 'pane', id: 'pane-2', sessionId: 'session-2' },
        ] } },
        fullscreenPaneId, showBrowser,
        onToggleBrowser: () => { setFullscreenPaneId(null); setShowBrowser(true); },
      })} />;
    }
    render(<BrowserExitHarness />);
    const selected = screen.getByTestId('terminal-pane-pane-2');
    const background = screen.getByTestId('terminal-pane-pane-1');
    fireEvent.change(screen.getByRole('textbox', { name: 'Draft pane-2' }), { target: { value: 'Still drafting' } });
    fireEvent.click(screen.getByRole('button', { name: 'Browser' }));
    expect(screen.getByTestId('terminal-pane-pane-2')).toBe(selected);
    expect(screen.getByTestId('terminal-pane-pane-1')).toBe(background);
    expect(background).toBeVisible();
    expect(screen.getByRole('textbox', { name: 'Draft pane-2' })).toHaveValue('Still drafting');
    expect(terminalPaneCalls.slice(-2).map(props => props.showBrowser)).toEqual([true, true]);
  });
});
