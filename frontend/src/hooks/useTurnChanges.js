import { useEffect, useRef, useState } from 'react';
import { apiGet } from '../utils/api';

const NONE = {};

// Files each finished turn changed; reloaded whenever a turn stops streaming.
export function useTurnChanges(sessionId, isStreaming) {
  const [turns, setTurns] = useState(NONE);
  const [revision, setRevision] = useState(0);
  const wasStreaming = useRef(isStreaming);

  useEffect(() => {
    if (wasStreaming.current && !isStreaming) setRevision(value => value + 1);
    wasStreaming.current = isStreaming;
  }, [isStreaming]);

  useEffect(() => {
    if (!sessionId) { setTurns(NONE); return undefined; }
    let cancelled = false;
    Promise.resolve()
      .then(() => apiGet(`/api/structured/sessions/${encodeURIComponent(sessionId)}/turn-changes`))
      .then(data => { if (!cancelled) setTurns(data?.turns && typeof data.turns === 'object' ? data.turns : NONE); })
      .catch(() => { if (!cancelled) setTurns(NONE); });
    return () => { cancelled = true; };
  }, [sessionId, revision]);

  return turns;
}
