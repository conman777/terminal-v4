import { resolveWebSocketUrl } from '../../utils/apiBase';
import React, { useState, useEffect, useRef, useCallback } from 'react';
import { MetricCard } from './shared/MetricCard';
import { apiFetch } from '../../utils/api';
import { getAccessToken } from '../../utils/auth';
import './PerformanceTab.css';

const MAX_METRICS = 1000;
const emptyMetrics = () => ({ coreWebVitals: [], loadMetrics: [], runtimeMetrics: [] });
const validMetrics = metrics => ['coreWebVitals', 'loadMetrics', 'runtimeMetrics'].every(key => Array.isArray(metrics?.[key]));

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
  const [metrics, setMetrics] = useState(emptyMetrics);
  const [isLive, setIsLive] = useState(false);
  const [notAvailable, setNotAvailable] = useState(false);
  const [error, setError] = useState('');
  const [isClearing, setIsClearing] = useState(false);
  const scope = useRef(null);

  const fetchMetrics = useCallback(async () => {
    const owner = scope.current;
    if (!port || !owner || owner.clearing) return;
    owner.controller?.abort();
    const controller = new AbortController();
    owner.controller = controller;
    const streamRevision = owner.streamRevision;
    const current = () => scope.current === owner && !controller.signal.aborted && owner.streamRevision === streamRevision;
    try {
      const response = await apiFetch(`/api/preview/${port}/performance`, { signal: controller.signal });
      if (!current()) return;
      if (response.status === 404) {
        setNotAvailable(true);
        setIsLive(false);
        return;
      }
      if (!response.ok) throw new Error('Performance request failed');
      const data = await response.json();
      if (!current()) return;
      if (!validMetrics(data.metrics)) throw new Error('Invalid metrics');
      setMetrics(data.metrics);
      setNotAvailable(false);
      setError('');
    } catch {
      if (current()) setError('Could not load performance metrics. Try refreshing.');
    }
  }, [port]);

  useEffect(() => {
    const owner = { controller: null, clearing: false, streamRevision: 0 };
    scope.current = owner;
    setMetrics(emptyMetrics());
    setNotAvailable(false);
    setError('');
    setIsLive(false);
    setIsClearing(false);
    void fetchMetrics();
    return () => {
      owner.controller?.abort();
      if (scope.current === owner) scope.current = null;
    };
  }, [fetchMetrics]);

  // WebSocket for live updates
  useEffect(() => {
    if (!isLive || notAvailable || !port) return;

    const token = getAccessToken();
    if (!token) return;
    const params = new URLSearchParams({ token });
    const wsUrl = resolveWebSocketUrl(`/api/preview/${port}/performance/stream?${params.toString()}`);

    const ws = new WebSocket(wsUrl);
    const owner = scope.current;
    let active = true;

    ws.onmessage = (event) => {
      if (!active) return;
      try {
        const data = JSON.parse(event.data);
        if (scope.current === owner && data.type === 'performance-update' && validMetrics(data.metrics)) {
          owner.streamRevision += 1;
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
      if (!active) return;
      console.error('WebSocket error:', err);
      setIsLive(false);
    };

    ws.onclose = () => {
      if (active) setIsLive(false);
    };

    return () => {
      active = false;
      ws.close();
    };
  }, [isLive, port, notAvailable]);

  const clearMetrics = async () => {
    const owner = scope.current;
    if (!port || !owner || owner.clearing) return;
    owner.clearing = true;
    owner.controller?.abort();
    setIsClearing(true);
    setIsLive(false);
    setError('');
    try {
      const response = await apiFetch(`/api/preview/${port}/performance`, { method: 'DELETE' });
      if (scope.current !== owner) return;
      if (!response.ok) throw new Error('Clear request failed');
      setMetrics(emptyMetrics());
    } catch {
      if (scope.current === owner) setError('Could not clear performance metrics. Try again.');
    } finally {
      owner.clearing = false;
      if (scope.current === owner) setIsClearing(false);
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
    if (lcp == null) return null;
    if (lcp <= 2500) return 'good';
    if (lcp <= 4000) return 'warning';
    return 'error';
  };

  const getFIDStatus = (fid) => {
    if (fid == null) return null;
    if (fid <= 100) return 'good';
    if (fid <= 300) return 'warning';
    return 'error';
  };

  const getCLSStatus = (cls) => {
    if (cls == null) return null;
    if (cls <= 0.1) return 'good';
    if (cls <= 0.25) return 'warning';
    return 'error';
  };

  // FPS chart data (last 60 samples)
  const fpsData = metrics.runtimeMetrics
    .filter((m) => Number.isFinite(m.data?.fps))
    .slice(-60)
    .map((m) => m.data.fps);

  if (notAvailable) {
    return (
      <div className="performance-tab" role="region" aria-label="Performance metrics" tabIndex={0}>
        <div className="performance-tab__header">
          <h2 className="performance-tab__title">Performance Monitor</h2>
        </div>
        <div className="performance-tab__empty">
          <p className="performance-tab__unavailable-title">Performance monitoring not available</p>
          <p>This preview server does not provide performance metrics.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="performance-tab" role="region" aria-label="Performance metrics" tabIndex={0}>
      {/* Header */}
      <div className="performance-tab__header">
        <h2 className="performance-tab__title">Performance Monitor</h2>
        <div className="performance-tab__actions">
          <button
            type="button"
            onClick={() => setIsLive(!isLive)}
            aria-pressed={isLive}
            disabled={!port || isClearing}
          >
            {isLive ? 'Live' : 'Start Live'}
          </button>
          <button
            type="button"
            onClick={fetchMetrics}
            disabled={!port || isClearing}
          >
            Refresh
          </button>
          <button
            type="button"
            onClick={exportReport}
          >
            Export
          </button>
          <button
            type="button"
            onClick={clearMetrics}
            disabled={!port || isClearing}
          >
            Clear
          </button>
        </div>
      </div>

      {error && <p role="alert">{error}</p>}

      {/* Core Web Vitals */}
      <div className="performance-tab__section">
        <h3 className="performance-tab__section-title">Core Web Vitals</h3>
        <div className="performance-tab__grid">
          <MetricCard
            className="performance-tab__metric"
            label="LCP (Largest Contentful Paint)"
            value={latestCWV.lcp}
            unit="ms"
            status={getLCPStatus(latestCWV.lcp)}
            subtext="Good: ≤2500ms, Needs improvement: ≤4000ms"
          />
          <MetricCard
            className="performance-tab__metric"
            label="FID (First Input Delay)"
            value={latestCWV.fid}
            unit="ms"
            status={getFIDStatus(latestCWV.fid)}
            subtext="Good: ≤100ms, Needs improvement: ≤300ms"
          />
          <MetricCard
            className="performance-tab__metric"
            label="CLS (Cumulative Layout Shift)"
            value={latestCWV.cls?.toFixed(3)}
            status={getCLSStatus(latestCWV.cls)}
            subtext="Good: ≤0.1, Needs improvement: ≤0.25"
          />
        </div>
      </div>

      {/* Load Metrics */}
      <div className="performance-tab__section">
        <h3 className="performance-tab__section-title">Load Metrics</h3>
        <div className="performance-tab__grid">
          <MetricCard
            className="performance-tab__metric"
            label="DOM Content Loaded"
            value={latestLoad.domContentLoaded}
            unit="ms"
          />
          <MetricCard
            className="performance-tab__metric"
            label="Full Page Load"
            value={latestLoad.fullPageLoad}
            unit="ms"
          />
          <MetricCard
            className="performance-tab__metric"
            label="Time to Interactive (TTI)"
            value={latestLoad.timeToInteractive}
            unit="ms"
          />
        </div>
      </div>

      {/* Runtime Metrics */}
      <div className="performance-tab__section">
        <h3 className="performance-tab__section-title">Runtime Performance</h3>
        <div className="performance-tab__grid">
          <MetricCard
            className="performance-tab__metric"
            label="FPS (Frames Per Second)"
            value={latestRuntime.fps?.toFixed(1)}
            status={latestRuntime.fps == null ? null : latestRuntime.fps >= 55 ? 'good' : latestRuntime.fps >= 30 ? 'warning' : 'error'}
            subtext="Target: 60 FPS"
          />
          <MetricCard
            className="performance-tab__metric"
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
          <div className="performance-tab__chart">
            <h4 className="performance-tab__chart-title">FPS Over Time</h4>
            <div className="performance-tab__chart-bars" role="img" aria-label={`FPS over time, last ${fpsData.length} samples`}>
              {fpsData.map((fps, i) => (
                <div
                  key={i}
                  className="performance-tab__chart-bar"
                  style={{ height: `${Math.max(0, Math.min(100, (fps / 60) * 100))}%` }}
                  title={`${fps.toFixed(1)} FPS`}
                />
              ))}
            </div>
            <div className="performance-tab__chart-axis">
              <span>0 FPS</span>
              <span>60 FPS</span>
            </div>
          </div>
        )}
      </div>

      {/* Long Tasks */}
      {latestRuntime.longTasks && latestRuntime.longTasks.length > 0 && (
        <div className="performance-tab__section">
          <h3 className="performance-tab__section-title">Long Tasks ({'>'}50ms)</h3>
          <div className="performance-tab__tasks">
            <table aria-label="Long tasks over 50 milliseconds">
              <thead>
                <tr>
                  <th scope="col">Start Time</th>
                  <th scope="col">Duration</th>
                </tr>
              </thead>
              <tbody>
                {latestRuntime.longTasks.map((task, i) => (
                  <tr key={i}>
                    <td>{task.startTime.toFixed(2)}ms</td>
                    <td className="performance-tab__duration">
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
          <div className="performance-tab__empty">
            No performance metrics available. Metrics will be collected as the app runs.
          </div>
        )}
    </div>
  );
}
