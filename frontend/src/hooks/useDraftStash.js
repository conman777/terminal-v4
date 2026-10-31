import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { loadStash, stashDraft, takeStashed } from '../utils/draftStash';
import { getEnvironmentCacheScope, subscribeEnvironment } from '../utils/remoteEnvironments';

const STASH_FAILED = 'This draft could not be stashed on this device, so it was kept in the composer. Free local storage and try again.';
const scopeKey = () => { const scope = getEnvironmentCacheScope(); return `${scope.identity}|${scope.environment}`; };

export function useDraftStash() {
  const [items, setItems] = useState(loadStash);
  const [error, setError] = useState('');
  const scope = useSyncExternalStore(subscribeEnvironment, scopeKey);
  useEffect(() => { setItems(loadStash()); setError(''); }, [scope]);

  const stash = useCallback(text => {
    const result = stashDraft(text);
    if (!result.ok) { setError(STASH_FAILED); return false; }
    setError('');
    setItems(result.items);
    return true;
  }, []);
  const restore = useCallback(id => {
    const text = takeStashed(id);
    setItems(loadStash());
    return text;
  }, []);
  return { items, error, stash, restore };
}
