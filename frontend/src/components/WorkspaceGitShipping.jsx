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
    {git.available && git.branch ? <>
      <ThreadGitActions cwd={cwd} branch={git.branch} files={git.files} onChanged={() => { git.refresh(); setRevision(value => value + 1); onChanged?.(); }} />
      <PullRequestRow cwd={cwd} branch={git.branch} refreshKey={revision} />
    </> : <p role="status">Commit, push and pull request actions need a Git repository with a checked-out branch.</p>}
  </section>;
}
