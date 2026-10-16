import { useEffect, useRef, useState } from 'react';
import { loadWorkspaceProfile } from '../utils/workspaceProfile';
import { buildProposalRequest, parseWorkspaceProposal, workspaceProposalRequest } from '../utils/workspaceProposals';
import './WorkspaceProposalsPanel.css';

const pendingRequests = new Map();

function ChangesPreview({ operations }) {
  return <ol className="workspace-proposal-changes">{operations.map((operation, index) => {
    const memory = operation.kind.startsWith('memory');
    const skill = operation.skill || operation;
    const name = memory ? 'Project knowledge' : skill.name || operation.beforeName;
    const before = memory ? operation.before : operation.beforeInstructions;
    const after = memory ? operation.content : skill.instructions;
    return <li key={index}>
      <strong>{name} · {operation.kind === 'memoryAppend' || operation.kind === 'skillCreate' ? 'Add' : operation.kind === 'skillRemove' ? 'Remove' : 'Update'}</strong>
      {before !== undefined && <div><small>Before</small><pre>{before || '(empty)'}</pre></div>}
      {after !== undefined && <div><small>{operation.kind === 'memoryAppend' ? 'Append to existing knowledge' : 'After'}</small><pre>{after || '(empty)'}</pre></div>}
    </li>;
  })}</ol>;
}

function ProposalsContent({ workspacePath, latestAssistantText = '', onRequestSuggestions, onProfileChanged }) {
  const [profile, setProfile] = useState(null);
  const [proposals, setProposals] = useState([]);
  const [requestId, setRequestId] = useState(() => pendingRequests.get(workspacePath) || '');
  const [candidate, setCandidate] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  const mounted = useRef(false);

  useEffect(() => {
    mounted.current = true;
    const controller = new AbortController();
    Promise.all([
      loadWorkspaceProfile(workspacePath, { signal: controller.signal }),
      workspaceProposalRequest(workspacePath, '', { signal: controller.signal }),
    ]).then(([saved, result]) => {
      if (!controller.signal.aborted) { setProfile(saved); setProposals(result.proposals); }
    }).catch(loadError => { if (!controller.signal.aborted) setError(loadError.message); });
    return () => { mounted.current = false; controller.abort(); };
  }, [workspacePath]);

  useEffect(() => { setCandidate(null); }, [latestAssistantText]);

  async function prepare() {
    setError('');
    const id = crypto.randomUUID();
    pendingRequests.set(workspacePath, id);
    setRequestId(id);
    setCandidate(null);
    try {
      await onRequestSuggestions(buildProposalRequest(profile, id));
      if (mounted.current) setStatus('Learning request added to the editable prompt. Send it, then preview the agent response here.');
    } catch (requestError) {
      if (mounted.current) setError(requestError.message || 'Unable to prepare the learning request');
    }
  }

  async function update(action, proposal) {
    setBusy(true); setError(''); setStatus('');
    try {
      const result = await workspaceProposalRequest(workspacePath,
        action === 'stage' ? '' : '/' + proposal.id + '/' + action,
        { method: 'POST', ...(action === 'stage' ? { body: proposal } : {}) });
      if (!mounted.current) return;
      if (result.profile) { setProfile(result.profile); onProfileChanged?.(result.profile); }
      const refreshed = await workspaceProposalRequest(workspacePath);
      if (!mounted.current) return;
      setProposals(refreshed.proposals);
      if (action === 'stage') setCandidate(null);
      setStatus(action === 'accept' ? 'Reviewed changes saved.' : action === 'reject' ? 'Suggestion rejected.' : 'Suggestion staged. Review before accepting.');
    } catch (updateError) {
      if (mounted.current) setError(updateError.message);
    } finally { if (mounted.current) setBusy(false); }
  }

  return <section className="workspace-proposals" aria-label="Reviewed learning">
    <h3>Reviewed learning</h3>
    <p>Ask the active agent what this task taught it. Preview its proposal, then accept or reject changes to this workspace.</p>
    <p>Hermes runtime memory is managed by Hermes itself. These reviewed suggestions update Terminal workspace knowledge.</p>
    {error && <p role="alert" className="workspace-proposal-error">{error}</p>}
    {!profile && !error && <p role="status">Loading suggestions…</p>}
    {profile && <>
      <div className="workspace-proposal-actions">
        <button type="button" disabled={busy || !onRequestSuggestions} onClick={prepare}>Prepare learning request</button>
        <button type="button" disabled={busy || !requestId || !latestAssistantText} onClick={() => {
          setError('');
          try { setCandidate(parseWorkspaceProposal(latestAssistantText, requestId)); }
          catch (parseError) { setCandidate(null); setError(parseError.message); }
        }}>Preview agent proposal</button>
      </div>
      {!onRequestSuggestions && <p>Select an active agent conversation to request suggestions.</p>}
      {candidate && <article className="workspace-proposal" aria-label="Unstaged agent suggestion">
        <h4>{candidate.title}</h4><p>{candidate.reason}</p><ChangesPreview operations={candidate.operations} />
        <button type="button" disabled={busy} onClick={() => update('stage', candidate)}>Stage for review</button>
      </article>}
      {proposals.filter(proposal => proposal.status === 'pending').map(proposal => <article className="workspace-proposal" key={proposal.id}>
        <h4>{proposal.title}</h4><p>{proposal.reason}</p><ChangesPreview operations={proposal.operations} />
        <div className="workspace-proposal-actions">
          <button type="button" disabled={busy} aria-label={'Accept ' + proposal.title} onClick={() => update('accept', proposal)}>Accept</button>
          <button type="button" disabled={busy} aria-label={'Reject ' + proposal.title} onClick={() => update('reject', proposal)}>Reject</button>
        </div>
      </article>)}
      {!proposals.some(proposal => proposal.status === 'pending') && <p>No pending suggestions.</p>}
      {proposals.some(proposal => proposal.status !== 'pending') && <details><summary>Recently reviewed suggestions</summary>
        <ul>{proposals.filter(proposal => proposal.status !== 'pending').map(proposal => <li key={proposal.id}>{proposal.title} · {proposal.status}</li>)}</ul>
      </details>}
    </>}
    <p role="status">{busy ? 'Saving suggestion…' : status}</p>
  </section>;
}

export function WorkspaceProposalsPanel(props) {
  if (!props.workspacePath) return <p>Select a workspace to review learning suggestions.</p>;
  return <ProposalsContent key={props.workspacePath} {...props} />;
}
