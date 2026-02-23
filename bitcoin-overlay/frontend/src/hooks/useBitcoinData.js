import { useState, useEffect, useCallback, useRef } from 'react';
import { fetchPrice, fetchChart } from '../utils/api';

const PRICE_POLL_INTERVAL = 60_000;
const CHART_POLL_INTERVAL = 300_000;

export function useBitcoinData() {
  const [price, setPrice] = useState(null);
  const [chartData, setChartData] = useState(null);
  const [timeRange, setTimeRange] = useState('30');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const mountedRef = useRef(true);

  const loadPrice = useCallback(async () => {
    try {
      const data = await fetchPrice();
      if (mountedRef.current) {
        setPrice(data);
        setError(null);
      }
    } catch (err) {
      if (mountedRef.current) {
        setError(err.message);
      }
    }
  }, []);

  const loadChart = useCallback(async (days) => {
    try {
      setLoading(true);
      const data = await fetchChart(days);
      if (mountedRef.current) {
        setChartData(data);
        setError(null);
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
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    loadPrice();
    const priceInterval = setInterval(loadPrice, PRICE_POLL_INTERVAL);
    return () => {
      mountedRef.current = false;
      clearInterval(priceInterval);
    };
  }, [loadPrice]);

  useEffect(() => {
    mountedRef.current = true;
    loadChart(timeRange);
    const chartInterval = setInterval(() => loadChart(timeRange), CHART_POLL_INTERVAL);
    return () => {
      mountedRef.current = false;
      clearInterval(chartInterval);
    };
  }, [timeRange, loadChart]);

  return { price, chartData, timeRange, setTimeRange, loading, error };
}
