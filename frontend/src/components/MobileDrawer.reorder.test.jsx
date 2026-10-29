import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MobileDrawer } from './MobileDrawer';

const apiFetch = vi.hoisted(() => vi.fn());
vi.mock('../utils/api', () => ({ apiFetch }));

const reply = (status, body) => ({ ok: status < 300, status, json: async () => body });
const thread = (id, extra = {}) => ({ id, title: id, cwd: '/repo', thread: { topic: id, projectPath: '/repo', ...extra } });

function serve({ order = { revision: 1, projects: {} }, put } = {}) {
  apiFetch.mockImplementation(async (url, options = {}) => {
    if (url === '/api/thread-order' && options.method === 'PUT') return put ? put(options.body) : reply(200, { revision: order.revision + 1, projects: { [options.body.projectPath]: options.body.order } });
    if (url === '/api/thread-order') return reply(200, order);
    if (url === '/api/thread-lineage') return reply(200, { links: [{ childId: 'b', parentId: 'a', kind: 'fork' }] });
    if (url.startsWith('/api/workspace/tasks')) return reply(200, { tasks: [], schedules: [] });
    return reply(200, []);
  });
}

function drawer(sessions, overrides = {}) {
  return {
    isOpen: true, onClose: vi.fn(), onCreateSession: vi.fn(), projects: [], activeSessions: sessions, archivedSessions: [], activeSessionId: null,
    sessionActivity: {}, onSelectSession: vi.fn(), onViewChange: vi.fn(), onFolderSelect: vi.fn(),
    sessionsGroupedByProject: [{ projectName: 'Repo', projectPath: '/repo', sessions }], ...overrides,
  };
}

const order = () => [...document.querySelectorAll('.md-thread-row')].map(row => row.dataset.reorderId);
const puts = () => apiFetch.mock.calls.filter(([, options]) => options?.method === 'PUT').map(([, options]) => options.body);
const touch = (x, y) => ({ touches: [{ clientX: x, clientY: y }], changedTouches: [{ clientX: x, clientY: y }] });

describe('MobileDrawer reordering and relations', () => {
  beforeEach(() => { apiFetch.mockReset(); vi.useRealTimers(); });
  afterEach(() => { delete document.elementFromPoint; });

  it('shows saved order with pinned threads first', async () => {
    serve({ order: { revision: 3, projects: { '/repo': ['c', 'p', 'a', 'b'] } } });
    render(<MobileDrawer {...drawer([thread('a'), thread('b'), thread('c'), thread('p', { pinned: true })])} />);
    await waitFor(() => expect(order()).toEqual(['p', 'c', 'a', 'b']));
  });

  it('reveals Move up and Move down from the options button without a long press', async () => {
    serve();
    render(<MobileDrawer {...drawer([thread('a'), thread('b'), thread('c')])} />);
    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith('/api/thread-order', expect.anything()));
    await act(async () => {});
    const row = document.querySelector('[data-reorder-id="b"]');
    fireEvent.click(within(row).getByRole('button', { name: 'Thread options' }));
    await act(async () => { fireEvent.click(within(row).getByRole('button', { name: 'Move up' })); });
    expect(puts()).toEqual([{ projectPath: '/repo', order: ['b', 'a', 'c'], expectedRevision: 1 }]);
    await waitFor(() => expect(order()).toEqual(['b', 'a', 'c']));
  });

  it('arms a row on long press and reorders by dragging it onto another thread', async () => {
    serve();
    render(<MobileDrawer {...drawer([thread('a'), thread('b'), thread('c')])} />);
    await act(async () => {});
    const row = document.querySelector('[data-reorder-id="a"]');
    const target = document.querySelector('[data-reorder-id="c"]');
    target.getBoundingClientRect = () => ({ top: 200, height: 40 });
    document.elementFromPoint = () => target;
    vi.useFakeTimers();
    fireEvent.touchStart(row, touch(10, 10));
    act(() => { vi.advanceTimersByTime(600); });
    vi.useRealTimers();
    expect(row).toHaveClass('thread-reorder-armed');
    fireEvent.touchMove(row, touch(10, 230));
    await act(async () => { fireEvent.touchEnd(row, touch(10, 230)); });
    expect(puts()).toEqual([{ projectPath: '/repo', order: ['b', 'c', 'a'], expectedRevision: 1 }]);
  });

  it('does not open a thread when the finger lifts after a long press', async () => {
    serve();
    const props = drawer([thread('a'), thread('b')]);
    render(<MobileDrawer {...props} />);
    await act(async () => {});
    const row = document.querySelector('[data-reorder-id="a"]');
    vi.useFakeTimers();
    fireEvent.touchStart(row, touch(10, 10));
    act(() => { vi.advanceTimersByTime(600); });
    fireEvent.touchEnd(row, touch(10, 10));
    fireEvent.click(within(row).getByText('a'));
    vi.useRealTimers();
    expect(props.onSelectSession).not.toHaveBeenCalled();
  });

  it('offers no ordering controls for a thread alone in its group', async () => {
    serve();
    render(<MobileDrawer {...drawer([thread('a'), thread('p', { pinned: true })])} />);
    await act(async () => {});
    const row = document.querySelector('[data-reorder-id="a"]');
    fireEvent.click(within(row).getByRole('button', { name: 'Thread options' }));
    expect(within(row).queryByRole('button', { name: /Move/ })).not.toBeInTheDocument();
    expect(within(row).getByRole('button', { name: 'Related threads' })).toBeInTheDocument();
  });

  it('opens a related thread and closes the drawer', async () => {
    serve();
    const props = drawer([thread('a', { topic: 'Parent conversation' }), thread('b', { topic: 'Forked child thread' })]);
    render(<MobileDrawer {...props} />);
    await act(async () => {});
    const row = document.querySelector('[data-reorder-id="b"]');
    fireEvent.click(within(row).getByRole('button', { name: 'Thread options' }));
    fireEvent.click(within(row).getByRole('button', { name: 'Related threads' }));
    const dialog = await screen.findByRole('dialog', { name: /Related threads for Forked child thread/ });
    fireEvent.click(await within(dialog).findByRole('button', { name: /Parent conversation/ }));
    expect(props.onSelectSession).toHaveBeenCalledWith('a');
    expect(props.onClose).toHaveBeenCalled();
  });
});
