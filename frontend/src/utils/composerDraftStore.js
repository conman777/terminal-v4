import { createUuid } from './createUuid';
import { getEnvironmentSignal, getEnvironmentStorage } from './remoteEnvironments';
import { resolveHomeApiUrl } from './apiBase';
import { cloneImageAttachments, sameImageInput } from './userImageInput';
import { createUserImageDraftStore } from './userImageDraftStore';

const stores = new WeakMap();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_RECORD_BYTES = 1_000_000;
const SAVE_ERROR = 'This draft could not be saved on this device. Your text was kept. Free local storage and retry before sending.';
const CHANGED_ERROR = 'A newer saved draft or request was found. Your local text was kept. Review the pending request before retrying.';
const emptySnapshot = Object.freeze({ text: '', revision: '', pending: null, isSending: false, error: '' });
const emptyStore = { getSnapshot: () => emptySnapshot, subscribe: () => () => {}, setText: () => {}, clearIfUnchanged: () => {} };

function createStore(sessionId, home, signal) {
  const storage = getEnvironmentStorage();
  const key = `composerDraft:v1:${encodeURIComponent(home)}:${sessionId}`;
  const fresh = () => ({ version: 1, home, sessionId, text: '', revision: createUuid(), pending: null });
  let record = fresh(), snapshot = emptySnapshot, savedRaw, error = '', corrupt = false, dirtyText = false, lease = null;
  const listeners = new Set();
  let imageStore = null, imageUnsubscribe = null, imageContext = null, imageLatched = false;
  function publish() {
    const image = imageStore?.getSnapshot();
    const source = image || record;
    snapshot = { text: source.text, revision: source.revision, pending: source.pending, isSending: Boolean(lease),
      error: image?.error?.message || error, ...(imageLatched || corrupt ? { imageRecovery: true } : {}) };
    listeners.forEach(listener => listener());
  }
  function read(raw) {
    if (raw == null) return fresh();
    if (raw.length > MAX_RECORD_BYTES || new TextEncoder().encode(raw).length > MAX_RECORD_BYTES) throw new Error('Saved draft is too large.');
    const value = JSON.parse(raw);
    if (!value || value.version !== 1 || value.home !== home || value.sessionId !== sessionId || typeof value.text !== 'string' || !UUID.test(value.revision)
      || (value.pending != null && (!UUID.test(value.pending.requestId) || typeof value.pending.text !== 'string' || !UUID.test(value.pending.draftRevision)))) throw new Error('Invalid saved draft.');
    const pending = value.pending ? Object.freeze({ requestId: value.pending.requestId, text: value.pending.text, draftRevision: value.pending.draftRevision,
      ...(Object.prototype.hasOwnProperty.call(value.pending, 'attachments') ? { attachments: cloneImageAttachments(value.pending.attachments) } : {}) }) : null;
    return { version: 1, home, sessionId, text: value.text, revision: value.revision, pending };
  }
  function refresh() {
    if (signal.aborted || imageLatched) return;
    try {
      const raw = storage.getItem(key);
      if (raw === savedRaw && !corrupt) return;
      const restored = read(raw);
      record = dirtyText ? { ...restored, text: record.text, revision: record.revision } : restored;
      savedRaw = raw; corrupt = false; error = ''; publish();
    } catch { corrupt = true; error = 'Saved draft could not be read. Its request identity was kept. Start another conversation or restore device storage before sending.'; publish(); }
  }
  function save(next, required = false, localDraft = dirtyText ? next : null) {
    if (signal.aborted) return false;
    try {
      if (corrupt) throw new Error('Saved draft is unreadable');
      // Fail closed when this writer has observed a different saved value. This
      // synchronous readback is not an atomic cross-window transaction.
      const currentRaw = storage.getItem(key);
      if (currentRaw !== savedRaw) {
        const restored = read(currentRaw);
        record = localDraft ? { ...restored, text: localDraft.text, revision: localDraft.revision } : restored;
        savedRaw = currentRaw; dirtyText = Boolean(localDraft); error = CHANGED_ERROR; publish(); return false;
      }
      const encoded = JSON.stringify(next);
      if (new TextEncoder().encode(encoded).length > MAX_RECORD_BYTES) throw new Error('Draft record is too large');
      storage.setItem(key, encoded); savedRaw = encoded; record = next; dirtyText = false; error = ''; publish(); return true;
    } catch {
      if (!required) record = next;
      if (!corrupt) error = SAVE_ERROR;
      publish(); return false;
    }
  }
  const store = {
    getSnapshot: () => snapshot,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    refresh,
    // A getter never creates a DB or authorizes transport from legacy metadata.
    getImageStore: () => imageStore,
    observeImages(context) {
      if (signal.aborted || context.signal?.aborted || !context.isCurrent()) throw new Error('The image draft scope changed.');
      if (imageStore && imageContext === context && imageStore.getSnapshot().storageState !== 'closed') return imageStore;
      if (imageStore && imageStore.getSnapshot().storageState !== 'closed' && imageContext?.isCurrent()) return imageStore;
      const retainedDraft = imageStore?.getSnapshot();
      imageUnsubscribe?.(); imageStore?.close();
      imageLatched = true; imageContext = context;
      imageStore = createUserImageDraftStore({ scope: context.scope, signal: context.signal,
        isCurrent: () => !signal.aborted && !context.signal?.aborted && context.isCurrent(),
        legacy: { readRaw: () => storage.getItem(key), writeMarker(marker) { storage.setItem(key, marker); savedRaw = marker; } },
        ...(retainedDraft ? { initialDraft: { text: retainedDraft.text, revision: retainedDraft.revision } }
          : !corrupt || dirtyText ? { initialDraft: { text: record.text, revision: record.revision } } : {}) });
      imageUnsubscribe = imageStore.subscribe(() => { error = ''; publish(); });
      publish(); return imageStore;
    },
    setText(value) {
      if (signal.aborted) return;
      const currentText = imageStore ? imageStore.getSnapshot().text : record.text;
      const text = typeof value === 'function' ? value(currentText) : value;
      if (typeof text !== 'string' || text === currentText) return;
      if (imageLatched) {
        try { if (!imageStore || imageContext?.isCurrent() !== true) return; imageStore.setText(text); }
        catch (failure) { error = failure.message || SAVE_ERROR; publish(); }
        return;
      }
      dirtyText = true;
      save({ ...record, text, revision: createUuid() });
    },
    ensureSavedForPaste(text, revision) {
      if (signal.aborted || imageLatched || corrupt || record.pending || record.text !== text || record.revision !== revision) return false;
      return save({ ...record }, true, record);
    },
    finalizeLargePaste({ baseText, baseRevision, localText, localRevision, remaining }) {
      if (signal.aborted || imageLatched || corrupt || record.pending || record.text !== localText || record.revision !== localRevision || typeof remaining !== 'string') return false;
      try {
        const raw = storage.getItem(key);
        if (raw === null || raw !== savedRaw) return false;
        const base = read(raw);
        if (base.pending || base.text !== baseText || base.revision !== baseRevision) return false;
        return save({ ...record, text: remaining, revision: createUuid() }, true, record);
      } catch { return false; }
    },
    finalizeSavedPaste({ baseText, baseRevision, remaining }) {
      return store.finalizeLargePaste({ baseText, baseRevision, localText: baseText, localRevision: baseRevision, remaining });
    },
    clearIfUnchanged(revision, submittedText) {
      if (imageLatched) {
        const current = imageStore?.getSnapshot();
        if (current && !current.pending && current.localIds.length === 0 && current.revision === revision
          && current.text.trim() === submittedText.trim()) store.setText('');
        return;
      }
      if (record.text && record.revision === revision && record.text.trim() === submittedText.trim()) {
        // An obsolete automatic clear must not become an empty local edit over
        // another writer's newer draft. Keep any already-unsaved local text.
        const localDraft = dirtyText ? record : null;
        dirtyText = true;
        save({ ...record, text: '', revision: createUuid() }, false, localDraft);
      }
    },
    // Promoted scopes await native Blob/text/intent commitment. Legacy-only
    // scopes retain the synchronous text codec; metadata alone grants no send authority.
    prepareIntent(text, attachments, source, requestId) {
      if (imageLatched) {
        if (!imageStore || imageContext?.isCurrent() !== true) throw new Error('The saved image draft is unavailable.');
        const native = imageStore, current = native.getSnapshot();
        const captured = source || { draftRevision: current.revision, localIds: [...current.localIds] };
        const input = { text, ...(attachments === undefined ? {} : { attachments: cloneImageAttachments(attachments) }),
          draftRevision: captured.draftRevision, localIds: [...captured.localIds], ...(requestId === undefined ? {} : { requestId }) };
        return native.flush().then(() => native.prepareIntent(input));
      }
      if (requestId !== undefined) throw new Error('The saved image draft is unavailable.');
      if (corrupt) refresh();
      const images = attachments === undefined ? null : cloneImageAttachments(attachments);
      const pendingImages = record.pending && Object.prototype.hasOwnProperty.call(record.pending, 'attachments');
      const same = images || pendingImages
        ? Boolean(images && pendingImages && sameImageInput({ text, attachments: images }, { text: record.pending.text, attachments: record.pending.attachments }))
        : record.pending?.text === text;
      if (record.pending && (images || pendingImages) && !same) throw new Error('An unresolved image or message request is pending. Confirm its outcome before changing the image manifest.');
      const existing = same ? record.pending : null;
      const pending = existing || Object.freeze({ requestId: createUuid(), text, draftRevision: record.revision, ...(images ? { attachments: images } : {}) });
      if (!save({ ...record, pending }, true)) throw new Error(error || SAVE_ERROR);
      return { ...pending, reused: Boolean(existing) };
    },
    confirmIntent(requestId, receipt) {
      if (imageLatched) {
        if (!imageStore || imageContext?.isCurrent() !== true) throw new Error('The saved image draft is unavailable.');
        return imageStore.confirmIntent({ requestId, receipt });
      }
      if (record.pending?.requestId === requestId) return save({ ...record, pending: null });
    },
    claimSend() { if (signal.aborted || lease) return null; lease = {}; publish(); return lease; },
    releaseSend(expected) { if (lease === expected) { lease = null; publish(); } },
  };
  refresh(); if (snapshot === emptySnapshot) publish();
  return store;
}

export function getComposerDraftStore(sessionId) {
  if (!sessionId) return emptyStore;
  const signal = getEnvironmentSignal();
  let scope = stores.get(signal); if (!scope) { scope = new Map(); stores.set(signal, scope); }
  const home = new URL(resolveHomeApiUrl('/'), window.location.origin).href.replace(/\/$/, '');
  const key = `${home}:${sessionId}`;
  let store = scope.get(key);
  if (!store) { store = createStore(sessionId, home, signal); scope.set(key, store); }
  else store.refresh();
  return store;
}
