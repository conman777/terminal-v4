import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MobileDrawer } from './MobileDrawer';
import { setActiveEnvironment } from '../utils/remoteEnvironments';

const downloadProjectArchiveMock = vi.fn();
const apiFetchMock = vi.fn();
vi.mock('../utils/api', () => ({ apiFetch: (...args) => apiFetchMock(...args) }));

vi.mock('../utils/projectArchiveDownload', () => ({
  downloadProjectArchive: (...args) => downloadProjectArchiveMock(...args)
}));

function buildProps(overrides = {}) {
  return {
    isOpen: true,
    onClose: vi.fn(),
    onCreateSession: vi.fn(),
    onOpenSettings: vi.fn(),
    onOpenApiSettings: vi.fn(),
    onOpenBrowserSettings: vi.fn(),
    onOpenBookmarks: vi.fn(),
    onOpenNotes: vi.fn(),
    onOpenProcessManager: vi.fn(),
    projects: [],
    projectsLoading: false,
    onFolderSelect: vi.fn(),
    currentPath: '',
    onAddScanFolder: vi.fn(),
    onNavigateToPath: vi.fn(),
    mobileView: 'terminal',
    onViewChange: vi.fn(),
    previewUrl: '',
    activeSessions: [],
    activeSessionId: null,
    sessionActivity: {},
    onSelectSession: vi.fn(),
    sessionsGroupedByProject: [],
    ...overrides
  };
}

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('MobileDrawer', () => {
  it('keeps confirmed settled work visible and returns threads needing attention to the inbox', () => {
    const lifecycle = { supported: true, settlementSupported: true, settled: true, requiresAttention: false, snoozed: false };
    const done = { id: 'ss-done', title: 'Finished work', runtime: 'v4', status: 'completed', threadLifecycle: lifecycle };
    const pending = { id: 'ss-pending', title: 'Needs a response', runtime: 'v4', status: 'completed', threadLifecycle: { ...lifecycle, requiresAttention: true } };
    const props = buildProps({ activeSessions: [done, pending], sessionsGroupedByProject: [{ projectName: 'Project', sessions: [done, pending] }] });
    const view = render(<MobileDrawer {...props} />);
    expect(screen.getByRole('region', { name: 'Settled threads' })).toHaveTextContent('Finished work');
    expect(screen.getByRole('button', { name: /Needs a response/ })).toBeVisible();
    const awakened = { ...done, threadLifecycle: { ...lifecycle, settled: false } };
    view.rerender(<MobileDrawer {...props} activeSessions={[awakened, pending]} sessionsGroupedByProject={[{ projectName: 'Project', sessions: [awakened, pending] }]} />);
    expect(screen.queryByRole('region', { name: 'Settled threads' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Finished work/ })).toBeVisible();
  });
  it('retains keyboard focus when a thread moves between the inbox and Settled', () => {
    const lifecycle = { supported: true, settlementSupported: true, settled: false, canSettle: true, requiresAttention: false, snoozed: false };
    const session = { id: 'ss-focus', title: 'Focused work', runtime: 'v4', status: 'idle', threadLifecycle: lifecycle };
    const groups = current => [{ projectName: 'Project', sessions: [current] }];
    const props = buildProps({ activeSessions: [session], sessionsGroupedByProject: groups(session) });
    const view = render(<MobileDrawer {...props} />);
    screen.getByRole('button', { name: /Focused work/ }).focus();
    const settled = { ...session, threadLifecycle: { ...lifecycle, settled: true } };
    view.rerender(<MobileDrawer {...props} activeSessions={[settled]} sessionsGroupedByProject={groups(settled)} />);
    expect(screen.getByRole('button', { name: /Focused work/ })).toHaveFocus();
    view.rerender(<MobileDrawer {...props} />);
    expect(screen.getByRole('button', { name: /Focused work/ })).toHaveFocus();
  });
  it('returns cached settled threads to the inbox when inventory is unavailable', () => {
    const session = { id: 'ss-stale', title: 'Stale work', runtime: 'v4', status: 'idle', threadLifecycle: { supported: true, snoozed: false, settlementSupported: true, settled: true, requiresAttention: false } };
    render(<MobileDrawer {...buildProps({ sessionLoadError: true, activeSessions: [session], sessionsGroupedByProject: [{ projectName: 'Project', sessions: [session] }] })} />);
    expect(screen.queryByRole('region', { name: 'Settled threads' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Stale work/ })).toBeVisible();
  });
  it('keeps snoozed conversations visible and returns them to the inbox when attention is needed', () => {
    const session = { id: 'ss-a', title: 'Snoozed work', threadLifecycle: { supported: true, snoozed: true, requiresAttention: false } };
    const props = buildProps({ activeSessions: [session], sessionsGroupedByProject: [{ projectName: 'Project', sessions: [session] }] });
    const view = render(<MobileDrawer {...props} />);
    expect(screen.getByRole('region', { name: 'Snoozed threads' })).toHaveTextContent('Snoozed work');
    const awakened = { ...session, threadLifecycle: { supported: true, snoozed: false, requiresAttention: true } };
    view.rerender(<MobileDrawer {...props} activeSessions={[awakened]} sessionsGroupedByProject={[{ projectName: 'Project', sessions: [awakened] }]} />);
    expect(screen.queryByRole('region', { name: 'Snoozed threads' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Snoozed work/ })).toBeVisible();
  });
  it('announces loading instead of an empty thread list while sessions load', () => {
    const props = buildProps({ activeSessions: [], sessionsGroupedByProject: [], sessionsLoading: true });
    const { rerender } = render(<MobileDrawer {...props} />);
    expect(screen.getByRole('status')).toHaveTextContent('Loading threads…');
    expect(screen.queryByText('No active threads')).not.toBeInTheDocument();
    expect(screen.queryByText('0 active')).not.toBeInTheDocument();
    rerender(<MobileDrawer {...props} sessionsLoading={false} />);
    expect(screen.getByText('No active threads')).toBeVisible();
    expect(screen.queryByText('Loading threads…')).not.toBeInTheDocument();
  });
  it('does not present a failed session inventory as an empty thread list', () => {
    const props = buildProps({ activeSessions: [], sessionsGroupedByProject: [], sessionLoadError: true });
    const { rerender } = render(<MobileDrawer {...props} />);
    expect(screen.getByText('Load failed')).toBeVisible();
    expect(screen.getByText('Thread list may be incomplete')).toBeVisible();
    expect(screen.queryByText('No active threads')).not.toBeInTheDocument();
    expect(screen.queryByText('0 active')).not.toBeInTheDocument();
    rerender(<MobileDrawer {...buildProps({ activeSessions: [{ id: 'cached', title: 'Cached thread' }], sessionLoadError: true })} />);
    expect(screen.getByText('Thread list may be incomplete')).toBeVisible();
    expect(screen.getByRole('button', { name: /Cached thread/ })).toBeVisible();
  });
  it('offers restoration from the scoped archived list without changing the active thread', async () => {
    const onUnarchiveSession = vi.fn().mockResolvedValue({ archived: false });
    const props = buildProps({ archivedSessions: [{ id: 'old', title: 'Archived discussion', thread: { archived: true } }], onUnarchiveSession });
    render(<MobileDrawer {...props} />);
    fireEvent.click(screen.getByRole('button', { name: /Archived threads/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Restore Archived discussion' }));
    await waitFor(() => expect(onUnarchiveSession).toHaveBeenCalledWith('old'));
    expect(props.onSelectSession).not.toHaveBeenCalled();
    expect(props.onClose).not.toHaveBeenCalled();
  });

  it('lets a user collapse archived search results without changing the normal archive state', () => {
    render(<MobileDrawer {...buildProps({ archivedSessions: [{ id: 'old', title: 'Release notes', thread: { archived: true } }], onUnarchiveSession: vi.fn() })} />);
    const search = screen.getByRole('searchbox', { name: 'Search threads' });
    const toggle = screen.getByRole('button', { name: /Archived threads \(1\)/ });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    fireEvent.change(search, { target: { value: 'Release' } });
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('button', { name: 'Restore Release notes' })).toBeVisible();
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('button', { name: 'Restore Release notes' })).not.toBeInTheDocument();
    fireEvent.click(toggle);
    expect(screen.getByRole('button', { name: 'Restore Release notes' })).toBeVisible();
    fireEvent.change(search, { target: { value: '' } });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(toggle);
    fireEvent.change(search, { target: { value: 'Release' } });
    fireEvent.click(toggle);
    fireEvent.change(search, { target: { value: '' } });
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('button', { name: 'Restore Release notes' })).toBeVisible();
  });

  it('shows restore failures and permits retry without selecting a thread', async () => {
    const onUnarchiveSession = vi.fn().mockRejectedValueOnce(new Error('Synthetic restore failure')).mockResolvedValueOnce({ archived: false });
    const props = buildProps({ archivedSessions: [{ id: 'old', title: 'Archived discussion', thread: { archived: true } }], onUnarchiveSession });
    render(<MobileDrawer {...props} />);
    fireEvent.click(screen.getByRole('button', { name: /Archived threads/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Restore Archived discussion' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Synthetic restore failure');
    fireEvent.click(screen.getByRole('button', { name: 'Restore Archived discussion' }));
    await waitFor(() => expect(onUnarchiveSession).toHaveBeenCalledTimes(2));
    expect(props.onSelectSession).not.toHaveBeenCalled();
  });

  it('discards a pending restore error after changing environments', async () => {
    let reject;
    const onUnarchiveSession = vi.fn(() => new Promise((_, fail) => { reject = fail; }));
    render(<MobileDrawer {...buildProps({ archivedSessions: [{ id: 'old', title: 'Archived discussion', thread: { archived: true } }], onUnarchiveSession })} />);
    fireEvent.click(screen.getByRole('button', { name: /Archived threads/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Restore Archived discussion' }));
    act(() => setActiveEnvironment({ id: 'restore-test-environment' }));
    await act(async () => reject(new Error('Stale restore failure')));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    act(() => setActiveEnvironment(null));
  });

  it('places pinned threads first within each project and identifies them', () => {
    const sessions = [{ id: 'a', title: 'First' }, { id: 'b', title: 'Pinned', thread: { pinned: true } }, { id: 'c', title: 'Last' }];
    render(<MobileDrawer {...buildProps({ activeSessions: sessions, sessionsGroupedByProject: [{ projectName: 'Project', sessions }] })} />);
    const dialog = screen.getByRole('dialog', { name: 'Mobile menu' });
    const rows = [...dialog.querySelectorAll('.mobile-drawer-project-sessions-modern > button')];
    expect(rows.map(row => row.querySelector('.thread-item-title-modern').textContent)).toEqual(['Pinned', 'First', 'Last']);
    expect(rows[0].querySelector('[aria-label="Pinned thread"]')).toBeInTheDocument();
  });

  it('keeps background work visible while approval state may change between polls', () => {
    const session = { id: 'work', title: 'Background work', status: 'running', threadLifecycle: { supported: true, requiresAttention: false } };
    render(<MobileDrawer {...buildProps({ activeSessions: [session], sessionsGroupedByProject: [{ projectName: 'Project', sessions: [session] }], sessionActivity: { work: { isBusy: true } } })} />);
    expect(screen.queryByRole('button', { name: /Working \(1\)/ })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Background work/ })).toBeVisible();
  });
  it('groups background work separately while keeping pinned, selected and attention threads visible', () => {
    const sessions = [
      { id: 'current', status: 'running', title: 'Current thread', threadLifecycle: { supported: true, requiresAttention: false } },
      { id: 'pinned', status: 'running', title: 'Pinned thread', thread: { pinned: true }, threadLifecycle: { supported: true, requiresAttention: false } },
      { id: 'attention', status: 'running', title: 'Needs review', threadLifecycle: { supported: true, requiresAttention: true } },
      { id: 'working', status: 'running', title: 'Background work', threadLifecycle: { supported: true, requiresAttention: false } },
      { id: 'done', title: 'Finished thread' },
    ];
    const props = buildProps({ activeSessions: sessions, activeSessionId: 'current', sessionsGroupedByProject: [{ projectName: 'Project', sessions }], sessionActivity: {
      current: { isBusy: true }, pinned: { isBusy: true }, attention: { isBusy: true, needsAttention: true }, working: { isBusy: true },
    } });
    const { rerender } = render(<MobileDrawer {...props} />);
    const section = screen.getByRole('region', { name: 'Working threads' });
    expect(section).toHaveTextContent('Background work');
    expect(section).not.toHaveTextContent('Current thread');
    expect(section).not.toHaveTextContent('Pinned thread');
    expect(section).not.toHaveTextContent('Needs review');
    for (const name of ['Current thread', 'Pinned thread', 'Needs review', 'Finished thread']) expect(screen.getByRole('button', { name: new RegExp(name) })).toBeVisible();
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search threads' }), { target: { value: 'Background' } });
    expect(screen.getByRole('button', { name: /Background work/ })).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: /Background work/ }));
    expect(props.onSelectSession).toHaveBeenCalledWith('working');
    expect(props.onClose).toHaveBeenCalled();
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search threads' }), { target: { value: '' } });
    rerender(<MobileDrawer {...props} sessionActivity={{ ...props.sessionActivity, working: { isBusy: false, needsAttention: true } }} />);
    expect(screen.queryByRole('region', { name: 'Working threads' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Background work/ })).toBeVisible();
  });

  it('keeps unread, unknown and pending work visible', () => {
    const sessions = [
      { id: 'work', status: 'running', title: 'Background work', threadLifecycle: { supported: true, requiresAttention: false } },
      { id: 'unknown', title: 'Unknown work', threadLifecycle: { supported: true, requiresAttention: false } },
      { id: 'pending', title: 'Pending approval', status: 'running', threadLifecycle: { supported: true, requiresAttention: true } },
    ];
    render(<MobileDrawer {...buildProps({ activeSessions: sessions, sessionsGroupedByProject: [{ projectName: 'Project', sessions }], sessionActivity: { work: { isBusy: true, needsAttention: true }, unknown: { isBusy: true }, pending: { isBusy: true } } })} />);
    expect(screen.getByRole('button', { name: /Background work/ })).toBeVisible();
    expect(screen.getByRole('button', { name: /Unknown work/ })).toBeVisible();
    expect(screen.getByRole('button', { name: /Pending approval/ })).toBeVisible();
  });

  it('keeps keyboard focus on a working thread when it becomes ready', () => {
    const session = { id: 'work', status: 'running', title: 'Background work', threadLifecycle: { supported: true, requiresAttention: false } };
    const props = buildProps({ activeSessions: [session], sessionsGroupedByProject: [{ projectName: 'Project', sessions: [session] }], sessionActivity: { work: { isBusy: true } } });
    const view = render(<MobileDrawer {...props} />);
    screen.getByRole('button', { name: /Background work/ }).focus();
    view.rerender(<MobileDrawer {...props} sessionActivity={{ work: { isBusy: false, needsAttention: true } }} />);
    expect(screen.getByRole('button', { name: /Background work/ })).toHaveFocus();
  });

  it('keeps a focused thread reachable if it starts work', () => {
    const sessions = [{ id: 'ready', status: 'running', title: 'Ready thread', threadLifecycle: { supported: true, requiresAttention: false } }, { id: 'other', status: 'running', title: 'Other work', threadLifecycle: { supported: true, requiresAttention: false } }];
    const props = buildProps({ activeSessions: sessions, sessionsGroupedByProject: [{ projectName: 'Project', sessions }], sessionActivity: { ready: { isBusy: false }, other: { isBusy: true } } });
    const view = render(<MobileDrawer {...props} />);
    screen.getByRole('button', { name: /Ready thread/ }).focus();
    view.rerender(<MobileDrawer {...props} sessionActivity={{ ready: { isBusy: true }, other: { isBusy: true } }} />);
    expect(screen.getByRole('region', { name: 'Working threads' })).toHaveTextContent('Working (2)');
    expect(screen.getByRole('button', { name: /Ready thread/ })).toHaveFocus();
  });

  it('keeps a conversation needing recovery out of the working section', () => {
    const session = { id: 'recovery', title: 'Needs recovery', status: 'cleanup_required' };
    render(<MobileDrawer {...buildProps({ activeSessions: [session], sessionActivity: { recovery: { isBusy: true } } })} />);
    expect(screen.queryByRole('region', { name: 'Working threads' })).not.toBeInTheDocument();
    const row = screen.getByRole('button', { name: /Needs recovery/ });
    expect(row.querySelector('[aria-label="Needs attention"]')).toBeInTheDocument();
    expect(row.querySelector('[aria-label="Working"]')).not.toBeInTheDocument();
  });

  it('keeps unknown or pending-request states outside the working section', () => {
    const sessions = [
      { id: 'ss-unknown', title: 'Unknown state' },
      { id: 'ss-pending', title: 'Approval needed', threadLifecycle: { supported: true, requiresAttention: true } },
      { id: 'ss-working', status: 'running', title: 'Safe work', threadLifecycle: { supported: true, requiresAttention: false } },
    ];
    render(<MobileDrawer {...buildProps({ activeSessions: sessions, sessionsGroupedByProject: [{ projectName: 'Project', sessions }], sessionActivity: Object.fromEntries(sessions.map(session => [session.id, { isBusy: true }])) })} />);
    expect(screen.getByRole('button', { name: /Unknown state/ })).toBeVisible();
    expect(screen.getByRole('button', { name: /Approval needed/ })).toBeVisible();
    expect(screen.getByRole('button', { name: /Safe work/ })).toBeVisible();
  });

  it('recovers initial focus after the browser applies the drawer inert change during paint', () => {
    const frames = new Map();
    let frameId = 0;
    vi.stubGlobal('requestAnimationFrame', callback => { frames.set(++frameId, callback); return frameId; });
    vi.stubGlobal('cancelAnimationFrame', id => frames.delete(id));
    const runFrame = () => act(() => {
      const current = [...frames.values()]; frames.clear(); current.forEach(callback => callback());
    });
    const nativeFocus = HTMLElement.prototype.focus;
    const ignoredOpeningFocusAttempts = 2;
    let ignoredAttempts = 0;
    const focus = vi.spyOn(HTMLElement.prototype, 'focus').mockImplementation(function (...args) {
      if (this.getAttribute('aria-label') === 'Close menu' && ignoredAttempts++ < ignoredOpeningFocusAttempts) return;
      return nativeFocus.apply(this, args);
    });
    const opener = document.createElement('button');
    document.body.append(opener); opener.focus();
    const view = render(<MobileDrawer {...buildProps()} />);
    const close = screen.getByRole('button', { name: 'Close menu' });
    runFrame();
    expect(close).not.toHaveFocus();
    opener.blur();
    runFrame();
    expect(close).toHaveFocus();
    view.unmount();
    expect(opener).toHaveFocus();
    expect(opener).not.toHaveAttribute('inert');
    opener.remove(); focus.mockRestore(); vi.unstubAllGlobals();
  });

  it.each([false, true])('preserves project dialog focus when delayed drawer focus runs with closed=%s', closed => {
    const frames = new Map();
    let frameId = 0;
    vi.stubGlobal('requestAnimationFrame', callback => { frames.set(++frameId, callback); return frameId; });
    vi.stubGlobal('cancelAnimationFrame', id => frames.delete(id));
    const runFrame = () => act(() => {
      const current = [...frames.values()]; frames.clear(); current.forEach(callback => callback());
    });
    const props = buildProps();
    const view = render(<MobileDrawer {...props} />);
    runFrame();
    const portal = document.createElement('section');
    portal.setAttribute('role', 'dialog');
    const input = document.createElement('input'); portal.append(input); document.body.append(portal);
    input.focus();
    if (closed) {
      view.rerender(<MobileDrawer {...props} isOpen={false} />);
      expect(frames.size).toBe(0);
    }
    runFrame();
    expect(input).toHaveFocus();
    view.rerender(<MobileDrawer {...props} isOpen={false} />);
    expect(frames.size).toBe(0);
    expect(input).toHaveFocus();
    portal.remove(); vi.unstubAllGlobals();
  });

  it('makes a closed drawer inert to keyboard and pointer interaction', () => {
    const { container } = render(<MobileDrawer {...buildProps({ isOpen: false })} />);
    expect(container.querySelector('.mobile-drawer-modern')).toHaveAttribute('inert');
  });

  beforeEach(() => {
    downloadProjectArchiveMock.mockReset();
    apiFetchMock.mockReset();
    apiFetchMock.mockResolvedValue({ ok: true, json: async () => [] });
  });

  it('searches saved content across the owner workspace and selects its full result', async () => {
    const row = { sessionId: 'saved', title: 'Saved thread', snippet: 'Found the needle', matchType: 'message', anchor: { type: 'message', messageId: 'm1', role: 'assistant' } };
    apiFetchMock.mockResolvedValue({ ok: true, json: async () => [row] });
    const props = buildProps({ currentPath: '/current-project', onSelectHistoryResult: vi.fn() });
    render(<MobileDrawer {...props} />);
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search threads' }), { target: { value: 'needle' } });
    const result = await screen.findByRole('button', { name: /Saved thread.*Found the needle/ });
    const [url, options] = apiFetchMock.mock.calls[0];
    expect(url).toBe('/api/workspace/history?q=needle&limit=20');
    expect(options.signal).toBeInstanceOf(AbortSignal);
    fireEvent.click(result);
    expect(props.onSelectHistoryResult).toHaveBeenCalledWith(row);
    expect(props.onClose).toHaveBeenCalled();
  });

  it('aborts stale searches and ignores responses after the query changes or drawer closes', async () => {
    const pending = [];
    apiFetchMock.mockImplementation((url, options) => new Promise(resolve => pending.push({ url, signal: options.signal, resolve })));
    const props = buildProps();
    const view = render(<MobileDrawer {...props} />);
    const search = screen.getByRole('searchbox', { name: 'Search threads' });
    fireEvent.change(search, { target: { value: 'first' } });
    await waitFor(() => expect(pending).toHaveLength(1));
    fireEvent.change(search, { target: { value: 'second' } });
    expect(pending[0].signal.aborted).toBe(true);
    await waitFor(() => expect(pending).toHaveLength(2));
    await act(async () => pending[0].resolve({ ok: true, json: async () => [{ sessionId: 'old', title: 'Stale result' }] }));
    expect(screen.queryByText('Stale result')).not.toBeInTheDocument();
    view.rerender(<MobileDrawer {...props} isOpen={false} />);
    expect(pending[1].signal.aborted).toBe(true);
  });

  it('clears saved results and aborts the request when the environment changes', async () => {
    const pending = [];
    apiFetchMock.mockImplementation((url, options) => new Promise(resolve => pending.push({ signal: options.signal, resolve })));
    const view = render(<MobileDrawer {...buildProps()} />);
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search threads' }), { target: { value: 'needle' } });
    await waitFor(() => expect(pending).toHaveLength(1));
    act(() => setActiveEnvironment({ id: 'synthetic-remote' }));
    expect(pending[0].signal.aborted).toBe(true);
    expect(screen.getByRole('searchbox', { name: 'Search threads' })).toHaveValue('');
    await act(async () => pending[0].resolve({ ok: true, json: async () => [{ sessionId: 'old', title: 'Other environment result' }] }));
    expect(screen.queryByText('Other environment result')).not.toBeInTheDocument();
    view.unmount();
    act(() => setActiveEnvironment(null));
  });

  it('does not send a pending search to a newly selected environment', async () => {
    const view = render(<MobileDrawer {...buildProps()} />);
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search threads' }), { target: { value: 'private lookup' } });
    act(() => setActiveEnvironment({ id: 'new-mobile-search-environment' }));
    await act(async () => new Promise(resolve => setTimeout(resolve, 400)));
    expect(apiFetchMock.mock.calls.filter(([url]) => url.startsWith('/api/workspace/history'))).toEqual([]);
    view.unmount();
    act(() => setActiveEnvironment(null));
  });

  it('searches live threads by title and project, with an explicit clear action', () => {
    const sessions = [
      { id: 'one', title: 'Fix login' },
      { id: 'two', title: 'Review layout' },
      { id: 'old', title: 'Archived login', thread: { archived: true } },
    ];
    const props = buildProps({ activeSessions: sessions, sessionsGroupedByProject: [
      { projectName: 'Alpha', projectPath: '/alpha', sessions: [sessions[0], sessions[2]] },
      { projectName: 'Beta', projectPath: '/beta', sessions: [sessions[1]] },
    ] });
    render(<MobileDrawer {...props} />);
    const search = screen.getByRole('searchbox', { name: 'Search threads' });
    fireEvent.change(search, { target: { value: 'LOGIN' } });
    expect(screen.getByRole('button', { name: 'Fix login' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Review layout' })).not.toBeInTheDocument();
    expect(screen.queryByText('Archived login')).not.toBeInTheDocument();
    fireEvent.change(search, { target: { value: '/beta' } });
    expect(screen.getByRole('button', { name: 'Review layout' })).toBeInTheDocument();
    fireEvent.change(search, { target: { value: 'missing' } });
    expect(screen.getByText('No matching active thread names or projects')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Clear thread search' }));
    expect(search).toHaveValue('');
    expect(search).toHaveFocus();
    expect(screen.getByRole('button', { name: 'Fix login' })).toBeInTheDocument();
  });

  it('renders project actions and global settings outside the thread list', () => {
    const props = buildProps({
      workspaceActions: <button type="button">Project tools</button>,
      onOpenWorkspaceBrowser: vi.fn(),
      theme: 'dark',
      onToggleTheme: vi.fn(),
    });
    render(<MobileDrawer {...props} />);
    expect(screen.getByRole('button', { name: 'Project tools' })).toBeInTheDocument();
    for (const [name, callback] of [
      ['Browser', props.onOpenWorkspaceBrowser],
      ['Browser settings', props.onOpenBrowserSettings],
      ['API settings', props.onOpenApiSettings],
      ['Light mode', props.onToggleTheme],
    ]) {
      fireEvent.click(screen.getByRole('button', { name }));
      expect(callback).toHaveBeenCalledWith();
    }
    expect(props.onClose).toHaveBeenCalledTimes(4);
  });

  it('restores focus and releases body scrolling when unmounted while open', () => {
    const trigger = document.createElement('button');
    document.body.appendChild(trigger);
    trigger.focus();
    const { unmount } = render(<MobileDrawer {...buildProps()} />);
    screen.getByRole('button', { name: 'Close menu' }).focus();
    expect(document.body.style.overflow).toBe('hidden');
    unmount();
    expect(trigger).toHaveFocus();
    expect(document.body.style.overflow).toBe('');
    trigger.remove();
  });

  it('does not steal focus or handle Escape from a project tool dialog', () => {
    const onClose = vi.fn();
    const props = buildProps({ onClose });
    const { rerender } = render(<MobileDrawer {...props} />);
    const dialog = document.createElement('section');
    dialog.setAttribute('role', 'dialog');
    const input = document.createElement('input');
    dialog.appendChild(input);
    document.body.appendChild(dialog);
    input.focus();
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();
    rerender(<MobileDrawer {...props} isOpen={false} />);
    expect(input).toHaveFocus();
    dialog.remove();
  });

  it('closes from the backdrop and retains the project search draft', () => {
    const props = buildProps({ projects: [{ path: '/repo', name: 'Repository' }] });
    const { container, rerender } = render(<MobileDrawer {...props} />);
    fireEvent.click(screen.getByRole('button', { name: 'Projects' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Search projects' }), { target: { value: 'Repo' } });
    fireEvent.click(container.querySelector('.mobile-drawer-overlay-modern'));
    expect(props.onClose).toHaveBeenCalledWith();
    rerender(<MobileDrawer {...props} isOpen={false} />);
    rerender(<MobileDrawer {...props} isOpen />);
    expect(screen.getByRole('textbox', { name: 'Search projects' })).toHaveValue('Repo');
  });

  it('makes the background inert while open and restores its previous inert state', () => {
    const background = document.createElement('button');
    const alreadyInert = document.createElement('div');
    alreadyInert.setAttribute('inert', '');
    document.body.append(background, alreadyInert);
    background.focus();
    const props = buildProps();
    const { rerender } = render(<MobileDrawer {...props} />);
    expect(background).toHaveAttribute('inert');
    expect(screen.getByRole('button', { name: 'Close menu' })).toHaveFocus();
    rerender(<MobileDrawer {...props} isOpen={false} />);
    expect(background).not.toHaveAttribute('inert');
    expect(alreadyInert).toHaveAttribute('inert');
    expect(background).toHaveFocus();
    background.remove();
    alreadyInert.remove();
  });

  it('closes on Escape key press', () => {
    const onClose = vi.fn();
    render(<MobileDrawer {...buildProps({ onClose })} />);

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('closes on left swipe gesture', () => {
    const onClose = vi.fn();
    const { container } = render(<MobileDrawer {...buildProps({ onClose })} />);
    const drawer = container.querySelector('.mobile-drawer-modern');
    expect(drawer).toBeTruthy();

    fireEvent.touchStart(drawer, {
      touches: [{ clientX: 220, clientY: 120 }]
    });
    fireEvent.touchEnd(drawer, {
      changedTouches: [{ clientX: 140, clientY: 126 }]
    });

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('traps focus within the drawer when tabbing', () => {
    const { container } = render(<MobileDrawer {...buildProps()} />);
    const drawer = container.querySelector('.mobile-drawer-modern');
    expect(drawer).toBeTruthy();

    const selector = [
      'button:not([disabled])',
      '[href]',
      'input:not([disabled])',
      'select:not([disabled])',
      'textarea:not([disabled])',
      '[tabindex]:not([tabindex="-1"])'
    ].join(', ');

    const focusable = Array.from(drawer.querySelectorAll(selector));
    expect(focusable.length).toBeGreaterThan(1);

    const first = focusable[0];
    const last = focusable[focusable.length - 1];

    last.focus();
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(first).toHaveFocus();

    first.focus();
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
    expect(last).toHaveFocus();
  });

  it('restores focus to the previously focused element when closing', () => {
    const trigger = document.createElement('button');
    trigger.textContent = 'open drawer';
    document.body.appendChild(trigger);
    trigger.focus();

    const props = buildProps({ isOpen: true });
    const { rerender } = render(<MobileDrawer {...props} />);

    rerender(<MobileDrawer {...props} isOpen={false} />);
    expect(trigger).toHaveFocus();

    trigger.remove();
  });

  it('exposes dialog semantics while open', () => {
    render(<MobileDrawer {...buildProps()} />);

    expect(screen.getByRole('dialog', { name: /mobile menu/i })).toBeInTheDocument();
  });

  it('filters archived sessions from the live threads list', () => {
    render(<MobileDrawer {...buildProps({
      sessionsGroupedByProject: [
        {
          projectName: 'terminal-v4',
          projectPath: 'C:\\repo',
          sessions: [
            {
              id: 'session-1',
              title: 'Terminal 1',
              updatedAt: '2026-03-09T10:00:00.000Z',
              thread: { topic: 'visible thread', archived: false }
            },
            {
              id: 'session-2',
              title: 'Terminal 2',
              updatedAt: '2026-03-09T10:01:00.000Z',
              thread: { topic: 'archived thread', archived: true }
            }
          ]
        }
      ]
    })} />);

    expect(screen.getByText('visible thread')).toBeInTheDocument();
    expect(screen.queryByText('archived thread')).not.toBeInTheDocument();
  });

  it('shows the active session inside the threads section with derived labels', () => {
    render(<MobileDrawer {...buildProps({
      activeSessions: [
        {
          id: 'session-1',
          title: 'C:\\Users\\conor\\OneDrive\\Personal\\Documents\\coding projects\\uplifting',
          cwd: 'C:\\Users\\conor\\OneDrive\\Personal\\Documents\\coding projects\\uplifting',
          updatedAt: '2026-03-09T10:00:00.000Z',
          thread: { topic: 'ship mobile header', archived: false }
        }
      ],
      sessionsGroupedByProject: [
        {
          projectName: 'uplifting',
          projectPath: 'C:\\Users\\conor\\OneDrive\\Personal\\Documents\\coding projects\\uplifting',
          sessions: [
            {
              id: 'session-1',
              title: 'C:\\Users\\conor\\OneDrive\\Personal\\Documents\\coding projects\\uplifting',
              cwd: 'C:\\Users\\conor\\OneDrive\\Personal\\Documents\\coding projects\\uplifting',
              updatedAt: '2026-03-09T10:00:00.000Z',
              thread: { topic: 'ship mobile header', archived: false }
            }
          ]
        }
      ],
      activeSessionId: 'session-1'
    })} />);

    expect(screen.getByText('Threads')).toBeInTheDocument();
    expect(screen.getAllByText('ship mobile header').length).toBeGreaterThan(0);
    expect(screen.getAllByText('uplifting').length).toBeGreaterThan(0);
  });

  it('surfaces primary utility actions from the simplified drawer', () => {
    const onOpenProcessManager = vi.fn();
    const onOpenBookmarks = vi.fn();
    const onOpenNotes = vi.fn();

    render(<MobileDrawer {...buildProps({ onOpenProcessManager, onOpenBookmarks, onOpenNotes })} />);

    fireEvent.click(screen.getByRole('button', { name: 'Process Manager' }));
    expect(onOpenProcessManager).toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Bookmarks' }));
    expect(onOpenBookmarks).toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Notes' }));
    expect(onOpenNotes).toHaveBeenCalled();
  });

  it('shows compact session subtitles instead of raw paths in the live list', () => {
    render(<MobileDrawer {...buildProps({
      sessionsGroupedByProject: [
        {
          projectName: 'uplifting',
          projectPath: 'C:\\Users\\conor\\OneDrive\\Personal\\Documents\\coding projects\\uplifting',
          sessions: [
            {
              id: 'session-1',
              title: 'C:\\Users\\conor\\OneDrive\\Personal\\Documents\\coding projects\\uplifting',
              cwd: 'C:\\Users\\conor\\OneDrive\\Personal\\Documents\\coding projects\\uplifting',
              updatedAt: '2026-03-09T10:00:00.000Z',
              thread: { topic: 'ship mobile polish', archived: false }
            }
          ]
        }
      ]
    })} />);

    const upliftingLabels = screen.getAllByText('uplifting');
    expect(upliftingLabels.length).toBeGreaterThan(0);
    expect(screen.queryByText(/OneDrive/)).not.toBeInTheDocument();
  });

  it('does not render a recent terminals section', () => {
    render(<MobileDrawer {...buildProps()} />);

    expect(screen.queryByText('Recent terminals')).not.toBeInTheDocument();
  });

  it('does not render a separate current session hero card', () => {
    render(<MobileDrawer {...buildProps({
      activeSessions: [
        {
          id: 'session-1',
          title: 'Terminal 1',
          updatedAt: '2026-03-09T10:00:00.000Z',
          thread: { topic: 'active mobile thread', archived: false }
        }
      ],
      sessionsGroupedByProject: [
        {
          projectName: 'terminal-v4',
          projectPath: 'C:\\repo',
          sessions: [
            {
              id: 'session-1',
              title: 'Terminal 1',
              updatedAt: '2026-03-09T10:00:00.000Z',
              thread: { topic: 'active mobile thread', archived: false }
            }
          ]
        }
      ],
      activeSessionId: 'session-1'
    })} />);

    expect(screen.queryByText('Current session')).not.toBeInTheDocument();
    expect(screen.getByText('active mobile thread')).toBeInTheDocument();
  });

  it('renders the simplified drawer shell', () => {
    render(<MobileDrawer {...buildProps({ previewUrl: 'https://example.com' })} />);

    expect(screen.getByRole('button', { name: 'Workspace' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Preview' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'New thread' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Settings' })).toBeInTheDocument();
  });

  it('downloads a zipped project from the projects section', () => {
    render(<MobileDrawer {...buildProps({
      projects: [{ path: 'C:\\repo', name: 'terminal v4' }]
    })} />);

    fireEvent.click(screen.getByRole('button', { name: /projects/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Zip and download terminal v4' }));

    expect(downloadProjectArchiveMock).toHaveBeenCalledWith('C:\\repo');
  });

  it('keeps the preview button visible even when no preview url is available yet', () => {
    render(<MobileDrawer {...buildProps({ previewUrl: '' })} />);

    expect(screen.getByRole('button', { name: 'Workspace' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Preview' })).toBeInTheDocument();
  });

  it('switches to preview even when no preview url is available yet', () => {
    const onViewChange = vi.fn();
    const onClose = vi.fn();

    render(<MobileDrawer {...buildProps({
      previewUrl: '',
      onViewChange,
      onClose,
    })} />);

    fireEvent.click(screen.getByRole('button', { name: 'Preview' }));

    expect(onViewChange).toHaveBeenCalledWith('preview');
    expect(onClose).toHaveBeenCalled();
  });

  it('shows a ready indicator for inactive threads with completed activity', () => {
    render(<MobileDrawer {...buildProps({
      activeSessionId: 'session-2',
      sessionActivity: {
        'session-1': {
          isBusy: false,
          needsAttention: true
        }
      },
      sessionsGroupedByProject: [
        {
          projectName: 'uplifting',
          projectPath: 'C:\\repo\\uplifting',
          sessions: [
            {
              id: 'session-1',
              title: 'Terminal 1',
              updatedAt: '2026-03-09T10:00:00.000Z',
              thread: { topic: 'review mobile pass', archived: false }
            }
          ]
        }
      ]
    })} />);

    expect(screen.getByLabelText('Ready to review')).toBeInTheDocument();
  });

  it('can hide the view tabs when mobile navigation owns the current view', () => {
    render(<MobileDrawer {...buildProps({ showViewTabs: false })} />);

    expect(screen.queryByRole('button', { name: 'Workspace' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Preview' })).not.toBeInTheDocument();
  });
});
