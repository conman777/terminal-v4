import { isAuthScopeCurrent } from './auth';

const entries = new WeakMap();
const owners = new WeakMap();

// Workspace-start can be mounted by more than one surface. Those views share
// one native store; one unmount must not close a sibling's in-flight write.
export function retainStartImageDraft({ store, auth, environmentSignal, isCurrent }) {
  const owner = JSON.stringify([auth.userId, auth.home]);
  if (!auth.userId || !isCurrent() || environmentSignal.aborted || !isAuthScopeCurrent(auth)) throw new Error('The image draft scope changed.');
  if (owners.has(store) && owners.get(store) !== owner) throw new Error('Reopen this workspace after changing accounts before adding images.');
  owners.set(store, owner);
  let entry = entries.get(store);
  if (entry && (entry.owner !== owner || entry.environmentSignal !== environmentSignal || !isAuthScopeCurrent(entry.auth))) {
    throw new Error('The image draft scope changed.');
  }
  if (!entry) {
    const controller = new AbortController();
    const views = new Set();
    const scope = [auth.userId, auth.home, 'home', 'workspace-start'];
    const current = () => !controller.signal.aborted && !environmentSignal.aborted && isAuthScopeCurrent(auth)
      && [...views].some(view => !view.released && view.isCurrent());
    const prior = store.getImageStore?.();
    if (prior && prior.getSnapshot().storageState !== 'closed') throw new Error('The saved image draft is already open.');
    // Register a view before observing: the native store checks liveness on entry.
    const initial = { isCurrent, released: false }; views.add(initial);
    try {
      const native = store.observeImages({ scope, signal: AbortSignal.any([environmentSignal, controller.signal]), isCurrent: current });
      entry = { owner, auth, environmentSignal, controller, views, native, scope, current };
      entries.set(store, entry);
      return makeLease(store, entry, initial);
    } catch (error) { controller.abort(); throw error; }
  }
  const view = { isCurrent, released: false }; entry.views.add(view);
  return makeLease(store, entry, view);
}

function makeLease(store, entry, view) {
  return { native: entry.native, scope: entry.scope,
    current: () => !view.released && view.isCurrent() && entry.current(),
    release() {
      if (view.released) return;
      view.released = true; entry.views.delete(view);
      if (entry.views.size) return;
      entry.controller.abort(); entry.native.close();
      if (entries.get(store) === entry) entries.delete(store);
    },
  };
}
