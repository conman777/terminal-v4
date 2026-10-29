import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { captureAuthScope, isAuthScopeCurrent } from '../utils/auth';
import { captureStartImageSource } from '../utils/startImageTransfer';
import { retainStartImageDraft } from '../utils/startImageDraftLease';

const empty = Object.freeze({ storageState: 'legacy', items: [], localIds: [], isHydrating: false, isSaving: false, pending: null });
const noSubscribe = () => () => {};
const getEmpty = () => empty;

// The start draft keeps original image bytes locally until a real, confirmed
// conversation can own them. This hook never uploads or sends the images.
export function useStartImageDraft({ store, authKey, environmentSignal, environment, active, enabled, imageSupported }) {
  const [bound, setBound] = useState(null);
  const [problem, setProblem] = useState('');
  const [previews, setPreviews] = useState(null);
  const live = useRef(null);
  const token = `${authKey}:${environment ? `paired:${environment.id}` : 'home'}`;
  live.current = { token, environmentSignal };
  useLayoutEffect(() => {
    const auth = captureAuthScope();
    const controller = new AbortController();
    const current = () => live.current?.token === token && live.current.environmentSignal === environmentSignal
      && !controller.signal.aborted && !environmentSignal.aborted && isAuthScopeCurrent(auth);
    if (!active || !auth.userId || environment || !current()) return () => controller.abort();
    try {
      const lease = retainStartImageDraft({ store, auth, environmentSignal, isCurrent: current });
      const { native, scope } = lease;
      const binding = { token, native, scope, current: lease.current, signal: controller.signal };
      setBound(binding);
      void native.hydrate().catch(error => { if (current()) setProblem(error.message || 'Saved images could not be loaded.'); });
      return () => { controller.abort(); lease.release(); };
    } catch (error) {
      setProblem(error.message || 'Saved images could not be loaded.');
      return () => controller.abort();
    }
  }, [store, token, environmentSignal, active]);
  const binding = bound?.token === token && bound.current() ? bound : null;
  const snapshot = useSyncExternalStore(binding?.native.subscribe || noSubscribe, binding?.native.getSnapshot || getEmpty, getEmpty);

  useEffect(() => {
    if (!binding || !snapshot.localIds.length) { setPreviews(null); return undefined; }
    let alive = true;
    const urls = [];
    void Promise.all(snapshot.localIds.map(async id => {
      try {
        const row = await binding.native.getBlob(id);
        if (!alive || !binding.current()) return null;
        const url = URL.createObjectURL?.(row.blob);
        if (url) urls.push(url);
        return [id, url];
      } catch { return null; }
    })).then(rows => { if (alive && binding.current()) setPreviews({ snapshot, values: new Map(rows.filter(Boolean)) }); });
    return () => { alive = false; for (const url of urls) URL.revokeObjectURL(url); };
  }, [binding, snapshot]);

  const busy = snapshot.isHydrating || snapshot.isSaving;
  const allowed = Boolean(binding && enabled && imageSupported && !busy && !snapshot.pending
    && !['closed', 'unavailable', 'conflict'].includes(snapshot.storageState));
  const invoke = async operation => {
    if (!binding?.current()) throw new Error('The image draft scope changed.');
    setProblem('');
    try { return await operation(binding.native); }
    catch (error) { if (binding.current()) setProblem(error.message || 'The image draft could not be saved.'); throw error; }
  };
  const items = (snapshot.items || []).map(item => ({ localId: item.localId, name: item.name,
    status: item.durability === 'missing' ? 'missing_bytes' : 'ready',
    ...(previews?.snapshot === snapshot && previews.values.get(item.localId) ? { previewUrl: previews.values.get(item.localId) } : {}) }));
  const images = binding ? { scopeKey: JSON.stringify(binding.scope), generation: token, items,
    admission: imageSupported ? { state: 'allowed', reason: '' } : { state: 'blocked', reason: 'Image support is not confirmed for this model.' },
    canAdd: allowed, canSend: allowed && items.every(item => item.status === 'ready'), isHydrating: snapshot.isHydrating, isSaving: snapshot.isSaving,
    error: problem || snapshot.error?.message || '',
    addFiles: files => invoke(async native => {
      if (!allowed) throw new Error('The image draft is not ready.');
      await native.hydrate();
      if (native.getSnapshot().storageState !== 'ready') await native.promoteLegacy();
      await native.flush();
      return native.addFiles(files, { expectedRevision: native.getSnapshot().revision });
    }),
    removeImage: id => invoke(async native => native.removeImage(id, { expectedRevision: native.getSnapshot().revision })),
  } : null;
  return { images, hasImages: snapshot.localIds.length > 0, source: binding?.native, current: binding?.current, signal: binding?.signal,
    capture: () => invoke(native => captureStartImageSource(native, binding.current)) };
}
