import React, { useState, useEffect, useRef } from 'react';
import { MetricCard } from './shared/MetricCard';

const MAX_METRICS = 1000;

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
  const [metrics, setMetrics] = useState({
    coreWebVitals: [],
    loadMetrics: [],
    runtimeMetrics: []
  });
  const [isLive, setIsLive] = useState(false);
  const wsRef = useRef(null);

  // Fetch initial metrics
  useEffect(() => {
    fetchMetrics();
  }, [port]);

  // WebSocket for live updates
  useEffect(() => {
    if (!isLive) return;

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/api/preview/${port}/performance/stream`;

    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.type === 'performance-update' && data.metrics) {
          setMetrics((prev) => ({
            coreWebVitals: limitArraySize(prev.coreWebVitals, data.metrics.coreWebVitals, MAX_METRICS),
            loadMetrics: limitArraySize(prev.loadMetrics, data.metrics.loadMetrics, MAX_METRICS),
            runtimeMetrics: limitArraySize(prev.runtimeMetrics, data.metrics.runtimeMetrics, MAX_METRICS)
          }));
        }
      } catch (err) {
        console.error('Error parsing WebSocket message:', err);
      }
    };

    ws.onerror = (err) => {
      console.error('WebSocket error:', err);
      setIsLive(false);
    };

    ws.onclose = () => {
      setIsLive(false);
    };

    return () => {
      ws.close();
    };
  }, [isLive, port]);

  const fetchMetrics = async () => {
    try {
      const response = await fetch(`/api/preview/${port}/performance`);
      if (response.ok) {
        const data = await response.json();
        setMetrics(data.metrics);
      }
    } catch (err) {
      console.error('Error fetching metrics:', err);
    }
  };

  const clearMetrics = async () => {
    try {
      await fetch(`/api/preview/${port}/performance`, { method: 'DELETE' });
      setMetrics({
        coreWebVitals: [],
        loadMetrics: [],
        runtimeMetrics: []
      });
    } catch (err) {
      console.error('Error clearing metrics:', err);
    }
  };

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
