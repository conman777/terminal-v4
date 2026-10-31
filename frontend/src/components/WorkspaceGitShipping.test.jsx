import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { WorkspaceGitShipping } from './WorkspaceGitShipping';
import { setUser } from '../utils/auth';

const apiFetch = vi.fn();
const apiGet = vi.fn();
const apiPost = vi.fn();
vi.mock('../utils/api', () => ({ apiFetch: (...args) => apiFetch(...args), apiGet: (...args) => apiGet(...args), apiPost: (...args) => apiPost(...args) }));

const SHA = 'b'.repeat(40);
const pull = { number: 12, headSha: SHA, url: 'https://github.com/acme/app/pull/12', state: 'OPEN', isDraft: false, mergeable: 'MERGEABLE', review: 'APPROVED', checks: { passed: 3, failed: 0, pending: 0 } };
const gitStatus = (body, ok = true, status = 200) => apiFetch.mockResolvedValue({ ok, status, json: async () => body });

beforeEach(() => {
  localStorage.clear(); setUser({ id: 'fixture-user' });
  apiFetch.mockReset(); apiGet.mockReset(); apiPost.mockReset();
  apiGet.mockResolvedValue({ pullRequest: pull, availability: 'ok', repository: '/repo' });
});

describe('WorkspaceGitShipping', () => {
  it('shows loading until Git status resolves, then displays the repository actions', async () => {
    let resolveStatus;
    apiFetch.mockReturnValue(new Promise(resolve => { resolveStatus = resolve; }));
    render(<WorkspaceGitShipping cwd="/repo" />);
    expect(screen.getByRole('status')).toHaveTextContent('Loading Git status');
    expect(screen.queryByText(/need a Git repository/)).toBeNull();
    resolveStatus({ ok: true, json: async () => ({ branch: 'feature', files: [] }) });
    expect(await screen.findByRole('button', { name: 'Commit, push & PR' })).toBeInTheDocument();
  });

  it('shows a retryable error when status fails', async () => {
    apiFetch.mockRejectedValueOnce(new Error('offline'));
    apiFetch.mockResolvedValue({ ok: true, json: async () => ({ branch: 'feature', files: [] }) });
    render(<WorkspaceGitShipping cwd="/repo" />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load Git status');
    expect(screen.queryByText(/need a Git repository/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Retry Git status' }));
    expect(await screen.findByRole('button', { name: 'Commit, push & PR' })).toBeInTheDocument();
  });

  it('hides the previous workspace actions immediately when the workspace changes', async () => {
    gitStatus({ branch: 'feature', files: [] });
    const { rerender } = render(<WorkspaceGitShipping cwd="/repo" />);
    expect(await screen.findByRole('button', { name: 'Commit, push & PR' })).toBeInTheDocument();
    apiFetch.mockReturnValue(new Promise(() => {}));
    rerender(<WorkspaceGitShipping cwd="/other" />);
    expect(screen.getByRole('status')).toHaveTextContent('Loading Git status');
    expect(screen.queryByRole('button', { name: 'Commit, push & PR' })).toBeNull();
  });

  it('shows the pull request row and merges only after confirming the reviewed head commit', async () => {
    gitStatus({ branch: 'feature', files: [] });
    apiPost.mockResolvedValue({ done: true });
    render(<WorkspaceGitShipping cwd="/repo" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Merge' }));
    expect(screen.getByText(/Reviewed commit bbbbbbb/)).toBeInTheDocument();
    expect(apiPost).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Confirm merge #12' }));
    await waitFor(() => expect(apiPost).toHaveBeenCalledWith('/api/workspace/git/pull-request/action', expect.objectContaining({ number: 12, headSha: SHA, confirm: `merge #12 (squash) @ ${SHA}` })));
  });

  it('offers Commit, push & PR and sends the message when there are changes', async () => {
    gitStatus({ branch: 'feature', files: [{ path: 'a.js', added: 1, removed: 0 }] });
    apiGet.mockResolvedValue({ pullRequest: null, availability: 'ok', repository: '/repo' });
    apiPost.mockResolvedValue({ pushed: true, branch: 'feature', url: 'https://github.com/acme/app/pull/13' });
    render(<WorkspaceGitShipping cwd="/repo" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Commit, push & PR' }));
    fireEvent.change(screen.getByLabelText('Commit message'), { target: { value: 'feat: add thing' } });
    fireEvent.click(screen.getByRole('button', { name: 'Commit, push & create PR' }));
    await screen.findByText(/Pull request created/);
    expect(apiPost.mock.calls[0]).toEqual(['/api/workspace/git/commit', { path: '/repo', message: 'feat: add thing', push: true }]);
  });

  it('says so when the folder is not a Git repository instead of showing actions', async () => {
    gitStatus({ error: 'not a repo' }, false, 400);
    render(<WorkspaceGitShipping cwd="/plain" />);
    expect(await screen.findByText(/need a Git repository with a checked-out branch/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Commit, push & PR' })).toBeNull();
    expect(apiGet).not.toHaveBeenCalled();
  });

  it('reports a pull request lookup error without raw gh text and keeps the commit action', async () => {
    gitStatus({ branch: 'feature', files: [] });
    apiGet.mockResolvedValue({ pullRequest: null, availability: 'error', reason: 'GitHub CLI is not signed in' });
    render(<WorkspaceGitShipping cwd="/repo" />);
    expect(await screen.findByText('GitHub CLI is not signed in')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Commit, push & PR' })).toBeInTheDocument();
  });

  it('reports a failed Git action in an alert', async () => {
    gitStatus({ branch: 'feature', files: [] });
    apiGet.mockResolvedValue({ pullRequest: null, availability: 'ok', repository: '/repo' });
    apiPost.mockRejectedValue(new Error('push rejected'));
    render(<WorkspaceGitShipping cwd="/repo" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Commit, push & PR' }));
    fireEvent.click(screen.getByRole('button', { name: 'Push branch' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('push rejected');
  });
});
