import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { FileManager } from './FileManager';
import { apiFetch, apiGet } from '../utils/api';
import { beginAuthChange, setUser } from '../utils/auth';
import { setActiveEnvironment, setEnvironmentIdentity } from '../utils/remoteEnvironments';
vi.mock('../utils/api', () => ({ apiGet: vi.fn(), apiFetch: vi.fn() }));
vi.mock('../utils/auth', async importOriginal => ({ ...await importOriginal(), getAccessToken: () => null }));

describe('FileManager workspace initialization', () => {
  beforeEach(() => {
    apiGet.mockReset().mockImplementation(async url => ({ path: new URL(url, 'http://fixture.invalid').searchParams.get('path'), items: [{ name: 'nested', type: 'directory' }] }));
  });
  it('closes files using its named control, including while the workspace is unavailable', async () => {
    const onClose = vi.fn();
    const { rerender } = render(<FileManager isOpen initialPath="/canonical/workspace" onClose={onClose} />);
    await screen.findByText('nested');
    fireEvent.click(screen.getByRole('button', { name: 'Close files' }));
    rerender(<FileManager isOpen initialPath={null} onClose={onClose} />);
    fireEvent.click(screen.getByRole('button', { name: 'Close files' }));
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('selects files and restores focus after dismissing an image preview', async () => {
    apiGet.mockResolvedValue({ path: '/canonical/workspace', items: [{ name: 'diagram.png', type: 'file', size: 0 }] });
    render(<FileManager isOpen initialPath="/canonical/workspace" onClose={() => {}} />);
    const entry = await screen.findByRole('button', { name: 'Select file diagram.png' });
    fireEvent.click(entry);
    expect(entry).toHaveAttribute('aria-pressed', 'true');
    expect(entry).toHaveTextContent('0 B');
    const preview = screen.getByRole('button', { name: 'Preview diagram.png' });
    preview.focus();
    fireEvent.click(preview);
    const dialog = screen.getByRole('dialog', { name: 'Preview diagram.png' });
    expect(dialog.parentElement).toBe(document.body);
    expect(dialog).toHaveFocus();
    fireEvent.keyDown(dialog, { key: 'Tab', shiftKey: true });
    expect(screen.getByRole('button', { name: 'Close' })).toHaveFocus();
    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(preview).toHaveFocus();
  });
  it('offers named keyboard folder navigation and clears a directory filter when opening a folder', async () => {
    render(<FileManager isOpen initialPath="/canonical/workspace" onClose={() => {}} />);
    await screen.findByText('nested');
    const search = screen.getByRole('searchbox', { name: 'Search files' });
    fireEvent.change(search, { target: { value: 'nested' } });
    const folder = screen.getByRole('button', { name: 'Open folder nested' });
    folder.focus();
    expect(folder).toHaveFocus();
    fireEvent.click(folder);
    await waitFor(() => expect(apiGet).toHaveBeenLastCalledWith('/api/files/list?path=%2Fcanonical%2Fworkspace%2Fnested'));
    expect(search).toHaveValue('');
    expect(screen.getByRole('navigation', { name: 'File path' }).querySelector('[aria-current="location"]')).toHaveTextContent('nested');
  });

  it('returns focus to New folder when cancelling a draft with Escape', async () => {
    render(<FileManager isOpen initialPath="/canonical/workspace" onClose={() => {}} />);
    await screen.findByText('nested');
    fireEvent.click(screen.getByRole('button', { name: 'New folder' }));
    const input = screen.getByRole('textbox', { name: 'Folder name' });
    fireEvent.change(input, { target: { value: 'Unsent folder' } });
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(screen.queryByRole('textbox', { name: 'Folder name' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'New folder' })).toHaveFocus();
  });
  it('does not read home while a selected session workspace is loading or unavailable', async () => {
    render(<FileManager isOpen initialPath={null} onClose={() => {}} />);
    await act(async () => { await Promise.resolve(); });
    expect(apiGet).not.toHaveBeenCalled();
    expect(screen.getByRole('status')).toHaveTextContent('Selected workspace is loading or unavailable');
  });
  it('initializes its real directory request to the selected workspace', async () => {
    render(<FileManager isOpen initialPath="/canonical/workspace" onClose={() => {}} />);
    await waitFor(() => expect(apiGet).toHaveBeenCalledWith('/api/files/list?path=%2Fcanonical%2Fworkspace'));
  });
  it('preserves manual browsing for the same workspace and resets on a keyed workspace change', async () => {
    const props = { isOpen: true, onClose: () => {} };
    const view = render(<FileManager key="home" {...props} initialPath="~" />);
    await screen.findByText('nested');
    await act(async () => { fireEvent.click(screen.getByText('nested')); });
    await waitFor(() => expect(apiGet).toHaveBeenLastCalledWith('/api/files/list?path=~%2Fnested'));
    const count = apiGet.mock.calls.length;
    view.rerender(<FileManager key="home" {...props} initialPath="~" />);
    expect(apiGet).toHaveBeenCalledTimes(count);
    view.rerender(<FileManager key="next-workspace" {...props} initialPath="/canonical/next" />);
    await waitFor(() => expect(apiGet).toHaveBeenLastCalledWith('/api/files/list?path=%2Fcanonical%2Fnext'));
  });
  it('keeps the newer manual directory when older navigation responses arrive later', async () => {
    const resolvers = new Map();
    apiGet.mockImplementation(url => {
      const selected = new URL(url, 'http://fixture.invalid').searchParams.get('path');
      if (selected === '/canonical') return Promise.resolve({ path: selected, items: [] });
      return new Promise(resolve => resolvers.set(selected, resolve));
    });
    const prompt = vi.spyOn(window, 'prompt').mockReturnValueOnce('/canonical/old').mockReturnValueOnce('/canonical/new');
    try {
      render(<FileManager isOpen initialPath="/canonical" onClose={() => {}} />);
      await waitFor(() => expect(screen.getByText('Empty folder')).toBeInTheDocument());
      fireEvent.click(screen.getByTitle('Go to path'));fireEvent.click(screen.getByTitle('Go to path'));
      await act(async () => { resolvers.get('/canonical/new')({ path: '/canonical/new', items: [{ name: 'new-marker', type: 'file' }] }); });
      expect(screen.getByText('new-marker')).toBeInTheDocument();
      await act(async () => { resolvers.get('/canonical/old')({ path: '/canonical/old', items: [{ name: 'old-marker', type: 'file' }] }); });
      expect(screen.getByText('new-marker')).toBeInTheDocument();
      expect(screen.queryByText('old-marker')).not.toBeInTheDocument();
    } finally { prompt.mockRestore(); }
  });

  it('ignores a directory response from a previous authentication generation', async () => {
    let finish;
    apiGet.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    render(<FileManager isOpen initialPath="/canonical/workspace" onClose={() => {}} />);
    await waitFor(() => expect(finish).toBeTypeOf('function'));
    beginAuthChange();
    await act(async () => { finish({ path: '/canonical/workspace', items: [{ name: 'old-account-file', type: 'file' }] }); });
    expect(screen.queryByText('old-account-file')).not.toBeInTheDocument();
  });

  it('clears already displayed files when the authenticated account changes', async () => {
    setUser({ id: 'first-account' });
    apiGet.mockResolvedValue({ path: '/canonical/workspace', items: [{ name: 'old-account-file', type: 'file' }] });
    try {
      render(<FileManager isOpen initialPath="/canonical/workspace" onClose={() => {}} />);
      expect(await screen.findByText('old-account-file')).toBeVisible();
      act(() => setUser({ id: 'second-account' }));
      expect(screen.queryByText('old-account-file')).not.toBeInTheDocument();
      expect(screen.getByRole('alert')).toHaveTextContent('Close and reopen Files');
    } finally { act(() => setUser(null)); }
  });

  it('keeps displayed files when the same account refreshes its profile', async () => {
    setUser({ id: 'same-account', name: 'Before' });
    apiGet.mockResolvedValue({ path: '/canonical/workspace', items: [{ name: 'current-file', type: 'file' }] });
    try {
      render(<FileManager isOpen initialPath="/canonical/workspace" onClose={() => {}} />);
      expect(await screen.findByText('current-file')).toBeVisible();
      act(() => setUser({ id: 'same-account', name: 'After' }));
      expect(screen.getByText('current-file')).toBeVisible();
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    } finally { act(() => setUser(null)); }
  });

});

describe('FileManager scoped project reveal', () => {
  beforeEach(() => { apiGet.mockReset(); apiFetch.mockReset(); setUser({ id: 'scoped-file-owner' }); });

  it('selects the referenced file using only a session-scoped directory listing', async () => {
    apiFetch.mockResolvedValue({ ok: true, json: async () => ({ root: '/work/project', path: 'src', truncated: false,
      items: [{ name: 'app.js', type: 'file', size: 3 }, { name: 'sub', type: 'directory', size: 0 }] }) });
    render(<FileManager isOpen initialPath="/work/project/src" sessionId="ss-owned" projectTarget={{ root: '/work/project', path: 'src/app.js' }} onClose={() => {}} />);
    expect(await screen.findByRole('button', { name: 'Select file app.js' })).toHaveAttribute('aria-pressed', 'true');
    const params = new URL(apiFetch.mock.calls[0][0], 'http://fixture.invalid').searchParams;
    expect(Object.fromEntries(params)).toEqual({ sessionId: 'ss-owned', root: '/work/project', path: 'src' });
    expect(apiGet).not.toHaveBeenCalled();
    expect(screen.getByText('Project files · read-only')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Download app.js' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'New folder' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Upload' })).toBeNull();
  });

  it('does not fall back to the unrestricted browser when the scoped request fails', async () => {
    apiFetch.mockResolvedValue({ ok: false, json: async () => ({ error: 'Project directory is unavailable' }) });
    render(<FileManager isOpen initialPath="/work/project/src" sessionId="ss-owned" projectTarget={{ root: '/work/project', path: 'src/app.js' }} onClose={() => {}} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Project directory is unavailable');
    expect(apiGet).not.toHaveBeenCalled();
  });

  it('discards a scoped listing when the server changes while it is loading', async () => {
    let finish;
    apiFetch.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    try {
      render(<FileManager isOpen initialPath="/work/project/src" sessionId="ss-owned" projectTarget={{ root: '/work/project', path: 'src/app.js' }} onClose={() => {}} />);
      await waitFor(() => expect(finish).toBeTypeOf('function'));
      act(() => setActiveEnvironment({ id: 'another-server' }));
      await act(async () => finish({ ok: true, json: async () => ({ root: '/work/project', path: 'src', truncated: false, items: [{ name: 'app.js', type: 'file', size: 3 }] }) }));
      expect(screen.queryByRole('button', { name: 'Select file app.js' })).toBeNull();
      expect(screen.getByRole('alert')).toHaveTextContent('Close and reopen Files');
      expect(apiFetch).toHaveBeenCalledTimes(1);
      expect(apiGet).not.toHaveBeenCalled();
    } finally { act(() => setActiveEnvironment(null)); }
  });

  it('opens a selected project file in a scoped text preview and restores focus', async () => {
    apiFetch.mockImplementation(async url => {
      if (url.includes('/list-directory?')) return { ok: true, json: async () => ({ root: '/work/project', path: 'src', truncated: false, items: [{ name: 'app.js', type: 'file', size: 3 }] }) };
      if (url.includes('/read-content?')) return { ok: true, json: async () => ({ root: '/work/project', path: 'src/app.js', line: 1, totalLines: 1, lines: [{ line: 1, text: 'const x = 1;', truncated: false }] }) };
      throw new Error(`Unexpected endpoint ${url}`);
    });
    render(<FileManager isOpen initialPath="/work/project/src" sessionId="ss-owned" projectTarget={{ root: '/work/project', path: 'src/app.js' }} onClose={() => {}} />);
    const preview = await screen.findByRole('button', { name: 'Preview app.js' });
    expect(preview).toHaveTextContent('Open');
    preview.focus();
    fireEvent.click(preview);
    const dialog = await screen.findByRole('dialog', { name: 'File preview: src/app.js, line 1' });
    expect(await screen.findByText('const x = 1;')).toBeVisible();
    const request = apiFetch.mock.calls.find(([url]) => url.includes('/read-content?'))[0];
    expect(Object.fromEntries(new URL(request, 'http://fixture.invalid').searchParams)).toEqual({ sessionId: 'ss-owned', root: '/work/project', path: 'src/app.js', line: '1', query: '' });
    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(preview).toHaveFocus();
    expect(apiGet).not.toHaveBeenCalled();
  });

  it('closes a project file preview when the active thread changes', async () => {
    apiFetch.mockImplementation(async url => url.includes('/list-directory?')
      ? { ok: true, json: async () => ({ root: '/work/project', path: 'src', truncated: false, items: [{ name: 'app.js', type: 'file', size: 3 }] }) }
      : { ok: true, json: async () => ({ root: '/work/project', path: 'src/app.js', line: 1, totalLines: 1, lines: [{ line: 1, text: 'private data', truncated: false }] }) });
    const props = { isOpen: true, initialPath: '/work/project/src', projectTarget: { root: '/work/project', path: 'src/app.js' }, onClose: () => {} };
    const view = render(<FileManager {...props} sessionId="ss-first" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Preview app.js' }));
    expect(await screen.findByText('private data')).toBeVisible();
    view.rerender(<FileManager {...props} sessionId="ss-second" />);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.queryByText('private data')).toBeNull();
  });

  it('reports unreadable files without falling back to the unrestricted browser', async () => {
    apiFetch.mockImplementation(async url => url.includes('/list-directory?')
      ? { ok: true, json: async () => ({ root: '/work/project', path: 'src', truncated: false, items: [{ name: 'data.bin', type: 'file', size: 3 }, { name: 'bad?name', type: 'file', size: 0 }] }) }
      : { ok: false, json: async () => ({ error: 'This file cannot be previewed as text.' }) });
    render(<FileManager isOpen initialPath="/work/project/src" sessionId="ss-owned" projectTarget={{ root: '/work/project', path: 'src/app.js' }} onClose={() => {}} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Preview data.bin' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('This file cannot be previewed as text.');
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(screen.getByRole('button', { name: 'Preview bad?name' })).toBeDisabled();
    expect(apiGet).not.toHaveBeenCalled();
  });

  it('closes a loading preview and discards its result when the server changes', async () => {
    let finishPreview;
    apiFetch.mockImplementation(async url => url.includes('/list-directory?')
      ? { ok: true, json: async () => ({ root: '/work/project', path: 'src', truncated: false, items: [{ name: 'app.js', type: 'file', size: 3 }] }) }
      : new Promise(resolve => { finishPreview = resolve; }));
    try {
      render(<FileManager isOpen initialPath="/work/project/src" sessionId="ss-owned" projectTarget={{ root: '/work/project', path: 'src/app.js' }} onClose={() => {}} />);
      fireEvent.click(await screen.findByRole('button', { name: 'Preview app.js' }));
      await waitFor(() => expect(finishPreview).toBeTypeOf('function'));
      act(() => setActiveEnvironment({ id: 'another-server' }));
      await act(async () => finishPreview({ ok: true, json: async () => ({ root: '/work/project', path: 'src/app.js', line: 1, totalLines: 1, lines: [{ line: 1, text: 'old server data', truncated: false }] }) }));
      expect(screen.queryByRole('dialog')).toBeNull();
      expect(screen.queryByText('old server data')).toBeNull();
      expect(apiGet).not.toHaveBeenCalled();
    } finally { act(() => setActiveEnvironment(null)); }
  });

  it('keeps navigation inside the project and rejects malformed directory entries', async () => {
    apiFetch.mockImplementation(async url => {
      const path = new URL(url, 'http://fixture.invalid').searchParams.get('path');
      return { ok: true, json: async () => ({ root: '/work/project', path, truncated: false,
        items: path === 'src' ? [{ name: 'app.js', type: 'file', size: 3 }, { name: 'sub', type: 'directory', size: 0 }]
          : path === 'src/sub' ? [{ name: '../escape', type: 'file', size: 0 }] : [] }) };
    });
    const openTerminal = vi.fn();
    render(<FileManager isOpen initialPath="/work/project/src" sessionId="ss-owned" projectTarget={{ root: '/work/project', path: 'src/app.js' }} onNavigateTerminal={openTerminal} onClose={() => {}} />);
    const folder = await screen.findByRole('button', { name: 'Open folder sub' });
    fireEvent.doubleClick(folder);
    expect(openTerminal).not.toHaveBeenCalled();
    fireEvent.click(folder);
    expect(await screen.findByRole('alert')).toHaveTextContent('invalid response');
    expect(screen.queryByRole('button', { name: 'Select file ../escape' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Go to path' })).toBeNull();
    expect(apiGet).not.toHaveBeenCalled();
  });
});

describe('FileManager project content search', () => {
  const listing = url => {
    const params = new URL(url, 'http://fixture.invalid').searchParams;
    return { ok: true, json: async () => ({ root: params.get('root'), path: params.get('path'), truncated: false, items: [{ name: 'main.js', type: 'file', size: 1 }] }) };
  };
  beforeEach(() => {
    apiGet.mockReset().mockImplementation(async url => ({ path: new URL(url, 'http://fixture.invalid').searchParams.get('path'), items: [] }));
    apiFetch.mockReset();
  });

  it('does not search without an owned active session', async () => {
    render(<FileManager isOpen initialPath="/canonical/workspace" onClose={() => {}} />);
    await screen.findByText('Empty folder');
    fireEvent.click(screen.getByRole('button', { name: 'Search project contents' }));
    expect(screen.getByRole('status')).toHaveTextContent('Select a thread to search its project');
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it('searches within the session and shows a result in its folder', async () => {
    apiFetch.mockImplementation(async url => url.includes('list-directory') ? listing(url) : { ok: true, json: async () => ({ root: '/canonical/workspace', matches: [{ path: 'src/main.js', line: 3, text: 'const needle = 1;' }], truncated: false }) });
    render(<FileManager isOpen initialPath="/canonical/workspace" sessionId="ss-owned" onClose={() => {}} />);
    await screen.findByText('Empty folder');
    fireEvent.click(screen.getByRole('button', { name: 'Search project contents' }));
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search project contents' }), { target: { value: 'needle' } });
    fireEvent.click(screen.getByRole('button', { name: 'Search project' }));
    const result = await screen.findByRole('button', { name: /src\/main.js:3/ });
    expect(apiFetch).toHaveBeenCalledWith(expect.stringContaining('sessionId=ss-owned'), expect.objectContaining({ signal: expect.any(AbortSignal) }));
    fireEvent.click(result);
    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith(expect.stringContaining('/api/workspace/files/list-directory?'), expect.objectContaining({ signal: expect.any(AbortSignal) })));
    expect(apiGet).toHaveBeenCalledTimes(1);
  });

  it('keeps the selected search line visible and returns to the existing results', async () => {
    apiFetch.mockImplementation(async url => url.includes('list-directory') ? listing(url) : { ok: true, json: async () => ({ root: '/canonical/workspace', matches: [
      { path: 'src/main.js', line: 3, text: 'const needle = 1;' },
      { path: 'src/other.js', line: 7, text: 'needle elsewhere' },
    ], truncated: false }) });
    render(<FileManager isOpen initialPath="/canonical/workspace" sessionId="ss-owned" onClose={() => {}} />);
    await screen.findByText('Empty folder');
    fireEvent.click(screen.getByRole('button', { name: 'Search project contents' }));
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search project contents' }), { target: { value: 'needle' } });
    fireEvent.click(screen.getByRole('button', { name: 'Search project' }));
    fireEvent.click(await screen.findByRole('button', { name: /src\/main.js:3/ }));
    const selected = screen.getByRole('region', { name: 'Selected search result' });
    expect(selected).toHaveFocus();
    expect(selected).toHaveTextContent('src/main.js:3');
    expect(selected).toHaveTextContent('const needle = 1;');
    expect(selected).toHaveTextContent('File may have changed since search.');
    fireEvent.click(screen.getByRole('button', { name: 'Back to search results' }));
    expect(screen.getByRole('button', { name: /src\/other.js:7/ })).toBeVisible();
    expect(screen.getByRole('button', { name: /src\/main.js:3/ })).toHaveFocus();
    expect(apiFetch.mock.calls.filter(([url]) => url.includes('search-content'))).toHaveLength(1);
  });

  it('opens a session-scoped current file preview at the selected line', async () => {
    apiFetch.mockImplementation(async url => url.includes('list-directory') ? listing(url) : url.includes('search-content')
      ? { ok: true, json: async () => ({ root: '/canonical/workspace', matches: [{ path: 'src/main.js', line: 3, text: 'needle' }] }) }
      : { ok: true, json: async () => ({ root: '/canonical/workspace', path: 'src/main.js', line: 3, totalLines: 4, lines: [{ line: 2, text: 'before', truncated: false }, { line: 3, text: 'needle now', truncated: false }, { line: 4, text: 'after', truncated: false }] }) });
    render(<FileManager isOpen initialPath="/canonical/workspace" sessionId="ss-owned" onClose={() => {}} />);
    await screen.findByText('Empty folder');
    fireEvent.click(screen.getByRole('button', { name: 'Search project contents' }));
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search project contents' }), { target: { value: 'needle' } });
    fireEvent.click(screen.getByRole('button', { name: 'Search project' }));
    fireEvent.click(await screen.findByRole('button', { name: /src\/main.js:3/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Open current file at line' }));
    const preview = await screen.findByRole('region', { name: 'Current file preview' });
    expect(preview).toHaveTextContent('before');
    expect(preview.querySelector('[aria-current="true"]')).toHaveTextContent('needle now');
    const [url, options] = apiFetch.mock.calls.at(-1);
    const params = new URL(url, 'http://fixture.invalid').searchParams;
    expect([params.get('sessionId'), params.get('root'), params.get('path'), params.get('line')]).toEqual(['ss-owned', '/canonical/workspace', 'src/main.js', '3']);
    expect(options.signal).toBeInstanceOf(AbortSignal);
  });

  it('keeps the original search snapshot if the current file cannot be opened', async () => {
    apiFetch.mockImplementation(async url => url.includes('list-directory') ? listing(url) : url.includes('search-content')
      ? { ok: true, json: async () => ({ root: '/canonical/workspace', matches: [{ path: 'src/main.js', line: 3, text: 'original needle' }] }) }
      : { ok: false, json: async () => ({ error: 'That line no longer exists; search again' }) });
    render(<FileManager isOpen initialPath="/canonical/workspace" sessionId="ss-owned" onClose={() => {}} />);
    await screen.findByText('Empty folder');
    fireEvent.click(screen.getByRole('button', { name: 'Search project contents' }));
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search project contents' }), { target: { value: 'needle' } });
    fireEvent.click(screen.getByRole('button', { name: 'Search project' }));
    fireEvent.click(await screen.findByRole('button', { name: /src\/main.js:3/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Open current file at line' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('That line no longer exists');
    expect(screen.getByRole('region', { name: 'Selected search result' })).toHaveTextContent('original needle');
    expect(screen.getByRole('button', { name: 'Back to search results' })).toBeVisible();
  });

  it('clears an already opened file preview when the account changes', async () => {
    setUser({ id: 'first-preview-account' });
    apiFetch.mockImplementation(async url => url.includes('list-directory') ? listing(url) : url.includes('search-content')
      ? { ok: true, json: async () => ({ root: '/canonical/workspace', matches: [{ path: 'src/main.js', line: 3, text: 'needle' }] }) }
      : { ok: true, json: async () => ({ root: '/canonical/workspace', path: 'src/main.js', line: 3, totalLines: 3, lines: [{ line: 3, text: 'old account preview', truncated: false }] }) });
    try {
      render(<FileManager isOpen initialPath="/canonical/workspace" sessionId="ss-owned" onClose={() => {}} />);
      await screen.findByText('Empty folder');
      fireEvent.click(screen.getByRole('button', { name: 'Search project contents' }));
      fireEvent.change(screen.getByRole('searchbox', { name: 'Search project contents' }), { target: { value: 'needle' } });
      fireEvent.click(screen.getByRole('button', { name: 'Search project' }));
      fireEvent.click(await screen.findByRole('button', { name: /src\/main.js:3/ }));
      fireEvent.click(screen.getByRole('button', { name: 'Open current file at line' }));
      expect(await screen.findByText('old account preview')).toBeVisible();
      act(() => setUser({ id: 'second-preview-account' }));
      expect(screen.queryByText('old account preview')).not.toBeInTheDocument();
      expect(screen.queryByRole('region', { name: 'Selected search result' })).not.toBeInTheDocument();
    } finally { act(() => setUser(null)); }
  });

  it.each(['session', 'environment', 'account'])('discards a late current-file preview after %s changes', async scope => {
    let finish;
    setEnvironmentIdentity('content-search-owner');
    apiFetch.mockImplementation(url => url.includes('list-directory') ? Promise.resolve(listing(url)) : url.includes('search-content')
      ? Promise.resolve({ ok: true, json: async () => ({ root: '/canonical/workspace', matches: [{ path: 'src/main.js', line: 3, text: 'needle' }] }) })
      : new Promise(resolve => { finish = resolve; }));
    try {
      const view = render(<FileManager isOpen initialPath="/canonical/workspace" sessionId="ss-owned" onClose={() => {}} />);
      await screen.findByText('Empty folder');
      fireEvent.click(screen.getByRole('button', { name: 'Search project contents' }));
      fireEvent.change(screen.getByRole('searchbox', { name: 'Search project contents' }), { target: { value: 'needle' } });
      fireEvent.click(screen.getByRole('button', { name: 'Search project' }));
      fireEvent.click(await screen.findByRole('button', { name: /src\/main.js:3/ }));
      fireEvent.click(screen.getByRole('button', { name: 'Open current file at line' }));
      const signal = apiFetch.mock.calls.at(-1)[1].signal;
      if (scope === 'session') view.rerender(<FileManager isOpen initialPath="/canonical/workspace" sessionId="ss-next" onClose={() => {}} />);
      else act(() => scope === 'environment' ? setActiveEnvironment({ id: 'other-server' }) : setEnvironmentIdentity('another-owner'));
      expect(signal.aborted).toBe(true);
      await act(async () => { finish({ ok: true, json: async () => ({ root: '/canonical/workspace', path: 'src/main.js', line: 3, totalLines: 3, lines: [{ line: 3, text: 'old sensitive preview', truncated: false }] }) }); });
      expect(screen.queryByText('old sensitive preview')).not.toBeInTheDocument();
    } finally { act(() => { setActiveEnvironment(null); setEnvironmentIdentity(null); }); }
  });

  it('discards a late preview when authentication changes before the environment updates', async () => {
    let finish;
    apiFetch.mockImplementation(url => url.includes('list-directory') ? Promise.resolve(listing(url)) : url.includes('search-content')
      ? Promise.resolve({ ok: true, json: async () => ({ root: '/canonical/workspace', matches: [{ path: 'src/main.js', line: 3, text: 'needle' }] }) })
      : new Promise(resolve => { finish = resolve; }));
    render(<FileManager isOpen initialPath="/canonical/workspace" sessionId="ss-owned" onClose={() => {}} />);
    await screen.findByText('Empty folder');
    fireEvent.click(screen.getByRole('button', { name: 'Search project contents' }));
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search project contents' }), { target: { value: 'needle' } });
    fireEvent.click(screen.getByRole('button', { name: 'Search project' }));
    fireEvent.click(await screen.findByRole('button', { name: /src\/main.js:3/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Open current file at line' }));
    beginAuthChange();
    await act(async () => { finish({ ok: true, json: async () => ({ root: '/canonical/workspace', path: 'src/main.js', line: 3, totalLines: 3, lines: [{ line: 3, text: 'old sensitive preview', truncated: false }] }) }); });
    expect(screen.queryByText('old sensitive preview')).not.toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Current file preview' })).not.toBeInTheDocument();
  });

  it('clears the selected search snapshot when the active session changes', async () => {
    apiFetch.mockImplementation(async url => url.includes('list-directory') ? listing(url) : { ok: true, json: async () => ({ root: '/canonical/workspace', matches: [{ path: 'src/main.js', line: 3, text: 'needle' }] }) });
    const view = render(<FileManager isOpen initialPath="/canonical/workspace" sessionId="ss-owned" onClose={() => {}} />);
    await screen.findByText('Empty folder');
    fireEvent.click(screen.getByRole('button', { name: 'Search project contents' }));
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search project contents' }), { target: { value: 'needle' } });
    fireEvent.click(screen.getByRole('button', { name: 'Search project' }));
    fireEvent.click(await screen.findByRole('button', { name: /src\/main.js:3/ }));
    expect(screen.getByRole('region', { name: 'Selected search result' })).toBeVisible();
    view.rerender(<FileManager isOpen initialPath="/canonical/workspace" sessionId="ss-other" onClose={() => {}} />);
    expect(screen.queryByRole('region', { name: 'Selected search result' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Back to search results' })).not.toBeInTheDocument();
  });

  it.each(['environment', 'account'])('clears the selected search snapshot when %s changes', async scope => {
    setEnvironmentIdentity('content-search-owner');
    apiFetch.mockImplementation(async url => url.includes('list-directory') ? listing(url) : { ok: true, json: async () => ({ root: '/canonical/workspace', matches: [{ path: 'src/main.js', line: 3, text: 'needle' }] }) });
    try {
      render(<FileManager isOpen initialPath="/canonical/workspace" sessionId="ss-owned" onClose={() => {}} />);
      await screen.findByText('Empty folder');
      fireEvent.click(screen.getByRole('button', { name: 'Search project contents' }));
      fireEvent.change(screen.getByRole('searchbox', { name: 'Search project contents' }), { target: { value: 'needle' } });
      fireEvent.click(screen.getByRole('button', { name: 'Search project' }));
      fireEvent.click(await screen.findByRole('button', { name: /src\/main.js:3/ }));
      expect(screen.getByRole('region', { name: 'Selected search result' })).toBeVisible();
      act(() => scope === 'environment' ? setActiveEnvironment({ id: 'other-server' }) : setEnvironmentIdentity('another-owner'));
      expect(screen.queryByRole('region', { name: 'Selected search result' })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Back to search results' })).not.toBeInTheDocument();
    } finally { act(() => { setActiveEnvironment(null); setEnvironmentIdentity(null); }); }
  });

  it.each(['session', 'environment', 'account'])('does not show a selected result folder response after the %s changes', async scope => {
    let finishFolder;
    setEnvironmentIdentity('content-search-owner');
    apiFetch.mockImplementation(url => url.includes('list-directory')
      ? new Promise(resolve => { finishFolder = resolve; })
      : Promise.resolve({ ok: true, json: async () => ({ root: '/canonical/workspace', matches: [{ path: 'src/main.js', line: 3, text: 'needle' }] }) }));
    try {
      const view = render(<FileManager isOpen initialPath="/canonical/workspace" sessionId="ss-owned" onClose={() => {}} />);
      await screen.findByText('Empty folder');
      fireEvent.click(screen.getByRole('button', { name: 'Search project contents' }));
      fireEvent.change(screen.getByRole('searchbox', { name: 'Search project contents' }), { target: { value: 'needle' } });
      fireEvent.click(screen.getByRole('button', { name: 'Search project' }));
      fireEvent.click(await screen.findByRole('button', { name: /src\/main.js:3/ }));
      await waitFor(() => expect(finishFolder).toBeTypeOf('function'));
      if (scope === 'session') view.rerender(<FileManager isOpen initialPath="/canonical/workspace" sessionId="ss-next" onClose={() => {}} />);
      else act(() => scope === 'environment' ? setActiveEnvironment({ id: 'other-server' }) : setEnvironmentIdentity('another-owner'));
      await act(async () => { finishFolder({ ok: true, json: async () => ({ root: '/canonical/workspace', path: 'src', truncated: false, items: [{ name: 'old-scope-marker', type: 'file', size: 1 }] }) }); });
      expect(screen.queryByText('old-scope-marker')).not.toBeInTheDocument();
      if (scope === 'session') {
        await waitFor(() => expect(apiGet.mock.calls.filter(([url]) => url === '/api/files/list?path=%2Fcanonical%2Fworkspace')).toHaveLength(2));
      } else {
        expect(apiGet.mock.calls.filter(([url]) => url === '/api/files/list?path=%2Fcanonical%2Fworkspace')).toHaveLength(1);
        expect(screen.getByRole('alert')).toHaveTextContent('Close and reopen Files');
      }
    } finally { act(() => { setActiveEnvironment(null); setEnvironmentIdentity(null); }); }
  });

  it('ignores a late response after changing the active session', async () => {
    let resolve;
    apiFetch.mockImplementation(() => new Promise(done => { resolve = done; }));
    const view = render(<FileManager isOpen initialPath="/canonical/workspace" sessionId="ss-first" onClose={() => {}} />);
    await screen.findByText('Empty folder');
    fireEvent.click(screen.getByRole('button', { name: 'Search project contents' }));
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search project contents' }), { target: { value: 'needle' } });
    fireEvent.click(screen.getByRole('button', { name: 'Search project' }));
    view.rerender(<FileManager isOpen initialPath="/canonical/workspace" sessionId="ss-next" onClose={() => {}} />);
    await act(async () => { resolve({ ok: true, json: async () => ({ root: '/canonical/workspace', matches: [{ path: 'old.txt', line: 1, text: 'needle' }] }) }); });
    expect(screen.queryByText('old.txt:1')).not.toBeInTheDocument();
  });

  it('ignores a search response from a previous authentication generation', async () => {
    let finish;
    apiFetch.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    render(<FileManager isOpen initialPath="/canonical/workspace" sessionId="ss-owned" onClose={() => {}} />);
    await screen.findByText('Empty folder');
    fireEvent.click(screen.getByRole('button', { name: 'Search project contents' }));
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search project contents' }), { target: { value: 'needle' } });
    fireEvent.click(screen.getByRole('button', { name: 'Search project' }));
    beginAuthChange();
    await act(async () => { finish({ ok: true, json: async () => ({ root: '/canonical/workspace', matches: [{ path: 'old-account.txt', line: 1, text: 'needle' }] }) }); });
    expect(screen.queryByText('old-account.txt:1')).not.toBeInTheDocument();
  });
});

it('focuses Files when opened and returns to its opener after Escape without interrupting composition',async()=>{
 apiGet.mockReset().mockResolvedValue({path:'/synthetic',items:[]});
 const onClose=vi.fn();
 const opener=document.createElement('button');opener.textContent='Synthetic Files opener';document.body.append(opener);opener.focus();
 const view=render(<FileManager isOpen initialPath="/synthetic" onClose={onClose}/>);
 try{
  expect(screen.getByRole('button',{name:'Close files'})).toHaveFocus();
  const region=screen.getByRole('region',{name:'Files'});
  fireEvent.keyDown(region,{key:'Escape',isComposing:true,keyCode:229});
  expect(onClose).not.toHaveBeenCalled();
  fireEvent.keyDown(region,{key:'Escape'});
  expect(onClose).toHaveBeenCalledOnce();
  view.rerender(<FileManager isOpen={false} initialPath="/synthetic" onClose={onClose}/>);
  expect(opener).toHaveFocus();
 }finally{view.unmount();opener.remove();}
});

it('uses Windows drive paths for folder navigation and stops at the drive root',async()=>{
 apiGet.mockReset().mockImplementation(async url=>({path:new URL(url,'http://fixture.invalid').searchParams.get('path'),items:[{name:'nested',type:'directory'}]}));
 const view=render(<FileManager isOpen initialPath={'C:\\workspace'} onClose={vi.fn()}/>);
 fireEvent.click(await screen.findByRole('button',{name:'Open folder nested'}));
 await waitFor(()=>expect(apiGet).toHaveBeenLastCalledWith('/api/files/list?path=C%3A%2Fworkspace%2Fnested'));
 fireEvent.click(screen.getByRole('button',{name:'Go up'}));
 await waitFor(()=>expect(apiGet).toHaveBeenLastCalledWith('/api/files/list?path=C%3A%2Fworkspace'));
 view.unmount();render(<FileManager isOpen initialPath={'C:\\'} onClose={vi.fn()}/>);
 await screen.findByRole('button',{name:'Open folder nested'});
 expect(screen.getByRole('button',{name:'Go up'})).toBeDisabled();
 expect(screen.getByRole('navigation',{name:'File path'}).querySelector('[aria-current="location"]')).toHaveTextContent('C:');
});
