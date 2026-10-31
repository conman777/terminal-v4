import { beforeEach, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { FileManager } from './FileManager';
import { apiFetch, apiGet } from '../utils/api';
import { setUser } from '../utils/auth';

vi.mock('../utils/api', () => ({ apiGet: vi.fn(), apiFetch: vi.fn() }));

beforeEach(() => {
  setUser({ id: 'search-owner' });
  apiGet.mockReset().mockResolvedValue({ path: '/work/project', items: [] });
  apiFetch.mockReset().mockImplementation(async url => {
    if (url.includes('/search-content?')) return { ok: true, json: async () => ({ root: '/work/project', matches: [{ path: 'src/app.js', line: 1, text: 'needle' }], truncated: false }) };
    if (url.includes('/list-directory?')) return { ok: true, json: async () => ({ root: '/work/project', path: 'src', items: [{ name: 'app.js', type: 'file', size: 5 }], truncated: false }) };
    throw new Error(`Unexpected request: ${url}`);
  });
});

it('opens a search-result folder only through the owner-scoped project listing', async () => {
  render(<FileManager isOpen initialPath="/work/project" sessionId="ss-owned" onClose={() => {}} />);
  await screen.findByText('Empty folder');
  fireEvent.click(screen.getByRole('button', { name: 'Search project contents' }));
  fireEvent.change(screen.getByRole('searchbox', { name: 'Search project contents' }), { target: { value: 'needle' } });
  fireEvent.click(screen.getByRole('button', { name: 'Search project' }));
  fireEvent.click(await screen.findByRole('button', { name: /src\/app.js:1/ }));
  await waitFor(() => expect(apiFetch.mock.calls.some(([url]) => url.includes('/list-directory?'))).toBe(true));
  const listing = apiFetch.mock.calls.find(([url]) => url.includes('/list-directory?'))[0];
  expect(Object.fromEntries(new URL(listing, 'http://fixture.invalid').searchParams)).toEqual({ sessionId: 'ss-owned', root: '/work/project', path: 'src' });
  expect(apiGet).toHaveBeenCalledTimes(1);
  expect(screen.getByRole('region', { name: 'Selected search result' })).toHaveTextContent('needle');
});

it('keeps a failed scoped listing in the project and never retries through general Files', async () => {
  const baseFetch = apiFetch.getMockImplementation();
  apiFetch.mockImplementation(async url => url.includes('/list-directory?')
    ? { ok: false, json: async () => ({ error: 'Project directory is unavailable' }) }
    : baseFetch(url));
  render(<FileManager isOpen initialPath="/work/project" sessionId="ss-owned" onClose={() => {}} />);
  await screen.findByText('Empty folder');
  fireEvent.click(screen.getByRole('button', { name: 'Search project contents' }));
  fireEvent.change(screen.getByRole('searchbox', { name: 'Search project contents' }), { target: { value: 'needle' } });
  fireEvent.click(screen.getByRole('button', { name: 'Search project' }));
  fireEvent.click(await screen.findByRole('button', { name: /src\/app.js:1/ }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Project directory is unavailable');
  expect(screen.getByRole('region', { name: 'Selected search result' })).toHaveTextContent('needle');
  expect(apiGet).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole('button', { name: 'Go to path' })).toBeNull();
});

it('returns to search after browsing the project and restores the original general folder', async () => {
  const baseFetch = apiFetch.getMockImplementation();
  apiFetch.mockImplementation(async url => {
    if (!url.includes('/list-directory?')) return baseFetch(url);
    const params = new URL(url, 'http://fixture.invalid').searchParams;
    return { ok: true, json: async () => ({ root: '/work/project', path: params.get('path'), truncated: false, items: params.get('path') === 'src'
      ? [{ name: 'app.js', type: 'file', size: 5 }, { name: 'nested', type: 'directory', size: 0 }] : [] }) };
  });
  render(<FileManager isOpen initialPath="/work/project" sessionId="ss-owned" onClose={() => {}} />);
  await screen.findByText('Empty folder');
  fireEvent.click(screen.getByRole('button', { name: 'Search project contents' }));
  fireEvent.change(screen.getByRole('searchbox', { name: 'Search project contents' }), { target: { value: 'needle' } });
  fireEvent.click(screen.getByRole('button', { name: 'Search project' }));
  fireEvent.click(await screen.findByRole('button', { name: /src\/app.js:1/ }));
  fireEvent.click(await screen.findByRole('button', { name: 'Open folder nested' }));
  await waitFor(() => expect(apiFetch.mock.calls.some(([url]) => url.includes('path=src%2Fnested'))).toBe(true));
  fireEvent.click(screen.getByRole('button', { name: 'Back to search results' }));
  expect(screen.getByRole('button', { name: /src\/app.js:1/ })).toHaveFocus();
  fireEvent.click(screen.getByRole('button', { name: 'Search project contents' }));
  await waitFor(() => expect(apiGet).toHaveBeenLastCalledWith('/api/files/list?path=%2Fwork%2Fproject'));
  expect(apiGet.mock.calls.every(([url]) => !url.includes('%2Fsrc'))).toBe(true);
});

it('rejects search results whose paths cannot be safely scoped', async () => {
  apiFetch.mockResolvedValue({ ok: true, json: async () => ({ root: '/work/project', matches: [{ path: '../outside.txt', line: 1, text: 'needle' }], truncated: false }) });
  render(<FileManager isOpen initialPath="/work/project" sessionId="ss-owned" onClose={() => {}} />);
  await screen.findByText('Empty folder');
  fireEvent.click(screen.getByRole('button', { name: 'Search project contents' }));
  fireEvent.change(screen.getByRole('searchbox', { name: 'Search project contents' }), { target: { value: 'needle' } });
  fireEvent.click(screen.getByRole('button', { name: 'Search project' }));
  fireEvent.click(await screen.findByRole('button', { name: /\.\.\/outside.txt:1/ }));
  expect(screen.getByRole('alert')).toHaveTextContent('cannot be opened safely');
  expect(apiGet).toHaveBeenCalledTimes(1);
  expect(apiFetch.mock.calls.filter(([url]) => url.includes('/list-directory?'))).toHaveLength(0);
});

it('opens safe filenames containing URL punctuation through the scoped listing', async () => {
  apiFetch.mockImplementation(async url => url.includes('/search-content?')
    ? { ok: true, json: async () => ({ root: '/work/project', matches: [{ path: 'src/a?#%.txt', line: 1, text: 'needle' }], truncated: false }) }
    : url.includes('/read-content?')
      ? { ok: true, json: async () => ({ root: '/work/project', path: 'src/a?#%.txt', line: 1, totalLines: 1, lines: [{ line: 1, text: 'safe text', truncated: false }] }) }
      : { ok: true, json: async () => ({ root: '/work/project', path: 'src', items: [{ name: 'a?#%.txt', type: 'file', size: 5 }], truncated: false }) });
  render(<FileManager isOpen initialPath="/work/project" sessionId="ss-owned" onClose={() => {}} />);
  await screen.findByText('Empty folder');
  fireEvent.click(screen.getByRole('button', { name: 'Search project contents' }));
  fireEvent.change(screen.getByRole('searchbox', { name: 'Search project contents' }), { target: { value: 'needle' } });
  fireEvent.click(screen.getByRole('button', { name: 'Search project' }));
  fireEvent.click(await screen.findByRole('button', { name: /src\/a\?#%\.txt:1/ }));
  expect(await screen.findByRole('button', { name: 'Select file a?#%.txt' })).toHaveAttribute('aria-pressed', 'true');
  fireEvent.click(screen.getByRole('button', { name: 'Preview a?#%.txt' }));
  expect(await screen.findByText('safe text')).toBeVisible();
  expect(apiGet).toHaveBeenCalledTimes(1);
});

it('shows that a search result became empty instead of treating the response as invalid', async () => {
  const baseFetch = apiFetch.getMockImplementation();
  apiFetch.mockImplementation(async url => url.includes('/read-content?')
    ? { ok: true, json: async () => ({ root: '/work/project', path: 'src/app.js', line: 1, totalLines: 0, lines: [] }) }
    : baseFetch(url));
  render(<FileManager isOpen initialPath="/work/project" sessionId="ss-owned" onClose={() => {}} />);
  await screen.findByText('Empty folder');
  fireEvent.click(screen.getByRole('button', { name: 'Search project contents' }));
  fireEvent.change(screen.getByRole('searchbox', { name: 'Search project contents' }), { target: { value: 'needle' } });
  fireEvent.click(screen.getByRole('button', { name: 'Search project' }));
  fireEvent.click(await screen.findByRole('button', { name: /src\/app.js:1/ }));
  fireEvent.click(screen.getByRole('button', { name: 'Open current file at line' }));
  expect(await screen.findByText('This file is now empty.')).toBeVisible();
  expect(screen.getByRole('region', { name: 'Selected search result' })).toHaveTextContent('needle');
});
