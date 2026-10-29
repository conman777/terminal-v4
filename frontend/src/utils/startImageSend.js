import { retainUserImageComposer } from './userImageComposerController';
import { cloneImageAttachments } from './userImageInput';
import { startImageMessageRequestId } from './startImageTransfer';
import { runNativeImageMessage } from './nativeImageMessage';

function waitForImageDraft(lease, current, signal) {
  return new Promise((resolve, reject) => {
    let timer, unsubscribe;
    const finish = (error, value) => {
      clearTimeout(timer); unsubscribe?.(); signal.removeEventListener('abort', aborted);
      if (error) reject(error); else resolve(value);
    };
    const aborted = () => finish(new Error('The image start was interrupted. The saved request was kept.'));
    const check = () => {
      if (!current() || signal.aborted) return aborted();
      const state = lease.getSnapshot();
      if (state.admission?.state === 'blocked') return finish(new Error(state.admission.reason || 'Image support is unavailable.'));
      if (['closed', 'unavailable', 'conflict'].includes(state.storage?.storageState)) return finish(new Error(state.error || 'The saved image draft needs review.'));
      if (state.admission?.state === 'allowed' && state.storage?.storageState === 'ready' && !state.storage.isHydrating && !state.storage.isSaving) finish(null, state.storage);
    };
    unsubscribe = lease.subscribe(check); signal.addEventListener('abort', aborted, { once: true });
    timer = setTimeout(() => finish(new Error('Image preparation timed out. The saved request was kept.')), 15000);
    check();
  });
}

// Runs only for the explicit start action. A held send is never automatically
// retried after a remount; its frozen request stays in the conversation draft.
export async function sendPreparedStartImages({ draft, session, auth, signal, environmentSignal, current, binding, localIds, bind }) {
  if (!current() || signal.aborted || session.runtime !== 'v4' || !session.id || !session.aiType || !session.model) throw new Error('The image start scope changed.');
  const scope = [auth.userId, auth.home, 'home', session.id];
  const lease = retainUserImageComposer({ scope, store: draft, session, signal: environmentSignal, isCurrent: current, readOnly: false });
  const abort = () => lease.release();
  signal.addEventListener('abort', abort, { once: true });
  try {
    let snapshot = await waitForImageDraft(lease, current, signal);
    const sameDraft = value => current() && value?.text === binding.text && value?.revision === binding.targetRevision && !value.pending
      && JSON.stringify(value.localIds) === JSON.stringify(localIds);
    if (!sameDraft(snapshot)) throw new Error('The destination draft changed. Review the conversation before starting.');
    for (const id of localIds) {
      snapshot = lease.getSnapshot().storage;
      if (!sameDraft(snapshot)) throw new Error('The destination draft changed. Review the conversation before starting.');
      const item = snapshot.items.find(value => value.localId === id);
      if (!item) throw new Error('A saved image is unavailable. Review the conversation.');
      if (item.uploadState !== 'ready' || item.expiresAt <= Date.now()) await lease.retryUpload(id);
    }
    if (!current()) throw new Error('The image start scope changed.');
    snapshot = lease.getSnapshot().storage;
    if (!sameDraft(snapshot)) throw new Error('The destination draft changed. Review the conversation before starting.');
    const attachments = cloneImageAttachments(localIds.map(id => {
      const item = snapshot.items.find(value => value.localId === id);
      return item?.uploadState === 'ready' && item.expiresAt > Date.now() ? item.descriptor : null;
    }));
    const messageRequestId = await startImageMessageRequestId(binding.requestId);
    if (!current() || !bind({ ...binding, messageRequestId, targetLocalIds: [...localIds], attachments })) {
      throw new Error('The image message identity could not be saved. Your draft was kept.');
    }
    const claim = draft.claimSend();
    if (!claim) throw new Error('A message is already being sent. Review the conversation.');
    try {
      const result = await runNativeImageMessage({ mode: 'send', text: binding.text, attachments, sessionId: session.id,
        composerStore: draft, auth, selection: { aiType: session.aiType, model: session.model }, signal, current,
        requiresCleanup: () => ['cleanup_required', 'reconciliation_required', 'running', 'accepted'].includes(session.status),
        requestId: messageRequestId });
      if (result?.accepted !== true || result.localCleanupPending) throw new Error('The message outcome or local cleanup needs review in the conversation.');
      return result;
    } finally { draft.releaseSend(claim); }
  } finally { signal.removeEventListener('abort', abort); lease.release(); }
}
