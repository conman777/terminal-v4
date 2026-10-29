import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import ThreadLineageDialog from './ThreadLineageDialog';

const apiFetch = vi.hoisted(() => vi.fn());
vi.mock('../utils/api', () => ({ apiFetch }));

const t = (id, title, extra = {}) => ({ id, title, cwd: '/repo', thread: { topic: title, projectPath: '/repo' }, ...extra });
const reply = body => ({ ok: true, json: async () => body });

function serve({ links = [], tasks = [] } = {}) {
  apiFetch.mockImplementation(async url => reply(url.startsWith('/api/thread-lineage') ? { links } : { tasks, schedules: [] }));
}

describe('ThreadLineageDialog', () => {
  beforeEach(() => { apiFetch.mockReset(); });

  it('lists parent, forks, delegated children and worktree siblings and opens one', async () => {
    serve({
      links: [{ childId: 'cur', parentId: 'par', kind: 'fork' }, { childId: 'fk', parentId: 'cur', kind: 'fork' }],
      tasks: [{ id: 'k', parentSessionId: 'cur', childSessionId: 'abc' }],
    });
    const sessions = [t('cur', 'Current'), t('par', 'Parent thread'), t('fk', 'Fork thread'), t('ss-abc', 'Delegated thread'), t('wt', 'Worktree thread', { cwd: '/repo-wt' })];
    const onOpen = vi.fn();
    const onClose = vi.fn();
    render(<ThreadLineageDialog session={sessions[0]} sessions={sessions} onOpen={onOpen} onClose={onClose} />);
    const dialog = await screen.findByRole('dialog', { name: 'Related threads for Current' });
    await screen.findByRole('button', { name: /Parent thread/ });
    expect(dialog.querySelectorAll('h3')).toHaveLength(4);
    expect(['Forked from', 'Forks', 'Delegated threads', 'Other worktrees'].map(name => screen.getByRole('heading', { name }).textContent)).toEqual(['Forked from', 'Forks', 'Delegated threads', 'Other worktrees']);
    await userEvent.click(screen.getByRole('button', { name: /Delegated thread/ }));
    expect(onOpen).toHaveBeenCalledWith('ss-abc');
    expect(onClose).toHaveBeenCalled();
  });

  it('shows an empty state when the thread has no relations', async () => {
    serve();
    render(<ThreadLineageDialog session={t('solo', 'Solo')} sessions={[t('solo', 'Solo')]} onOpen={vi.fn()} onClose={vi.fn()} />);
    expect(await screen.findByText('No related threads yet.')).toBeInTheDocument();
  });

  it('shows related threads that are no longer listed as unavailable', async () => {
    serve({ links: [{ childId: 'cur', parentId: 'gone', kind: 'fork' }] });
    const onOpen = vi.fn();
    render(<ThreadLineageDialog session={t('cur', 'Current')} sessions={[t('cur', 'Current')]} onOpen={onOpen} onClose={vi.fn()} />);
    const item = await screen.findByRole('button', { name: /gone.*unavailable/i });
    expect(item).toBeDisabled();
  });

  it('reports a load failure and retries', async () => {
    apiFetch.mockResolvedValueOnce({ ok: false, json: async () => ({}) }).mockResolvedValueOnce({ ok: false, json: async () => ({}) });
    render(<ThreadLineageDialog session={t('cur', 'Current')} sessions={[t('cur', 'Current')]} onOpen={vi.fn()} onClose={vi.fn()} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load related threads.');
    serve();
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('No related threads yet.')).toBeInTheDocument();
  });

  it('closes on Escape', async () => {
    serve();
    const onClose = vi.fn();
    render(<ThreadLineageDialog session={t('cur', 'Current')} sessions={[t('cur', 'Current')]} onOpen={vi.fn()} onClose={onClose} />);
    await screen.findByText('No related threads yet.');
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });
});
