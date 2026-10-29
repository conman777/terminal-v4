import { createUuid } from '../utils/createUuid';
import { useEffect, useRef, useState } from 'react';
import { loadWorkspaceProfile, loadAccountKnowledge } from '../utils/workspaceProfile';
import { buildProposalRequest, parseWorkspaceProposal, workspaceProposalRequest } from '../utils/workspaceProposals';
import './WorkspaceProposalsPanel.css';

const pendingRequests = new Map();

function ChangesPreview({ operations, scope }) {
  return <ol className="workspace-proposal-changes">{operations.map((operation, index) => {
    const memory = operation.kind.startsWith('memory');
    const skill = operation.skill || operation;
    const name = memory ? scope === 'account' ? 'Account knowledge' : 'Project knowledge' : skill.name || operation.beforeName;
    const before = memory ? operation.before : operation.beforeInstructions;
    const after = memory ? operation.content : skill.instructions;
    const beforeFiles = operation.beforeSupportFiles || {};
    const afterFiles = operation.kind === 'skillRemove' ? {} : skill.supportFiles === undefined ? beforeFiles : skill.supportFiles;
    const fileNames = [...new Set([...Object.keys(beforeFiles), ...Object.keys(afterFiles)])];
    return <li key={index}>
      <strong>{name} · {operation.kind === 'memoryAppend' || operation.kind === 'skillCreate' ? 'Add' : operation.kind === 'skillRemove' ? 'Remove' : 'Update'}</strong>
      {!memory && <div><small>Usage</small><p>{operation.kind === 'skillCreate' ? (skill.activation || 'alwaysOn') : operation.kind === 'skillRemove' ? (operation.beforeActivation || 'alwaysOn') : `${operation.beforeActivation || 'alwaysOn'} → ${operation.activation || operation.beforeActivation || 'alwaysOn'}`}</p></div>}
      {before !== undefined && <div><small>Before</small><pre>{before || '(empty)'}</pre></div>}
      {after !== undefined && <div><small>{operation.kind === 'memoryAppend' ? 'Append to existing knowledge' : 'After'}</small><pre>{after || '(empty)'}</pre></div>}
      {fileNames.filter(path => beforeFiles[path] !== afterFiles[path]).map(path => <div className="workspace-proposal-file" key={path}>
        <strong>{path} · {Object.hasOwn(beforeFiles, path) ? Object.hasOwn(afterFiles, path) ? 'Update file' : 'Remove file' : 'Add file'}</strong>
        {Object.hasOwn(beforeFiles, path) && <div><small>Previous file contents</small><pre>{beforeFiles[path] || '(empty)'}</pre></div>}
        {Object.hasOwn(afterFiles, path) && <div><small>Proposed file contents</small><pre>{afterFiles[path] || '(empty)'}</pre></div>}
      </div>)}
      {!memory && operation.kind === 'skillUpdate' && operation.supportFiles === undefined && <small>Supporting files are preserved.</small>}
    </li>;
  })}</ol>;
}

