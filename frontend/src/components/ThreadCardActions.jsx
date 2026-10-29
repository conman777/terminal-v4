import { useEffect, useState } from 'react';
import { apiGet, apiPost } from '../utils/api';

const icons = {
  commit: <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true"><circle cx="12" cy="12" r="3.5" /><path d="M3 12h5.5M15.5 12H21" /></svg>,
  editor: <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m8 7-5 5 5 5M16 7l5 5-5 5" /></svg>,
};

function splitCommitMessage(message) {
  const [title, ...rest] = message.trim().split('\n');
  return { title: title.trim(), body: rest.join('\n').trim() };
}

// T3 Code's "Commit, push & PR" row: stages everything in the thread's repository and ships it.
export function ThreadGitActions({ cwd, branch, files, onChanged }) {
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState('');
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');
  const hasChanges = files > 0;
  const ready = !pending && (!hasChanges || message.trim().length > 0);

  const run = async (action) => {
    setPending(true);
    setError('');
    setResult(null);
    try {
      let text = `Pushed ${branch}`;
      let pullRequest = null;
      if (hasChanges) {
        const commit = await apiPost('/api/workspace/git/commit', { path: cwd, message: message.trim(), push: action !== 'commit' });
        text = commit.pushed ? `Committed and pushed ${commit.branch}` : `Committed to ${commit.branch}`;
      } else if (action === 'push') {
        await apiPost('/api/workspace/git/push', { path: cwd });
      }
      if (action === 'pr') {
        const { title, body } = hasChanges ? splitCommitMessage(message) : { title: branch, body: '' };
        pullRequest = (await apiPost('/api/workspace/git/pull-request', { path: cwd, title, body })).url || null;
        text = 'Pull request created';
      }
      setMessage('');
      setResult({ text, pullRequest });
      onChanged?.();
    } catch (failure) {
      setError(failure?.message || 'Git action failed');
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="thread-git-actions">
      <button type="button" className="thread-details-row" aria-expanded={open} onClick={() => setOpen(value => !value)}>
        {icons.commit}<span>Commit, push & PR</span>
      </button>
      {open && <div className="thread-git-form">
        {hasChanges && <textarea aria-label="Commit message" placeholder="Commit message" rows={3} maxLength={2000}
          value={message} onChange={event => setMessage(event.target.value)} disabled={pending} />}
        <div className="thread-git-buttons">
          {hasChanges ? <>
            <button type="button" disabled={!ready} onClick={() => run('commit')}>Commit</button>
            <button type="button" disabled={!ready} onClick={() => run('push')}>Commit & push</button>
            <button type="button" className="thread-git-primary" disabled={!ready} onClick={() => run('pr')}>Commit, push & create PR</button>
          </> : <>
            <button type="button" disabled={pending} onClick={() => run('push')}>Push branch</button>
            <button type="button" className="thread-git-primary" disabled={pending} onClick={() => run('pr')}>Create pull request</button>
          </>}
        </div>
        {pending && <p role="status" className="thread-git-note">Working…</p>}
        {error && <p role="alert" className="thread-git-note thread-git-error">{error}</p>}
        {result && <p role="status" className="thread-git-note">{result.text}
          {result.pullRequest && <> · <a href={result.pullRequest} target="_blank" rel="noreferrer">Open pull request</a></>}</p>}
      </div>}
    </div>
  );
}

let installedEditors = null;
export function resetInstalledEditorsCache() { installedEditors = null; }
function loadInstalledEditors() {
  installedEditors ||= Promise.resolve().then(() => apiGet('/api/system/editors')).then(data => (Array.isArray(data?.editors) ? data.editors : []), () => []);
  return installedEditors;
}

export function OpenInEditorRow({ cwd }) {
  const [editors, setEditors] = useState([]);
  const [error, setError] = useState('');
  useEffect(() => {
    let cancelled = false;
    loadInstalledEditors().then(list => { if (!cancelled) setEditors(list); });
    return () => { cancelled = true; };
  }, []);
  const editor = editors[0];
  if (!editor || !cwd) return null;
  const open = async () => {
    setError('');
    try {
      await apiPost('/api/system/open-in-editor', { editor: editor.id, path: cwd });
    } catch (failure) {
      setError(failure?.message || `Could not open ${editor.label}`);
    }
  };
  return <>
    <button type="button" className="thread-details-row" onClick={open}>{icons.editor}<span>{`Open in ${editor.label}`}</span></button>
    {error && <p role="alert" className="thread-git-note thread-git-error">{error}</p>}
  </>;
}

const REVIEW_LABELS = { APPROVED: 'Approved', CHANGES_REQUESTED: 'Changes requested', REVIEW_REQUIRED: 'Review needed' };

function describeChecks({ passed = 0, failed = 0, pending = 0 } = {}) {
  const parts = [passed && `${passed} passed`, failed && `${failed} failed`, pending && `${pending} running`].filter(Boolean);
  return parts.length ? parts.join(', ') : 'No checks';
}

// The open pull request for this branch, with how its checks and review are going.
export function PullRequestStatus({ cwd, branch, refreshKey = 0 }) {
  const [pullRequest, setPullRequest] = useState(null);
  useEffect(() => {
    if (!cwd || !branch) { setPullRequest(null); return undefined; }
    let cancelled = false;
    Promise.resolve().then(() => apiGet(`/api/workspace/git/pull-request?${new URLSearchParams({ path: cwd })}`))
      .then(data => { if (!cancelled) setPullRequest(data?.pullRequest || null); })
      .catch(() => { if (!cancelled) setPullRequest(null); });
    return () => { cancelled = true; };
  }, [branch, cwd, refreshKey]);
  if (!pullRequest?.url) return null;
  const review = REVIEW_LABELS[pullRequest.review];
  const state = pullRequest.state && pullRequest.state !== 'OPEN' ? ` · ${pullRequest.state.toLowerCase()}` : '';
  return (
    <a className={`thread-details-row thread-pr-status${pullRequest.checks?.failed ? ' failing' : ''}`} href={pullRequest.url} target="_blank" rel="noreferrer">
      {icons.commit}<span>{`PR #${pullRequest.number} · ${describeChecks(pullRequest.checks)}${review ? ` · ${review}` : ''}${state}`}</span>
    </a>
  );
}
