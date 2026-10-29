import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiGet, apiPost } from '../utils/api';
import { PullRequestRow, WATCH_INTERVAL_MS } from './PullRequestRow';
import { setActiveEnvironment } from '../utils/remoteEnvironments';
import { setUser } from '../utils/auth';

vi.mock('../utils/api', () => ({ apiGet: vi.fn(), apiPost: vi.fn() }));

const SHA = 'a'.repeat(40);
const base = { number: 7, headSha: SHA, url: 'https://github.com/acme/app/pull/7', state: 'OPEN', isDraft: false, mergeable: 'MERGEABLE', review: 'APPROVED', checks: { passed: 2, failed: 0, pending: 0 } };
const reply = (pullRequest, repository = '/w') => ({ pullRequest, availability: 'ok', repository });
const statusCalls = () => vi.mocked(apiGet).mock.calls.length;

beforeEach(() => { vi.mocked(apiGet).mockReset(); vi.mocked(apiPost).mockReset(); setActiveEnvironment(null); });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
afterEach(() => vi.useRealTimers());

describe('PullRequestRow', () => {
  it('shows a conflict indicator and withholds merge when the branch conflicts', async () => {
    vi.mocked(apiGet).mockResolvedValue(reply({ ...base, mergeable: 'CONFLICTING' }));
    render(<PullRequestRow cwd="/w" branch="b" />);
    await screen.findByText('Merge conflicts with the base branch');
    expect(screen.queryByRole('button', { name: 'Merge' })).toBeNull();
  });

  it('offers only Mark ready on a draft and labels it a draft', async () => {
    vi.mocked(apiGet).mockResolvedValue(reply({ ...base, isDraft: true }));
    render(<PullRequestRow cwd="/w" branch="b" />);
    const link = await screen.findByRole('link', { name: /PR #7/ });
    expect([link.textContent.endsWith('· draft'), !!screen.queryByRole('button', { name: 'Merge' }), !!screen.getByRole('button', { name: 'Mark ready' })]).toEqual([true, false, true]);
  });

  it('merges only after an exact-action confirmation and sends that confirmation', async () => {
    vi.mocked(apiGet).mockResolvedValue(reply(base));
    vi.mocked(apiPost).mockResolvedValue({ done: true });
    render(<PullRequestRow cwd="/w" branch="b" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Merge' }));
    expect(apiPost).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText('Merge method'), { target: { value: 'rebase' } });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm merge #7' }));
    await waitFor(() => expect(apiPost).toHaveBeenCalled());
    expect(vi.mocked(apiPost).mock.calls).toEqual([['/api/workspace/git/pull-request/action', { path: '/w', repository: '/w', action: 'merge', number: 7, headSha: SHA, url: base.url, method: 'rebase', confirm: `merge #7 (rebase) @ ${SHA}` }]]);
    await waitFor(() => expect(statusCalls()).toBe(2));
  });

  it('keeps the confirmation open and reports a failed merge honestly', async () => {
    vi.mocked(apiGet).mockResolvedValue(reply(base));
    vi.mocked(apiPost).mockRejectedValue(new Error('GitHub did not answer in time. The action may or may not have completed: refresh the pull request before retrying'));
    render(<PullRequestRow cwd="/w" branch="b" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Merge' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm merge #7' }));
    expect((await screen.findByRole('alert')).textContent).toContain('may or may not have completed');
    expect(screen.getByRole('button', { name: 'Confirm merge #7' })).toBeEnabled();
  });

  it('cancelling the confirmation sends nothing', async () => {
    vi.mocked(apiGet).mockResolvedValue(reply({ ...base, isDraft: true }));
    render(<PullRequestRow cwd="/w" branch="b" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Mark ready' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect([apiPost.mock.calls.length, screen.queryByRole('group')]).toEqual([0, null]);
  });

  it('refreshes on a bounded interval only while watching and stops once merged', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.mocked(apiGet).mockResolvedValue(reply(base));
    render(<PullRequestRow cwd="/w" branch="b" />);
    await screen.findByRole('button', { name: 'Watch' });
    await act(async () => { vi.advanceTimersByTime(WATCH_INTERVAL_MS * 3); });
    const idle = statusCalls();
    fireEvent.click(screen.getByRole('button', { name: 'Watch' }));
    vi.mocked(apiGet).mockResolvedValue(reply({ ...base, state: 'MERGED' }));
    await act(async () => { vi.advanceTimersByTime(WATCH_INTERVAL_MS); });
    await screen.findByText(/merged/);
    const merged = statusCalls();
    await act(async () => { vi.advanceTimersByTime(WATCH_INTERVAL_MS * 3); });
    expect([idle, merged, statusCalls()]).toEqual([1, 2, 2]);
  });

  it('says so when status cannot be checked instead of hiding the row', async () => {
    vi.mocked(apiGet).mockResolvedValue({ pullRequest: null, availability: 'error', reason: 'Pull request status could not be checked: HTTP 401' });
    render(<PullRequestRow cwd="/w" branch="b" />);
    expect((await screen.findByRole('status')).textContent).toContain('HTTP 401');
  });

  it('says so when the request itself fails', async () => {
    vi.mocked(apiGet).mockRejectedValue(new Error('offline'));
    render(<PullRequestRow cwd="/w" branch="b" />);
    expect((await screen.findByRole('status')).textContent).toBe('Pull request status could not be loaded');
  });

  it('drops the previous project pull request the moment the project changes and ignores its late reply', async () => {
    const slow = deferred();
    vi.mocked(apiGet).mockResolvedValueOnce(reply(base, '/a')).mockReturnValueOnce(slow.promise);
    const { rerender } = render(<PullRequestRow cwd="/a" branch="b" />);
    await screen.findByRole('link', { name: /PR #7/ });
    rerender(<PullRequestRow cwd="/b" branch="b" />);
    expect([screen.queryByRole('link'), screen.queryByRole('button', { name: 'Merge' })]).toEqual([null, null]);
    rerender(<PullRequestRow cwd="/c" branch="b" />);
    await act(async () => { slow.resolve(reply({ ...base, number: 99, url: 'https://github.com/x/y/pull/99' }, '/b')); });
    expect(screen.queryByRole('link')).toBeNull();
  });

  it('aborts the previous project request and never shows its late reply after switching back and forth', async () => {
    const first = deferred();
    const signals = [];
    vi.mocked(apiGet).mockImplementation((url, options) => { signals.push(options?.signal); return signals.length === 1 ? first.promise : Promise.resolve(reply({ ...base, number: 8, url: 'https://github.com/acme/app/pull/8' }, '/b')); });
    const { rerender } = render(<PullRequestRow cwd="/a" branch="b" />);
    rerender(<PullRequestRow cwd="/b" branch="b" />);
    await screen.findByRole('link', { name: /PR #8/ });
    await act(async () => { first.resolve(reply(base, '/a')); });
    expect([signals[0].aborted, screen.getByRole('link').textContent.startsWith('PR #8')]).toEqual([true, true]);
  });

  it('closes an open confirmation and clears the row when the project changes', async () => {
    const pending = deferred();
    vi.mocked(apiGet).mockResolvedValueOnce(reply(base, '/a')).mockReturnValueOnce(pending.promise);
    const { rerender } = render(<PullRequestRow cwd="/a" branch="b" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Merge' }));
    rerender(<PullRequestRow cwd="/b" branch="b" />);
    expect([screen.queryByRole('group'), screen.queryByRole('button', { name: /Confirm merge/ })]).toEqual([null, null]);
  });

  it('does not apply an in-flight merge result to the next project', async () => {
    const merge = deferred();
    vi.mocked(apiGet).mockResolvedValueOnce(reply(base, '/a')).mockResolvedValue(reply({ ...base, number: 8, url: 'https://github.com/acme/app/pull/8' }, '/b'));
    vi.mocked(apiPost).mockReturnValue(merge.promise);
    const { rerender } = render(<PullRequestRow cwd="/a" branch="b" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Merge' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm merge #7' }));
    rerender(<PullRequestRow cwd="/b" branch="b" />);
    await screen.findByRole('link', { name: /PR #8/ });
    const before = statusCalls();
    await act(async () => { merge.resolve({ done: true }); });
    expect([statusCalls(), screen.queryByRole('status')]).toEqual([before, null]);
  });

  it('clears the row when the account or environment changes', async () => {
    const slow = deferred();
    vi.mocked(apiGet).mockResolvedValueOnce(reply(base)).mockReturnValue(slow.promise);
    render(<PullRequestRow cwd="/w" branch="b" />);
    await screen.findByRole('link', { name: /PR #7/ });
    await act(async () => { setActiveEnvironment({ id: 'laptop' }); });
    expect(screen.queryByRole('link')).toBeNull();
    vi.mocked(apiGet).mockResolvedValue(reply(base));
    await act(async () => { setActiveEnvironment(null); });
    await screen.findByRole('link', { name: /PR #7/ });
    vi.mocked(apiGet).mockReturnValue(slow.promise);
    await act(async () => { setUser({ id: 'someone-else' }); });
    expect(screen.queryByRole('link')).toBeNull();
  });

  it('closes the confirmation when the head commit moves so the reviewed commit is never stale', async () => {
    vi.mocked(apiGet).mockResolvedValueOnce(reply(base)).mockResolvedValue(reply({ ...base, headSha: 'b'.repeat(40) }));
    render(<PullRequestRow cwd="/w" branch="b" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Merge' }));
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(statusCalls()).toBe(2));
    await waitFor(() => expect(screen.queryByRole('group')).toBeNull());
  });
});