function ProposalsContent({ workspacePath, scope = 'workspace', latestAssistantText = '', onRequestSuggestions, onProfileChanged, savedProfile, profileWriteBusy = false, onProfileWriteStart, onProfileWriteEnd }) {
  const scopeKey = scope === 'account' ? 'account' : 'workspace:' + workspacePath;
  const request = (suffix = '', options = {}) => workspaceProposalRequest(workspacePath, suffix, options, scope);
  const [profile, setProfile] = useState(null);
  const [proposals, setProposals] = useState([]);
  const [requestId, setRequestId] = useState(() => pendingRequests.get(scopeKey) || '');
  const [candidate, setCandidate] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  const [refresh, setRefresh] = useState(0);
  const mounted = useRef(false);
  const updating = useRef(false);

  useEffect(() => {
    mounted.current = true;
    setError('');
    const controller = new AbortController();
    Promise.all([
      savedProfile ? Promise.resolve(savedProfile) : scope === 'account' ? loadAccountKnowledge({ signal: controller.signal }) : loadWorkspaceProfile(workspacePath, { signal: controller.signal }),
      workspaceProposalRequest(workspacePath, '', { signal: controller.signal }, scope),
    ]).then(([saved, result]) => {
      if (!controller.signal.aborted) { setProfile(saved); setProposals(result.proposals); }
    }).catch(loadError => { if (!controller.signal.aborted) setError(loadError.message); });
    return () => { mounted.current = false; controller.abort(); };
  }, [workspacePath, scope, savedProfile, refresh]);

  useEffect(() => { setCandidate(null); }, [latestAssistantText]);

  async function prepare() {
    setError('');
    const id = createUuid();
    pendingRequests.set(scopeKey, id);
    setRequestId(id);
    setCandidate(null);
    try {
      await onRequestSuggestions(buildProposalRequest(profile, id, scope));
      if (mounted.current) setStatus('Learning request added to the editable prompt. Send it, then preview the agent response here.');
    } catch (requestError) {
      if (mounted.current) setError(requestError.message || 'Unable to prepare the learning request');
    }
  }

  async function update(action, proposal) {
    if (updating.current || profileWriteBusy) return;
    const ownsProfileWrite = action !== 'stage' && !!onProfileWriteStart;
    if (ownsProfileWrite && !onProfileWriteStart()) return;
    updating.current = true;
    setBusy(true); setError(''); setStatus('');
    try {
      const result = await request(
        action === 'stage' ? '' : '/' + proposal.id + '/' + action,
        { method: 'POST', ...(action === 'stage' ? { body: proposal } : {}) });
      if (!mounted.current) return;
      if (result.profile) { setProfile(result.profile); onProfileChanged?.(result.profile); }
      const refreshed = await request();
      if (!mounted.current) return;
      setProposals(refreshed.proposals);
      if (action === 'stage') setCandidate(null);
      setStatus(action === 'accept' ? 'Reviewed changes saved.' : action === 'reject' ? 'Suggestion rejected.' : 'Suggestion staged. Review before accepting.');
    } catch (updateError) {
      if (mounted.current) setError(updateError.message);
    } finally {
      updating.current = false;
      if (ownsProfileWrite) onProfileWriteEnd?.();
      if (mounted.current) setBusy(false);
    }
  }

  return <section className="workspace-proposals" aria-label="Reviewed learning">
    <header><h3>Reviewed learning</h3>
    <p>Ask the active agent what this task taught it. Preview its proposal, then accept or reject changes to {scope === 'account' ? 'your account across workspaces' : 'this workspace'}.</p></header>
    <p>Reviewed suggestions update V4 {scope === 'account' ? 'account' : 'workspace'} knowledge and are included in future V4 agent requests.</p>
    {error && <div role="alert" className="workspace-proposal-error"><p>{error}</p>{!profile && <button type="button" onClick={() => setRefresh(value => value + 1)}>Retry learning</button>}</div>}
    {!profile && !error && <p role="status">Loading suggestions…</p>}
    {profile && <>
      <div className="workspace-proposal-actions">
        <button type="button" disabled={busy || profileWriteBusy || !onRequestSuggestions} onClick={prepare}>Prepare learning request</button>
        <button type="button" disabled={busy || profileWriteBusy || !requestId || !latestAssistantText} onClick={() => {
          setError('');
          try { setCandidate(parseWorkspaceProposal(latestAssistantText, requestId, scope)); }
          catch (parseError) { setCandidate(null); setError(parseError.message); }
        }}>Preview agent proposal</button>
      </div>
      {!onRequestSuggestions && <p>Select an active agent conversation to request suggestions.</p>}
      {candidate && <article className="workspace-proposal" aria-label="Unstaged agent suggestion">
        <h4>{candidate.title}</h4><p>{candidate.reason}</p><ChangesPreview operations={candidate.operations} scope={scope} />
        <button type="button" disabled={busy || profileWriteBusy} onClick={() => update('stage', candidate)}>Stage for review</button>
      </article>}
      {proposals.filter(proposal => proposal.status === 'pending').map(proposal => <article className="workspace-proposal" key={proposal.id}>
        <h4>{proposal.title}</h4><p>{proposal.reason}</p><ChangesPreview operations={proposal.operations} scope={scope} />
        <div className="workspace-proposal-actions">
          <button type="button" disabled={busy || profileWriteBusy} aria-label={'Accept ' + proposal.title} onClick={() => update('accept', proposal)}>Accept</button>
          <button type="button" disabled={busy || profileWriteBusy} aria-label={'Reject ' + proposal.title} onClick={() => update('reject', proposal)}>Reject</button>
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

export function AccountProposalsPanel(props) {
  return <ProposalsContent {...props} scope="account" />;
}
