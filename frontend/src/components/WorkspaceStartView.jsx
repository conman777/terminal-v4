import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { apiFetch } from '../utils/api';
import { loadWorkspaceProfile } from '../utils/workspaceProfile';
import { AgentModelPicker } from './AgentModelPicker';
import { ComposerPicker } from './ComposerPicker';
import { SetupChecklist } from './SetupChecklist';
import { loadSavedAgentSelection, saveAgentSelection } from '../utils/agentSelection';
import { isConversationAgent } from '../utils/agentLauncher';
import { getActiveEnvironment, getEnvironmentSignal, subscribeEnvironment } from '../utils/remoteEnvironments';
import { captureAuthScope, isAuthScopeCurrent, subscribeAuth } from '../utils/auth';
import { environmentAllows } from '../utils/runtimePermissions';
import { DesktopStatusBar } from './DesktopStatusBar';
import { useComposerDraft } from '../hooks/useComposerDraft';
import { useStartImageDraft } from '../hooks/useStartImageDraft';
import { prepareWorktreeCreation } from '../utils/worktreeCreationIntent';
import { worktreeParentFor } from '../utils/worktreeOrigin';
import { recordThreadLineage } from '../utils/threadLineageApi';
import { withAttachedFiles } from '../utils/attachedFiles';
import { createWorkspaceStartAttachments } from '../utils/workspaceStartAttachments';
import { startImageRequestId } from '../utils/startImageTransfer';
import { discardUnfinishedWorktree, fetchWorktreeProgress } from '../utils/worktreeProgress';
import { WorktreeSetupCard } from './WorktreeSetupCard';
import { useInstalledSkills } from '../hooks/useInstalledSkills';
import { useCurrentPullRequest } from '../hooks/useCurrentPullRequest';
import { buildMentionThreads } from './composer-context/mentionThreads';
import { splitContext } from './composer-context/composerContext';

function availabilityReason(value) {
  return [value?.reason, value?.unavailableReason].find(reason => typeof reason === 'string' && reason.trim())?.trim();
}

const authSnapshot = () => JSON.stringify(captureAuthScope());

const PLACEMENT_OPTIONS = [
  { value: 'here', label: 'This folder', description: 'Work directly in the selected project' },
  { value: 'worktree', label: 'New worktree', description: 'Its own checkout and branch, so this task stays separate' },
];

export function worktreeNameFromPrompt(text) {
  const words = splitContext(text).text.replace(/[^\p{L}\p{N} _-]+/gu, ' ').trim().split(/\s+/).filter(Boolean).slice(0, 8);
  return words.join(' ').slice(0, 60).trim() || 'Thread';
}

async function createTaskWorktree(path, prompt, baseRef, operation) {
  let response;
  try { response = await apiFetch('/api/workspace/git/worktrees', { method: 'POST', signal: operation.signal, body: { path, name: worktreeNameFromPrompt(prompt), baseRef, operationId: operation.operationId } }); }
  catch (failure) {
    operation.assertCurrent();
    if (failure instanceof TypeError) throw new Error('Connection lost while creating the worktree. The request may have completed.');
    throw failure;
  }
  operation.assertCurrent();
  const result = await response.json().catch(() => null);
  if (!response.ok) {
    const progress = await fetchWorktreeProgress(operation.operationId).catch(() => null);
    if (progress?.cleaned === true) {
      try { operation.discard(); } catch { /* the saved request is reviewed on the next attempt */ }
      throw Object.assign(new Error(result?.error || 'Worktree setup did not finish. Nothing was left behind.'), { worktreeCleaned: true });
    }
  }
  if (!response.ok || !result?.path || result.available === false || result.creationStatus === 'unconfirmed') throw new Error(result?.error || 'Could not confirm this worktree. Review Git & worktrees before continuing.');
  return result.path;
}

