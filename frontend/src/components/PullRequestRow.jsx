import { useCallback, useEffect, useRef, useState } from 'react';
import { apiGet, apiPost } from '../utils/api';
import './ThreadCardExtras.css';

export const WATCH_INTERVAL_MS = 60000;
const REVIEW_LABELS = { APPROVED: 'Approved', CHANGES_REQUESTED: 'Changes requested', REVIEW_REQUIRED: 'Review needed' };
const METHODS = [['squash', 'Squash and merge'], ['merge', 'Create a merge commit'], ['rebase', 'Rebase and merge']];

const icon = <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true"><circle cx="12" cy="12" r="3.5" /><path d="M3 12h5.5M15.5 12H21" /></svg>;

function describeChecks({ passed = 0, failed = 0, pending = 0 } = {}) {
  const parts = [passed && `${passed} passed`, failed && `${failed} failed`, pending && `${pending} running`].filter(Boolean);
  return parts.length ? parts.join(', ') : 'No checks';
}

export function confirmationFor(action, number, method) {
  return action === 'merge' ? `merge #${number} (${method})` : `ready #${number}`;
}

export function PullRequestRow({ cwd, branch, refreshKey = 0 }) {
  const [pullRequest, setPullRequest] = useState(null);
  const [problem, setProblem] = useState('');
  const [watching, setWatching] = useState(false);
  const [confirming, setConfirming] = useState(null);
  const [method, setMethod] = useState('squash');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [reload, setReload] = useState(0);
  const generation = useRef(0);

  const refresh = useCallback(() => setReload(value => value + 1), []);

  useEffect(() => {
    if (!cwd || !branch) { setPullRequest(null); setProblem(''); return undefined; }
    let cancelled = false;
    Promise.resolve().then(() => apiGet(`/api/workspace/git/pull-request?${new URLSearchParams({ path: cwd })}`))
      .then(data => {
        if (cancelled) return;
        setPullRequest(data?.pullRequest || null);
        setProblem(data?.availability === 'error' ? data.reason || 'Pull request status could not be checked' : '');
      })
      .catch(() => { if (!cancelled) setProblem('Pull request status could not be loaded'); });
    return () => { cancelled = true; };
  }, [branch, cwd, refreshKey, reload]);

  const open = pullRequest?.state === 'OPEN';
  useEffect(() => {
    if (!watching || !open) return undefined;
    const timer = setInterval(() => { if (!document.hidden) refresh(); }, WATCH_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [watching, open, refresh]);

  useEffect(() => { setConfirming(null); setError(''); }, [pullRequest?.number, branch, cwd]);

  if (problem && !pullRequest) return <p role="status" className="thread-git-note">{problem}</p>;
  if (!pullRequest?.url) return null;

  const review = REVIEW_LABELS[pullRequest.review];
  const state = pullRequest.state === 'OPEN' ? (pullRequest.isDraft ? ' · draft' : '') : ` · ${String(pullRequest.state || '').toLowerCase()}`;
  const conflicting = open && pullRequest.mergeable === 'CONFLICTING';
  const canReady = open && pullRequest.isDraft;
  const canMerge = open && !pullRequest.isDraft && !conflicting;

  const confirm = async () => {
    const token = ++generation.current;
    setPending(true);
    setError('');
    const body = { path: cwd, action: confirming, number: pullRequest.number, confirm: confirmationFor(confirming, pullRequest.number, method) };
    if (confirming === 'merge') body.method = method;
    try {
      await apiPost('/api/workspace/git/pull-request/action', body);
      if (token === generation.current) { setConfirming(null); refresh(); }
    } catch (failure) {
      if (token === generation.current) setError(failure?.message || 'The pull request action failed. Refresh to see its current state.');
    } finally {
      if (token === generation.current) setPending(false);
    }
  };

  return (
    <div className="thread-pr">
      <a className={`thread-details-row thread-pr-status${pullRequest.checks?.failed ? ' failing' : ''}`} href={pullRequest.url} target="_blank" rel="noreferrer">
        {icon}<span>{`PR #${pullRequest.number} · ${describeChecks(pullRequest.checks)}${review ? ` · ${review}` : ''}${state}`}</span>
      </a>
      {conflicting && <p className="thread-git-note thread-git-error thread-pr-conflict">Merge conflicts with the base branch</p>}
      {problem && <p role="status" className="thread-git-note">{problem}. Showing the last known state.</p>}
      {open && <div className="thread-pr-actions">
        {canReady && <button type="button" disabled={pending} onClick={() => setConfirming('ready')}>Mark ready</button>}
        {canMerge && <button type="button" disabled={pending} onClick={() => setConfirming('merge')}>Merge</button>}
        <button type="button" aria-pressed={watching} onClick={() => setWatching(value => !value)}>{watching ? 'Watching' : 'Watch'}</button>
        <button type="button" disabled={pending} onClick={refresh}>Refresh</button>
      </div>}
      {confirming && <div className="thread-pr-confirm" role="group" aria-label="Confirm pull request action">
        {confirming === 'merge' && <label>Merge method<select value={method} disabled={pending} onChange={event => setMethod(event.target.value)}>
          {METHODS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>}
        <p className="thread-git-note">{confirming === 'merge' ? `This ${method}s pull request #${pullRequest.number} into its base branch on GitHub using your gh login.` : `This marks pull request #${pullRequest.number} ready for review on GitHub.`}</p>
        <div className="thread-git-buttons">
          <button type="button" className="thread-git-primary" disabled={pending} onClick={confirm}>{confirming === 'merge' ? `Confirm merge #${pullRequest.number}` : `Confirm ready #${pullRequest.number}`}</button>
          <button type="button" disabled={pending} onClick={() => { setConfirming(null); setError(''); }}>Cancel</button>
        </div>
      </div>}
      {pending && <p role="status" className="thread-git-note">Working…</p>}
      {error && <p role="alert" className="thread-git-note thread-git-error">{error}</p>}
    </div>
  );
}
