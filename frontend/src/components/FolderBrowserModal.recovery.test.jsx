import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { FolderBrowserModal } from './FolderBrowserModal';

const apiFetch = vi.hoisted(() => vi.fn());
vi.mock('../utils/api', () => ({ apiFetch }));
const directory = { path: '/synthetic/project', folders: ['src'], parent: '/synthetic' };
const props = () => ({ isOpen: true, currentPath: directory.path, recentFolders: [], onClose: vi.fn(), onSelect: vi.fn() });
beforeEach(() => { apiFetch.mockReset().mockResolvedValue({ ok: true, json: async () => directory }); });

it('shows selection failures without an agent selector and lets the user retry the retained folder', async () => {
  const options = props();
  options.onSelect.mockRejectedValueOnce(new Error('Synthetic selection unavailable')).mockResolvedValueOnce();
  render(<FolderBrowserModal {...options} />);
  await waitFor(() => expect(screen.getByRole('button', { name: 'Open here' })).toBeEnabled());
  fireEvent.click(screen.getByRole('button', { name: 'Open here' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Synthetic selection unavailable');
  expect(options.onClose).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Open here' }));
  await waitFor(() => expect(options.onClose).toHaveBeenCalledOnce());
  expect(options.onSelect.mock.calls).toEqual(Array(2).fill([directory.path, undefined, undefined]));
});

it('does not select an unverified directory after loading fails and retries the requested path', async () => {
  apiFetch.mockRejectedValueOnce(new Error('Synthetic directory unavailable'));
  const options = props();
  render(<FolderBrowserModal {...options} />);
  expect(await screen.findByRole('alert')).toHaveTextContent('Synthetic directory unavailable');
  expect(screen.getByRole('button', { name: 'Open here' })).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: 'Retry loading folder' }));
  expect(await screen.findByRole('button', { name: 'src', exact: true })).toBeVisible();
  expect(apiFetch.mock.calls.map(([url]) => url)).toEqual(Array(2).fill('/api/fs/list?path=%2Fsynthetic%2Fproject'));
});

it('keeps a failed child destination visible and retries that destination rather than its parent', async () => {
  apiFetch.mockResolvedValueOnce({ ok: true, json: async () => directory }).mockRejectedValueOnce(new Error('Child unavailable'));
  render(<FolderBrowserModal {...props()} />);
  fireEvent.click(await screen.findByRole('button', { name: 'src', exact: true }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Child unavailable');
  expect(screen.getByRole('button', { name: 'Open here' })).toBeDisabled();
  apiFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ path: '/synthetic/project/src', folders: [], parent: directory.path }) });
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Retry loading folder' })));
  expect(apiFetch.mock.calls.at(-1)[0]).toBe('/api/fs/list?path=%2Fsynthetic%2Fproject%2Fsrc');
});