export function WorkspaceStartView({
  currentPath,
  projects = [],
  sessions = [],
  customAiProviders = [],
  recentFolders = [],
  onSelectWorkspace,
  originThread = null,
  onSubmitPrompt,
  onOpenImageConversation,
  onReviewImageConversation,
  onAddWorkspace,
}) {
  const environment = useSyncExternalStore(subscribeEnvironment, getActiveEnvironment);
  const environmentSignal = useSyncExternalStore(subscribeEnvironment, getEnvironmentSignal, getEnvironmentSignal);
  const authKey = useSyncExternalStore(subscribeAuth, authSnapshot, authSnapshot);
  const attachmentStore = useMemo(() => createWorkspaceStartAttachments(), [authKey, environmentSignal]);
  const attachmentDraft = useSyncExternalStore(attachmentStore.subscribe, attachmentStore.getSnapshot);
  const canCreateSession = environmentAllows(environment, 'terminalInput');
  const canExecuteAgent = canCreateSession && environmentAllows(environment, 'agentExecute');
  const { value: composerValue, setValue: setComposerValue, revision: composerDraftRevision, clearIfUnchanged: clearComposerDraft, error: composerDraftError, store: composerStore } = useComposerDraft('workspace-start');
  const [agents, setAgents] = useState([]);
  const [agentId, setAgentId] = useState('codex');
  const [selection, setSelection] = useState(() => loadSavedAgentSelection('codex'));
  const [selectedPath, setSelectedPath] = useState(currentPath || '');
  const canReadWorkspace = environmentAllows(environment, 'fileRead');
  const installedSkills = useInstalledSkills(canReadWorkspace ? selectedPath : '');
  const mentionPullRequests = useCurrentPullRequest(selectedPath, null, { enabled: canReadWorkspace && Boolean(selectedPath) });
  const mentionThreads = useMemo(() => buildMentionThreads(sessions, null), [sessions]);
  const [placement, setPlacement] = useState('here');
  const [baseRef, setBaseRef] = useState('HEAD');
  const [branchResult, setBranchResult] = useState(null);
  const [loading, setLoading] = useState(true);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState('');
  const [worktreeAttempt, setWorktreeAttempt] = useState(false);
  const [activeWorktreeOp, setActiveWorktreeOp] = useState(null);
  const [catalogError, setCatalogError] = useState('');
  const [catalogAttempt, setCatalogAttempt] = useState(0);
  const sending = useRef(false);
  const composerShell = useRef(null);
  const editedSelection = useRef(false);
  useEffect(() => { setSelectedPath(currentPath || ''); }, [currentPath]);
  useEffect(() => { setBaseRef('HEAD'); }, [selectedPath, environmentSignal, authKey]);
  useEffect(() => {
    if (placement !== 'worktree' || !selectedPath) return undefined;
    const controller = new AbortController();
    async function loadBranches() {
      try {
        const response = await apiFetch('/api/workspace/git/branches?path=' + encodeURIComponent(selectedPath), { signal: controller.signal });
        if (!response.ok) throw new Error('Branch list unavailable');
        const result = await response.json();
        if (!Array.isArray(result.branches)) throw new Error('Branch list unavailable');
        const branches = [...new Set(result.branches.filter(ref => typeof ref === 'string' && ref.length <= 200 && /^refs\/(heads|remotes)\//.test(ref)))].slice(0, 200);
        if (!controller.signal.aborted) setBranchResult({ path: selectedPath, environmentSignal, authKey, branches, truncated: result.truncated === true });
      } catch {
        if (!controller.signal.aborted) setBranchResult({ path: selectedPath, environmentSignal, authKey, unavailable: true, branches: [] });
      }
    }
    void loadBranches();
    return () => controller.abort();
  }, [placement, selectedPath, environmentSignal, authKey]);
  const branchState = branchResult?.path === selectedPath && branchResult.environmentSignal === environmentSignal && branchResult.authKey === authKey ? branchResult : null;
  useEffect(() => {
    const width = Math.max(window.innerWidth || 0, window.visualViewport?.width || 0, document.documentElement?.clientWidth || 0);
    if (selectedPath && width > 768 && !window.matchMedia?.('(pointer: coarse)').matches) composerShell.current?.querySelector('textarea')?.focus();
  }, [selectedPath]);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError('');
    setCatalogError('');
    editedSelection.current = false;
    async function load() {
      try {
        const response = await apiFetch('/api/agent/catalog', { signal: controller.signal });
        const catalog = await response.json();
        if (!response.ok || !Array.isArray(catalog.agents)) throw new Error('Unable to load agents. Try again.');
        const choices = catalog.agents.filter(agent => isConversationAgent(agent) && (agent.available === true || agent.id === 'codex'));
        if (!choices.length) throw new Error('No compatible agents are available. Configure an agent, then try again.');
        if (controller.signal.aborted) return;
        setAgents(choices);
        let preferred = 'codex';
        try { preferred = localStorage.getItem('terminalV4StartAgent') || preferred; } catch { /* optional preference */ }
        let projectSelection = null;
        if (selectedPath) {
          try {
            const profile = await loadWorkspaceProfile(selectedPath, { signal: controller.signal });
            if (choices.some(agent => agent.id === profile.defaultAgent)) preferred = profile.defaultAgent;
            if (profile.defaultAgent === preferred && profile.selection?.model) projectSelection = profile.selection;
          } catch { /* Agent defaults still work when project knowledge is unavailable. */ }
        }
        if (!controller.signal.aborted && !editedSelection.current) {
          const nextId = choices.find(agent => agent.id === preferred)?.id || choices.find(agent => agent.available)?.id || choices[0]?.id || 'codex';
          setAgentId(nextId);
          setSelection(projectSelection || loadSavedAgentSelection(nextId));
        }
      } catch (failure) {
        if (!controller.signal.aborted) {
          setAgents([]);
          setCatalogError(failure.message || 'Unable to load agents. Try again.');
        }
      } finally { if (!controller.signal.aborted) setLoading(false); }
    }
    void load();
    return () => controller.abort();
  }, [selectedPath, catalogAttempt]);
  const selectedAgent = agents.find(agent => agent.id === agentId);
  const nativeAttachments = selectedAgent?.runtime === 'codex' || selectedAgent?.runtime === 'claude';
  const projectPaths = [...new Set([selectedPath, ...projects.map(project => project.path), ...recentFolders].filter(Boolean))];
  const canStart = canExecuteAgent && Boolean(selectedPath) && (placement !== 'worktree' || Boolean(baseRef.trim())) && !loading && !starting && selectedAgent?.available === true && selection?.available !== false && Boolean(selection?.model || (!selectedAgent?.connectionProfile && selectedAgent?.models?.length === 0));
  const hasWorkspace = Boolean(selectedPath);
  const agentUnavailable = Boolean(selectedAgent && selectedAgent.available !== true);
  const modelUnavailable = selection?.available === false;
  const canRecheck = canExecuteAgent && hasWorkspace && !loading && !starting && !catalogError && (agentUnavailable || modelUnavailable);
  const selectedModel = selectedAgent?.models?.find(model => model.id === selection?.model);
  const v4ImagesSupported = selectedAgent?.runtime === 'v4' && selectedModel?.imageInput === true && !environment;
  const startImages = useStartImageDraft({ store: composerStore, authKey, environmentSignal, environment,
    active: v4ImagesSupported || Boolean(composerStore.getSnapshot().imageRecovery),
    enabled: canStart && !attachmentDraft.pending, imageSupported: v4ImagesSupported });
  const imageComposer = selectedAgent?.runtime === 'v4' && (v4ImagesSupported || startImages.hasImages) ? startImages.images : null;
  let startHint = '';
  if (starting) startHint = 'Starting your task…';
  else if (canCreateSession && !canExecuteAgent) startHint = 'Agent execution is disabled in this environment. Choose another environment to start a task.';
  else if (canExecuteAgent && !hasWorkspace) startHint = 'Choose a project before starting a task.';
  else if (canExecuteAgent && !error && !catalogError) {
    if (loading) startHint = 'Loading agents…';
    else if (agentUnavailable) startHint = `${selectedAgent.label || 'This agent'} is unavailable. ${availabilityReason(selectedAgent) || 'Complete agent setup on this host, then recheck availability.'}`;
    else if (modelUnavailable) startHint = `The selected model is unavailable. ${availabilityReason(selection) || availabilityReason(selectedModel) || 'Choose another model or recheck availability.'}`;
    else if (placement === 'worktree' && !baseRef.trim()) startHint = 'Enter a base branch or commit for the worktree.';
    else if (!canStart) startHint = 'Choose a model before starting a task.';
    else if (!startImages.hasImages) startHint = 'Project selected. Describe your task above, then send to start.';
  }

  function recordWorktreeLineage(childId) {
    const parentId = worktreeParentFor(originThread, selectedPath, childId);
    if (parentId) void recordThreadLineage(childId, parentId, 'worktree');
  }

  async function handleSubmit(value) {
    const trimmed = typeof value === 'string' ? value.trim() : composerValue.trim();
    const attachments = attachmentDraft.attachments;
    if (!canStart || (!trimmed && !attachments.length && !startImages.hasImages) || sending.current || attachmentDraft.pending || attachmentDraft.error || (attachments.length && !nativeAttachments)) return;
    if (startImages.hasImages && (!imageComposer?.canSend || !onOpenImageConversation || nativeAttachments)) return;
    sending.current = true;
    setStarting(true);
    setError('');
    const submitScope = captureAuthScope();
    try {
      const operation = placement === 'worktree' ? prepareWorktreeCreation(selectedPath, 'start') : null;
      if (operation) { setWorktreeAttempt(true); setActiveWorktreeOp(operation.operationId); }
      const path = operation ? await createTaskWorktree(selectedPath, trimmed, baseRef.trim(), operation) : selectedPath;
      operation?.assertCurrent();
      let receipt;
      if (startImages.hasImages) {
        const source = await startImages.capture();
        const requestId = await startImageRequestId(source);
        if (environmentSignal.aborted || !isAuthScopeCurrent(submitScope) || !startImages.current?.()
          || JSON.stringify(await startImages.capture()) !== JSON.stringify(source)) throw new Error('The saved image draft changed. Review it before continuing.');
        const sourceBinding = { ...source, requestId };
        if (!attachmentStore.beginImage(sourceBinding)) throw new Error('Could not save the image request. Your draft was kept.');
        receipt = await onOpenImageConversation(composerValue, { path, agentId, selection,
          imageTransfer: { source: startImages.source, sourceBinding, bind: attachmentStore.bindImage, isCurrent: startImages.current, signal: startImages.signal } });
        if (receipt?.opened !== true || !receipt.sessionId) throw new Error('Conversation creation could not be confirmed. Your images were kept.');
      } else {
        if (!attachmentStore.begin()) throw new Error('Could not save the start request. Your draft was kept.');
        receipt = await onSubmitPrompt?.(withAttachedFiles(trimmed, attachments.map(item => item.path)), { path, agentId, selection });
      }
      operation?.assertCurrent();
      if (environmentSignal.aborted || !isAuthScopeCurrent(submitScope)) return;
      if (!startImages.hasImages && (receipt === false || receipt?.accepted === false)) throw new Error('The agent did not accept this task. Your prompt is saved here.');
      if (!startImages.hasImages && receipt?.accepted !== true) throw new Error('Task delivery could not be confirmed. Your draft is saved here.');
      operation?.complete();
      if (operation) recordWorktreeLineage(receipt?.sessionId);
      setWorktreeAttempt(false);
      if (!startImages.hasImages) clearComposerDraft(composerDraftRevision, trimmed);
      attachmentStore.complete(attachments);
    } catch (failure) {
      if (failure.worktreeCleaned) setWorktreeAttempt(false);
      if (!environmentSignal.aborted && isAuthScopeCurrent(submitScope)) setError(failure.message || 'Unable to start this task. Your prompt is saved here.');
    }
    finally { sending.current = false; setStarting(false); setActiveWorktreeOp(null); }
  }

  async function handleDiscardUnfinishedWorktree() {
    if (sending.current) return;
    sending.current = true;
    setStarting(true);
    try {
      const operation = prepareWorktreeCreation(selectedPath, 'start');
      const result = await discardUnfinishedWorktree(selectedPath, operation.operationId);
      if (!result.discarded && !/No unfinished worktree request/.test(result.error)) { setError(result.error); return; }
      operation.discard();
      setWorktreeAttempt(false);
      setError('');
    } catch (failure) { setError(failure.message); }
    finally { sending.current = false; setStarting(false); }
  }

  async function handleOpenImageConversation() {
    if (!canStart || !onOpenImageConversation || nativeAttachments || sending.current || attachmentDraft.pending || attachmentDraft.error || attachmentDraft.attachments.length || startImages.hasImages) return;
    sending.current = true;
    setStarting(true);
    setError('');
    const submitScope = captureAuthScope();
    const text = composerValue;
    try {
      const operation = placement === 'worktree' ? prepareWorktreeCreation(selectedPath, 'start') : null;
      if (operation) { setWorktreeAttempt(true); setActiveWorktreeOp(operation.operationId); }
      const path = operation ? await createTaskWorktree(selectedPath, text, baseRef.trim(), operation) : selectedPath;
      operation?.assertCurrent();
      if (!attachmentStore.begin('conversation')) throw new Error('Could not save the conversation request. Your draft was kept.');
      const receipt = await onOpenImageConversation(text, { path, agentId, selection });
      operation?.assertCurrent();
      if (environmentSignal.aborted || !isAuthScopeCurrent(submitScope)) return;
      if (receipt?.opened !== true || !receipt.sessionId) throw new Error('Conversation creation could not be confirmed. Your draft is saved here.');
      operation?.complete();
      if (operation) recordWorktreeLineage(receipt?.sessionId);
      setWorktreeAttempt(false);
      clearComposerDraft(composerDraftRevision, text);
      attachmentStore.complete([]);
    } catch (failure) {
      if (failure.worktreeCleaned) setWorktreeAttempt(false);
      if (!environmentSignal.aborted && isAuthScopeCurrent(submitScope)) setError(failure.message || 'Unable to open the conversation. Your draft is saved here.');
    }
    finally { sending.current = false; setStarting(false); setActiveWorktreeOp(null); }
  }

  async function handleResumeImageConversation() {
    const saved = attachmentDraft.imageTransfer;
    if (!saved?.creation || !saved.requestId || saved.messageRequestId || !startImages.source || !startImages.current?.() || !onOpenImageConversation || sending.current) return;
    sending.current = true; setStarting(true); setError('');
    const submitScope = captureAuthScope();
    try {
      const receipt = await onOpenImageConversation(saved.text, { path: saved.creation.cwd,
        imageTransfer: { source: startImages.source, sourceBinding: saved, bind: attachmentStore.bindImage, isCurrent: startImages.current, signal: startImages.signal } });
      if (environmentSignal.aborted || !isAuthScopeCurrent(submitScope)) return;
      if (receipt?.opened !== true || !receipt.sessionId) throw new Error('Conversation creation is still unconfirmed. Your images were kept.');
      attachmentStore.complete([]);
    } catch (failure) { if (!environmentSignal.aborted && isAuthScopeCurrent(submitScope)) setError(failure.message || 'The previous image request is still held.'); }
    finally { sending.current = false; setStarting(false); }
  }

  async function handleStartAnotherTask() {
    if (sending.current || starting) return;
    if (attachmentDraft.pendingKind !== 'image') { attachmentStore.release(); return; }
    const saved = attachmentDraft.imageTransfer, source = startImages.source;
    if (!saved || !source || !startImages.current?.()) return;
    sending.current = true; setStarting(true); setError('');
    try {
      await source.hydrate();
      if (!startImages.current()) throw new Error('The image draft scope changed.');
      const current = source.getSnapshot();
      if (current.scopeKey !== JSON.stringify(saved.sourceScope) || current.authorityId !== saved.sourceAuthorityId) throw new Error('The saved image draft changed. Review the conversation before starting again.');
      if (current.localIds.length) {
        if (current.revision === saved.sourceRevision && JSON.stringify(current.localIds) === JSON.stringify(saved.sourceLocalIds)) {
          await source.renewStartRevision({ expectedRevision: saved.sourceRevision, expectedLocalIds: saved.sourceLocalIds });
        } else {
          await source.flush(); await source.hydrate();
          const checked = source.getSnapshot();
          if (checked.revision !== current.revision || checked.text !== current.text || JSON.stringify(checked.localIds) !== JSON.stringify(current.localIds)) throw new Error('The current draft changed again. Review it before starting another task.');
        }
      } else if (!saved.targetScope) throw new Error('The original images are unavailable. Review the previous request before starting again.');
      if (!startImages.current() || !attachmentStore.release()) throw new Error('The previous request could not be cleared. Review it before starting again.');
    } catch (failure) { if (startImages.current?.()) setError(failure.message || 'The previous request could not be cleared.'); }
    finally { sending.current = false; setStarting(false); }
  }

  return (
    <section className="workspace-start-view" aria-label="Workspace start">
      <div className="workspace-start-shell">
        <header className="workspace-welcome">
          <h1>What should we build?</h1>
        </header>

        {!canCreateSession && <p className="remote-readonly-notice" role="status">This environment is read-only. Select an existing thread to view its output.</p>}
        {canCreateSession && <SetupChecklist welcome />}
        <div className="workspace-start-composer-shell" ref={composerShell}>
          <DesktopStatusBar
            sessionId="workspace-start"
            aiType={agentId}
            customAiProviders={customAiProviders}
            mentionRoot={canReadWorkspace ? selectedPath : ''}
            mentionThreads={mentionThreads}
            mentionPullRequests={mentionPullRequests}
            skills={installedSkills}
            composerValue={composerValue}
            composerDraftStore={composerStore}
            composerAttachments={attachmentDraft.attachments}
            attachmentsEnabled={nativeAttachments || Boolean(imageComposer)}
            attachmentsDisabledMessage="Images cannot be attached on this screen. Open a conversation to add images."
            userImages={imageComposer}
            allowAnyFile
            onComposerAttachmentAdd={attachmentStore.add}
            onComposerAttachmentRemove={attachmentStore.remove}
            onComposerChange={setComposerValue}
            onComposerSubmit={handleSubmit}
            composerPlaceholder={`Ask ${selectedAgent?.label || 'Codex'} to do anything…`}
            composerDisabled={!canExecuteAgent || starting || (attachmentDraft.pending && attachmentDraft.pendingKind === 'image')}
            composerSubmitDisabled={!canStart || attachmentDraft.pending || Boolean(attachmentDraft.error) || (attachmentDraft.attachments.length > 0 && !nativeAttachments) || (startImages.hasImages && !imageComposer?.canSend)}
            composerSubmitLabel="Start task"
            showTopRow={false}
            showComposerFooter={false}
            showImageButton={nativeAttachments || Boolean(imageComposer)}
            showAiSelector={false}
            showAutocorrectToggle={false}
            showMicButtons={false}
            composerSecondaryAction={<div className="workspace-start-controls">
              <ComposerPicker label="Project" value={selectedPath} placeholder="Choose project" disabled={starting}
                className="workspace-start-project-picker" displayPrefix="Project: "
                icon={<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><path d="M3 7V5a2 2 0 0 1 2-2h4l2 3h8a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" /></svg>}
                options={projectPaths.map(path => ({ value: path, label: projects.find(project => project.path === path)?.name || path.split(/[\\/]/).filter(Boolean).pop() || path, description: path }))}
                onChange={path => { if (path === selectedPath) return; setSelectedPath(path); setSelection(null); onSelectWorkspace?.(path); }}
                action={onAddWorkspace ? { label: hasWorkspace ? 'Change workspace' : 'Add workspace', text: 'Add project folder…', onClick: onAddWorkspace } : undefined} />
              <ComposerPicker label="Where" className="workspace-start-placement-picker" value={placement} disabled={starting || !selectedPath} options={PLACEMENT_OPTIONS} onChange={setPlacement} />
              {agents.length > 1 ? <ComposerPicker label="Agent" value={agentId} disabled={starting || loading}
                options={agents.map(agent => ({ value: agent.id, label: agent.label }))}
                onChange={id => { editedSelection.current = true; setAgentId(id); setSelection(loadSavedAgentSelection(id)); try { localStorage.setItem('terminalV4StartAgent', id); } catch { /* optional preference */ } }} />
                : <span className="workspace-start-agent-badge">{selectedAgent?.label || 'Codex'}</span>}
              {!loading && selectedAgent && <div className="workspace-start-model" onPointerDown={() => { editedSelection.current = true; }} onKeyDown={() => { editedSelection.current = true; }}>
                <AgentModelPicker key={`${selectedPath}:${agentId}`} compact disabled={starting} agentId={agentId} value={selection} onChange={next => { setSelection(next); saveAgentSelection(agentId, next); }} />
              </div>}
            </div>}
          />
          {!nativeAttachments && !v4ImagesSupported && !startImages.hasImages && selectedAgent?.runtime === 'v4' && onOpenImageConversation && <div className="workspace-start-hint workspace-start-image-entry">
            <button type="button" disabled={!canStart || attachmentDraft.pending || Boolean(attachmentDraft.error) || attachmentDraft.attachments.length > 0 || startImages.hasImages} onClick={handleOpenImageConversation}>Open conversation to add images</button>
            <p>Your draft moves to the conversation without sending. Image support depends on the selected model.</p>
          </div>}
          {placement === 'worktree' && <div className="workspace-start-base">
            <label htmlFor="worktree-base-ref">Base branch or commit</label>
            <input id="worktree-base-ref" aria-label="Worktree base branch or commit" value={baseRef} onChange={event => setBaseRef(event.target.value)} disabled={starting} maxLength={200} spellCheck={false} />
            {branchState?.branches.length > 0 && <select aria-label="Choose a base branch" value={branchState.branches.includes(baseRef) ? baseRef : ''} disabled={starting} onChange={event => { if (event.target.value) setBaseRef(event.target.value); }}>
              <option value="">Choose a branch…</option>
              {branchState.branches.map(ref => <option key={ref} value={ref}>{ref.replace(/^refs\/(heads|remotes)\//, '')}</option>)}
            </select>}
            {branchState?.unavailable && <small>Branch list unavailable. Enter a branch or commit above.</small>}
            {branchState?.truncated && <small>Showing the first 200 branches. Enter another branch above.</small>}
          </div>}
          {starting && activeWorktreeOp && <WorktreeSetupCard operationId={activeWorktreeOp} />}
          {(error || catalogError || composerDraftError) && <p className="workspace-start-error" role="alert">{error || catalogError || composerDraftError}</p>}
          {attachmentDraft.error && <div className="workspace-start-recovery" role="alert">{attachmentDraft.error} <button type="button" onClick={attachmentStore.retrySave}>{attachmentDraft.attachments.length ? 'Retry saving attachments' : 'Retry saving request'}</button></div>}
          {attachmentDraft.attachments.length > 0 && !nativeAttachments && <p className="workspace-start-hint" role="status">Choose Codex or Claude to send the attached files, or remove them before starting this task.</p>}
          {startImages.hasImages && !attachmentDraft.pending && <p className="workspace-start-hint">Your images are saved on this device until the task starts.</p>}
          {attachmentDraft.pending && !starting && <div className="workspace-start-hint workspace-start-recovery" role="status">
            <p>{attachmentDraft.pendingKind === 'image' ? attachmentDraft.imageTransfer?.messageRequestId ? 'The message may have been sent. Review the conversation and its saved request before starting another task.' : 'The conversation or image transfer may have completed. Check the original request and conversation before starting another task.' : `${attachmentDraft.pendingKind === 'conversation' ? 'This conversation may have been created. Check your conversations before trying again.' : 'This task may have started. Check your conversations before starting it again.'} Your draft${attachmentDraft.attachments.length ? ' and attachments are' : ' is'} still here.`}</p>
            {attachmentDraft.pendingKind === 'image' && attachmentDraft.imageTransfer?.creation && !attachmentDraft.imageTransfer?.messageRequestId && <button type="button" disabled={starting || !startImages.source || !startImages.current?.()} onClick={handleResumeImageConversation}>Check and resume image request</button>}
            {attachmentDraft.pendingKind === 'image' && attachmentDraft.imageTransfer?.targetScope?.[3] && onReviewImageConversation && <button type="button" disabled={starting} onClick={() => onReviewImageConversation(attachmentDraft.imageTransfer.targetScope[3])}>Review conversation</button>}
            {attachmentDraft.pendingKind === 'image' && <p>Review the current text and image list before starting a different task.</p>}
            <button type="button" disabled={starting || (attachmentDraft.pendingKind === 'image' && !startImages.source)} onClick={handleStartAnotherTask}>Start another task</button>
          </div>}
          {error && worktreeAttempt && placement === 'worktree' && <div className="workspace-start-hint workspace-start-recovery">
            <p>A previous request may have created a checkout. Check Git &amp; worktrees before using a new request.</p>
            <button type="button" disabled={starting} onClick={() => {
              try { prepareWorktreeCreation(selectedPath, 'start').discard(); setWorktreeAttempt(false); setError(''); }
              catch (failure) { setError(failure.message); }
            }}>Use a new worktree request</button>
            <button type="button" disabled={starting} onClick={handleDiscardUnfinishedWorktree}>Remove the unfinished checkout</button>
          </div>}

          {catalogError && <button type="button" className="workspace-start-retry" onClick={() => setCatalogAttempt(attempt => attempt + 1)}>Retry loading agents</button>}
          {canRecheck && <button type="button" className="workspace-start-retry" onClick={() => setCatalogAttempt(attempt => attempt + 1)}>Recheck availability</button>}
          {startHint && (!attachmentDraft.pending || starting) && <p role="status" className="workspace-start-hint">{startHint}</p>}
        </div>
      </div>
    </section>
  );
}
