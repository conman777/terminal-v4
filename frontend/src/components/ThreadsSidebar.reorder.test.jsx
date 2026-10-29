import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import ThreadsSidebar from './ThreadsSidebar';

const apiFetch = vi.hoisted(() => vi.fn());
vi.mock('../utils/api', () => ({ apiFetch }));
vi.mock('../contexts/ThemeContext', () => ({ useTheme: () => ({ theme: 'dark', toggleTheme: vi.fn() }) }));

const reply = (status, body) => ({ ok: status < 300, status, json: async () => body });
const thread = (id, extra = {}, path = '/repo') => ({
  id, title: id, cwd: path, updatedAt: '2026-03-05T18:00:00.000Z',
  thread: { topic: id, projectPath: path, ...extra },
});

function props(sessions, overrides = {}) {
  const live = sessions.filter(session => !session.thread.pinned);
  return {
    isCollapsed: false, workspacePath: '/repo', onToggle: vi.fn(), projects: [], sessionActivity: {}, activeSessionId: 'none',
    sessionsGroupedByProject: [{ projectName: 'Repo', projectPath: '/repo', sessions }],
    pinnedSessions: sessions.filter(session => session.thread.pinned), archivedSessions: [],
    onSelectSession: vi.fn(), onPinSession: vi.fn(), onUnpinSession: vi.fn(), onArchiveSession: vi.fn(), onUnarchiveSession: vi.fn(),
    onTopicChange: vi.fn(), onCloseSession: vi.fn(), onCreateSession: vi.fn(), onCloseProject: vi.fn(), onAddProject: vi.fn(),
    onOpenSettings: vi.fn(), onOpenBookmarks: vi.fn(), onOpenNotes: vi.fn(), onTogglePreview: vi.fn(), onToggleFileManager: vi.fn(), logout: vi.fn(),
    ...overrides, live,
  };
}

function serve({ order = { revision: 1, projects: {} }, put } = {}) {
  apiFetch.mockImplementation(async (url, options = {}) => {
    if (url === '/api/thread-order' && options.method === 'PUT') return put ? put(options.body) : reply(200, { revision: order.revision + 1, projects: { [options.body.projectPath]: options.body.order } });
    if (url === '/api/thread-order') return reply(200, order);
    if (url === '/api/thread-lineage') return reply(200, { links: [{ childId: 'b', parentId: 'a', kind: 'fork' }] });
    if (url.startsWith('/api/workspace/tasks')) return reply(200, { tasks: [], schedules: [] });
    return reply(200, url.startsWith('/api/workspace/git') ? { branches: {} } : []);
  });
}

const titles = () => [...document.querySelectorAll('.threads-recent .threads-session-topic')].map(node => node.textContent);
const puts = () => apiFetch.mock.calls.filter(([, options]) => options?.method === 'PUT').map(([, options]) => options.body);

