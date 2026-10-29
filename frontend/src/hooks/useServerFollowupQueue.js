import { useCallback, useEffect, useRef, useState } from 'react';
import { probeServerFollowupQueue } from '../utils/serverFollowupQueue';
import { subscribeEnvironment } from '../utils/remoteEnvironments';

const initial = sessionId => ({ sessionId, status: sessionId ? 'unknown' : 'unavailable', snapshot: null, reason: '' });

export function useServerFollowupQueue(sessionId, { pollMs = 5000, retryMs = 3000 } = {}) {
  const [state, setState] = useState(() => initial(sessionId));
  const [scope, setScope] = useState(0);
  const refreshRef = useRef(() => {});
  useEffect(() => subscribeEnvironment(() => setScope(value => value + 1)), []);
  useEffect(() => {
    setState(initial(sessionId));
    if (!sessionId) return undefined;
    const controller = new AbortController();
    let timer;
    let settled = 'unknown';
    const run = async () => {
      const result = await probeServerFollowupQueue(sessionId, controller.signal);
      if (controller.signal.aborted) return;
      if (result.status === 'unknown') {
        if (settled === 'available') setState(current => (current.sessionId === sessionId ? current : initial(sessionId)));
        else setState(initial(sessionId));
      } else {
        settled = result.status;
        setState({ sessionId, status: result.status, snapshot: result.snapshot ?? null, reason: result.reason ?? '' });
      }
      const delay = settled === 'available' ? pollMs : settled === 'unknown' ? retryMs : 0;
      if (delay > 0) timer = setTimeout(run, delay);
    };
    refreshRef.current = () => { clearTimeout(timer); void run(); };
    void run();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [sessionId, scope, pollMs, retryMs]);
  const refresh = useCallback(() => refreshRef.current(), []);
  return state.sessionId === sessionId ? { ...state, refresh } : { ...initial(sessionId), refresh };
}
