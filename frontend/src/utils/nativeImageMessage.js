import { apiFetch } from './api';
import { cloneImageAttachments, projectImageInput, sameImageInput } from './userImageInput';
import { readUserImageAdmission } from './userImageComposerController';

function acceptedReceipt(receipt, requestId) {
  return receipt?.requestId === requestId && typeof receipt.turnId === 'string' && Boolean(receipt.turnId)
    && typeof receipt.messageId === 'string' && Boolean(receipt.messageId)
    && Number.isSafeInteger(receipt.acceptedSeq) && receipt.acceptedSeq > 0
    && ['accepted', 'running', 'completed', 'failed', 'cancelled', 'interrupted', 'cleanup_required', 'reconciliation_required'].includes(receipt.status);
}

// Caller owns the composer send lease and the abort/current scope. This is the
// same session-bound send and receipt protocol for mounted and start composers.
export async function runNativeImageMessage({ mode, text, attachments, sessionId, composerStore, auth, selection, signal, current,
  requiresCleanup = () => false, historyOnly = () => false, requestId, onAccepted = () => {}, onNotice = () => {} }) {
  let native = composerStore.getImageStore?.();
  let intent = null, postStarted = false, receiptRead = false;
  const matches = receipt => acceptedReceipt(receipt, intent?.requestId)
    && (intent.kind !== 'images-v1' || sameImageInput(receipt.input, { text: intent.text, attachments: intent.attachments }));
  const hardConfirmationError = problem => Object.assign(new Error(String(problem?.message || 'Saved message receipt identity could not be confirmed.').slice(0, 400)),
    { code: problem?.code || 'confirmation_failed', noReceiptRecovery: true });
  const sameCoreProof = (left, right) => matches(left) && matches(right)
    && ['requestId', 'turnId', 'messageId', 'acceptedSeq'].every(field => left[field] === right[field]);
  const accept = async receipt => {
    if (!current()) return { accepted: false, stale: true };
    if (!matches(receipt)) throw new Error('Saved message receipt or image manifest could not be confirmed.');
    let held;
    try { held = native.getPendingIntent(); } catch (problem) { throw hardConfirmationError(problem); }
    if (held && held.requestId !== intent.requestId || [intent.acceptedReceipt, held?.acceptedReceipt].some(proof => proof && !sameCoreProof(proof, receipt))) {
      throw hardConfirmationError({ code: 'receipt_mismatch', message: 'The receipt contradicts the previous send’s saved canonical identity.' });
    }
    let cleanupError = null;
    try { await composerStore.confirmIntent(intent.requestId, receipt); }
    catch (problem) {
      if (!current()) return { accepted: false, stale: true };
      if (!['quota', 'unavailable'].includes(problem?.code)) throw hardConfirmationError(problem);
      cleanupError = problem;
    }
    if (!current()) return { accepted: false, stale: true };
    onAccepted(intent, receipt);
    if (cleanupError) onNotice(String(cleanupError.message || 'The previous send was accepted, but local cleanup is pending.').slice(0, 400));
    return { accepted: true, ...receipt, draftManaged: true, ...(cleanupError ? { localCleanupPending: true } : {}) };
  };
  const admitImagePost = async () => {
    const admission = await readUserImageAdmission({ aiType: selection.aiType, model: selection.model,
      scope: [auth.userId, auth.home, 'home', sessionId], signal, isCurrent: current });
    if (!current()) return false;
    if (admission.state !== 'allowed') throw new Error(admission.reason || 'Image support is not confirmed for this model.');
    return true;
  };
  const validateIntent = value => {
    if (!value || !['images-v1', 'legacy-text-v1'].includes(value.kind) || typeof value.serializedBody !== 'string') throw new Error('The saved request body is unavailable.');
    const body = JSON.parse(value.serializedBody);
    if (value.kind === 'images-v1') {
      cloneImageAttachments(value.attachments);
      if (Object.keys(body).sort().join(',') !== 'attachments,requestId,text' || body.requestId !== value.requestId
        || !sameImageInput({ text: body.text, attachments: body.attachments }, { text: value.text, attachments: value.attachments })) throw new Error('The saved image body could not be confirmed.');
    } else if (Object.keys(body).sort().join(',') !== 'fallbackToMessage,requestId,text' || body.requestId !== value.requestId
      || body.text !== `${value.text}\n` || body.fallbackToMessage !== true) throw new Error('The saved text body could not be confirmed.');
    if (requestId && value.requestId !== requestId) throw new Error('The saved message request does not match this start.');
    return value;
  };
  try {
    if (native && mode !== 'send' && composerStore.getSnapshot().imageRecovery) {
      native = composerStore.observeImages({ scope: [auth.userId, auth.home, 'home', sessionId], signal, isCurrent: current });
      await native.hydrate(); if (!current()) return { accepted: false, stale: true };
    }
    if (!native) {
      if (mode === 'send') throw new Error('Images must be saved on this device before sending. Add them to this conversation first. Your draft was kept.');
      const legacy = composerStore.getSnapshot().pending;
      if (!legacy || !Object.prototype.hasOwnProperty.call(legacy, 'attachments')) throw new Error('There is no previous saved image send to check.');
      native = composerStore.observeImages({ scope: [auth.userId, auth.home, 'home', sessionId], signal, isCurrent: current });
      await native.hydrate(); if (!current()) return { accepted: false, stale: true };
    }
    const expectedScope = JSON.stringify([auth.userId, auth.home, 'home', sessionId]);
    if (native.getSnapshot().scopeKey !== expectedScope) throw new Error('The saved image draft belongs to another scope.');
    if (mode !== 'send' && native.getSnapshot().storageState !== 'ready') await native.promoteLegacy();
    if (!current()) return { accepted: false, stale: true };
    const source = native.getSnapshot();
    if (source.storageState !== 'ready') throw new Error('Load and save the image draft before sending.');
    if (mode === 'send') {
      if (requiresCleanup()) throw new Error('Cleanup is not confirmed. Retry cancellation before sending.');
      if (source.pending) throw new Error('A previous send is unresolved. Check or retry its original request before sending another message.');
      if (typeof text !== 'string' || text !== source.text) throw new Error('The image draft changed before Send. Review the current draft.');
      const refs = attachments === undefined || Array.isArray(attachments) && attachments.length === 0 ? null : cloneImageAttachments(attachments);
      if (!refs && source.localIds.length) throw new Error('Ready image references are required for the selected images.');
      const projected = refs ? projectImageInput(text, refs) : { text: text.trim() };
      const captured = { draftRevision: source.revision, localIds: [...source.localIds] };
      if (refs && !await admitImagePost()) return { accepted: false, stale: true };
      const committed = await composerStore.prepareIntent(projected.text, refs || undefined, captured, requestId);
      if (!current()) return { accepted: false, stale: true };
      intent = validateIntent(committed);
      if (intent.kind === 'images-v1' ? !refs || !sameImageInput({ text: intent.text, attachments: intent.attachments }, projected) : refs || intent.text !== projected.text) throw new Error('The committed request does not match the submitted draft.');
    } else intent = validateIntent(native.getPendingIntent());
    if (!current()) return { accepted: false, stale: true };
    if (mode === 'check' && intent.acceptedReceipt && matches(intent.acceptedReceipt)) return await accept(intent.acceptedReceipt);
    if (mode !== 'send' || intent.reused) {
      receiptRead = true;
      const response = await apiFetch(`/api/structured/sessions/${encodeURIComponent(sessionId)}/requests/${intent.requestId}`, { signal });
      if (!current()) return { accepted: false, stale: true };
      if (response.ok) { const receipt = await response.json(); if (!current()) return { accepted: false, stale: true }; return await accept(receipt); }
      if (response.status !== 404) throw new Error('The previous send could not be checked. Its original identity was kept.');
      if (mode === 'check') { onNotice('No accepted receipt was found. The original send is still held; 404 does not confirm cancellation.'); return { accepted: false, unknown: true, draftManaged: true }; }
      receiptRead = false;
      if (requiresCleanup()) throw new Error('Cleanup is not confirmed. Retry cancellation before sending.');
      if (intent.kind === 'images-v1') {
        if (!await admitImagePost()) return { accepted: false, stale: true };
        for (let index = 0; index < intent.submittedLocalIds.length; index += 1) {
          const blob = await native.getBlob(intent.submittedLocalIds[index]); if (!current()) return { accepted: false, stale: true };
          const ref = intent.attachments[index];
          if (!blob || blob.localId !== intent.submittedLocalIds[index] || blob.uploadId !== ref.attachmentId || blob.artifactId !== ref.artifactId
            || blob.mimeType !== ref.mimeType || blob.bytes !== ref.bytes || blob.name !== ref.name) throw new Error('Original image bytes could not be confirmed. The frozen request was kept.');
        }
      }
    }
    if (!current()) return { accepted: false, stale: true };
    if (intent.kind === 'images-v1' && !await admitImagePost()) return { accepted: false, stale: true };
    if (!current()) return { accepted: false, stale: true };
    if (historyOnly()) return { accepted: false, historyOnly: true };
    postStarted = true;
    const response = await apiFetch(`/api/structured/sessions/${encodeURIComponent(sessionId)}/${intent.kind === 'images-v1' ? 'attachments/send' : 'input'}`, {
      method: 'POST', body: intent.serializedBody, headers: { 'Content-Type': 'application/json' }, signal,
    });
    if (!current()) return { accepted: false, stale: true };
    if (!response.ok) {
      const payload = await response.json().catch(() => null); if (!current()) return { accepted: false, stale: true };
      const problem = new Error(payload?.error || `Message was not accepted (${response.status}).`); problem.rejected = response.status < 500; throw problem;
    }
    const receipt = await response.json(); if (!current()) return { accepted: false, stale: true }; return await accept(receipt);
  } catch (problem) {
    if (!current()) return { accepted: false, stale: true };
    if (postStarted && intent && !problem.rejected && !problem.noReceiptRecovery && !receiptRead) {
      try {
        const response = await apiFetch(`/api/structured/sessions/${encodeURIComponent(sessionId)}/requests/${intent.requestId}`, { signal });
        if (!current()) return { accepted: false, stale: true };
        const receipt = response.ok ? await response.json() : null;
        if (!current()) return { accepted: false, stale: true };
        if (matches(receipt)) return await accept(receipt);
      } catch { /* Explicit recovery retains the same original identity. */ }
    }
    if (!current()) return { accepted: false, stale: true };
    throw new Error(String(problem.message || 'The previous send could not be confirmed. Its original request was kept.').slice(0, 400));
  }
}
