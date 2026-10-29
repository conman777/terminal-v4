import { apiFetch } from './api';
import { captureAuthScope, isAuthScopeCurrent, subscribeAuth } from './auth';
import { getActiveEnvironment, getEnvironmentSignal } from './remoteEnvironments';
import { cloneImageAttachments } from './userImageInput';

const entries = new Map(), catalogCache = new Map();
const TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
let generation = 0;
const message = error => String(error?.message || error || 'Image operation could not be confirmed.').slice(0, 400);
const failure = (text, code = 'not_ready') => Object.assign(new Error(text), { code });
const modelKey = session => JSON.stringify([session?.runtime, session?.aiType, session?.model]);
const owns = (value, key) => Object.prototype.hasOwnProperty.call(value, key);

// Resolved metadata only: consumers never share an in-flight request whose first
// AbortSignal could cancel another view. Scope and liveness are checked even on
// cache hits; metadata never grants authority to a different account or host.
async function readOwnedCatalog({ scope, signal, isCurrent }) {
  const auth = captureAuthScope(), environment = getEnvironmentSignal();
  const guard = () => {
    if (signal?.aborted || environment.aborted || getEnvironmentSignal() !== environment || !isCurrent()
      || !isAuthScopeCurrent(auth) || !auth.userId || auth.userId !== scope?.[0] || auth.home !== scope?.[1]
      || scope?.[2] !== 'home' || getActiveEnvironment()) throw failure('The image model scope changed.', 'stale_scope');
  };
  guard();
  const cacheKey = JSON.stringify([auth.generation, ...scope.slice(0, 3)]);
  if (catalogCache.has(cacheKey)) return catalogCache.get(cacheKey);
  const response = await apiFetch('/api/agent/catalog', { signal }); guard();
  if (!response.ok) throw failure('Image support could not be checked for this model.');
  const payload = await response.json(); guard();
  if (!Array.isArray(payload?.agents)) throw failure('Image model metadata is unavailable.');
  catalogCache.set(cacheKey, payload);
  while (catalogCache.size > 16) catalogCache.delete(catalogCache.keys().next().value);
  return payload;
}
function modelAdmission(catalog, aiType, modelId) {
  const provider = catalog?.agents?.find(agent => agent.id === aiType);
  const model = provider?.models?.find(value => value.id === modelId);
  return typeof aiType === 'string' && aiType.length > 0 && typeof modelId === 'string' && modelId.length > 0 && model?.imageInput === true
    ? { state: 'allowed', reason: '' } : { state: 'blocked', reason: 'Image support is not confirmed for this model.' };
}
export async function readUserImageAdmission({ aiType, model, ...context }) {
  if (typeof aiType !== 'string' || !aiType || typeof model !== 'string' || !model) throw failure('Canonical provider and model metadata are required for image sending.');
  const catalog = await readOwnedCatalog(context);
  if (!context.isCurrent() || context.signal?.aborted) throw failure('The image model selection changed.', 'stale_scope');
  return modelAdmission(catalog, aiType, model);
}

