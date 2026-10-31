import { resolveAgentSessionLaunch } from './agentLauncher';
import { getComposerDraftStore } from './composerDraftStore';
import { captureAuthScope, isAuthScopeCurrent } from './auth';
import { getEnvironmentSignal } from './remoteEnvironments';
import { bindStartImageTarget, copyStartImages } from './startImageTransfer';
import { sendPreparedStartImages } from './startImageSend';
import { retainUserImageComposer } from './userImageComposerController';
import { splitContext } from '../components/composer-context/composerContext';

// An empty conversation supplies the image composer's real session scope.
// With an image transfer, the explicit start action also submits the message.
export async function openWorkspaceImageConversation(prompt, options, { customAiProviders, createStructuredSession, rememberProject, addSessionToDesktop, isDesktopCurrent = () => true, desktopId, onSelected }) {
  const text = typeof prompt === 'string' ? prompt : '';
  const title = splitContext(text).text.trim().slice(0, 80) || undefined;
  const cwd = options.path;
  if (!cwd) throw new Error('Choose a project first.');
  const signal = getEnvironmentSignal();
  const authority = captureAuthScope();
  const assertScope = () => {
    if (signal.aborted || !isAuthScopeCurrent(authority)) throw new Error('The environment or account changed. Check the original server before retrying.');
  };
  const launch = options.imageTransfer?.sourceBinding?.creation || await resolveAgentSessionLaunch(options.agentId || 'codex', options.selection, customAiProviders);
  assertScope();
  if (launch.kind !== 'structured') throw new Error('This agent does not support conversation images.');
  let sourceBinding = options.imageTransfer?.sourceBinding;
  if (sourceBinding && !sourceBinding.creation) {
    sourceBinding = { ...sourceBinding, creation: { kind: launch.kind, provider: launch.provider, model: launch.model,
      reasoning: launch.reasoning, serviceTier: launch.serviceTier, cwd, title } };
    if (!options.imageTransfer.bind(sourceBinding)) throw new Error('The image request could not be saved. Your originals were kept.');
  }
  const creation = sourceBinding?.creation;
  if (creation && creation.cwd !== cwd) throw new Error('The saved project changed. Review the original request.');
  let prepared = false;
  const session = await createStructuredSession({ cwd, provider: launch.provider, model: launch.model, reasoning: launch.reasoning, serviceTier: launch.serviceTier, title: creation?.title ?? title,
    ...(sourceBinding ? { startRequestId: sourceBinding.requestId } : {}),
    shouldSelectSession: isDesktopCurrent,
    onSelected,
    async prepareSession(created) {
      assertScope();
      if (!created?.id || created.runtime !== 'v4') throw new Error('This conversation does not support V4 images.');
      const draft = getComposerDraftStore(created.id);
      const previous = draft.getSnapshot();
      if (previous.error) throw new Error(previous.error);
      if ((previous.text && previous.text !== text) || (sourceBinding?.targetScope && previous.text !== text)) throw new Error('The destination draft changed. Review it before continuing.');
      draft.setText(text);
      const saved = draft.getSnapshot();
      if (saved.error || saved.text !== text) throw new Error(saved.error || 'The conversation draft could not be saved.');
      if (options.imageTransfer) {
        const { source, bind, isCurrent, signal: sourceSignal } = options.imageTransfer;
        const current = () => !signal.aborted && !sourceSignal?.aborted && isAuthScopeCurrent(authority) && isCurrent() && isDesktopCurrent();
        if (!current()) throw new Error('The image transfer scope changed.');
        const targetScope = [authority.userId, authority.home, 'home', created.id];
        if (sourceBinding.targetScope && JSON.stringify(sourceBinding.targetScope) !== JSON.stringify(targetScope)) throw new Error('The saved conversation changed. Review the original request.');
        const binding = bindStartImageTarget(sourceBinding, targetScope);
        if (!bind(binding)) throw new Error('The image transfer could not be saved. Your originals were kept.');
        const targetSignal = AbortSignal.any([signal, ...(sourceSignal ? [sourceSignal] : [])]);
        const lease = retainUserImageComposer({ scope: targetScope, store: draft, session: created, signal, isCurrent: current, readOnly: false });
        const stop = () => lease.release();
        targetSignal.addEventListener('abort', stop, { once: true });
        try {
          const target = await lease.prepareDraft();
          await target.flush();
          const copied = await copyStartImages({ source, target, binding, isCurrent: current });
          const copyBinding = { ...binding, targetRevision: target.getSnapshot().revision, targetLocalIds: copied.localIds };
          if (binding.targetRevision && binding.targetRevision !== copyBinding.targetRevision) throw new Error('The destination draft changed. Review it before continuing.');
          if (!bind(copyBinding)) throw new Error('The copied image identity could not be saved. Your originals were kept.');
          await sendPreparedStartImages({ draft, session: created, auth: authority, signal: targetSignal, environmentSignal: signal, current, binding: copyBinding, localIds: copied.localIds, bind });
          let expectedRevision = sourceBinding.sourceRevision;
          for (const id of sourceBinding.sourceLocalIds) {
            if (!current()) throw new Error('The image transfer scope changed.');
            const result = await source.removeImage(id, { expectedRevision });
            if (result?.committed !== true) throw new Error('The original draft cleanup could not be confirmed.');
            expectedRevision = result.snapshot.revision;
          }
          if (!current() || source.getSnapshot().text !== text || source.getSnapshot().revision !== expectedRevision
            || source.getSnapshot().localIds.length) throw new Error('The original draft changed. Review it before continuing.');
          source.setText('');
          await source.flush();
        } finally { targetSignal.removeEventListener('abort', stop); lease.release(); }
      }
      prepared = true;
    },
  });
  assertScope();
  if (!session?.id || !prepared) throw new Error('The conversation could not be prepared. Your draft was kept.');
  rememberProject(cwd, session);
  addSessionToDesktop(session.id, desktopId);
  return { opened: true, sessionId: session.id };
}

