import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { captureAuthScope, isAuthScopeCurrent, subscribeAuth } from '../utils/auth';
import { getActiveEnvironment, getEnvironmentSignal, subscribeEnvironment } from '../utils/remoteEnvironments';
import { retainUserImageComposer } from '../utils/userImageComposerController';

const EMPTY = Object.freeze({ storage: null, admission: { state: 'checking', reason: 'Checking image support…' }, error: '', isAdding: false });
const noopSubscribe = () => () => {};
const emptySnapshot = () => EMPTY;
const authKey = () => { const auth = captureAuthScope(); return JSON.stringify([auth.generation, auth.userId, auth.home]); };
let nextGeneration = 0;
const bounded = error => String(error?.message || error || '').slice(0, 400);

// Each mounted view owns its action lease and preview URLs. The controller owns
// shared local/network work; retiring one view does not retire another view.
export function useUserImageComposer(options) {
  useSyncExternalStore(subscribeAuth, authKey);
  const environmentSignal = useSyncExternalStore(subscribeEnvironment, getEnvironmentSignal);
  const auth = captureAuthScope(), paired = getActiveEnvironment();
  const session = options.session, owned = session?.runtime === 'v4' && Boolean(session?.id);
  const scope = [auth.userId, auth.home, paired ? `paired:${paired.id}` : 'home', session?.id];
  const scopeKey = JSON.stringify(scope);
  const storeOwner = useRef(null), ownerKey = JSON.stringify([auth.userId, auth.home]);
  if (!storeOwner.current || storeOwner.current.store !== options.store) storeOwner.current = { store: options.store, ownerKey, signal: environmentSignal };
  const storeMatches = storeOwner.current.ownerKey === ownerKey && storeOwner.current.signal === environmentSignal;
  const signature = JSON.stringify([scopeKey, auth.generation, session?.runtime, session?.aiType, session?.model, options.active !== false, options.readOnly === true]);
  const live = useRef(null), identity = useRef(null);
  if (!identity.current || identity.current.signature !== signature || identity.current.signal !== environmentSignal || identity.current.store !== options.store) {
    identity.current = { signature, signal: environmentSignal, store: options.store, generation: ++nextGeneration };
  }
  const token = identity.current;
  live.current = { token, options };
  const [binding, setBinding] = useState(null);
  const [previews, setPreviews] = useState(null);
  const [actionState, setActionState] = useState(null);
  const current = useCallback(() => live.current?.token === token && live.current.options.active !== false
    && storeMatches && Boolean(auth.userId) && !token.retired && !environmentSignal.aborted && isAuthScopeCurrent(auth), [token]);

  // Render-time current() checks reject stale native callbacks. Committed
  // liveness changes synchronously release the writer in layout cleanup, so
  // its native epoch can abort/close before passive effects or a later paint.
  useLayoutEffect(() => {
    token.retired = false;
    if (!owned || !auth.userId || options.active === false || !current()) return () => { token.retired = true; };
    const lease = retainUserImageComposer({ scope, store: options.store, session, signal: environmentSignal, isCurrent: current, readOnly: options.readOnly === true });
    setBinding({ token, lease });
    return () => { token.retired = true; lease.release(); };
  }, [token, owned, options.store, current]);
  const lease = binding?.token === token ? binding.lease : null;
  const state = useSyncExternalStore(lease?.subscribe || noopSubscribe, lease?.getSnapshot || emptySnapshot);
  const storage = state.storage;
  const facade = useSyncExternalStore(options.store.subscribe, options.store.getSnapshot);

  useEffect(() => {
    const native = options.store.getImageStore?.();
    if (!native || !storage || !current()) return;
    let retired = false;
    const urls = new Set(), result = new Map();
    const alive = () => !retired && current();
    const selected = storage.items || [], removals = storage.removals || [];
    void Promise.all([...selected, ...removals].map(async item => {
      try {
        const value = await native.getBlob(item.localId);
        if (!alive() || value.localId !== item.localId || !(value.blob instanceof Blob)
          || value.bytes !== value.blob.size || value.mimeType !== value.blob.type) return;
        if (selected.includes(item) && (value.name !== item.name || value.bytes !== item.bytes || value.mimeType !== item.mimeType)) return;
        let previewUrl;
        if (selected.includes(item) && typeof URL.createObjectURL === 'function') { previewUrl = URL.createObjectURL(value.blob); urls.add(previewUrl); }
        result.set(item.localId, { name: value.name, ...(previewUrl ? { previewUrl } : {}) });
      } catch { /* Missing bytes stay explicit; previews never authorize transport. */ }
    })).then(() => { if (alive()) setPreviews({ token, storage, values: result }); });
    return () => { retired = true; for (const url of urls) URL.revokeObjectURL(url); };
  }, [token, storage, options.store, current]);

  const activeAction = actionState?.token === token ? actionState : null;
  const invoke = useCallback(async (name, ...args) => {
    if (!current() || !lease || live.current.options.readOnly) throw new Error('The image draft scope changed or this view is read-only.');
    setActionState({ token, kind: name, error: '' });
    try {
      const result = ['checkPreviousSend', 'retryPreviousSend'].includes(name)
        ? await live.current.options[name === 'checkPreviousSend' ? 'checkPendingMessage' : 'retryPendingMessage']?.()
        : await lease[name](...args);
      if (current()) setActionState({ token, kind: '', cleanupPending: result?.localCleanupPending === true, error: '' });
      return result;
    } catch (problem) {
      if (current()) setActionState({ token, kind: '', error: bounded(problem) });
      throw problem;
    }
  }, [token, lease, current]);
  const unavailable = !current() || options.active === false;
  const admission = unavailable ? { state: 'blocked', reason: 'The image draft scope changed.' } : state.admission;
  const itemPreviews = previews?.token === token && previews.storage === storage ? previews.values : new Map();
  const items = (storage?.items || []).map(item => ({ localId: item.localId, name: item.name, mimeType: item.mimeType, bytes: item.bytes,
    uploadPinned: Boolean(storage?.pending?.submittedLocalIds?.includes(item.localId)),
    status: item.durability === 'missing' ? (storage.localIds.includes(item.localId) ? 'missing_bytes' : 'error')
      : item.uploadState === 'expired' || item.uploadState === 'ready' && item.expiresAt != null && item.expiresAt <= Date.now() ? 'expired'
      : item.uploadState === 'ready' && item.descriptor ? 'ready'
        : item.uploadState === 'uploading' && state.uploadingIds?.includes(item.localId) ? 'uploading'
          : ['failed', 'unknown', 'uploading'].includes(item.uploadState) ? 'error' : 'saved',
    ...(item.errorCode && item.errorCode !== 'upload_expired' ? { error: String(item.errorCode).slice(0, 400) } : {}), ...itemPreviews.get(item.localId) }));
  for (const job of storage?.removals || []) if (!items.some(item => item.localId === job.localId)) items.push({ localId: job.localId,
    name: itemPreviews.get(job.localId)?.name || 'Image awaiting removal', status: 'removal_unknown' });
  const pending = current() && (storage?.pending || (facade.pending && Object.prototype.hasOwnProperty.call(facade.pending, 'attachments') ? facade.pending : null));
  const recovery = pending && state.recovery?.requestId === pending.requestId ? state.recovery : null;
  const canRecover = !unavailable && !options.readOnly && !paired && Boolean(storage) && !storage.isHydrating;
  const held = Boolean(pending), imagesPresent = items.length > 0;
  const localBusy = Boolean(storage?.isHydrating || storage?.isSaving || state.isAdding);
  const blocked = unavailable || options.readOnly || options.conversationBusy || options.requiresCleanup || localBusy;
  const hasAuthority = Boolean(options.store.getImageStore?.() || facade.imageRecovery);
  const canSend = !blocked && !held && (!hasAuthority || storage?.storageState === 'ready')
    && (!imagesPresent || admission.state === 'allowed' && items.every(item => item.status === 'ready'));
  const userImages = owned ? {
    scopeKey, generation: token.generation, items, admission,
    canAdd: !blocked && admission.state === 'allowed', canSend,
    isHydrating: Boolean(storage?.isHydrating), isSaving: Boolean(storage?.isSaving || state.isAdding),
    error: activeAction?.error || state.error || bounded(storage?.error),
    pendingPreviousSend: pending ? { requestId: pending.requestId,
      status: activeAction?.kind === 'checkPreviousSend' || activeAction?.kind === 'retryPreviousSend' ? 'checking'
        : pending.acceptedReceipt || activeAction?.cleanupPending ? 'accepted_cleanup_pending'
          : pending.missingBytePins?.length ? 'missing_bytes' : 'unknown',
      body: { text: pending.text, ...(pending.attachments ? { attachments: pending.attachments } : {}) },
      ...(recovery ? { originalsRevision: recovery.revision, originals: recovery.slots, originalsState: recovery.state,
        originalsError: recovery.error, originalsCanChoose: canRecover && recovery.canChoose, originalsCanSave: canRecover && recovery.canSave } : {}) } : null,
    addFiles: (...args) => invoke('addFiles', ...args), removeImage: id => invoke('removeImage', id), retryUpload: id => invoke('retryUpload', id),
    checkPreviousSend: () => invoke('checkPreviousSend'), retryPreviousSend: () => invoke('retryPreviousSend'),
    selectOriginalImage: (...args) => invoke('selectOriginalImage', ...args), saveOriginalImages: (...args) => invoke('saveOriginalImages', ...args),
  } : null;
  const sendDraft = useCallback(async raw => {
    if (!current()) return { accepted: false, stale: true };
    const native = options.store.getImageStore?.(), source = native?.getSnapshot();
    if (source?.pending) throw new Error('Check or retry the previous saved send first.');
    const refs = source?.localIds.length ? source.localIds.map(id => {
      const item = source.items.find(value => value.localId === id);
      return item?.uploadState === 'ready' && (item.expiresAt == null || item.expiresAt > Date.now()) ? item.descriptor : null;
    }) : undefined;
    if (refs && (state.admission.state !== 'allowed' || refs.some(ref => !ref))) throw new Error('The selected images are not ready for this model.');
    if (live.current.options.readOnly || live.current.options.conversationBusy || live.current.options.requiresCleanup) throw new Error('This conversation cannot accept a message yet.');
    return await live.current.options.sendMessage(raw, refs);
  }, [token, options.store, state.admission.state, current]);
  return { userImages, sendDraft, draftManaged: owned && hasAuthority };
}
