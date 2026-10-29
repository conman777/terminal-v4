import './SystemResourcesView.css';
import { resolveWebSocketUrl } from '../utils/apiBase';
import { useState, useEffect, useRef, useCallback } from 'react';
import { apiGet } from '../utils/api';
import { getAccessToken } from '../utils/auth';
import { useSystemStatsPolling } from '../hooks/useSystemStatsPolling';
import { isWindowActive, subscribeWindowActivity } from '../utils/windowActivity';

// Format bytes to human-readable GB
function formatBytes(bytes) {
  const gb = bytes / (1024 ** 3);
  return `${gb.toFixed(1)} GB`;
}

// Format bytes to human-readable MB (for process memory)
function formatMB(bytes) {
  const mb = bytes / (1024 ** 2);
  if (mb >= 1000) {
    return `${(mb / 1024).toFixed(1)} GB`;
  }
  return `${mb.toFixed(0)} MB`;
}

// Mini sparkline chart
function Sparkline({ data, color, height = 40, width = 100 }) {
  if (!data || data.length < 2) {
    return (
      <div style={{ width, height, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-muted)', fontSize: '12px' }}>
        No data
      </div>
    );
  }

  const max = Math.max(...data, 100);
  const min = Math.min(...data, 0);
  const range = max - min || 1;

  const points = data.map((value, i) => {
    const x = (i / (data.length - 1)) * width;
    const y = height - ((value - min) / range) * (height - 4) - 2;
    return `${x},${y}`;
  });

  const pathD = `M ${points.join(' L ')}`;
  const areaD = `M 0,${height} L ${points.join(' L ')} L ${width},${height} Z`;

  return (
    <svg aria-hidden="true" viewBox={`0 0 ${width} ${height}`} width={width} height={height} style={{ maxWidth: '100%', display: 'block', color }}>
      <path d={areaD} fill="currentColor" opacity="0.08" />
      <path d={pathD} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

// Circular progress indicator
function CircularProgress({ value, size = 80, strokeWidth = 8, color }) {
  const radius = (size - strokeWidth) / 2;
  const circumference = radius * 2 * Math.PI;
  const offset = circumference - (value / 100) * circumference;

  return (
    <svg aria-hidden="true" width={size} height={size} style={{ transform: 'rotate(-90deg)', color }}>
      <circle
        cx={size / 2}
        cy={size / 2}
        r={radius}
        fill="none"
        strokeWidth={strokeWidth}
        style={{ stroke: 'var(--border-default)' }}
      />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={radius}
        fill="none"
        strokeWidth={strokeWidth}
        strokeDasharray={circumference}
        strokeDashoffset={offset}
        strokeLinecap="round"
        style={{ transition: 'stroke-dashoffset 0.5s ease', stroke: 'currentColor' }}
      />
    </svg>
  );
}

// Metric card component
function MetricCard({ title, value, subtitle, icon, color, trend, trendData, children }) {
  return (
    <div className="metric-card">
      <div className="metric-header">
        <span className="metric-icon" style={{ color }}>{icon}</span>
        <span className="metric-title">{title}</span>
      </div>
      <div className="metric-value" style={{ color }}>{value}</div>
      {subtitle && <div className="metric-subtitle">{subtitle}</div>}
      {trendData && trendData.length > 1 && (
        <div className="metric-trend">
          <Sparkline data={trendData} color={color} height={32} width={100} />
        </div>
      )}
      {children}
    </div>
  );
}

export function SystemResourcesView({ onClose } = {}) {
  const [windowActive, setWindowActive] = useState(() => isWindowActive());
  const systemStats = useSystemStatsPolling(windowActive);
  const [statsHistory, setStatsHistory] = useState(null);
  const [historyRange, setHistoryRange] = useState('24h');
  const [latencyMs, setLatencyMs] = useState(null);
  const [latencyHistory, setLatencyHistory] = useState([]);
  const [wsLatencyMs, setWsLatencyMs] = useState(null);
  const [wsLatencyHistory, setWsLatencyHistory] = useState([]);
  const [wsTarget, setWsTarget] = useState(null);
  const [clientFrameMs, setClientFrameMs] = useState(null);
  const [clientFrameHistory, setClientFrameHistory] = useState([]);
  const wsRef = useRef(null);
  const frameRef = useRef(null);

  useEffect(() => subscribeWindowActivity(setWindowActive), []);

  // Fetch history
  useEffect(() => {
    if (!windowActive) {
      return undefined;
    }

    const fetchHistory = async () => {
      try {
        const data = await apiGet(`/api/system/stats/history?range=${historyRange}`);
        setStatsHistory(data);
      } catch (err) {
        console.error('Failed to fetch stats history:', err);
      }
    };

    fetchHistory();
    const interval = setInterval(fetchHistory, 60000);
    return () => clearInterval(interval);
  }, [historyRange, windowActive]);

  // API latency measurement
  useEffect(() => {
    if (!windowActive) {
      setLatencyMs(null);
      return undefined;
    }

    const measureLatency = async () => {
      try {
        const start = performance.now();
        await apiGet('/api/health');
        const latency = Math.round(performance.now() - start);
        setLatencyMs(latency);
        setLatencyHistory(prev => [...prev.slice(-29), latency]);
      } catch {
        setLatencyMs(null);
      }
    };

    measureLatency();
    const interval = setInterval(measureLatency, 10000);
    return () => clearInterval(interval);
  }, [windowActive]);

  // WebSocket latency
  useEffect(() => {
    if (!windowActive) {
      setWsLatencyMs(null);
      setWsTarget(null);
      return undefined;
    }

    const token = getAccessToken();
    const wsUrl = resolveWebSocketUrl(`/api/latency/ws?token=${encodeURIComponent(token)}`);
    setWsTarget(wsUrl);

    let ws;
    let pingInterval;
    let pingStart = 0;

    const connect = () => {
      ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      ws.onopen = () => {
        pingInterval = setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) {
            pingStart = performance.now();
            ws.send('ping');
          }
        }, 5000);
      };

      ws.onmessage = (e) => {
        if (e.data === 'pong') {
          const rtt = Math.round(performance.now() - pingStart);
          setWsLatencyMs(rtt);
          setWsLatencyHistory(prev => [...prev.slice(-29), rtt]);
        }
      };

      ws.onerror = () => setWsLatencyMs(null);
      ws.onclose = () => clearInterval(pingInterval);
    };

    connect();

    return () => {
      clearInterval(pingInterval);
      if (ws) ws.close();
    };
  }, [windowActive]);

  // Client frame time
  useEffect(() => {
    if (!windowActive) {
      setClientFrameMs(null);
      if (frameRef.current) {
        cancelAnimationFrame(frameRef.current);
        frameRef.current = null;
      }
      return undefined;
    }

    let lastTime = performance.now();
    let lastReport = lastTime;
    let frameTime = 0;
    let frameCount = 0;
    let running = true;

    const measure = () => {
      if (!running) return;
      const now = performance.now();
      const delta = now - lastTime;
      lastTime = now;

      if (delta > 0 && delta < 1000) {
        frameTime += delta;
        frameCount += 1;
      }
      if (now - lastReport >= 1000) {
        if (frameCount > 0) {
          const average = Math.round(frameTime / frameCount);
          setClientFrameMs(average);
          setClientFrameHistory(prev => [...prev.slice(-29), average]);
        }
        lastReport = now;
        frameTime = 0;
        frameCount = 0;
      }

      frameRef.current = requestAnimationFrame(measure);
    };

    frameRef.current = requestAnimationFrame(measure);

    return () => {
      running = false;
      if (frameRef.current) cancelAnimationFrame(frameRef.current);
    };
  }, [windowActive]);

  const getStatus = (pct) => pct >= 85 ? 'critical' : pct >= 70 ? 'warning' : 'healthy';
  const getColor = (status) => status === 'critical' ? 'var(--error)' : status === 'warning' ? 'var(--warning)' : 'var(--success)';

  const memPct = systemStats?.memoryPercent ?? 0;
  const cpuPct = systemStats?.cpuPercent ?? 0;
  const memStatus = getStatus(memPct);
  const cpuStatus = getStatus(cpuPct);
  const overallStatus = memStatus === 'critical' || cpuStatus === 'critical' ? 'critical' :
                        memStatus === 'warning' || cpuStatus === 'warning' ? 'warning' : 'healthy';
  const statusLabel = overallStatus === 'critical' ? 'Resources Low' : overallStatus === 'warning' ? 'Moderate Load' : 'Healthy';

  return (
    <div className="system-resources-view">
      <div className="sr-header">
        <div className="sr-title-section">
          <h1>System Resources</h1>
          <span className={`sr-status-badge ${overallStatus}`}>{statusLabel}</span>
        </div>
        <div className="sr-time-range">
          {onClose && <button type="button" className="btn-secondary btn-small" onClick={onClose}>Back to workspace</button>}
          <select aria-label="History range" value={historyRange} onChange={(e) => setHistoryRange(e.target.value)}>
            <option value="1h">Last Hour</option>
            <option value="6h">Last 6 Hours</option>
            <option value="24h">Last 24 Hours</option>
            <option value="7d">Last 7 Days</option>
            <option value="30d">Last 30 Days</option>
          </select>
        </div>
      </div>

      {statsHistory?.historyError && (
        <div className="sr-alert warning" role="status">
          {statsHistory.historyPersistenceEnabled === false
            ? 'History is temporary and will be lost when this server restarts. Current metrics remain available.'
            : 'Saved history was recovered. Earlier data was preserved for recovery.'}
        </div>
      )}

      {overallStatus !== 'healthy' && (
        <div className={`sr-alert ${overallStatus}`}>
          {overallStatus === 'critical'
            ? 'System resources are running low. Consider closing unused sessions or upgrading the VM.'
            : 'Resource usage is elevated. Monitor for potential slowdowns.'}
        </div>
      )}

      <div className="sr-grid primary">
        {/* RAM Card */}
        <div className="sr-card large">
          <div className="sr-card-header">
            <span className="sr-card-icon">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <rect x="4" y="4" width="16" height="16" rx="2" />
                <line x1="4" y1="12" x2="20" y2="12" />
                <line x1="12" y1="4" x2="12" y2="20" />
              </svg>
            </span>
            <span className="sr-card-title">Memory</span>
          </div>
          <div className="sr-card-body">
            <div className="sr-circular-container">
              <CircularProgress value={memPct} size={100} strokeWidth={10} color={getColor(memStatus)} />
              <div className="sr-circular-label">
                <span className="sr-circular-value" style={{ color: getColor(memStatus) }}>{Math.round(memPct)}%</span>
                <span className="sr-circular-unit">used</span>
              </div>
            </div>
            <div className="sr-stats-list">
              <div className="sr-stat-row">
                <span className="sr-stat-label">Used</span>
                <span className="sr-stat-value">{systemStats ? formatBytes(systemStats.memoryUsed) : '—'}</span>
              </div>
              <div className="sr-stat-row">
                <span className="sr-stat-label">Free</span>
                <span className="sr-stat-value" style={{ color: getColor(memStatus) }}>{systemStats ? formatBytes(Math.max(0, systemStats.memoryTotal - systemStats.memoryUsed)) : '—'}</span>
              </div>
              <div className="sr-stat-row">
                <span className="sr-stat-label">Total</span>
                <span className="sr-stat-value">{systemStats ? formatBytes(systemStats.memoryTotal) : '—'}</span>
              </div>
            </div>
          </div>
          {statsHistory?.history?.length > 1 && (
            <div className="sr-card-chart">
              <Sparkline data={statsHistory.history.map(p => p.memoryPercent)} color="var(--accent-primary-light)" height={50} width={280} />
              <div className="sr-chart-legend">
                Avg: {Math.round(statsHistory.history.reduce((a, p) => a + p.memoryPercent, 0) / statsHistory.history.length)}% · Max: {Math.round(Math.max(...statsHistory.history.map(p => p.memoryPercent)))}%
              </div>
            </div>
          )}
        </div>

        {/* CPU Card */}
        <div className="sr-card large">
          <div className="sr-card-header">
            <span className="sr-card-icon">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <rect x="4" y="4" width="16" height="16" rx="2" />
                <rect x="9" y="9" width="6" height="6" />
                <line x1="9" y1="1" x2="9" y2="4" />
                <line x1="15" y1="1" x2="15" y2="4" />
                <line x1="9" y1="20" x2="9" y2="23" />
                <line x1="15" y1="20" x2="15" y2="23" />
                <line x1="20" y1="9" x2="23" y2="9" />
                <line x1="20" y1="15" x2="23" y2="15" />
                <line x1="1" y1="9" x2="4" y2="9" />
                <line x1="1" y1="15" x2="4" y2="15" />
              </svg>
            </span>
            <span className="sr-card-title">CPU</span>
            <span className="sr-card-badge">{systemStats?.cpu?.cores ?? '—'} cores</span>
          </div>
          <div className="sr-card-body">
            <div className="sr-circular-container">
              <CircularProgress value={cpuPct} size={100} strokeWidth={10} color={getColor(cpuStatus)} />
              <div className="sr-circular-label">
                <span className="sr-circular-value" style={{ color: getColor(cpuStatus) }}>{Math.round(cpuPct)}%</span>
                <span className="sr-circular-unit">used</span>
              </div>
            </div>
            <div className="sr-stats-list">
              <div className="sr-stat-row">
                <span className="sr-stat-label">Used</span>
                <span className="sr-stat-value">{Math.round(cpuPct)}%</span>
              </div>
              <div className="sr-stat-row">
                <span className="sr-stat-label">Available</span>
                <span className="sr-stat-value" style={{ color: getColor(cpuStatus) }}>{Math.round(100 - cpuPct)}%</span>
              </div>
            </div>
          </div>
          {statsHistory?.history?.length > 1 && (
            <div className="sr-card-chart">
              <Sparkline data={statsHistory.history.map(p => p.cpuPercent)} color="var(--success)" height={50} width={280} />
              <div className="sr-chart-legend">
                Avg: {Math.round(statsHistory.history.reduce((a, p) => a + p.cpuPercent, 0) / statsHistory.history.length)}% · Max: {Math.round(Math.max(...statsHistory.history.map(p => p.cpuPercent)))}%
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="sr-grid secondary">
        {/* Disk storage */}
        <div className="sr-card">
          <div className="sr-card-header">
            <span className="sr-card-icon">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <ellipse cx="12" cy="5" rx="9" ry="3" />
                <path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3" />
                <path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5" />
              </svg>
            </span>
            <span className="sr-card-title">Disk storage</span>
          </div>
          <div className="sr-card-body io">
            <div className="sr-io-row">
              <span className="sr-io-direction read">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                  <line x1="12" y1="5" x2="12" y2="19" />
                  <polyline points="19 12 12 19 5 12" />
                </svg>
                Used
              </span>
              <span className="sr-io-value">{systemStats ? formatBytes(systemStats.diskUsed) : '—'}</span>
            </div>
            <div className="sr-io-row">
              <span className="sr-io-direction write">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                  <line x1="12" y1="19" x2="12" y2="5" />
                  <polyline points="5 12 12 5 19 12" />
                </svg>
                Total
              </span>
              <span className="sr-io-value">{systemStats ? formatBytes(systemStats.diskTotal) : '—'}</span>
            </div>
          </div>
          {statsHistory?.history?.length > 1 && (
            <div className="sr-card-chart small">
              <Sparkline data={statsHistory.history.map(p => p.diskPercent)} color="var(--accent-info)" height={30} width={100} />
              <span className="sr-mini-label">Storage used (%)</span>
            </div>
          )}
        </div>

        {/* Network Latency */}
        <div className="sr-card">
          <div className="sr-card-header">
            <span className="sr-card-icon">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M5 12.55a11 11 0 0 1 14.08 0" />
                <path d="M1.42 9a16 16 0 0 1 21.16 0" />
                <path d="M8.53 16.11a6 6 0 0 1 6.95 0" />
                <line x1="12" y1="20" x2="12.01" y2="20" />
              </svg>
            </span>
            <span className="sr-card-title">Network</span>
          </div>
          <div className="sr-card-body latency">
            <div className="sr-latency-row">
              <span className="sr-latency-label">API</span>
              <span className="sr-latency-value">{latencyMs !== null ? `${latencyMs}ms` : '—'}</span>
              {latencyHistory.length > 1 && (
                <Sparkline data={latencyHistory} color="var(--accent-primary-light)" height={24} width={60} />
              )}
            </div>
            <div className="sr-latency-row">
              <span className="sr-latency-label">WebSocket</span>
              <span className="sr-latency-value">{wsLatencyMs !== null ? `${wsLatencyMs}ms` : '—'}</span>
              {wsLatencyHistory.length > 1 && (
                <Sparkline data={wsLatencyHistory} color="var(--accent-info)" height={24} width={60} />
              )}
            </div>
          </div>
        </div>

        {/* Performance */}
        <div className="sr-card">
          <div className="sr-card-header">
            <span className="sr-card-icon">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
              </svg>
            </span>
            <span className="sr-card-title">Performance</span>
          </div>
          <div className="sr-card-body latency">
            <div className="sr-latency-row">
              <span className="sr-latency-label">Client Frame</span>
              <span className="sr-latency-value">{clientFrameMs !== null ? `${clientFrameMs}ms` : '—'}</span>
              {clientFrameHistory.length > 1 && (
                <Sparkline data={clientFrameHistory} color="var(--accent-primary)" height={24} width={60} />
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Top Processes */}
      {systemStats?.processes?.length > 0 && (
        <div className="sr-processes-section">
          <h2>Top Processes</h2>
          <div className="sr-processes-table">
            <div className="sr-process-header">
              <span className="sr-process-name">Process</span>
              <span className="sr-process-cpu">CPU</span>
              <span className="sr-process-mem">Memory</span>
            </div>
            {systemStats.processes.map((proc) => (
              <div key={proc.pid} className="sr-process-row">
                <span className="sr-process-name" title={proc.name}>{proc.name}</span>
                <span className={`sr-process-cpu ${proc.cpu > 50 ? 'critical' : proc.cpu > 20 ? 'warning' : ''}`}>
                  {proc.cpu.toFixed(1)}%
                </span>
                <span className="sr-process-mem">{formatMB(proc.memoryBytes)}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {statsHistory?.history?.length > 0 && (
        <div className="sr-footer">
          {statsHistory.history.length} data points collected
        </div>
      )}


    </div>
  );
}

export default SystemResourcesView;