describe('ThreadsSidebar reordering', () => {
  beforeEach(() => { apiFetch.mockReset(); });

  it('shows threads in the saved project order', async () => {
    serve({ order: { revision: 4, projects: { '/repo': ['c', 'a', 'b'] } } });
    render(<ThreadsSidebar {...props([thread('a'), thread('b'), thread('c')])} />);
    await waitFor(() => expect(titles()).toEqual(['c', 'a', 'b']));
  });

  it('moves a thread with Alt+ArrowDown, saves it, and keeps keyboard focus on it', async () => {
    serve();
    render(<ThreadsSidebar {...props([thread('a'), thread('b'), thread('c')])} />);
    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith('/api/thread-order', expect.anything()));
    const first = screen.getByRole('button', { name: 'Select a' });
    first.focus();
    await act(async () => { fireEvent.keyDown(first, { key: 'ArrowDown', altKey: true }); });
    expect(puts()).toEqual([{ projectPath: '/repo', order: ['b', 'a', 'c'], expectedRevision: 1 }]);
    await waitFor(() => expect(titles()).toEqual(['b', 'a', 'c']));
    expect(screen.getByRole('button', { name: 'Select a' })).toHaveFocus();
  });

  it('offers Move up and Move down in the thread menu only where a move is possible', async () => {
    serve();
    render(<ThreadsSidebar {...props([thread('a'), thread('b')])} />);
    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith('/api/thread-order', expect.anything()));
    fireEvent.click(screen.getByRole('button', { name: 'Thread actions for a' }));
    expect(screen.queryByRole('menuitem', { name: 'Move up' })).not.toBeInTheDocument();
    await act(async () => { fireEvent.click(screen.getByRole('menuitem', { name: 'Move down' })); });
    expect(puts()[0].order).toEqual(['b', 'a']);
  });

  it('reorders by drag and drop within a project', async () => {
    serve();
    render(<ThreadsSidebar {...props([thread('a'), thread('b'), thread('c')])} />);
    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith('/api/thread-order', expect.anything()));
    const card = id => document.querySelector(`[data-thread-id="${id}"]`);
    const data = { setData: vi.fn(), effectAllowed: '', dropEffect: '' };
    card('c').getBoundingClientRect = () => ({ top: -100, height: 20 });
    fireEvent.dragStart(card('a'), { dataTransfer: data });
    fireEvent.dragOver(card('c'), { dataTransfer: data, clientY: 10 });
    await act(async () => { fireEvent.drop(card('c'), { dataTransfer: data, clientY: 10 }); });
    expect(puts()).toEqual([{ projectPath: '/repo', order: ['b', 'c', 'a'], expectedRevision: 1 }]);
  });

  it('does not accept a drop from a different project', async () => {
    serve();
    const sessions = [thread('a'), thread('b'), thread('x', {}, '/other')];
    render(<ThreadsSidebar {...props(sessions, { sessionsGroupedByProject: [{ projectName: 'Repo', projectPath: '/repo', sessions: sessions.slice(0, 2) }, { projectName: 'Other', projectPath: '/other', sessions: sessions.slice(2) }] })} />);
    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith('/api/thread-order', expect.anything()));
    const card = id => document.querySelector(`[data-thread-id="${id}"]`);
    const data = { setData: vi.fn() };
    fireEvent.dragStart(card('a'), { dataTransfer: data });
    fireEvent.dragOver(card('x'), { dataTransfer: data, clientY: 10 });
    fireEvent.drop(card('x'), { dataTransfer: data, clientY: 10 });
    expect(puts()).toEqual([]);
    expect(card('x').getAttribute('draggable')).toBeNull();
  });

  it('keeps pinned threads in the Pinned section above reordered threads', async () => {
    serve({ order: { revision: 2, projects: { '/repo': ['a', 'b', 'p'] } } });
    render(<ThreadsSidebar {...props([thread('a'), thread('b'), thread('p', { pinned: true })])} />);
    await waitFor(() => expect(titles()).toEqual(['a', 'b']));
    const pinned = document.querySelector('.threads-pinned');
    expect(within(pinned).getByRole('button', { name: 'Select p' })).toBeInTheDocument();
    expect(pinned.compareDocumentPosition(document.querySelector('.threads-recent')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Thread actions for p' }));
    expect(screen.queryByRole('menuitem', { name: /Move/ })).not.toBeInTheDocument();
  });

  it('adopts the server order and says so when the revision is stale', async () => {
    serve({ put: () => reply(409, { error: 'changed', current: { revision: 9, projects: { '/repo': ['b', 'a'] } } }) });
    render(<ThreadsSidebar {...props([thread('a'), thread('b')])} />);
    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith('/api/thread-order', expect.anything()));
    const first = screen.getByRole('button', { name: 'Select a' });
    await act(async () => { fireEvent.keyDown(first, { key: 'ArrowDown', altKey: true }); });
    expect(await screen.findByText('Thread order changed on another device. Showing the latest order.')).toBeInTheDocument();
    expect(titles()).toEqual(['b', 'a']);
  });

  it('offers no reordering when the saved order could not be loaded', async () => {
    apiFetch.mockResolvedValue(reply(503, {}));
    render(<ThreadsSidebar {...props([thread('a'), thread('b')])} />);
    await act(async () => {});
    fireEvent.click(screen.getByRole('button', { name: 'Thread actions for a' }));
    expect(screen.queryByRole('menuitem', { name: /Move/ })).not.toBeInTheDocument();
  });
});

describe('ThreadsSidebar related threads', () => {
  beforeEach(() => { apiFetch.mockReset(); });

  it('opens a related thread from the thread menu', async () => {
    serve();
    const p = props([thread('a', { topic: 'Parent conversation' }), thread('b', { topic: 'Forked child thread' })]);
    render(<ThreadsSidebar {...p} />);
    fireEvent.click(screen.getByRole('button', { name: 'Thread actions for Forked child thread' }));
    await userEvent.click(screen.getByRole('menuitem', { name: 'Related threads' }));
    await userEvent.click(within(await screen.findByRole('dialog', { name: /Related threads/ })).getByRole('button', { name: /Parent conversation/ }));
    expect(p.onSelectSession).toHaveBeenCalledWith('a');
    expect(screen.queryByRole('dialog', { name: /Related threads/ })).not.toBeInTheDocument();
  });
});
