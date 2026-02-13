import React, { useState, useEffect, useRef, useCallback } from 'react';
import { MetricCard } from './shared/MetricCard';
import { apiFetch } from '../../utils/api';
import { getAccessToken } from '../../utils/auth';

const MAX_METRICS = 1000;
const MAX_RECONNECT_DELAY_MS = 10000;
const BASE_RECONNECT_DELAY_MS = 1000;
const EMPTY_METRICS = {
  coreWebVitals: [],
  loadMetrics: [],
  runtimeMetrics: []
};

/**
 * Limit array size to prevent unbounded growth
 */
const limitArraySize = (arr, newItems, maxSize) => {
  const combined = [...arr, ...newItems];
  return combined.length > maxSize ? combined.slice(-maxSize) : combined;
};

/**
 * PerformanceTab Component
 *
 * Displays performance metrics including Core Web Vitals, load metrics, and runtime metrics
 */
export function PerformanceTab({ port }) {
  const [metrics, setMetrics] = useState(EMPTY_METRICS);
  const [isLive, setIsLive] = useState(false);
  const [notAvailable, setNotAvailable] = useState(false);
  const wsRef = useRef(null);
  const reconnectTimerRef = useRef(null);
  const reconnectAttemptRef = useRef(0);

  const applyMetrics = useCallback((incomingMetrics, replace = false) => {
    const incoming = incomingMetrics || EMPTY_METRICS;
    const incomingCore = Array.isArray(incoming.coreWebVitals) ? incoming.coreWebVitals : [];
    const incomingLoad = Array.isArray(incoming.loadMetrics) ? incoming.loadMetrics : [];
    const incomingRuntime = Array.isArray(incoming.runtimeMetrics) ? incoming.runtimeMetrics : [];

    setMetrics((prev) => {
      if (replace) {
        return {
          coreWebVitals: incomingCore.slice(-MAX_METRICS),
          loadMetrics: incomingLoad.slice(-MAX_METRICS),
          runtimeMetrics: incomingRuntime.slice(-MAX_METRICS)
        };
      }
      return {
        coreWebVitals: limitArraySize(prev.coreWebVitals, incomingCore, MAX_METRICS),
        loadMetrics: limitArraySize(prev.loadMetrics, incomingLoad, MAX_METRICS),
        runtimeMetrics: limitArraySize(prev.runtimeMetrics, incomingRuntime, MAX_METRICS)
      };
    });
  }, []);

  const fetchMetrics = useCallback(async () => {
    try {
      const response = await apiFetch(`/api/preview/${port}/performance`);
      if (response.status === 404) {
        setNotAvailable(true);
        setIsLive(false);
        return;
      }
      if (!response.ok) {
        throw new Error(`Failed to fetch performance metrics (${response.status})`);
      }
      const data = await response.json();
      applyMetrics(data.metrics, true);
      setNotAvailable(false);
    } catch (err) {
      console.error('Error fetching performance metrics:', err);
    }
  }, [applyMetrics, port]);

  const clearMetrics = useCallback(async () => {
    try {
      const response = await apiFetch(`/api/preview/${port}/performance`, { method: 'DELETE' });
      if (!response.ok && response.status !== 404) {
        throw new Error(`Failed to clear performance metrics (${response.status})`);
      }
      setMetrics(EMPTY_METRICS);
      if (response.status === 404) {
        setNotAvailable(true);
        setIsLive(false);
      }
    } catch (err) {
      console.error('Error clearing metrics:', err);
    }
  }, [port]);

  // Fetch initial metrics
  useEffect(() => {
    void fetchMetrics();
  }, [fetchMetrics]);

  // WebSocket for live updates
  useEffect(() => {
    if (!isLive || notAvailable) return;

    let isDisposed = false;
    let ws = null;

    const clearReconnectTimer = () => {
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
    };

    const scheduleReconnect = () => {
      if (isDisposed || !isLive) return;
      clearReconnectTimer();
      reconnectAttemptRef.current += 1;
      const delay = Math.min(
        MAX_RECONNECT_DELAY_MS,
        BASE_RECONNECT_DELAY_MS * (2 ** (reconnectAttemptRef.current - 1))
      );
      reconnectTimerRef.current = setTimeout(connect, delay);
    };

    const connect = () => {
      if (isDisposed) return;
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const token = getAccessToken();
      const tokenQuery = token ? `?token=${encodeURIComponent(token)}` : '';
      const wsUrl = `${protocol}//${window.location.host}/api/preview/${port}/performance/stream${tokenQuery}`;
      ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      ws.onopen = () => {
        reconnectAttemptRef.current = 0;
        clearReconnectTimer();
      };

      ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          if (data.type === 'performance-snapshot' && data.metrics) {
            applyMetrics(data.metrics, true);
          } else if (data.type === 'performance-update' && data.metrics) {
            applyMetrics(data.metrics, false);
          }
        } catch (err) {
          console.error('Error parsing performance stream message:', err);
        }
      };

      ws.onerror = (err) => {
        console.error('Performance stream WebSocket error:', err);
      };

      ws.onclose = () => {
        if (!isDisposed) {
          scheduleReconnect();
        }
      };
    };

    connect();

    return () => {
      isDisposed = true;
      clearReconnectTimer();
      if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
        ws.close();
      }
    };
  }, [applyMetrics, isLive, notAvailable, port]);

  const exportReport = () => {
    const report = {
      port,
      timestamp: new Date().toISOString(),
      metrics
    };
    const blob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `performance-report-${port}-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  // Get latest metrics
  const latestCWV = metrics.coreWebVitals[metrics.coreWebVitals.length - 1]?.data || {};
  const latestLoad = metrics.loadMetrics[metrics.loadMetrics.length - 1]?.data || {};
  const latestRuntime = metrics.runtimeMetrics[metrics.runtimeMetrics.length - 1]?.data || {};

  // Calculate status for Core Web Vitals
  const getLCPStatus = (lcp) => {
    if (!lcp) return null;
    if (lcp <= 2500) return 'good';
    if (lcp <= 4000) return 'warning';
    return 'error';
  };

  const getFIDStatus = (fid) => {
    if (!fid) return null;
    if (fid <= 100) return 'good';
    if (fid <= 300) return 'warning';
    return 'error';
  };

  const getCLSStatus = (cls) => {
    if (!cls) return null;
    if (cls <= 0.1) return 'good';
    if (cls <= 0.25) return 'warning';
    return 'error';
  };

  // FPS chart data (last 60 samples)
  const fpsData = metrics.runtimeMetrics
    .filter((m) => m.data.fps !== null)
    .slice(-60)
    .map((m) => m.data.fps);

  if (notAvailable) {
    return (
      <div className="p-4 h-full overflow-auto">
        <div className="flex justify-between items-center mb-6">
          <h2 className="text-xl font-semibold">Performance Monitor</h2>
        </div>
        <div className="text-center py-12 text-gray-500">
          <p className="text-lg font-medium mb-2">Performance monitoring not available</p>
          <p>The backend performance endpoints are unavailable for this preview target.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="p-4 h-full overflow-auto">
      {/* Header */}
      <div className="flex justify-between items-center mb-6">
        <h2 className="text-xl font-semibold">Performance Monitor</h2>
        <div className="flex gap-2">
          <button
            onClick={() => setIsLive(!isLive)}
            className={`px-3 py-1 rounded text-sm font-medium ${
              isLive
                ? 'bg-green-600 text-white'
                : 'bg-gray-200 text-gray-700 hover:bg-gray-300'
            }`}
          >
            {isLive ? 'Live' : 'Start Live'}
          </button>
          <button
            onClick={fetchMetrics}
            className="px-3 py-1 bg-blue-600 text-white rounded text-sm font-medium hover:bg-blue-700"
          >
            Refresh
          </button>
          <button
            onClick={exportReport}
            className="px-3 py-1 bg-gray-600 text-white rounded text-sm font-medium hover:bg-gray-700"
          >
            Export
          </button>
          <button
            onClick={clearMetrics}
            className="px-3 py-1 bg-red-600 text-white rounded text-sm font-medium hover:bg-red-700"
          >
            Clear
          </button>
        </div>
      </div>

      {/* Core Web Vitals */}
      <div className="mb-6">
        <h3 className="text-lg font-semibold mb-3">Core Web Vitals</h3>
        <div className="grid grid-cols-3 gap-4">
          <MetricCard
            label="LCP (Largest Contentful Paint)"
            value={latestCWV.lcp}
            unit="ms"
            status={getLCPStatus(latestCWV.lcp)}
            subtext="Good: ≤2500ms, Needs improvement: ≤4000ms"
          />
          <MetricCard
            label="FID (First Input Delay)"
            value={latestCWV.fid}
            unit="ms"
            status={getFIDStatus(latestCWV.fid)}
            subtext="Good: ≤100ms, Needs improvement: ≤300ms"
          />
          <MetricCard
            label="CLS (Cumulative Layout Shift)"
            value={latestCWV.cls?.toFixed(3)}
            status={getCLSStatus(latestCWV.cls)}
            subtext="Good: ≤0.1, Needs improvement: ≤0.25"
          />
        </div>
      </div>

      {/* Load Metrics */}
      <div className="mb-6">
        <h3 className="text-lg font-semibold mb-3">Load Metrics</h3>
        <div className="grid grid-cols-3 gap-4">
          <MetricCard
            label="DOM Content Loaded"
            value={latestLoad.domContentLoaded}
            unit="ms"
          />
          <MetricCard
            label="Full Page Load"
            value={latestLoad.fullPageLoad}
            unit="ms"
          />
          <MetricCard
            label="Time to Interactive (TTI)"
            value={latestLoad.timeToInteractive}
            unit="ms"
          />
        </div>
      </div>

      {/* Runtime Metrics */}
      <div className="mb-6">
        <h3 className="text-lg font-semibold mb-3">Runtime Performance</h3>
        <div className="grid grid-cols-2 gap-4 mb-4">
          <MetricCard
            label="FPS (Frames Per Second)"
            value={latestRuntime.fps?.toFixed(1)}
            status={latestRuntime.fps >= 55 ? 'good' : latestRuntime.fps >= 30 ? 'warning' : 'error'}
            subtext="Target: 60 FPS"
          />
          <MetricCard
            label="JS Heap Used"
            value={
              latestRuntime.memory
                ? (latestRuntime.memory.usedJSHeapSize / 1024 / 1024).toFixed(1)
                : null
            }
            unit="MB"
            subtext={
              latestRuntime.memory
                ? `Total: ${(latestRuntime.memory.totalJSHeapSize / 1024 / 1024).toFixed(1)} MB`
                : null
            }
          />
        </div>

        {/* FPS Graph */}
        {fpsData.length > 0 && (
          <div className="bg-white rounded-lg border border-gray-200 p-4">
            <h4 className="text-sm font-medium text-gray-700 mb-2">FPS Over Time</h4>
            <div className="h-32 flex items-end gap-1">
              {fpsData.map((fps, i) => (
                <div
                  key={i}
                  className="flex-1 bg-blue-500 rounded-t"
                  style={{ height: `${(fps / 60) * 100}%` }}
                  title={`${fps.toFixed(1)} FPS`}
                />
              ))}
            </div>
            <div className="flex justify-between text-xs text-gray-500 mt-1">
              <span>0 FPS</span>
              <span>60 FPS</span>
            </div>
          </div>
        )}
      </div>

      {/* Long Tasks */}
        {latestRuntime.longTasks && latestRuntime.longTasks.length > 0 && (
          <div className="mb-6">
            <h3 className="text-lg font-semibold mb-3">Long Tasks ({'>'}50ms)</h3>
          <div className="bg-white rounded-lg border border-gray-200">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 border-b">
                <tr>
                  <th className="text-left p-2">Start Time</th>
                  <th className="text-left p-2">Duration</th>
                </tr>
              </thead>
              <tbody>
                {latestRuntime.longTasks.map((task, i) => (
                  <tr key={i} className="border-b last:border-b-0">
                    <td className="p-2">{task.startTime.toFixed(2)}ms</td>
                    <td className="p-2 text-red-600 font-medium">
                      {task.duration.toFixed(2)}ms
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* No data message */}
      {metrics.coreWebVitals.length === 0 &&
        metrics.loadMetrics.length === 0 &&
        metrics.runtimeMetrics.length === 0 && (
          <div className="text-center py-12 text-gray-500">
            No performance metrics available. Metrics will be collected as the app runs.
          </div>
        )}
    </div>
  );
}
