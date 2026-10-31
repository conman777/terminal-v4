import { useState } from 'react';
import { useWorkspaceGitStatus } from '../hooks/useWorkspaceGitStatus';
import { PullRequestRow } from './PullRequestRow';
import { ThreadGitActions } from './ThreadCardActions';
import './ThreadDetailsCard.css';
import './ThreadCardExtras.css';

export function WorkspaceGitShipping({ cwd, onChanged }) {
  const git = useWorkspaceGitStatus(cwd);
  const [revision, setRevision] = useState(0);
  return <section className="workspace-git-shipping" aria-label="Commit and pull request">
    <h3>Commit &amp; pull request</h3>
    {git.status === 'loading' ? <p role="status">Loading Git status…</p>
      : git.status === 'error' ? <div role="alert">Could not load Git status. <button type="button" onClick={git.refresh}>Retry Git status</button></div>
      : git.available && git.branch ? <>
      <ThreadGitActions cwd={cwd} branch={git.branch} files={git.files} onChanged={() => { git.refresh(); setRevision(value => value + 1); onChanged?.(); }} />
      <PullRequestRow cwd={cwd} branch={git.branch} refreshKey={revision} />
    </> : git.status === 'idle' ? <p role="status">Select a workspace to view Git actions.</p> : <p role="status">Commit, push and pull request actions need a Git repository with a checked-out branch.</p>}
  </section>;
}
