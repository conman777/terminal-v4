import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { FolderBrowserModal } from './FolderBrowserModal';
const apiFetch = vi.hoisted(() => vi.fn());
vi.mock('../utils/api', () => ({ apiFetch }));
const aiOptions = [{ id: 'cli', label: 'CLI' }, { id: 'codex', label: 'Codex' }];
const props = () => ({ isOpen: true, currentPath: '/synthetic/project', recentFolders: ['/synthetic/recent'], onClose: vi.fn(), onSelect: vi.fn(), showAiSelector: true, defaultAiOptionId: 'codex', aiOptions });
beforeEach(() => {
  localStorage.setItem('terminalV4AgentModels', JSON.stringify({ codex: { model: 'synthetic-saved-model', reasoning: 'high' } }));
  apiFetch.mockReset().mockImplementation(async url => ({ ok: true, json: async () => url.startsWith('/api/fs/list')
    ? { path: '/synthetic/project', folders: [], parent: '/synthetic' }
    : url.startsWith('/api/workspace/profile') ? { defaultAgent: 'codex', selection: { model: 'synthetic-project-model', reasoning: 'high' } }
      : { agents: [{ id: 'codex', label: 'Codex', available: true, models: [{ id: 'synthetic-project-model', label: 'Synthetic model' }], reasoningLevels: ['high'] }] } }));
});
afterEach(() => { localStorage.clear(); });

it('uses the normal project agent/model defaults for an ordinary New thread launch', async () => {
  const options = props();
  render(<FolderBrowserModal {...options} />);
  await waitFor(() => expect(screen.getByRole('button', { name: 'Start thread' })).toBeEnabled());
  // The live agent catalog marks the selection available; wait for it so the launch reflects it.
  await waitFor(() => expect(apiFetch.mock.calls.some(([url]) => url.startsWith('/api/agent/catalog'))).toBe(true));
  await act(async () => { await Promise.all(apiFetch.mock.results.map(result => result.value)); });
  fireEvent.click(screen.getByRole('button', { name: 'Start thread' }));
  expect(options.onSelect).toHaveBeenCalledWith('/synthetic/project', 'codex', '', { model: 'synthetic-project-model', reasoning: 'high', available: true });
});

it.each([true, false])('explicit terminal mode opens CLI with an optional name and bypasses agent defaults (showAiSelector %s)', async showAiSelector => {
  const options = props();
  render(<FolderBrowserModal {...options} showAiSelector={showAiSelector} launchMode="terminal" />);
  expect(screen.getByRole('dialog', { name: 'New terminal' })).toBeVisible();
  expect(screen.queryByLabelText('Agent')).not.toBeInTheDocument();
  fireEvent.change(screen.getByLabelText('Terminal name (optional)'), { target: { value: 'Synthetic shell' } });
  await waitFor(() => expect(screen.getByRole('button', { name: 'Open terminal' })).toBeEnabled());
  fireEvent.click(screen.getByRole('button', { name: 'Open terminal' }));
  expect(options.onSelect.mock.calls).toEqual([['/synthetic/project', 'cli', 'Synthetic shell']]);
  expect(apiFetch.mock.calls.map(([url]) => url)).toEqual(['/api/fs/list?path=%2Fsynthetic%2Fproject']);
});

it('keeps recent-folder launches in explicit terminal mode on CLI without loading project/model defaults', async () => {
  const options = props();
  render(<FolderBrowserModal {...options} launchMode="terminal" />);
  await waitFor(() => expect(screen.getByRole('button', { name: 'Open terminal' })).toBeEnabled());
  fireEvent.click(screen.getByRole('button', { name: 'recent', exact: true }));
  await waitFor(() => expect(options.onSelect).toHaveBeenCalledWith('/synthetic/recent', 'cli', undefined));
  expect(apiFetch.mock.calls.every(([url]) => url.startsWith('/api/fs/list'))).toBe(true);
});

it('leaves focus for the new terminal after a launch, but returns it to the opener on cancel', async () => {
  const outcome = async launched => {
    const opener = document.body.appendChild(document.createElement('button'));
    opener.focus();
    const options = { ...props(), onSelect: vi.fn().mockResolvedValue(undefined) };
    const view = render(<FolderBrowserModal {...options} launchMode="terminal" />);
    if (launched) {
      await waitFor(() => expect(screen.getByRole('button', { name: 'Open terminal' })).toBeEnabled());
      fireEvent.click(screen.getByRole('button', { name: 'Open terminal' }));
      await waitFor(() => expect(options.onClose).toHaveBeenCalled());
    }
    view.rerender(<FolderBrowserModal {...options} isOpen={false} launchMode="terminal" />);
    const focused = document.activeElement === opener;
    view.unmount(); opener.remove();
    return focused;
  };
  expect([await outcome(true), await outcome(false)]).toEqual([false, true]);
});
