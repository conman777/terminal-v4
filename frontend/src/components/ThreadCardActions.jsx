import { useState } from 'react';
import { apiPost } from '../utils/api';

const icons = {
  commit: <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true"><circle cx="12" cy="12" r="3.5" /><path d="M3 12h5.5M15.5 12H21" /></svg>,
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

export { OpenInEditorPicker as OpenInEditorRow, resetInstalledEditorsCache } from './OpenInEditorPicker';
export { PullRequestRow as PullRequestStatus } from './PullRequestRow';
