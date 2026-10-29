import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { apiGet, apiPost } from '../utils/api';
import { OpenInEditorRow, PullRequestStatus, ThreadGitActions, resetInstalledEditorsCache } from './ThreadCardActions';

vi.mock('../utils/api', () => ({ apiGet: vi.fn(), apiPost: vi.fn() }));

const REPO = '/work/repo';
const BRANCH = 'fix/ui';

beforeEach(() => {
  vi.mocked(apiGet).mockReset();
  vi.mocked(apiPost).mockReset();
  resetInstalledEditorsCache();
});

describe('ThreadGitActions', () => {
  it('commits every change and pushes the branch', async () => {
    const onChanged = vi.fn();
    vi.mocked(apiPost).mockResolvedValue({ commit: 'abc123', branch: BRANCH, pushed: true });
    render(<ThreadGitActions cwd={REPO} branch={BRANCH} files={3} onChanged={onChanged} />);
    fireEvent.click(screen.getByRole('button', { name: 'Commit, push & PR' }));
    fireEvent.change(screen.getByLabelText('Commit message'), { target: { value: 'feat: tidy ui' } });
    fireEvent.click(screen.getByRole('button', { name: 'Commit & push' }));
    await screen.findByText(`Committed and pushed ${BRANCH}`);
    expect([vi.mocked(apiPost).mock.calls, onChanged.mock.calls.length]).toEqual([
      [['/api/workspace/git/commit', { path: REPO, message: 'feat: tidy ui', push: true }]], 1,
    ]);
  });

  it('opens a pull request titled by the first line of the message', async () => {
    const url = 'https://github.com/acme/repo/pull/7';
    vi.mocked(apiPost).mockImplementation(async (path) => (path.endsWith('/commit') ? { commit: 'abc', branch: BRANCH, pushed: true } : { url }));
    render(<ThreadGitActions cwd={REPO} branch={BRANCH} files={1} onChanged={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Commit, push & PR' }));
    fireEvent.change(screen.getByLabelText('Commit message'), { target: { value: 'feat: tidy ui\n\nMatches T3.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Commit, push & create PR' }));
    expect((await screen.findByRole('link', { name: 'Open pull request' })).getAttribute('href')).toBe(url);
    expect(vi.mocked(apiPost).mock.calls).toEqual([
      ['/api/workspace/git/commit', { path: REPO, message: 'feat: tidy ui\n\nMatches T3.', push: true }],
      ['/api/workspace/git/pull-request', { path: REPO, title: 'feat: tidy ui', body: 'Matches T3.' }],
    ]);
  });

  it('offers only push and pull request when there is nothing to commit', () => {
    render(<ThreadGitActions cwd={REPO} branch={BRANCH} files={0} onChanged={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Commit, push & PR' }));
    expect([
      screen.queryByLabelText('Commit message'),
      screen.getAllByRole('button').map(button => button.textContent),
    ]).toEqual([null, ['Commit, push & PR', 'Push branch', 'Create pull request']]);
  });

  it('shows why a git action failed', async () => {
    vi.mocked(apiPost).mockRejectedValue(new Error('This repository has no remote to push to'));
    render(<ThreadGitActions cwd={REPO} branch={BRANCH} files={0} onChanged={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Commit, push & PR' }));
    fireEvent.click(screen.getByRole('button', { name: 'Push branch' }));
    expect((await screen.findByRole('alert')).textContent).toBe('This repository has no remote to push to');
  });
});

describe('OpenInEditorRow', () => {
  it('opens the folder in the first installed editor', async () => {
    vi.mocked(apiGet).mockResolvedValue({ editors: [{ id: 'cursor', label: 'Cursor' }] });
    vi.mocked(apiPost).mockResolvedValue({ opened: true });
    render(<OpenInEditorRow cwd={REPO} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Open in Cursor' }));
    await waitFor(() => expect(vi.mocked(apiPost).mock.calls).toEqual([['/api/system/open-in-editor', { editor: 'cursor', path: REPO }]]));
  });

  it('renders nothing when no editor is installed', async () => {
    vi.mocked(apiGet).mockResolvedValue({ editors: [] });
    const { container } = render(<OpenInEditorRow cwd={REPO} />);
    await waitFor(() => expect(vi.mocked(apiGet)).toHaveBeenCalled());
    expect(container.innerHTML).toBe('');
  });
});

describe('PullRequestStatus', () => {
  it('shows the branch pull request with its checks and review', async () => {
    vi.mocked(apiGet).mockResolvedValue({ pullRequest: { number: 7, url: 'https://github.com/acme/app/pull/7', state: 'OPEN', review: 'APPROVED', checks: { passed: 2, failed: 1, pending: 1 } } });
    render(<PullRequestStatus cwd={REPO} branch={BRANCH} />);
    const link = await screen.findByRole('link', { name: /PR #7/ });
    expect([link.getAttribute('href'), link.textContent, vi.mocked(apiGet).mock.calls[0][0]]).toEqual([
      'https://github.com/acme/app/pull/7', 'PR #7 · 2 passed, 1 failed, 1 running · Approved', '/api/workspace/git/pull-request?path=%2Fwork%2Frepo',
    ]);
  });

  it('shows nothing when the branch has no pull request', async () => {
    vi.mocked(apiGet).mockResolvedValue({ pullRequest: null, reason: 'No pull request for this branch yet' });
    const { container } = render(<PullRequestStatus cwd={REPO} branch={BRANCH} />);
    await waitFor(() => expect(vi.mocked(apiGet)).toHaveBeenCalled());
    expect(container.innerHTML).toBe('');
  });
});