export async function startWorkspacePrompt(prompt, options, { customAiProviders, createStructuredSession, rememberProject, addSessionToDesktop, sendToSession }) {
  const text = typeof prompt === 'string' ? prompt.trim() : '';
  const cwd = options.path;
  if (!text || !cwd) throw new Error('Choose a project and enter a task first.');
  const signal = getEnvironmentSignal();
  const authority = captureAuthScope();
  const assertScope = () => {
    if (signal.aborted || !isAuthScopeCurrent(authority)) throw new Error('The environment or account changed. Check the original server before retrying.');
  };
  const launch = await resolveAgentSessionLaunch(options.agentId || 'codex', options.selection, customAiProviders);
  assertScope();
  if (launch.kind !== 'structured') throw new Error('Use New terminal for this agent. Select Codex or a supported conversation agent here.');
  const title = splitContext(text).text.trim().slice(0, 80) || undefined;
  const session = await createStructuredSession({ cwd, provider: launch.provider, model: launch.model, reasoning: launch.reasoning, serviceTier: launch.serviceTier, title });
  assertScope();
  if (!session?.id) throw new Error('The agent session could not be created.');
  rememberProject(cwd, session);
  addSessionToDesktop(session.id);
  const draft = getComposerDraftStore(session.id);
  draft.setText(text);
  const draftRevision = draft.getSnapshot().revision;
  try {
    const receipt = await sendToSession(session.id, text);
    assertScope();
    if (receipt?.accepted !== true) throw new Error('The agent did not accept this task. The prompt is saved in the conversation.');
    draft.clearIfUnchanged(draftRevision, text);
    return { accepted: true, sessionId: session.id };
  } catch (error) {
    const failure = new Error(error?.message || 'The task could not be started. The prompt is saved in the conversation.');
    failure.sessionId = session.id;
    throw failure;
  }
}
