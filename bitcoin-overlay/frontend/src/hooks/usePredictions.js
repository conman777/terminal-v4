import { useState, useEffect, useCallback, useRef } from 'react';
import { fetchPredictions } from '../utils/api';

const POLL_INTERVAL = 60_000;

export function usePredictions(refreshKey) {
  const [predictions, setPredictions] = useState([]);
  const [stats, setStats] = useState(null);
  const [loading, setLoading] = useState(true);
  const mountedRef = useRef(true);

  const load = useCallback(async () => {
    try {
      const data = await fetchPredictions();
      if (mountedRef.current) {
        setPredictions(data.predictions || []);
        setStats(data.stats || null);
      }
    } catch {
      // Silently fail — predictions are supplementary
    } finally {
      if (mountedRef.current) {
        setLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  useEffect(() => {
    load();
    const interval = setInterval(load, POLL_INTERVAL);
    return () => clearInterval(interval);
  }, [load]);

  // Re-fetch when analysis refreshes
  useEffect(() => {
    if (refreshKey) load();
  }, [refreshKey, load]);

  return { predictions, stats, loading };
}
