import { useMemo, useSyncExternalStore } from 'react';
import { getEnvironmentSignal, subscribeEnvironment } from '../utils/remoteEnvironments';
import { getComposerDraftStore } from '../utils/composerDraftStore';

export function useComposerDraft(sessionId) {
  const scope = useSyncExternalStore(subscribeEnvironment, getEnvironmentSignal);
  const store = useMemo(() => getComposerDraftStore(sessionId), [sessionId, scope]);
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot);
  return { value: snapshot.text, revision: snapshot.revision, pending: snapshot.pending, error: snapshot.error, isSending: snapshot.isSending,
    setValue: store.setText, clearIfUnchanged: store.clearIfUnchanged, store };
}
