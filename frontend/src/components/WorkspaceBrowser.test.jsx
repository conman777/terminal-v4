import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import WorkspaceBrowser from './WorkspaceBrowser';

const apiFetch = vi.hoisted(() => vi.fn());
vi.mock('../utils/api', () => ({ apiFetch }));
const ID = '11111111-1111-4111-8111-111111111111';
const TAB = '22222222-2222-4222-8222-222222222222';
const state = { activeTabId: TAB, tabs: [{ id: TAB, title: 'Fixture', url: 'https://fixture.test/' }], dialog: null };
const response = value => ({ ok: true, status: 200, json: async () => value });

beforeEach(() => {
  apiFetch.mockReset().mockImplementation(async path => response(path.endsWith('/sessions') ? { id: ID, state } : path.endsWith('/frame') ? { ...state, width: 1280, height: 800, image: 'synthetic-jpeg' } : state));
});
afterEach(() => vi.restoreAllMocks());

describe('WorkspaceBrowser', () => {
  it('keeps the typing draft editable while a browser resize is waiting for its new frame', async () => {
    let notifyResize, finishResize;
    let dimensions = { width: 1280, height: 800 };
    vi.stubGlobal('ResizeObserver', class {
      constructor(callback) { notifyResize = callback; }
      observe() {}
      disconnect() {}
    });
    try {
      apiFetch.mockImplementation(async (path, options = {}) => {
        if (path.endsWith('/sessions')) return response({ id: ID, state });
        if (path.endsWith('/frame')) return response({ ...state, ...dimensions, image: 'fixture-frame' });
        if (options.body?.type === 'resize') return new Promise(resolve => {
          finishResize = () => { dimensions = { width: options.body.width, height: options.body.height }; resolve(response(state)); };
        });
        return response(state);
      });
      render(<WorkspaceBrowser onClose={() => {}} />);
      await screen.findByAltText('Live browser page');
      fireEvent.click(screen.getByRole('button', { name: 'Show typing controls' }));
      const input = screen.getByRole('textbox', { name: 'Type into browser page' });
      fireEvent.change(input, { target: { value: 'unsent' } });
      const surface = screen.getByRole('application', { name: 'Interactive browser page' });
      vi.spyOn(surface, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, width: 390, height: 500 });
      act(() => notifyResize());
      await waitFor(() => expect(finishResize).toBeTypeOf('function'));
      expect(input).toBeEnabled();
      expect(screen.getByRole('button', { name: 'Type', exact: true })).toBeDisabled();
      fireEvent.change(input, { target: { value: 'unsent typing' } });
      fireEvent.submit(input.closest('form'));
      expect(apiFetch.mock.calls.filter(([_path, options]) => options?.body?.type === 'text')).toEqual([]);
      await act(async () => finishResize());
      await screen.findByAltText('Live browser page');
      expect(input).toHaveValue('unsent typing');
    } finally { vi.unstubAllGlobals(); }
  });

  it('recovers the resized frame when a control change supersedes the resize response', async () => {
    let notifyResize, finishResize;
    vi.stubGlobal('ResizeObserver', class {
      constructor(callback) { notifyResize = callback; }
      observe() {}
      disconnect() {}
    });
    try {
      let current = { ...state, control: { owner: 'agent', label: 'Fixture agent' } };
      let dimensions = { width: 1280, height: 800 };
      apiFetch.mockImplementation(async (path, options = {}) => {
        if (path.endsWith('/sessions')) return response({ id: ID, state: current });
        if (path.endsWith('/frame')) return response({ ...current, ...dimensions, image: 'fixture-frame' });
        if (options.body?.type === 'resize') return new Promise(resolve => {
          finishResize = () => { dimensions = { width: options.body.width, height: options.body.height }; resolve(response(current)); };
        });
        if (options.body?.type === 'control') current = { ...current, control: { owner: 'human' } };
        return response(current);
      });
      render(<WorkspaceBrowser onClose={() => {}} />);
      await screen.findByAltText('Live browser page');
      const surface = screen.getByRole('application', { name: 'Interactive browser page' });
      vi.spyOn(surface, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, width: 600, height: 500 });
      act(() => notifyResize());
      await waitFor(() => expect(finishResize).toBeTypeOf('function'));
      fireEvent.click(screen.getByRole('button', { name: 'Take control' }));
      await screen.findByText('Agents are paused');
      await act(async () => finishResize());
      await screen.findByAltText('Live browser page');
      expect(surface).toHaveAttribute('aria-busy', 'false');
    } finally { vi.unstubAllGlobals(); }
  });
  it.each([
    { availability: {}, back: false, forward: false },
    { availability: { canGoBack: false, canGoForward: false }, back: false, forward: false },
    { availability: { canGoBack: true, canGoForward: false }, back: true, forward: false },
    { availability: { canGoBack: false, canGoForward: true }, back: false, forward: true },
  ])('uses only engine-reported history availability: $availability', async ({ availability, back, forward }) => {
    const current = { ...state, tabs: [{ ...state.tabs[0], ...availability }] };
    apiFetch.mockImplementation(async path => response(path.endsWith('/sessions') ? { id: ID, state: current } : { ...current, width: 1280, height: 800, image: null }));
    render(<WorkspaceBrowser onClose={() => {}} />);
    await waitFor(() => expect(screen.getByLabelText('Browser address')).toHaveValue(state.tabs[0].url));
    const buttons = [screen.getByRole('button', { name: 'Browser back' }), screen.getByRole('button', { name: 'Browser forward' })];
    expect(buttons.map(button => !button.disabled)).toEqual([back, forward]);
    fireEvent.click(buttons[back ? 1 : 0]);
    expect(apiFetch.mock.calls.filter(([_path, options]) => options.body)).toEqual([]);
    if (back || forward) {
      fireEvent.click(buttons[back ? 0 : 1]);
      await waitFor(() => expect(apiFetch.mock.calls.filter(([_path, options]) => options.body).map(([_path, options]) => options.body)).toEqual([{ type: back ? 'back' : 'forward' }]));
    }
  });
  it('scrolls a touch gesture without clicking when the final move is small', async () => {
    vi.stubGlobal('PointerEvent', MouseEvent);
    try {
      render(<WorkspaceBrowser onClose={() => {}} />);
      await screen.findByAltText('Live browser page');
      const surface = screen.getByRole('application', { name: 'Interactive browser page' });
      vi.spyOn(surface, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, width: 1280, height: 800 });
      const pointer = (type, x, y) => {
        const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y });
        Object.defineProperty(event, 'pointerType', { value: 'touch' });
        fireEvent(surface, event);
      };
      let now = 1000;
      vi.spyOn(Date, 'now').mockImplementation(() => now);
      pointer('pointerdown', 100, 200);
      now += 100;
      pointer('pointermove', 100, 120);
      now += 100;
      pointer('pointermove', 100, 118);
      pointer('pointerup', 100, 118);
      await waitFor(() => expect(apiFetch.mock.calls.filter(([_path, options]) => options.body).map(([_path, options]) => options.body)).toEqual([
        { type: 'wheel', deltaX: 0, deltaY: 80 },
      ]));
    } finally { vi.unstubAllGlobals(); }
  });

  it('keeps a rapid wheel burst in the same scroll gesture while its first request is pending', async () => {
    const current = { ...state, tabs: [{ ...state.tabs[0], documentId: 'fixture-document' }] };
    let finishFirst;
    const wheels = [];
    apiFetch.mockImplementation(async (path, options = {}) => {
      if (path.endsWith('/sessions')) return response({ id: ID, state: current });
      if (path.endsWith('/frame')) return response({ ...current, width: 1280, height: 800, viewRevision: 3, image: 'fixture-frame' });
      if (options.body?.type === 'wheel') {
        wheels.push(options.body);
        if (wheels.length === 1) await new Promise(resolve => { finishFirst = resolve; });
      }
      return response(current);
    });
    render(<WorkspaceBrowser onClose={() => {}} />);
    await screen.findByAltText('Live browser page');
    const surface = screen.getByRole('application', { name: 'Interactive browser page' });
    vi.spyOn(surface, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, width: 1280, height: 800 });
    fireEvent.wheel(surface, { deltaY: 60 });
    await waitFor(() => expect(finishFirst).toBeTypeOf('function'));
    fireEvent.wheel(surface, { deltaY: 80 });
    await act(async () => finishFirst());
    await waitFor(() => expect(wheels).toHaveLength(2));
    expect(wheels[0].scrollId).toMatch(/^[a-f0-9-]+$/);
    expect(wheels[1].scrollId).toBe(wheels[0].scrollId);
    expect(wheels.map(wheel => wheel.deltaY)).toEqual([60, 80]);
  });

  it('keeps repeated scrolling keys in the same view-bound gesture', async () => {
    const current = { ...state, tabs: [{ ...state.tabs[0], documentId: 'fixture-document' }] };
    apiFetch.mockImplementation(async path => response(path.endsWith('/sessions') ? { id: ID, state: current } : path.endsWith('/frame') ? { ...current, width: 1280, height: 800, viewRevision: 3, image: 'fixture-frame' } : current));
    render(<WorkspaceBrowser onClose={() => {}} />);
    await screen.findByAltText('Live browser page');
    const surface = screen.getByRole('application', { name: 'Interactive browser page' });
    vi.spyOn(surface, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, width: 1280, height: 800 });
    fireEvent.keyDown(surface, { key: 'PageDown' });
    fireEvent.keyDown(surface, { key: 'PageDown', repeat: true });
    await waitFor(() => expect(apiFetch.mock.calls.filter(([_path, options]) => options?.body?.type === 'key')).toHaveLength(2));
    const keys = apiFetch.mock.calls.map(([_path, options]) => options?.body).filter(body => body?.type === 'key');
    expect(keys[0].scrollId).toMatch(/^[a-f0-9-]+$/);
    expect(keys[1].scrollId).toBe(keys[0].scrollId);
  });

  it('keeps a long touch scroll in one view-bound gesture', async () => {
    const current = { ...state, tabs: [{ ...state.tabs[0], documentId: 'fixture-document' }] };
    apiFetch.mockImplementation(async path => response(path.endsWith('/sessions') ? { id: ID, state: current } : path.endsWith('/frame') ? { ...current, width: 1280, height: 800, viewRevision: 3, image: 'fixture-frame' } : current));
    render(<WorkspaceBrowser onClose={() => {}} />);
    await screen.findByAltText('Live browser page');
    const surface = screen.getByRole('application', { name: 'Interactive browser page' });
    vi.spyOn(surface, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, width: 1280, height: 800 });
    const pointer = (type, y) => {
      const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: 100, clientY: y });
      Object.defineProperty(event, 'pointerType', { value: 'touch' });
      fireEvent(surface, event);
    };
    let now = 1000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    pointer('pointerdown', 300);
    now += 100;
    pointer('pointermove', 200);
    now += 700;
    pointer('pointermove', 100);
    pointer('pointerup', 100);
    await waitFor(() => expect(apiFetch.mock.calls.filter(([_path, options]) => options?.body?.type === 'wheel')).toHaveLength(2));
    const wheels = apiFetch.mock.calls.map(([_path, options]) => options?.body).filter(body => body?.type === 'wheel');
    expect(wheels[0].scrollId).toMatch(/^[a-f0-9-]+$/);
    expect(wheels[1].scrollId).toBe(wheels[0].scrollId);
  });

  it('does not turn a cancelled touch gesture into a page click', async () => {
    render(<WorkspaceBrowser onClose={() => {}} />);
    await screen.findByAltText('Live browser page');
    const surface = screen.getByRole('application', { name: 'Interactive browser page' });
    vi.spyOn(surface, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, width: 1280, height: 800 });
    const pointer = type => {
      const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: 100, clientY: 200 });
      Object.defineProperty(event, 'pointerType', { value: 'touch' });
      fireEvent(surface, event);
    };
    pointer('pointerdown');
    pointer('pointercancel');
    await act(async () => {});
    expect(apiFetch.mock.calls.filter(([_path, options]) => options.body)).toEqual([]);
  });

  it('keeps one release slot when the browser command queue is full', async () => {
    let finishDown;
    apiFetch.mockImplementation(async (path, options = {}) => {
      if (options.body?.type === 'pointer' && options.body.action === 'down') return new Promise(resolve => { finishDown = () => resolve(response(state)); });
      return response(path.endsWith('/sessions') ? { id: ID, state } : path.endsWith('/frame') ? { ...state, width: 1280, height: 800, image: 'fixture-frame' } : state);
    });
    render(<WorkspaceBrowser onClose={() => {}} />);
    await screen.findByAltText('Live browser page');
    const surface = screen.getByRole('application', { name: 'Interactive browser page' });
    vi.spyOn(surface, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, width: 1280, height: 800 });
    const pointer = type => {
      const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: 100, clientY: 200 });
      Object.defineProperty(event, 'pointerType', { value: 'mouse' });
      fireEvent(surface, event);
    };
    pointer('pointerdown');
    await waitFor(() => expect(finishDown).toBeTypeOf('function'));
    for (let index = 0; index < 63; index++) fireEvent.wheel(surface, { deltaY: 1 });
    pointer('pointerup');
    await act(async () => finishDown());
    await waitFor(() => expect(apiFetch.mock.calls.some(([_path, options]) => options?.body?.type === 'pointer' && options.body.action === 'up')).toBe(true));
    const commands = apiFetch.mock.calls.map(([_path, options]) => options?.body).filter(Boolean);
    expect([commands.length, commands[0].action, commands.at(-1).action]).toEqual([65, 'down', 'up']);
  });

  it('sends a keepalive cancellation for an unresolved pointer when the pane closes', async () => {
    let finishDown;
    apiFetch.mockImplementation(async (path, options = {}) => {
      if (options.body?.type === 'pointer' && options.body.action === 'down') return new Promise(resolve => { finishDown = () => resolve(response(state)); });
      return response(path.endsWith('/sessions') ? { id: ID, state } : path.endsWith('/frame') ? { ...state, width: 1280, height: 800, image: 'fixture-frame' } : state);
    });
    const view = render(<WorkspaceBrowser onClose={() => {}} />);
    await screen.findByAltText('Live browser page');
    const surface = screen.getByRole('application', { name: 'Interactive browser page' });
    vi.spyOn(surface, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, width: 1280, height: 800 });
    const event = new MouseEvent('pointerdown', { bubbles: true, cancelable: true, clientX: 100, clientY: 200 });
    Object.defineProperty(event, 'pointerType', { value: 'mouse' });
    fireEvent(surface, event);
    await waitFor(() => expect(finishDown).toBeTypeOf('function'));
    const down = apiFetch.mock.calls.find(([_path, options]) => options?.body?.type === 'pointer')[1].body;
    view.unmount();
    const cancellation = apiFetch.mock.calls.find(([_path, options]) => options?.body?.action === 'cancel');
    expect({ body: cancellation?.[1].body, keepalive: cancellation?.[1].keepalive })
      .toEqual({ body: { type: 'pointer', action: 'cancel', gestureId: down.gestureId }, keepalive: true });
    await act(async () => finishDown());
  });

  it('discards a pre-switch frame rather than showing the previous tab under the new address', async () => {
    const next = { ...state, activeTabId: 'next-tab', tabs: [...state.tabs, { id: 'next-tab', title: 'Next page', url: 'https://fixture.test/next' }] };
    let completeFrame;
    apiFetch.mockImplementation(async (path, options) => {
      if (path.endsWith('/frame')) return new Promise(resolve => { completeFrame = resolve; });
      return response(path.endsWith('/sessions') ? { id: ID, state } : options.body?.type === 'newTab' ? next : state);
    });
    render(<WorkspaceBrowser onClose={() => {}} />);
    await waitFor(() => expect(completeFrame).toBeTypeOf('function'));
    fireEvent.click(screen.getByRole('button', { name: 'New browser tab' }));
    await waitFor(() => expect(screen.getByLabelText('Browser address')).toHaveValue('https://fixture.test/next'));
    await act(async () => completeFrame(response({ ...state, width: 1280, height: 800, image: 'old-page-frame' })));
    expect(screen.queryByAltText('Live browser page')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Browser address')).toHaveValue('https://fixture.test/next');
  });

  it('keeps auxiliary text after a failed request and only clears the submitted draft on success', async () => {
    let complete;
    apiFetch.mockImplementation(async (path, options) => {
      if (options.body?.type === 'text') return new Promise(resolve => { complete = resolve; });
      return response(path.endsWith('/sessions') ? { id: ID, state } : { ...state, width: 1280, height: 800, image: null });
    });
    render(<WorkspaceBrowser onClose={() => {}} />);
    await waitFor(() => expect(screen.getByLabelText('Browser address')).toHaveValue(state.tabs[0].url));
    fireEvent.click(screen.getByRole('button', { name: 'Show typing controls' }));
    const input = screen.getByLabelText('Type into browser page');
    fireEvent.change(input, { target: { value: 'retry this text' } });
    fireEvent.click(screen.getByRole('button', { name: 'Type', exact: true }));
    await waitFor(() => expect(complete).toBeTypeOf('function'));
    await act(async () => complete({ ok: false, status: 503, json: async () => ({ error: 'Synthetic connection failure' }) }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Synthetic connection failure');
    expect(input).toHaveValue('retry this text');
    fireEvent.click(screen.getByRole('button', { name: 'Type', exact: true }));
    await act(async () => {});
    fireEvent.change(input, { target: { value: 'newer unsent text' } });
    await act(async () => complete(response(state)));
    expect(input).toHaveValue('newer unsent text');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Type', exact: true }));
    await act(async () => {});
    await act(async () => complete(response(state)));
    expect(input).toHaveValue('');
  });

  it('selects the address on focus and restores the active URL on Escape without navigating', async () => {
    render(<WorkspaceBrowser onClose={() => {}} />);
    const address = screen.getByLabelText('Browser address');
    await waitFor(() => expect(address).toHaveValue(state.tabs[0].url));
    act(() => address.focus());
    expect([address.selectionStart, address.selectionEnd]).toEqual([0, state.tabs[0].url.length]);
    fireEvent.change(address, { target: { value: 'unfinished draft' } });
    fireEvent.keyDown(address, { key: 'Escape' });
    expect(address).toHaveValue(state.tabs[0].url);
    expect(address).not.toHaveFocus();
    expect(screen.getByRole('button', { name: 'Close browser pane' })).toHaveFocus();
    expect(apiFetch.mock.calls.filter(([_path, options]) => options.body?.type === 'navigate')).toEqual([]);
  });

  it('scopes address and reload shortcuts to the browser pane', async () => {
    render(<><input aria-label="Outside browser" /><WorkspaceBrowser onClose={() => {}} /></>);
    const address = screen.getByLabelText('Browser address');
    await waitFor(() => expect(address).toHaveValue(state.tabs[0].url));
    const outside = screen.getByLabelText('Outside browser');
    act(() => outside.focus());
    expect(fireEvent.keyDown(outside, { key: 'l', metaKey: true })).toBe(true);
    expect(fireEvent.keyDown(outside, { key: 'r', ctrlKey: true })).toBe(true);
    expect(outside).toHaveFocus();
    expect(apiFetch.mock.calls.filter(([_path, options]) => options.body)).toEqual([]);
    expect(fireEvent.keyDown(screen.getByRole('button', { name: 'New browser tab' }), { key: 'l', metaKey: true })).toBe(false);
    expect(address).toHaveFocus();
    expect(fireEvent.keyDown(address, { key: 'r', ctrlKey: true })).toBe(false);
    await waitFor(() => expect(apiFetch.mock.calls.filter(([_path, options]) => options.body).map(([_path, options]) => options.body)).toEqual([{ type: 'reload' }]));
  });

  it('does not intercept browser shortcuts or send manual keys while an agent has control', async () => {
    const controlled = { ...state, control: { owner: 'agent', label: 'Agent fixture' } };
    apiFetch.mockImplementation(async path => response(path.endsWith('/sessions') ? { id: ID, state: controlled } : { ...controlled, width: 1280, height: 800, image: null }));
    render(<WorkspaceBrowser onClose={() => {}} />);
    await screen.findByRole('button', { name: 'Take control' });
    const surface = screen.getByRole('application', { name: 'Interactive browser page' });
    act(() => surface.focus());
    expect(fireEvent.keyDown(surface, { key: 'l', metaKey: true })).toBe(true);
    expect(fireEvent.keyDown(surface, { key: 'r', ctrlKey: true })).toBe(true);
    fireEvent.keyDown(surface, { key: 'a' });
    expect(surface).toHaveFocus();
    expect(apiFetch.mock.calls.filter(([_path, options]) => options.body)).toEqual([]);
  });

  it('focuses an explicitly opened blank tab without stealing focus for polled blank tabs', async () => {
    const blankId = 'blank-tab';
    let current = state, resolveFrame;
    apiFetch.mockImplementation(async (path, options) => {
      if (path.endsWith('/approvals')) return response({ requests: [] });
      if (path.endsWith('/frame')) return new Promise(resolve => { resolveFrame = resolve; });
      if (options.body?.type === 'newTab') current = { ...state, activeTabId: blankId, tabs: [...state.tabs, { id: blankId, url: 'about:blank', title: '' }] };
      if (options.body?.type === 'switchTab') current = { ...current, activeTabId: options.body.id };
      return response(path.endsWith('/sessions') ? { id: ID, state: current } : current);
    });
    render(<><input aria-label="Outside browser" /><WorkspaceBrowser onClose={() => {}} /></>);
    await waitFor(() => expect(screen.getByLabelText('Browser address')).toHaveValue(state.tabs[0].url));
    await waitFor(() => expect(resolveFrame).toBeTypeOf('function'));
    const outside = screen.getByLabelText('Outside browser');
    act(() => outside.focus());
    await act(async () => { resolveFrame(response({ ...state, tabs: [{ id: TAB, url: 'about:blank', title: '' }], width: 1280, height: 800, image: null })); });
    expect(outside).toHaveFocus();
    fireEvent.click(screen.getByRole('button', { name: 'New browser tab' }));
    await waitFor(() => expect(screen.getByLabelText('Browser address')).toHaveFocus());
    expect(screen.getByLabelText('Browser address')).toHaveValue('');
    act(() => outside.focus());
    fireEvent.click(screen.getByRole('tab', { name: 'Fixture' }));
    await waitFor(() => expect(screen.getByLabelText('Browser address')).toHaveValue(state.tabs[0].url));
    expect(outside).toHaveFocus();
    fireEvent.click(screen.getByRole('tab', { name: 'New tab' }));
    await waitFor(() => expect(screen.getByLabelText('Browser address')).toHaveFocus());
    expect(screen.getByLabelText('Browser address')).toHaveValue('');
  });

  it('does not steal focus if the user leaves while a new blank tab is opening', async () => {
    let resolveTab;
    apiFetch.mockImplementation(async (path, options) => {
      if (options.body?.type === 'newTab') return new Promise(resolve => { resolveTab = resolve; });
      return response(path.endsWith('/sessions') ? { id: ID, state } : { ...state, width: 1280, height: 800, image: null });
    });
    render(<><input aria-label="Outside browser" /><WorkspaceBrowser onClose={() => {}} /></>);
    const newTab = screen.getByRole('button', { name: 'New browser tab' });
    await waitFor(() => expect(newTab).toBeEnabled());
    act(() => newTab.focus());
    fireEvent.click(newTab);
    await waitFor(() => expect(resolveTab).toBeTypeOf('function'));
    const outside = screen.getByLabelText('Outside browser');
    act(() => outside.focus());
    await act(async () => { resolveTab(response({ ...state, tabs: [{ id: TAB, title: '', url: 'about:blank' }] })); });
    expect(outside).toHaveFocus();
  });

  it('restores the latest active URL after a poll while keeping the draft until Escape', async () => {
    let resolveFrame;
    apiFetch.mockImplementation(async path => {
      if (path.endsWith('/frame')) return new Promise(resolve => { resolveFrame = resolve; });
      return response(path.endsWith('/sessions') ? { id: ID, state } : { requests: [] });
    });
    render(<WorkspaceBrowser onClose={() => {}} />);
    const address = screen.getByLabelText('Browser address');
    await waitFor(() => expect(address).toHaveValue(state.tabs[0].url));
    await waitFor(() => expect(resolveFrame).toBeTypeOf('function'));
    act(() => address.focus());
    fireEvent.change(address, { target: { value: 'my draft' } });
    const latestUrl = 'https://fixture.test/updated';
    await act(async () => { resolveFrame(response({ ...state, tabs: [{ ...state.tabs[0], url: latestUrl }], width: 1280, height: 800, image: null })); });
    expect(address).toHaveValue('my draft');
    fireEvent.keyDown(address, { key: 'Escape' });
    expect(address).toHaveValue(latestUrl);
    expect(address).not.toHaveFocus();
  });

  it('reveals auxiliary typing controls and preserves Reset in the actions menu', async () => {
    render(<WorkspaceBrowser onClose={() => {}} />);
    await waitFor(() => expect(screen.getByLabelText('Browser address')).toHaveValue(state.tabs[0].url));
    expect(screen.getByLabelText('Type into browser page')).not.toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Show typing controls' }));
    expect(screen.getByLabelText('Type into browser page')).toBeVisible();
    fireEvent.change(screen.getByLabelText('Type into browser page'), { target: { value: 'page text' } });
    fireEvent.click(screen.getByRole('button', { name: 'Type', exact: true }));
    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith(`/api/workspace-browser/sessions/${ID}/command`, expect.objectContaining({ body: { type: 'text', text: 'page text' } })));
    fireEvent.click(screen.getByRole('button', { name: 'Hide typing controls' }));
    expect(screen.getByLabelText('Type into browser page')).not.toBeVisible();
    fireEvent.click(screen.getByText('Browser actions'));
    expect(screen.getByRole('button', { name: 'Reset', exact: true })).toBeEnabled();
  });

  it('opens typing controls by default for small screens or coarse pointers', async () => {
    const matchMedia = vi.fn(() => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
    vi.stubGlobal('matchMedia', matchMedia);
    try {
      render(<WorkspaceBrowser onClose={() => {}} />);
      await waitFor(() => expect(screen.getByLabelText('Browser address')).toHaveValue(state.tabs[0].url));
      expect(screen.getByLabelText('Type into browser page')).toBeVisible();
      expect(matchMedia).toHaveBeenCalledWith('(max-width: 600px), (pointer: coarse)');
    } finally { vi.unstubAllGlobals(); }
  });

  it('offers expansion only when the dock provides a toggle and closes without resetting', async () => {
    const close = vi.fn(), toggle = vi.fn();
    const { rerender } = render(<WorkspaceBrowser onClose={close} />);
    await waitFor(() => expect(screen.getByLabelText('Browser address')).toHaveValue(state.tabs[0].url));
    expect(screen.queryByRole('button', { name: 'Expand browser pane' })).not.toBeInTheDocument();
    rerender(<WorkspaceBrowser onClose={close} onToggleExpanded={toggle} isExpanded={false} />);
    fireEvent.click(screen.getByRole('button', { name: 'Expand browser pane' }));
    expect(toggle).toHaveBeenCalledOnce();
    rerender(<WorkspaceBrowser onClose={close} onToggleExpanded={toggle} isExpanded />);
    expect(screen.getByRole('button', { name: 'Restore browser pane' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Close browser pane' }));
    expect(close).toHaveBeenCalledOnce();
    expect(apiFetch.mock.calls.filter(([_path, options]) => options.method === 'DELETE')).toEqual([]);
  });

  it('ignores a pre-dismissal frame that arrives after the next prompt has been edited', async () => {
    const first = { ...state, dialog: { id: 'dialog-a', tabId: TAB, type: 'prompt', message: 'Prompt A', defaultValue: 'A default' } };
    const second = { ...state, dialog: { id: 'dialog-b', tabId: TAB, type: 'prompt', message: 'Prompt B', defaultValue: 'B default' } };
    let current = first, resolveOldFrame, frames = 0;
    apiFetch.mockImplementation(async (path, options) => {
      if (path.endsWith('/approvals')) return response({ requests: [] });
      if (path.endsWith('/frame') && ++frames === 1) return new Promise(resolve => { resolveOldFrame = resolve; });
      if (options.body?.type === 'dialog') current = second;
      return response(path.endsWith('/sessions') ? { id: ID, state: current } : { ...current, width: 1280, height: 800, image: null });
    });
    render(<WorkspaceBrowser onClose={() => {}} />);
    await waitFor(() => expect(screen.getByLabelText('Browser dialog response')).toHaveValue('A default'));
    await waitFor(() => expect(resolveOldFrame).toBeTypeOf('function'));
    fireEvent.click(screen.getByRole('button', { name: 'OK', exact: true }));
    await waitFor(() => expect(screen.getByLabelText('Browser dialog response')).toHaveValue('B default'));
    fireEvent.change(screen.getByLabelText('Browser dialog response'), { target: { value: 'edited B draft' } });
    await act(async () => { resolveOldFrame(response({ ...first, width: 1280, height: 800, image: null })); });
    await waitFor(() => expect(frames).toBeGreaterThan(1));
    expect(screen.getByText('Prompt B')).toBeInTheDocument();
    expect(screen.getByLabelText('Browser dialog response')).toHaveValue('edited B draft');
  });
  it('keeps prompt edits during frame polls and binds each queued decision to its dialog', async () => {
    let current = { ...state, dialog: { id: 'prompt-one', tabId: TAB, type: 'prompt', message: 'First prompt', defaultValue: 'first default' } };
    let frames = 0;
    apiFetch.mockImplementation(async (path, options) => {
      if (path.endsWith('/approvals')) return response({ requests: [] });
      if (path.endsWith('/frame')) frames++;
      if (options.body?.type === 'dialog') current = { ...state, dialog: options.body.accept ? { id: 'prompt-two', tabId: TAB, type: 'prompt', message: 'Second prompt', defaultValue: 'second default' } : null };
      return response(path.endsWith('/sessions') ? { id: ID, state: current } : { ...current, width: 1280, height: 800, image: null });
    });
    render(<WorkspaceBrowser onClose={() => {}} />);
    await waitFor(() => expect(screen.getByLabelText('Browser dialog response')).toHaveValue('first default'));
    fireEvent.change(screen.getByLabelText('Browser dialog response'), { target: { value: 'edited first response' } });
    const priorFrames = frames;
    await waitFor(() => expect(frames).toBeGreaterThan(priorFrames));
    expect(screen.getByLabelText('Browser dialog response')).toHaveValue('edited first response');
    fireEvent.click(screen.getByRole('button', { name: 'OK', exact: true }));
    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith(`/api/workspace-browser/sessions/${ID}/command`, expect.objectContaining({ body: { type: 'dialog', dialogId: 'prompt-one', accept: true, text: 'edited first response' } })));
    await waitFor(() => expect(screen.getByLabelText('Browser dialog response')).toHaveValue('second default'));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel', exact: true }));
    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith(`/api/workspace-browser/sessions/${ID}/command`, expect.objectContaining({ body: { type: 'dialog', dialogId: 'prompt-two', accept: false } })));
    await waitFor(() => expect(screen.queryByLabelText('Browser dialog response')).not.toBeInTheDocument());
  });
  it('holds manual input while an agent controls the browser and supports explicit takeover', async () => {
    let current = { ...state, control: { owner: 'agent', label: 'Codex fixture' } };
    apiFetch.mockImplementation(async (path, options) => {
      if (path.endsWith('/approvals')) return response({ requests: [] });
      if (options.body?.type === 'control') current = { ...current, control: { owner: options.body.owner === 'human' ? 'human' : 'unclaimed' } };
      return response(path.endsWith('/sessions') ? { id: ID, state: current } : { ...current, width: 1280, height: 800, image: 'frame' });
    });
    render(<WorkspaceBrowser onClose={() => {}} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Take control' }));
    await screen.findByRole('button', { name: 'Let agents control' });
    expect(apiFetch).toHaveBeenCalledWith(`/api/workspace-browser/sessions/${ID}/command`, expect.objectContaining({ home: true, body: { type: 'control', owner: 'human' } }));
  });
  it('allows a pending takeover to resolve a dialog while ordinary input remains disabled', async () => {
    let current = { ...state, control: { owner: 'agent', label: 'Fixture' }, dialog: { id: 'key-dialog', type: 'alert', message: 'Key dialog' } };
    apiFetch.mockImplementation(async (path, options) => {
      if (path.endsWith('/approvals')) return response({ requests: [] });
      if (options.body?.type === 'control') current = { ...current, control: { owner: 'human_pending' }, keyboardRelease: 'pending' };
      if (options.body?.type === 'dialog') current = { ...current, control: { owner: 'human' }, keyboardRelease: null, dialog: null };
      return response(path.endsWith('/sessions') ? { id: ID, state: current } : { ...current, width: 1280, height: 800, image: null });
    });
    render(<WorkspaceBrowser onClose={() => {}} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Take control' }));
    await screen.findByText('Finishing the agent’s keyboard action');
    expect(screen.getByRole('button', { name: 'New browser tab' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel', exact: true }));
    await screen.findByRole('button', { name: 'Let agents control' });
    expect(apiFetch).toHaveBeenCalledWith(`/api/workspace-browser/sessions/${ID}/command`, expect.objectContaining({ body: { type: 'dialog', dialogId: 'key-dialog', accept: false } }));
  });
  it.each([{ label: 'Allow once', approved: true }, { label: 'Deny', approved: false }])('shows the exact requested action and binds $label to its approval ID', async ({ label, approved }) => {
    const approval = { id: 'owned-approval', label: 'Claude fixture', name: 'browser_open', arguments: { url: 'https://fixture.test/' }, target: { url: 'https://fixture.test/reviewed-page' } };
    apiFetch.mockImplementation(async (path, options) => {
      if (path.endsWith('/approvals')) return response({ requests: [approval] });
      if (path.includes('/approvals/')) return { ok: true, status: 204 };
      return response(path.endsWith('/sessions') ? { id: ID, state } : { ...state, width: 1280, height: 800, image: 'frame' });
    });
    render(<WorkspaceBrowser onClose={() => {}} />);
    const decision = await screen.findByRole('button', { name: label });
    expect(screen.getByText('Page: https://fixture.test/reviewed-page')).toBeInTheDocument();
    expect(screen.getByText(/"url": "https:\/\/fixture.test\/"/)).toBeInTheDocument();
    fireEvent.click(decision);
    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith('/api/workspace-browser/approvals/owned-approval', expect.objectContaining({ home: true, method: 'POST', body: { approved } })));
    await waitFor(() => expect(screen.queryByRole('button', { name: label })).not.toBeInTheDocument());
  });
  it('presents a tab-list request in plain language with raw arguments available in Details', async () => {
    const approval = { id: 'list-tabs-review', label: 'Codex fixture', name: 'browser_tabs', arguments: {}, target: {} };
    apiFetch.mockImplementation(async path => {
      if (path.endsWith('/approvals')) return response({ requests: [approval] });
      return response(path.endsWith('/sessions') ? { id: ID, state } : { ...state, width: 1280, height: 800, image: 'frame' });
    });
    render(<WorkspaceBrowser onClose={() => {}} />);
    expect(await screen.findByText('View open browser tabs?')).toBeVisible();
    expect(screen.getByText('{}')).not.toBeVisible();
    fireEvent.click(screen.getByText('Review exact action'));
    expect(screen.getByText('{}')).toBeVisible();
    expect(screen.getByText('browser_tabs')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Allow once' })).toBeEnabled();
  });
  it('opens an authenticated home browser and navigates an entered address', async () => {
    render(<WorkspaceBrowser onClose={() => {}} />);
    await waitFor(() => expect(screen.getByLabelText('Browser address')).toHaveValue('https://fixture.test/'));
    fireEvent.change(screen.getByLabelText('Browser address'), { target: { value: 'example.com/docs' } });
    fireEvent.click(screen.getByRole('button', { name: 'Go', exact: true }));
    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith(`/api/workspace-browser/sessions/${ID}/command`, expect.objectContaining({ home: true, method: 'POST', body: { type: 'navigate', url: 'https://example.com/docs' } })));
  });
  it('rejects a file URL before any navigation request and keeps terminal-independent close usable', async () => {
    const close = vi.fn(); render(<WorkspaceBrowser onClose={close} />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Go', exact: true })).toBeEnabled());
    fireEvent.change(screen.getByLabelText('Browser address'), { target: { value: 'file:///etc/hosts' } });
    fireEvent.click(screen.getByRole('button', { name: 'Go', exact: true }));
    expect(screen.getByRole('alert')).toHaveTextContent('HTTP or HTTPS');
    expect(apiFetch.mock.calls.filter(([_path, options]) => options.body?.type === 'navigate')).toEqual([]);
    fireEvent.click(screen.getByRole('button', { name: 'Close browser pane' })); expect(close).toHaveBeenCalledOnce();
  });
  it('relays typed characters and paste to the focused remote page in order', async () => {
    render(<WorkspaceBrowser onClose={() => {}} />);
    await waitFor(() => expect(screen.getByLabelText('Browser address')).toHaveValue('https://fixture.test/'));
    const surface = screen.getByRole('application', { name: 'Interactive browser page' });
    fireEvent.keyDown(surface, { key: 'a' });
    fireEvent.paste(surface, { clipboardData: { getData: () => 'pasted text' } });
    await waitFor(() => expect(apiFetch.mock.calls.filter(([_path, options]) => options.body?.type === 'text').map(([_path, options]) => options.body)).toEqual([{ type: 'text', text: 'a' }, { type: 'text', text: 'pasted text' }]));
  });
  it('shows a startup error with a retry instead of an inert empty pane', async () => {
    apiFetch.mockRejectedValue(new Error('Chromium is unavailable'));
    render(<WorkspaceBrowser onClose={() => {}} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Chromium is unavailable');
    expect(screen.getByRole('button', { name: 'Restart browser' })).toBeEnabled();
  });
  it('clears a transient stream error after frames recover', async () => {
    let failed = false;
    apiFetch.mockImplementation(async path => {
      if (path.endsWith('/sessions')) return response({ id: ID, state });
      if (path.endsWith('/frame') && !failed) { failed = true; throw new Error('Temporary capture failure'); }
      return response({ ...state, width: 1280, height: 800, image: 'recovered-frame' });
    });
    render(<WorkspaceBrowser onClose={() => {}} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Temporary capture failure');
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull(), { timeout: 3000 });
    expect(screen.getByAltText('Live browser page')).toHaveAttribute('src', 'data:image/jpeg;base64,recovered-frame');
  });
  it('restarts an expired session when the server has already removed it', async () => {
    apiFetch.mockImplementation(async (path, options) => {
      if (options.method === 'DELETE') return { ok: false, status: 404, json: async () => ({ error: 'Browser session not found.' }) };
      return response(path.endsWith('/sessions') ? { id: ID, state } : { ...state, width: 1280, height: 800, image: 'frame' });
    });
    render(<WorkspaceBrowser onClose={() => {}} />);
    fireEvent.click(screen.getByText('Browser actions'));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Reset', exact: true })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Reset', exact: true }));
    await waitFor(() => expect(apiFetch.mock.calls.filter(([path, options]) => path.endsWith('/sessions') && options.method === 'POST')).toHaveLength(2));
  });
});
