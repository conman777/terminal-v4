import { useState, useEffect, useRef, useCallback } from 'react';
import { apiGet } from '../utils/api';
import { getAccessToken } from '../utils/auth';
import { useSystemStatsPolling } from '../hooks/useSystemStatsPolling';

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

// Format disk I/O rates to human-readable format
function formatIORate(mbps) {
  if (mbps >= 1000) {
    return `${(mbps / 1024).toFixed(1)} GB/s`;
  } else if (mbps >= 1) {
    return `${mbps.toFixed(1)} MB/s`;
  } else if (mbps >= 0.01) {
    return `${(mbps * 1024).toFixed(0)} KB/s`;
  } else {
    return `${(mbps * 1024 * 1024).toFixed(0)} B/s`;
  }
}

// Mini sparkline chart
function Sparkline({ data, color, height = 40, width = 100 }) {
  if (!data || data.length < 2) {
    return (
      <div style={{ width, height, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-muted)', fontSize: '10px' }}>
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
  const gradientId = `gradient-${color.replace(/[^a-z0-9]/gi, '')}`;

  return (
    <svg width={width} height={height} style={{ display: 'block' }}>
      <defs>
        <linearGradient id={gradientId} x1="0%" y1="0%" x2="0%" y2="100%">
          <stop offset="0%" stopColor={color} stopOpacity="0.4" />
          <stop offset="100%" stopColor={color} stopOpacity="0.05" />
        </linearGradient>
      </defs>
      <path d={areaD} fill={`url(#${gradientId})`} />
      <path d={pathD} fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

// Circular progress indicator
function CircularProgress({ value, size = 80, strokeWidth = 8, color }) {
  const radius = (size - strokeWidth) / 2;
  const circumference = radius * 2 * Math.PI;
  const offset = circumference - (value / 100) * circumference;

  return (
    <svg width={size} height={size} style={{ transform: 'rotate(-90deg)' }}>
      <circle
        cx={size / 2}
        cy={size / 2}
        r={radius}
        fill="none"
        stroke="var(--border-default)"
        strokeWidth={strokeWidth}
      />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={radius}
        fill="none"
        stroke={color}
        strokeWidth={strokeWidth}
        strokeDasharray={circumference}
        strokeDashoffset={offset}
        strokeLinecap="round"
        style={{ transition: 'stroke-dashoffset 0.5s ease' }}
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

export function SystemResourcesView() {
  const systemStats = useSystemStatsPolling(true);
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

  // Fetch history
  useEffect(() => {
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
  }, [historyRange]);

  // API latency measurement
  useEffect(() => {
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
  }, []);

  // WebSocket latency
  useEffect(() => {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const host = window.location.host;
    const token = getAccessToken();
    const wsUrl = `${protocol}//${host}/api/latency/ws?token=${token}`;
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
  }, []);

  // Client frame time
  useEffect(() => {
    let lastTime = performance.now();
    let running = true;

    const measure = () => {
      if (!running) return;
      const now = performance.now();
      const delta = Math.round(now - lastTime);
      lastTime = now;

      if (delta < 1000) {
        setClientFrameMs(delta);
        setClientFrameHistory(prev => [...prev.slice(-29), delta]);
      }

      frameRef.current = requestAnimationFrame(measure);
    };

    frameRef.current = requestAnimationFrame(measure);

    return () => {
      running = false;
      if (frameRef.current) cancelAnimationFrame(frameRef.current);
    };
  }, []);

  const getStatus = (pct) => pct >= 85 ? 'critical' : pct >= 70 ? 'warning' : 'healthy';
  const getColor = (status) => status === 'critical' ? '#ef4444' : status === 'warning' ? '#f59e0b' : '#22c55e';

  const memPct = systemStats?.memory?.percentage ?? 0;
  const cpuPct = systemStats?.cpu?.percentage ?? 0;
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
          <select value={historyRange} onChange={(e) => setHistoryRange(e.target.value)}>
            <option value="1h">Last Hour</option>
            <option value="6h">Last 6 Hours</option>
            <option value="24h">Last 24 Hours</option>
            <option value="7d">Last 7 Days</option>
            <option value="30d">Last 30 Days</option>
          </select>
        </div>
      </div>

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
                <span className="sr-circular-value" style={{ color: getColor(memStatus) }}>{memPct}%</span>
                <span className="sr-circular-unit">used</span>
              </div>
            </div>
            <div className="sr-stats-list">
              <div className="sr-stat-row">
                <span className="sr-stat-label">Used</span>
                <span className="sr-stat-value">{systemStats ? formatBytes(systemStats.memory.used) : '—'}</span>
              </div>
              <div className="sr-stat-row">
                <span className="sr-stat-label">Free</span>
                <span className="sr-stat-value" style={{ color: getColor(memStatus) }}>{systemStats ? formatBytes(systemStats.memory.free) : '—'}</span>
              </div>
              <div className="sr-stat-row">
                <span className="sr-stat-label">Total</span>
                <span className="sr-stat-value">{systemStats ? formatBytes(systemStats.memory.total) : '—'}</span>
              </div>
            </div>
          </div>
          {statsHistory?.history?.length > 1 && (
            <div className="sr-card-chart">
              <Sparkline data={statsHistory.history.map(p => p.memory)} color="#3b82f6" height={50} width={280} />
              <div className="sr-chart-legend">
                Avg: {Math.round(statsHistory.history.reduce((a, p) => a + p.memory, 0) / statsHistory.history.length)}% · Max: {Math.max(...statsHistory.history.map(p => p.memory))}%
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
                <span className="sr-circular-value" style={{ color: getColor(cpuStatus) }}>{cpuPct}%</span>
                <span className="sr-circular-unit">used</span>
              </div>
            </div>
            <div className="sr-stats-list">
              <div className="sr-stat-row">
                <span className="sr-stat-label">Used</span>
                <span className="sr-stat-value">{cpuPct}%</span>
              </div>
              <div className="sr-stat-row">
                <span className="sr-stat-label">Available</span>
                <span className="sr-stat-value" style={{ color: getColor(cpuStatus) }}>{100 - cpuPct}%</span>
              </div>
            </div>
          </div>
          {statsHistory?.history?.length > 1 && (
            <div className="sr-card-chart">
              <Sparkline data={statsHistory.history.map(p => p.cpu)} color="#22c55e" height={50} width={280} />
              <div className="sr-chart-legend">
                Avg: {Math.round(statsHistory.history.reduce((a, p) => a + p.cpu, 0) / statsHistory.history.length)}% · Max: {Math.max(...statsHistory.history.map(p => p.cpu))}%
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="sr-grid secondary">
        {/* Disk I/O */}
        <div className="sr-card">
          <div className="sr-card-header">
            <span className="sr-card-icon">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <ellipse cx="12" cy="5" rx="9" ry="3" />
                <path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3" />
                <path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5" />
              </svg>
            </span>
            <span className="sr-card-title">Disk I/O</span>
          </div>
          <div className="sr-card-body io">
            <div className="sr-io-row">
              <span className="sr-io-direction read">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                  <line x1="12" y1="5" x2="12" y2="19" />
                  <polyline points="19 12 12 19 5 12" />
                </svg>
                Read
              </span>
              <span className="sr-io-value">{systemStats?.disk ? formatIORate(systemStats.disk.readMBps) : '—'}</span>
            </div>
            <div className="sr-io-row">
              <span className="sr-io-direction write">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                  <line x1="12" y1="19" x2="12" y2="5" />
                  <polyline points="5 12 12 5 19 12" />
                </svg>
                Write
              </span>
              <span className="sr-io-value">{systemStats?.disk ? formatIORate(systemStats.disk.writeMBps) : '—'}</span>
            </div>
          </div>
          {statsHistory?.history?.length > 1 && (
            <div className="sr-card-chart small">
              <div className="sr-dual-chart">
                <div>
                  <Sparkline data={statsHistory.history.map(p => p.diskRead || 0)} color="#06b6d4" height={30} width={100} />
                  <span className="sr-mini-label">Read</span>
                </div>
                <div>
                  <Sparkline data={statsHistory.history.map(p => p.diskWrite || 0)} color="#f59e0b" height={30} width={100} />
                  <span className="sr-mini-label">Write</span>
                </div>
              </div>
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
                <Sparkline data={latencyHistory} color="#3b82f6" height={24} width={60} />
              )}
            </div>
            <div className="sr-latency-row">
              <span className="sr-latency-label">WebSocket</span>
              <span className="sr-latency-value">{wsLatencyMs !== null ? `${wsLatencyMs}ms` : '—'}</span>
              {wsLatencyHistory.length > 1 && (
                <Sparkline data={wsLatencyHistory} color="#38bdf8" height={24} width={60} />
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
                <Sparkline data={clientFrameHistory} color="#f59e0b" height={24} width={60} />
              )}
            </div>
            <div className="sr-latency-row">
              <span className="sr-latency-label">Server Loop</span>
              <span className="sr-latency-value">
                {systemStats?.eventLoop?.meanMs != null ? `${systemStats.eventLoop.meanMs}ms` : '—'}
                {systemStats?.eventLoop?.maxMs != null && <span className="sr-latency-max"> (max {systemStats.eventLoop.maxMs})</span>}
              </span>
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
              <span className="sr-process-ports">Ports</span>
              <span className="sr-process-cpu">CPU</span>
              <span className="sr-process-mem">Memory</span>
            </div>
            {systemStats.processes.map((proc) => (
              <div key={proc.pid} className="sr-process-row">
                <span className="sr-process-name" title={proc.name}>{proc.name}</span>
                <span className="sr-process-ports" title={proc.ports?.join(', ')}>
                  {proc.ports?.length ? proc.ports.join(', ') : '—'}
                </span>
                <span className={`sr-process-cpu ${proc.cpu > 50 ? 'critical' : proc.cpu > 20 ? 'warning' : ''}`}>
                  {proc.cpu.toFixed(1)}%
                </span>
                <span className="sr-process-mem">{formatMB(proc.memoryBytes)}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {statsHistory?.count > 0 && (
        <div className="sr-footer">
          {statsHistory.count} data points collected
        </div>
      )}

      <style jsx>{`
        .system-resources-view {
          height: 100%;
          overflow-y: auto;
          background: var(--bg-primary, #0a0a0c);
          padding: 24px;
          scrollbar-width: thin;
          scrollbar-color: var(--border-default) transparent;
        }

        .sr-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          margin-bottom: 20px;
        }

        .sr-title-section {
          display: flex;
          align-items: center;
          gap: 12px;
        }

        .sr-title-section h1 {
          margin: 0;
          font-size: 16px;
          font-weight: 700;
          color: var(--accent-primary, #f59e0b);
          text-transform: uppercase;
          letter-spacing: 0.5px;
        }

        .sr-status-badge {
          font-size: 11px;
          font-weight: 600;
          padding: 3px 10px;
          border-radius: 20px;
        }

        .sr-status-badge.healthy {
          background: rgba(34, 197, 94, 0.1);
          color: #22c55e;
        }

        .sr-status-badge.warning {
          background: rgba(245, 158, 11, 0.1);
          color: #f59e0b;
        }

        .sr-status-badge.critical {
          background: rgba(239, 68, 68, 0.1);
          color: #ef4444;
        }

        .sr-time-range select {
          background: rgba(255, 255, 255, 0.03);
          border: 1px solid rgba(255, 255, 255, 0.06);
          border-radius: 6px;
          padding: 6px 12px;
          color: var(--text-primary);
          font-size: 12px;
          cursor: pointer;
          transition: border-color 0.15s ease;
        }

        .sr-time-range select:hover {
          border-color: rgba(245, 158, 11, 0.3);
        }

        .sr-alert {
          padding: 12px 16px;
          border-radius: 8px;
          font-size: 13px;
          margin-bottom: 20px;
        }

        .sr-alert.warning {
          background: rgba(245, 158, 11, 0.06);
          border: 1px solid rgba(245, 158, 11, 0.2);
          color: #f59e0b;
        }

        .sr-alert.critical {
          background: rgba(239, 68, 68, 0.06);
          border: 1px solid rgba(239, 68, 68, 0.2);
          color: #ef4444;
        }

        .sr-grid {
          display: grid;
          gap: 14px;
          margin-bottom: 14px;
        }

        .sr-grid.primary {
          grid-template-columns: repeat(2, 1fr);
        }

        .sr-grid.secondary {
          grid-template-columns: repeat(3, 1fr);
        }

        @media (max-width: 1200px) {
          .sr-grid.primary {
            grid-template-columns: 1fr;
          }
          .sr-grid.secondary {
            grid-template-columns: repeat(2, 1fr);
          }
        }

        @media (max-width: 800px) {
          .sr-grid.secondary {
            grid-template-columns: 1fr;
          }
        }

        .sr-card {
          background: rgba(255, 255, 255, 0.02);
          border: 1px solid rgba(255, 255, 255, 0.04);
          border-radius: 10px;
          padding: 16px;
          transition: border-color 0.15s ease;
        }

        .sr-card:hover {
          border-color: rgba(255, 255, 255, 0.08);
        }

        .sr-card.large {
          padding: 20px;
        }

        .sr-card-header {
          display: flex;
          align-items: center;
          gap: 8px;
          margin-bottom: 16px;
        }

        .sr-card-icon {
          color: var(--text-muted);
          opacity: 0.6;
        }

        .sr-card-title {
          font-size: 11px;
          font-weight: 600;
          color: var(--text-muted);
          text-transform: uppercase;
          letter-spacing: 1px;
        }

        .sr-card-badge {
          margin-left: auto;
          font-size: 10px;
          color: var(--text-muted);
          background: rgba(255, 255, 255, 0.04);
          padding: 2px 8px;
          border-radius: 10px;
        }

        .sr-card-body {
          display: flex;
          gap: 24px;
          align-items: center;
        }

        .sr-card-body.io {
          flex-direction: column;
          gap: 8px;
          align-items: stretch;
        }

        .sr-card-body.latency {
          flex-direction: column;
          gap: 10px;
          align-items: stretch;
        }

        .sr-circular-container {
          position: relative;
          display: flex;
          align-items: center;
          justify-content: center;
        }

        .sr-circular-label {
          position: absolute;
          display: flex;
          flex-direction: column;
          align-items: center;
          text-align: center;
        }

        .sr-circular-value {
          font-size: 22px;
          font-weight: 700;
          line-height: 1;
        }

        .sr-circular-unit {
          font-size: 10px;
          color: var(--text-muted);
          margin-top: 2px;
        }

        .sr-stats-list {
          flex: 1;
          display: flex;
          flex-direction: column;
          gap: 8px;
        }

        .sr-stat-row {
          display: flex;
          justify-content: space-between;
          align-items: center;
        }

        .sr-stat-label {
          font-size: 12px;
          color: var(--text-muted);
        }

        .sr-stat-value {
          font-size: 13px;
          font-weight: 500;
          color: var(--text-primary);
          font-family: var(--font-mono);
        }

        .sr-card-chart {
          margin-top: 16px;
          padding-top: 16px;
          box-shadow: 0 -1px 0 rgba(255, 255, 255, 0.03);
        }

        .sr-card-chart.small {
          margin-top: 12px;
          padding-top: 12px;
        }

        .sr-chart-legend {
          font-size: 10px;
          color: var(--text-muted);
          margin-top: 6px;
          text-align: center;
        }

        .sr-dual-chart {
          display: flex;
          gap: 16px;
          justify-content: center;
        }

        .sr-dual-chart > div {
          text-align: center;
        }

        .sr-mini-label {
          font-size: 10px;
          color: var(--text-muted);
          display: block;
          margin-top: 4px;
        }

        .sr-io-row {
          display: flex;
          align-items: center;
          gap: 12px;
          padding: 8px 12px;
          background: rgba(255, 255, 255, 0.02);
          border-radius: 8px;
        }

        .sr-io-direction {
          display: flex;
          align-items: center;
          gap: 6px;
          font-size: 12px;
          font-weight: 500;
          min-width: 60px;
        }

        .sr-io-direction.read {
          color: #06b6d4;
        }

        .sr-io-direction.write {
          color: var(--accent-primary, #f59e0b);
        }

        .sr-io-value {
          margin-left: auto;
          font-size: 13px;
          font-weight: 600;
          color: var(--text-primary);
          font-family: var(--font-mono);
        }

        .sr-latency-row {
          display: flex;
          align-items: center;
          gap: 12px;
          padding: 6px 0;
        }

        .sr-latency-label {
          font-size: 11px;
          color: var(--text-muted);
          min-width: 80px;
        }

        .sr-latency-value {
          font-size: 13px;
          font-weight: 500;
          color: var(--text-primary);
          font-family: var(--font-mono);
          min-width: 60px;
        }

        .sr-latency-max {
          font-size: 10px;
          color: var(--text-muted);
          font-weight: 400;
        }

        .sr-processes-section {
          margin-top: 20px;
        }

        .sr-processes-section h2 {
          font-size: 11px;
          font-weight: 600;
          color: var(--text-muted);
          text-transform: uppercase;
          letter-spacing: 1px;
          margin: 0 0 10px 0;
        }

        .sr-processes-table {
          background: rgba(255, 255, 255, 0.02);
          border: 1px solid rgba(255, 255, 255, 0.04);
          border-radius: 10px;
          overflow: hidden;
        }

        .sr-process-header,
        .sr-process-row {
          display: grid;
          grid-template-columns: 1fr 100px 70px 80px;
          gap: 12px;
          padding: 10px 16px;
          font-family: var(--font-mono);
          font-size: 12px;
        }

        .sr-process-header {
          background: rgba(255, 255, 255, 0.02);
          font-weight: 600;
          color: var(--text-muted);
          text-transform: uppercase;
          font-size: 10px;
          letter-spacing: 0.5px;
        }

        .sr-process-row {
          box-shadow: 0 -1px 0 rgba(255, 255, 255, 0.03);
          color: var(--text-primary);
          transition: background 0.1s ease;
        }

        .sr-process-row:hover {
          background: rgba(255, 255, 255, 0.03);
        }

        .sr-process-name {
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }

        .sr-process-ports {
          color: var(--accent-info, #38bdf8);
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }

        .sr-process-cpu {
          text-align: right;
        }

        .sr-process-cpu.critical {
          color: var(--error, #fb3654);
        }

        .sr-process-cpu.warning {
          color: var(--accent-primary, #f59e0b);
        }

        .sr-process-mem {
          text-align: right;
        }

        .sr-footer {
          margin-top: 16px;
          text-align: center;
          font-size: 10px;
          color: var(--text-muted);
          opacity: 0.6;
        }
      `}</style>
    </div>
  );
}

export default SystemResourcesView;
