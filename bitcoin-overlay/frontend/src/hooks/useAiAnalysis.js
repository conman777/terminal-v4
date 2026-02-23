import { useState, useEffect, useCallback, useRef } from 'react';
import { fetchAnalysis } from '../utils/api';

export function useAiAnalysis(chartData, timeRange) {
  const [analysis, setAnalysis] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const mountedRef = useRef(true);
  const lastTimeRangeRef = useRef(null);

  const load = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const data = await fetchAnalysis(parseInt(timeRange, 10));
      if (mountedRef.current) {
        setAnalysis(data);
      }
    } catch (err) {
      if (mountedRef.current) {
        setError(err.message);
      }
    } finally {
      if (mountedRef.current) {
        setLoading(false);
      }
    }
  }, [timeRange]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (chartData && chartData.prices && chartData.prices.length > 0) {
      if (lastTimeRangeRef.current !== timeRange) {
        lastTimeRangeRef.current = timeRange;
        load();
      }
    }
  }, [chartData, timeRange, load]);

  return { analysis, loading, error, refresh: load };
}