function createEntry(options, key) {
  const auth = captureAuthScope(), lifetime = new AbortController(), views = new Set(), listeners = new Set(), jobs = new Map();
  let session = options.session, signature = modelKey(session), epoch = 0, closed = false, native = null, nativeUnsubscribe = null;
  let nativeEpoch = null, preparation = null, catalog = null, catalogStarted = false, adding = false, retainedFiles = null, retainedLocalIds = [], error = '', admission = { state: 'checking', reason: 'Checking image support…' }, snapshot;
  let observedRecoveryKey, recoveryRevision = 0, recovery = null, restoring = null;
  const signal = AbortSignal.any([options.signal, lifetime.signal]);
  const current = () => !closed && !signal.aborted && isAuthScopeCurrent(auth)
    && auth.userId === options.scope[0] && auth.home === options.scope[1]
    && getEnvironmentSignal() === options.signal
    && (getActiveEnvironment() ? `paired:${getActiveEnvironment().id}` : 'home') === options.scope[2]
    && [...views].some(view => !view.released && view.options.isCurrent());
  const publish = () => {
    const storage = native?.getSnapshot() || null;
    observeRecovery(storage);
    snapshot = { scopeKey: key, generation: entry.generation, storage, admission, isAdding: adding, uploadingIds: [...jobs.keys()], error,
      recovery: recovery ? { requestId: recovery.requestId, revision: recovery.revision, state: recovery.state,
        canChoose: recoveryReady(storage) && recovery.pins.length > 0,
        canSave: recoveryReady(storage) && recovery.pins.length > 0 && recovery.choices.every(Boolean), error: recovery.error,
        slots: recovery.pins.map((pin, slot) => ({ slot, name: pin.attachment.name, mimeType: pin.attachment.mimeType, bytes: pin.attachment.bytes, selected: Boolean(recovery.choices[slot]) })) } : null };
    for (const listener of listeners) listener();
  };
  const entry = { generation: ++generation };
  const writable = view => !view.released && !view.options.readOnly && view.options.isCurrent() && modelKey(view.options.session) === signature;
  function recoveryReady(storage) {
    return current() && [...views].some(writable) && storage?.storageState === 'ready'
      && !preparation && !nativeEpoch?.preparationFailed && !restoring;
  }
  function guard(view, requireAdmission = false) {
    if (!current() || view && (view.released || view.options.readOnly || !view.options.isCurrent() || modelKey(view.options.session) !== signature)) throw failure('The image draft scope changed.', 'stale_scope');
    if (getActiveEnvironment() || session?.runtime !== 'v4') throw failure('Images require an owned V4 conversation on the home server.');
    if (requireAdmission && admission.state !== 'allowed') throw failure(admission.reason || 'Image support is not confirmed for this model.');
  }
  // Native owns validation and bytes. This fingerprint observes its validated
  // metadata synchronously, including intermediate A→B→A publications which a
  // React render may coalesce. Current draft/head revisions are deliberately
  // separate from the immutable previous request's source revision.
  function recoveryIdentity(storage) {
    const pending = storage?.pending;
    if (storage?.scopeKey !== key || !storage.authorityId || pending?.kind !== 'images-v1'
      || !Array.isArray(pending.missingBytePins)) return { key: null, core: null, pending: null };
    const descriptor = value => [value.attachmentId, value.artifactId, value.mimeType, value.bytes, value.name];
    const receipt = pending.acceptedReceipt;
    const core = JSON.stringify([storage.scopeKey, storage.authorityId, pending.kind, pending.requestId, pending.text,
      pending.serializedBody, pending.serializedBodySha256, pending.draftRevision, pending.submittedLocalIds,
      [pending.rawSourceEvidence?.kind, pending.rawSourceEvidence?.revision, pending.rawSourceEvidence?.localIds],
      pending.attachments.map(descriptor), receipt ? [receipt.status, receipt.requestId, receipt.turnId, receipt.messageId,
        receipt.acceptedSeq, receipt.input?.text, receipt.input?.attachments?.map(descriptor)] : null]);
    return { core, pending, key: JSON.stringify([core, pending.missingBytePins.map(pin => [pin.localId, descriptor(pin.attachment)])]) };
  }
  function observeRecovery(storage) {
    const next = recoveryIdentity(storage);
    if (next.key === observedRecoveryKey) return;
    const ownClear = restoring && !restoring.invalidated && !restoring.ownClear && restoring.started
      && observedRecoveryKey === restoring.key && next.core === restoring.core && next.pending?.missingBytePins.length === 0;
    if (restoring) {
      if (ownClear) restoring.ownClear = next.key;
      else restoring.invalidated = true;
    }
    observedRecoveryKey = next.key; recoveryRevision += 1;
    recovery = next.pending?.missingBytePins.length || ownClear ? {
      requestId: next.pending.requestId, revision: recoveryRevision, pins: next.pending.missingBytePins,
      choices: next.pending.missingBytePins.map(() => null), state: ownClear ? 'saving' : 'missing', error: '',
    } : null;
  }
  function recoveryGuard(view, request) {
    guard(view); publish();
    if (!recoveryReady(native?.getSnapshot())) throw failure('Finish preparing the saved image request on this device before choosing or saving its originals.');
    if (!request || !Number.isSafeInteger(request.originalsRevision) || !recovery || !recovery.pins.length
      || request.requestId !== recovery.requestId || request.originalsRevision !== recovery.revision) throw failure('The previous image request changed. Choose its current originals again.', 'stale_scope');
    if (restoring) throw failure('The original images are still being saved.');
    return recovery;
  }
  async function selectOriginalImage(view, file, request) {
    const target = recoveryGuard(view, request), slot = request.slot;
    if (!Number.isSafeInteger(slot) || slot < 0 || slot >= target.pins.length || !(file instanceof Blob)) throw failure('Choose one original image for this row.', 'invalid_input');
    const attachment = target.pins[slot].attachment;
    if (file.name !== attachment.name || file.type !== attachment.mimeType || file.size !== attachment.bytes) throw failure('Choose the original file with the displayed name, type and byte count. Its bytes will be checked when saved.', 'invalid_input');
    target.choices[slot] = file; target.state = 'missing'; target.error = ''; publish();
    return { selected: true };
  }
  async function saveOriginalImages(view, request) {
    const target = recoveryGuard(view, request);
    if (!target.choices.every(Boolean)) throw failure('Choose one original image for every missing row.', 'invalid_input');
    const identity = recoveryIdentity(native.getSnapshot());
    const operation = { key: identity.key, core: identity.core, invalidated: false, ownClear: null, started: false,
      files: Object.freeze([...target.choices]) };
    restoring = operation; target.state = 'saving'; target.error = ''; publish();
    try {
      guard(view); operation.started = true;
      const commit = await native.restorePendingBytes({ requestId: request.requestId, files: operation.files });
      guard(view); publish();
      const result = recoveryIdentity(commit?.snapshot), actual = recoveryIdentity(native.getSnapshot());
      if (operation.invalidated || commit?.committed !== true || !operation.ownClear || result.key !== operation.ownClear
        || actual.key !== operation.ownClear || result.core !== operation.core || result.pending?.missingBytePins.length !== 0) {
        throw failure('The original image save could not be confirmed for this request. Its identity was kept.', 'stale_scope');
      }
      recovery.state = 'restored'; recovery.error = ''; publish();
      return commit;
    } catch (problem) {
      if (current() && !operation.invalidated && observedRecoveryKey === operation.key && recovery === target) {
        target.state = 'error'; target.error = message(problem);
      } else if (current() && !operation.invalidated && operation.ownClear && observedRecoveryKey === operation.ownClear) {
        recovery = null;
      }
      throw problem;
    } finally {
      if (restoring === operation) restoring = null;
      if (current()) publish();
    }
  }
  function updateAdmission() {
    if (getActiveEnvironment() || session?.runtime !== 'v4') admission = { state: 'blocked', reason: 'Images require an owned V4 conversation on the home server.' };
    else if (!catalog) admission = { state: catalogStarted ? 'checking' : 'blocked', reason: error || 'Checking image support…' };
    else {
      admission = modelAdmission(catalog, session.aiType, session.model);
    }
    publish();
  }
  async function loadCatalog() {
    if (catalogStarted || closed || getActiveEnvironment()) return;
    catalogStarted = true;
    try {
      catalog = await readOwnedCatalog({ scope: options.scope, signal, isCurrent: current });
    } catch (problem) { if (current()) { error = message(problem); catalogStarted = false; } }
    if (current()) updateAdmission();
  }
  function getNative() {
    guard();
    if (!nativeEpoch) {
      const prior = options.store.getImageStore?.(), priorClosed = prior?.getSnapshot().storageState === 'closed';
      const value = { controller: new AbortController(), owner: null, invalidated: false, retired: false, hydration: null,
        attempted: false, preparationFailed: false, native: null, owned: false };
      nativeEpoch = value;
      const context = { scope: options.scope, signal: AbortSignal.any([signal, value.controller.signal]), isCurrent: () => {
        if (value.retired || value.invalidated || !current()) return false;
        // A render-time liveness check can revoke this epoch before committed
        // layout cleanup aborts it. The latch cannot be revived by an ABA view.
        if (value.owner && !writable(value.owner)) { value.invalidated = true; return false; }
        return true;
      } };
      try { native = options.store.observeImages(context); }
      catch (problem) { nativeEpoch = null; value.retired = true; value.controller.abort(); throw problem; }
      value.native = native;
      // The facade can reuse somebody else's readable native context. Such a
      // context is not this controller's mutation fence; only prepare after a
      // safe close/rebind below. Existing ready authority stays in place.
      value.owned = !prior || priorClosed || native !== prior;
      nativeUnsubscribe = native.subscribe(publish); publish();
    }
    return native;
  }
  async function load(promote = false, view) {
    const awaited = promote ? preparation : null;
    if (awaited) {
      const outcome = await awaited.promise;
      guard(view);
      // A shared upload may survive its initiating view, but a readonly reader
      // cannot authorize fresh mutation after a queued preparation settles.
      if (!view && ![...views].some(writable)) throw failure('The image draft scope changed.', 'stale_scope');
      if (!outcome?.prepared) throw outcome?.error || failure('The saved image request could not be prepared.');
      if (awaited.epoch !== nativeEpoch || awaited.epoch.native !== native || awaited.epoch.retired || awaited.epoch.invalidated
        || native.getSnapshot().storageState !== 'ready') throw failure('The prepared image draft changed.', 'stale_scope');
    }
    const value = getNative(), captured = nativeEpoch;
    if (!captured.hydration) captured.hydration = value.hydrate().catch(problem => { captured.hydration = null; throw problem; });
    await captured.hydration; guard(view);
    if (captured !== nativeEpoch || captured.retired || captured.invalidated) throw failure('The image draft scope changed.', 'stale_scope');
    if (promote && value.getSnapshot().storageState !== 'ready') await value.promoteLegacy();
    guard(view); publish(); return value;
  }
  function retireNative(value) {
    if (!value || value.retired) return;
    value.invalidated = true; value.retired = true;
    if (nativeEpoch === value) { nativeUnsubscribe?.(); nativeUnsubscribe = null; nativeEpoch = null; }
    // Both mechanisms are synchronous existing native ports: signal aborts
    // tracked transactions; close permanently retires the old native queue.
    value.controller.abort(); value.native?.close();
  }
  function readRecovery(view) {
    void load().then(value => prepareRecovery(view, value)).catch(problem => {
      if (current() && (!view || !view.released && view.options.isCurrent()) && problem.code !== 'stale_scope') {
        error = message(problem); publish();
      }
    });
  }
  function preparationBusy(storage) {
    return options.store.getSnapshot().isSending || storage.isSaving || adding || jobs.size > 0 || restoring;
  }
  function prepareRecovery(view, value = native) {
    const captured = nativeEpoch, storage = value?.getSnapshot(), pending = storage?.pending;
    if (preparation || !current() || !view || !writable(view) || !captured || captured.native !== value
      || captured.attempted || captured.retired || captured.invalidated || preparationBusy(storage)
      || !['legacy', 'copy_committed'].includes(storage.storageState)
      || !recoveryIdentity(storage).pending || !pending.missingBytePins.length) return;
    if (!captured.owned) {
      // Never take over a live write/send or an already-ready native. The busy
      // check above preserves its pending request and newer raw draft. A later
      // writable lease/reopen can try admission when that work has settled.
      retireNative(captured); readRecovery(view); return;
    }
    const attempt = { owner: view, epoch: captured, invalidated: false, promise: null };
    preparation = attempt; captured.owner = view; captured.attempted = true; error = '';
    attempt.promise = (async () => {
      try {
        guard(view);
        await value.promoteLegacy();
        guard(view);
        if (attempt.invalidated || captured.invalidated || captured.retired || captured !== nativeEpoch
          || value.getSnapshot().storageState !== 'ready') throw failure('The saved image request could not be prepared for this view.', 'stale_scope');
        return { prepared: true };
      } catch (problem) {
        if (attempt.invalidated || captured.invalidated || captured.retired || !writable(view) || !current()) {
          attempt.invalidated = true; retireNative(captured);
        } else if (captured === nativeEpoch) { captured.preparationFailed = true; error = message(problem); }
        // Background admission stays observed/non-rejecting. Waiting actions
        // must inspect this exact attempt's typed outcome instead of treating
        // settlement as permission to reacquire a different native context.
        return { prepared: false, error: problem };
      } finally {
        // Keep the old promise as the admission barrier even after abort/close:
        // a compatible returning view cannot overlap or revive its old work.
        if (preparation === attempt) preparation = null;
        if (!captured.retired && !captured.invalidated) captured.owner = null;
        if (current()) {
          publish();
          if (attempt.invalidated) {
            const writer = [...views].find(writable);
            readRecovery(writer);
          }
        }
      }
    })();
    publish();
  }
  function retirePreparation(view) {
    if (!preparation || preparation.owner !== view) return;
    preparation.invalidated = true; retireNative(preparation.epoch);
    // Readonly siblings receive a fresh readable native context. It cannot
    // prepare while the retained old promise still occupies admission.
    if (current()) readRecovery();
  }
  function operationCurrent(operation, localId) {
    return current() && operation.epoch === epoch && operation.signature === signature
      && (!localId || native?.getSnapshot().localIds.includes(localId));
  }
  async function upload(localId) {
    if (jobs.has(localId)) return jobs.get(localId).promise;
    guard(null, true);
    const operation = { epoch, signature, controller: new AbortController(), promise: null };
    operation.promise = (async () => {
      let ticket;
      try {
        const value = await load(true); if (!operationCurrent(operation, localId)) throw failure('The image draft changed.', 'stale_scope');
        ticket = await value.beginUpload(localId);
        if (!operationCurrent(operation, localId)) throw failure('The image draft changed.', 'stale_scope');
        guard(null, true);
        const body = new FormData(); body.append('uploadId', ticket.uploadId); body.append('image', ticket.blob, ticket.name);
        const response = await apiFetch(`/api/structured/sessions/${encodeURIComponent(session.id)}/attachments`, {
          method: 'POST', body, signal: AbortSignal.any([signal, operation.controller.signal]),
        });
        if (!operationCurrent(operation, localId)) throw failure('The image draft changed.', 'stale_scope');
        const ready = await response.json();
        if (!operationCurrent(operation, localId)) throw failure('The image draft changed.', 'stale_scope');
        const fields = ready && Object.keys(ready).sort().join(',');
        if (![200, 201].includes(response.status) || !response.ok || fields !== 'attachment,expiresAt,status' || ready.status !== 'ready'
          || !Number.isSafeInteger(ready.expiresAt) || ready.expiresAt <= Date.now()) throw failure('The upload receipt is invalid or expired.');
        const [attachment] = cloneImageAttachments([ready.attachment]);
        if (attachment.attachmentId !== ticket.uploadId || attachment.artifactId !== ticket.artifactId || attachment.mimeType !== ticket.mimeType
          || attachment.bytes !== ticket.bytes || attachment.name !== ticket.name) throw failure('The uploaded image did not match the saved image.');
        guard(null, true);
        const applied = await value.completeUpload(ticket, ready);
        if (!operationCurrent(operation, localId)) throw failure('The image draft changed.', 'stale_scope');
        if (!applied.applied) throw failure('The upload result is no longer current.');
        return applied;
      } catch (problem) {
        if (operationCurrent(operation, localId)) {
          error = message(problem);
          if (ticket) { try { await native.failUpload(ticket, { code: 'upload_unconfirmed', message: error }); } catch (storageError) { error = message(storageError); } }
          publish();
        }
        throw problem;
      } finally { if (jobs.get(localId) === operation) { jobs.delete(localId); if (current()) publish(); } }
    })();
    jobs.set(localId, operation); return operation.promise;
  }
  async function addFiles(view, supplied) {
    guard(view, true);
    const files = Array.from(supplied || []);
    if (!files.length || files.length > 8 || files.some(file => !(file instanceof Blob) || !TYPES.has(file.type) || file.size < 1 || file.size > 8388608)
      || files.reduce((sum, file) => sum + file.size, 0) > 16777216) throw failure('Choose up to eight supported images, at most 8 MiB each and 16 MiB combined.');
    if (adding) throw failure('An image batch is still being saved.');
    if (retainedFiles?.length && retainedLocalIds.length && (files.length !== retainedFiles.length
      || files.some((file, index) => file !== retainedFiles[index]))) throw failure('Retry or remove the original unsaved image batch before choosing another batch.');
    adding = true; retainedFiles = files; retainedLocalIds = []; error = ''; publish();
    try {
      const operation = { epoch, signature }, value = await load(true, view);
      if (!operationCurrent(operation)) throw failure('The image draft changed.', 'stale_scope');
      guard(null, true); await value.flush();
      const before = new Set(value.getSnapshot().localIds);
      const commit = await value.addFiles(files, { expectedRevision: value.getSnapshot().revision });
      if (!operationCurrent(operation)) throw failure('The image draft changed.', 'stale_scope');
      if (commit.committed !== true) throw failure('The image batch was not saved.');
      retainedFiles = null; retainedLocalIds = [];
      for (const id of commit.snapshot.localIds.filter(id => !before.has(id))) await upload(id);
      return commit;
    } catch (problem) {
      if (current()) {
        const saved = native?.getSnapshot();
        const failed = saved?.items.filter(item => item.durability === 'missing' && !saved.localIds.includes(item.localId)) || [];
        // The native producer publishes failed sources in the supplied batch's
        // order. Retain exact File identities, not reconstructed filenames.
        if (failed.length === files.length && failed.every((item, i) => item.name === (typeof files[i].name === 'string' ? files[i].name : 'image.png')
          && item.mimeType === files[i].type && item.bytes === files[i].size)) {
          retainedFiles = files; retainedLocalIds = failed.map(item => item.localId);
        } else { retainedFiles = null; retainedLocalIds = []; }
        error = message(problem); publish();
      }
      throw problem;
    }
    finally { adding = false; if (current()) publish(); }
  }
  async function remove(view, localId) {
    guard(view); error = '';
    try {
      const value = await load(true, view); guard(view);
      let job = value.getSnapshot().removals.find(item => item.localId === localId), commit;
      if (!job) {
        commit = await value.removeImage(localId, { expectedRevision: value.getSnapshot().revision });
        guard();
        if (commit.committed === false && commit.reason === 'local_only') {
          const index = retainedLocalIds.indexOf(localId);
          if (index >= 0) { retainedLocalIds = retainedLocalIds.filter((_, i) => i !== index); retainedFiles = retainedFiles.filter((_, i) => i !== index); }
          return commit;
        }
        if (commit.committed !== true) throw failure('Image removal was not saved.');
        job = value.getSnapshot().removals.find(item => item.localId === localId);
      }
      if (!job) return commit;
      jobs.get(localId)?.controller.abort();
      const response = await apiFetch(`/api/structured/sessions/${encodeURIComponent(session.id)}/attachments/${job.uploadId}`, { method: 'DELETE', signal });
      guard();
      if (!response.ok || response.status !== 204) throw failure('Image removal could not be confirmed. Retry removal.');
      return await value.completeRemoval({ uploadId: job.uploadId, uploadGeneration: job.uploadGeneration });
    } catch (problem) { if (current()) { error = message(problem); publish(); } throw problem; }
  }
  const unsubscribeAuth = subscribeAuth(() => { if (!isAuthScopeCurrent(auth)) { lifetime.abort(); for (const job of jobs.values()) job.controller.abort(); publish(); } });
  Object.assign(entry, {
    retain(viewOptions) {
      if (modelKey(viewOptions.session) !== signature) {
        signature = modelKey(viewOptions.session); session = viewOptions.session; epoch += 1; entry.generation = ++generation;
        for (const job of jobs.values()) job.controller.abort(); updateAdmission();
      }
      const view = { options: viewOptions, released: false }; views.add(view);
      updateAdmission(); void loadCatalog();
      options.store.refresh?.();
      const stored = options.store.getSnapshot();
      if (options.store.getImageStore?.() || stored.imageRecovery || stored.pending && owns(stored.pending, 'attachments')) {
        readRecovery(view);
      }
      let priorSnapshot, heldSnapshot;
      return { getSnapshot: () => {
          if (!view.released && view.options.isCurrent() && modelKey(view.options.session) === signature) return snapshot;
          if (priorSnapshot !== snapshot) { priorSnapshot = snapshot; heldSnapshot = { ...snapshot, admission: { state: 'blocked', reason: 'The image draft scope changed.' } }; }
          return heldSnapshot;
        }, subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
        addFiles: files => addFiles(view, files), removeImage: localId => remove(view, localId),
        prepareDraft: () => { guard(view); return load(true, view); },
        selectOriginalImage: (file, request) => selectOriginalImage(view, file, request),
        saveOriginalImages: request => saveOriginalImages(view, request),
        retryUpload: localId => { try { guard(view, true);
          if (!native?.getSnapshot().localIds.includes(localId)) {
            if (retainedFiles?.length && retainedLocalIds.includes(localId)) return addFiles(view, retainedFiles);
            throw failure('The original unsaved image source is unavailable. Choose it again before uploading.', 'missing_bytes');
          }
          return upload(localId); } catch (problem) { return Promise.reject(problem); } },
        release() {
          if (view.released) return; view.released = true; views.delete(view);
          retirePreparation(view);
          if (views.size) return;
          if (restoring) restoring.invalidated = true;
          recovery = null;
          closed = true; epoch += 1; lifetime.abort(); for (const job of jobs.values()) job.controller.abort();
          nativeUnsubscribe?.(); unsubscribeAuth(); if (nativeEpoch) retireNative(nativeEpoch);
          else if (native?.getSnapshot().storageState !== 'closed') native?.close();
          listeners.clear(); if (entries.get(key) === entry) entries.delete(key);
        } };
    },
  });
  publish(); return entry;
}

export function retainUserImageComposer(options) {
  const key = JSON.stringify(options.scope);
  let entry = entries.get(key);
  if (!entry) { entry = createEntry(options, key); entries.set(key, entry); }
  return entry.retain(options);
}
