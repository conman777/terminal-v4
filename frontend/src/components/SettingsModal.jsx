import { useState, useRef, useEffect } from 'react';
import { FolderBrowserModal } from './FolderBrowserModal';
import { apiGet } from '../utils/api';
import { getAccessToken } from '../utils/auth';

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

// Simple sparkline chart component
function Sparkline({ data, color, height = 32, width = 120 }) {
  if (!data || data.length < 2) {
    return (
      <div style={{ width, height, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-secondary)', fontSize: '10px' }}>
        No data yet
      </div>
    );
  }

  const max = Math.max(...data, 100);
  const min = Math.min(...data, 0);
  const range = max - min || 1;

  // Create SVG path
  const points = data.map((value, i) => {
    const x = (i / (data.length - 1)) * width;
    const y = height - ((value - min) / range) * (height - 4) - 2;
    return `${x},${y}`;
  });

  const pathD = `M ${points.join(' L ')}`;

  // Area fill path
  const areaD = `M 0,${height} L ${points.join(' L ')} L ${width},${height} Z`;

  return (
    <svg width={width} height={height} style={{ display: 'block' }}>
      <defs>
        <linearGradient id={`gradient-${color.replace(/[^a-z]/gi, '')}`} x1="0%" y1="0%" x2="0%" y2="100%">
          <stop offset="0%" stopColor={color} stopOpacity="0.3" />
          <stop offset="100%" stopColor={color} stopOpacity="0.05" />
        </linearGradient>
      </defs>
      <path d={areaD} fill={`url(#gradient-${color.replace(/[^a-z]/gi, '')})`} />
      <path d={pathD} fill="none" stroke={color} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function SettingsModal({ isOpen, onClose, sessionId, sessionTitle, currentCwd, recentFolders, onSave, onAddRecentFolder, terminalFontSize, onFontSizeChange, terminalWebglEnabled, onWebglChange }) {
  const [workingDir, setWorkingDir] = useState(currentCwd || '');
  const [showDropdown, setShowDropdown] = useState(false);
  const [showFolderBrowser, setShowFolderBrowser] = useState(false);
  const resolvedWebglEnabled = terminalWebglEnabled !== false;
  const [systemStats, setSystemStats] = useState(null);
  const [statsHistory, setStatsHistory] = useState(null);
  const [historyRange, setHistoryRange] = useState('24h');
  const [latencyMs, setLatencyMs] = useState(null);
  const [latencyHistory, setLatencyHistory] = useState([]);
  const [wsLatencyMs, setWsLatencyMs] = useState(null);
  const [wsLatencyHistory, setWsLatencyHistory] = useState([]);
  const [wsTarget, setWsTarget] = useState(null);
  const [clientFrameMs, setClientFrameMs] = useState(null);
  const [clientFrameHistory, setClientFrameHistory] = useState([]);
  const dropdownRef = useRef(null);

  // Update local state when modal opens
  useEffect(() => {
    if (isOpen) {
      setWorkingDir(currentCwd || '');
    }
  }, [isOpen, currentCwd]);

  // Close dropdown on outside click
  useEffect(() => {
    const handleClickOutside = (event) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target)) {
        setShowDropdown(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // Poll system stats while modal is open
  useEffect(() => {
    if (!isOpen) {
      setSystemStats(null);
      return;
    }

    const fetchStats = async () => {
      try {
        const stats = await apiGet('/api/system/stats');
        if (stats.memory) {
          setSystemStats(stats);
        }
      } catch (err) {
        // Silently fail - stats are optional
      }
    };

    fetchStats();
    const interval = setInterval(fetchStats, 5000); // 5s is sufficient for system stats
    return () => clearInterval(interval);
  }, [isOpen]);

  // Poll API latency while modal is open
  useEffect(() => {
    if (!isOpen) {
      setLatencyMs(null);
      setLatencyHistory([]);
      setWsLatencyMs(null);
      setWsLatencyHistory([]);
      setWsTarget(null);
      setClientFrameMs(null);
      setClientFrameHistory([]);
      return;
    }

    let active = true;
    const measureLatency = async () => {
      const start = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
      try {
        await apiGet('/api/health');
        const end = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
        if (active) {
          const latency = Math.round(end - start);
          setLatencyMs(latency);
          setLatencyHistory((prev) => {
            const next = [...prev, latency];
            return next.slice(-60);
          });
        }
      } catch {
        if (active) {
          setLatencyMs(null);
        }
      }
    };

    measureLatency();
    const interval = setInterval(measureLatency, 10000);
    return () => {
      active = false;
      clearInterval(interval);
    };
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) {
      setWsLatencyMs(null);
      setWsLatencyHistory([]);
      return;
    }

    let socket = null;
    let pingTimer = null;
    let active = true;
    let nextId = 1;

    const buildWsUrl = () => {
      const token = getAccessToken();
      const base = import.meta.env.VITE_API_URL || window.location.origin;
      const url = new URL('/api/latency/ws', base);
      if (token) url.searchParams.set('token', token);
      url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
      setWsTarget(url.toString());
      return url.toString();
    };

    const connect = () => {
      socket = new WebSocket(buildWsUrl());

      socket.onopen = () => {
        const sendPing = () => {
          if (!socket || socket.readyState !== WebSocket.OPEN) return;
          const sentAt = (typeof performance !== 'undefined' && performance.now)
            ? performance.now()
            : Date.now();
          socket.send(JSON.stringify({ type: 'ping', id: nextId++, sentAt }));
        };
        sendPing();
        pingTimer = setInterval(sendPing, 5000);
      };

      socket.onmessage = (event) => {
        if (!active) return;
        let data = event.data;
        if (typeof data !== 'string') {
          data = new TextDecoder().decode(data);
        }
        if (!data.startsWith('{')) return;
        try {
          const msg = JSON.parse(data);
          if (msg?.type !== 'pong') return;
          const now = (typeof performance !== 'undefined' && performance.now)
            ? performance.now()
            : Date.now();
          if (typeof msg.sentAt !== 'number') return;
          const rtt = Math.round(now - msg.sentAt);
          setWsLatencyMs(rtt);
          setWsLatencyHistory((prev) => {
            const next = [...prev, rtt];
            return next.slice(-60);
          });
        } catch {
          // Ignore malformed messages.
        }
      };
    };

    connect();

    return () => {
      active = false;
      if (pingTimer) clearInterval(pingTimer);
      if (socket) socket.close();
    };
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) {
      setClientFrameMs(null);
      setClientFrameHistory([]);
      return;
    }

    let rafId = null;
    let last = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
    let active = true;

    const tick = (now) => {
      if (!active) return;
      const delta = now - last;
      last = now;
      setClientFrameMs(Math.round(delta));
      setClientFrameHistory((prev) => {
        const next = [...prev, delta];
        return next.slice(-60);
      });
      rafId = requestAnimationFrame(tick);
    };

    rafId = requestAnimationFrame(tick);
    return () => {
      active = false;
      if (rafId) cancelAnimationFrame(rafId);
    };
  }, [isOpen]);

  // Fetch stats history when modal opens or range changes
  useEffect(() => {
    if (!isOpen) {
      setStatsHistory(null);
      return;
    }

    const fetchHistory = async () => {
      try {
        const data = await apiGet(`/api/system/stats/history?range=${historyRange}`);
        if (data.history) {
          setStatsHistory(data);
        }
      } catch (err) {
        // Silently fail
      }
    };

    fetchHistory();
    // Refresh history every minute
    const interval = setInterval(fetchHistory, 60000);
    return () => clearInterval(interval);
  }, [isOpen, historyRange]);

  const handleSave = () => {
    if (workingDir && workingDir.trim()) {
      onAddRecentFolder(workingDir.trim());
    }
    onSave(sessionId, workingDir.trim());
    onClose();
  };

  const handleDownload = () => {
    const pathToDownload = workingDir || currentCwd;
    if (!pathToDownload) return;
    const params = new URLSearchParams({ path: pathToDownload });
    const token = getAccessToken();
    if (token) {
      params.set('token', token);
    }
    // Trigger download by navigating to the endpoint
    window.location.href = `/api/fs/download?${params.toString()}`;
  };

  const handleSelectFolder = (folder) => {
    setWorkingDir(folder);
    setShowDropdown(false);
  };

  const handleClear = () => {
    setWorkingDir('');
  };

  if (!isOpen) return null;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>Session Settings</h2>
          <button className="modal-close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>
        <div className="modal-body">
          <div className="form-group">
            <label>Session: <strong>{sessionTitle || 'New Terminal'}</strong></label>
          </div>
          <div className="form-group">
            <label htmlFor="working-dir">Working Directory</label>
            <div className="input-with-actions">
              <div className="input-with-dropdown" ref={dropdownRef}>
                <input
                  id="working-dir"
                  type="text"
                  value={workingDir}
                  onChange={(e) => setWorkingDir(e.target.value)}
                  placeholder="e.g., C:\Users\YourName\Projects"
                  onFocus={() => recentFolders.length > 0 && setShowDropdown(true)}
                />
                {recentFolders.length > 0 && (
                  <button
                    type="button"
                    className="dropdown-toggle"
                    onClick={() => setShowDropdown(!showDropdown)}
                    aria-label="Show recent folders"
                  >
                    ▼
                  </button>
                )}
                {showDropdown && recentFolders.length > 0 && (
                  <div className="folder-dropdown">
                    <div className="folder-dropdown-header">Recent Folders</div>
                    {recentFolders.map((folder, index) => (
                      <button
                        key={index}
                        type="button"
                        className="folder-dropdown-item"
                        onClick={() => handleSelectFolder(folder)}
                      >
                        <span className="folder-icon">📁</span>
                        <span className="folder-path" title={folder}>
                          {folder}
                        </span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
              <div className="input-actions">
                <button
                  type="button"
                  className="btn-secondary btn-small"
                  onClick={() => setShowFolderBrowser(true)}
                  title="Browse folders"
                >
                  Browse
                </button>
                {currentCwd && currentCwd !== workingDir && (
                  <button
                    type="button"
                    className="btn-secondary btn-small"
                    onClick={() => setWorkingDir(currentCwd)}
                    title="Use current terminal directory"
                  >
                    Use Current
                  </button>
                )}
                {workingDir && (
                  <button
                    type="button"
                    className="btn-secondary btn-small"
                    onClick={handleClear}
                    title="Clear directory"
                  >
                    Clear
                  </button>
                )}
              </div>
            </div>
            <small>
              {currentCwd ? (
                <>Current: <code>{currentCwd}</code></>
              ) : (
                'Leave empty to use backend default'
              )}
            </small>
          </div>
          <div className="form-group">
            <label htmlFor="font-size">Terminal Font Size</label>
            <div className="font-size-selector">
              <input
                id="font-size"
                type="range"
                min="10"
                max="24"
                value={terminalFontSize}
                onChange={(e) => onFontSizeChange(parseInt(e.target.value, 10))}
              />
              <span className="font-size-value">{terminalFontSize}px</span>
            </div>
            <small>Adjust terminal text size (changes apply immediately)</small>
          </div>
          <div className="form-group">
            <label>Terminal Renderer</label>
            <div className="mode-toggle" role="group" aria-label="Terminal renderer">
              <button
                type="button"
                className={`mode-btn ${resolvedWebglEnabled ? 'active' : ''}`}
                onClick={() => onWebglChange?.(true)}
              >
                WebGL
              </button>
              <button
                type="button"
                className={`mode-btn ${!resolvedWebglEnabled ? 'active' : ''}`}
                onClick={() => onWebglChange?.(false)}
              >
                Canvas
              </button>
            </div>
            <small>Use WebGL for GPU acceleration; switch to Canvas if you see glitches.</small>
          </div>

          {/* System Resources Section */}
          {systemStats && (() => {
            const memPct = systemStats.memory.percentage;
            const cpuPct = systemStats.cpu.percentage;
            const getStatus = (pct) => pct >= 85 ? 'critical' : pct >= 70 ? 'warning' : 'healthy';
            const getColor = (status) => status === 'critical' ? 'var(--accent-error)' : status === 'warning' ? 'var(--accent-warning)' : 'var(--accent-success, #22c55e)';
            const memStatus = getStatus(memPct);
            const cpuStatus = getStatus(cpuPct);
            const overallStatus = memStatus === 'critical' || cpuStatus === 'critical' ? 'critical' :
                                  memStatus === 'warning' || cpuStatus === 'warning' ? 'warning' : 'healthy';
            const statusLabel = overallStatus === 'critical' ? 'Resources Low' : overallStatus === 'warning' ? 'Moderate Load' : 'Healthy';
            const eventLoopMean = systemStats.eventLoop?.meanMs ?? null;
            const eventLoopMax = systemStats.eventLoop?.maxMs ?? null;

            // Calculate disk I/O percentages based on history peak
            let diskReadPct = 0;
            let diskWritePct = 0;
            if (statsHistory?.history?.length > 0) {
              const maxRead = Math.max(...statsHistory.history.map(p => p.diskRead || 0), 1);
              const maxWrite = Math.max(...statsHistory.history.map(p => p.diskWrite || 0), 1);
              diskReadPct = Math.min(100, Math.round((systemStats.disk?.readMBps || 0) / maxRead * 100));
              diskWritePct = Math.min(100, Math.round((systemStats.disk?.writeMBps || 0) / maxWrite * 100));
            }

            return (
            <div className="settings-section" style={{ marginTop: '1.5rem', paddingTop: '1.5rem', borderTop: '1px solid var(--border-dim)' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
                <h3 style={{ margin: 0, fontSize: '14px', fontWeight: 600, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>System Resources</h3>
                <span style={{
                  fontSize: '11px',
                  fontWeight: 600,
                  padding: '3px 8px',
                  borderRadius: '4px',
                  backgroundColor: getColor(overallStatus) + '20',
                  color: getColor(overallStatus)
                }}>
                  {statusLabel}
                </span>
              </div>

              <div className="stat-row">
                <label>RAM</label>
                <div className="stat-bar">
                  <div
                    className="stat-fill"
                    style={{ width: `${memPct}%`, backgroundColor: getColor(memStatus) }}
                  />
                </div>
                <span style={{ color: getColor(memStatus) }}>
                  {formatBytes(systemStats.memory.free)} free
                </span>
              </div>
              <div style={{ fontSize: '11px', color: 'var(--text-secondary)', marginBottom: '0.75rem', marginTop: '-4px' }}>
                {formatBytes(systemStats.memory.used)} used of {formatBytes(systemStats.memory.total)} ({memPct}%)
              </div>

              <div className="stat-row">
                <label>CPU</label>
                <div className="stat-bar">
                  <div
                    className="stat-fill"
                    style={{ width: `${cpuPct}%`, backgroundColor: getColor(cpuStatus) }}
                  />
                </div>
                <span style={{ color: getColor(cpuStatus) }}>{100 - cpuPct}% available</span>
              </div>
              <div style={{ fontSize: '11px', color: 'var(--text-secondary)', marginBottom: '0.5rem', marginTop: '-4px' }}>
                {cpuPct}% used across {systemStats.cpu.cores} cores
              </div>

              <div className="stat-row">
                <label>Latency</label>
                <div className="stat-bar">
                  <div
                    className="stat-fill"
                    style={{ width: `${Math.min(100, Math.max(0, latencyMs ?? 0))}%`, backgroundColor: 'var(--accent-primary)' }}
                  />
                </div>
                <span>{latencyMs !== null ? `${latencyMs} ms` : '—'}</span>
              </div>
              {latencyHistory.length > 1 && (
                <div style={{ marginBottom: '0.75rem', marginTop: '-2px' }}>
                  <Sparkline data={latencyHistory} color="var(--accent-primary)" height={24} width={140} />
                  <div style={{ fontSize: '10px', color: 'var(--text-secondary)', marginTop: '4px' }}>
                    Avg: {Math.round(latencyHistory.reduce((a, b) => a + b, 0) / latencyHistory.length)} ms
                  </div>
                </div>
              )}
              <div className="stat-row">
                <label>WS RTT</label>
                <div className="stat-bar">
                  <div
                    className="stat-fill"
                    style={{ width: `${Math.min(100, Math.max(0, wsLatencyMs ?? 0))}%`, backgroundColor: 'var(--accent-info, #38bdf8)' }}
                  />
                </div>
                <span>{wsLatencyMs !== null ? `${wsLatencyMs} ms` : '—'}</span>
              </div>
              {wsLatencyHistory.length > 1 && (
                <div style={{ marginBottom: '0.75rem', marginTop: '-2px' }}>
                  <Sparkline data={wsLatencyHistory} color="var(--accent-info, #38bdf8)" height={24} width={140} />
                  <div style={{ fontSize: '10px', color: 'var(--text-secondary)', marginTop: '4px' }}>
                    Avg: {Math.round(wsLatencyHistory.reduce((a, b) => a + b, 0) / wsLatencyHistory.length)} ms
                  </div>
                </div>
              )}
              {wsTarget && (
                <div style={{ fontSize: '10px', color: 'var(--text-secondary)', marginBottom: '0.5rem' }}>
                  WS: <code>{wsTarget}</code>
                </div>
              )}
              <div className="stat-row">
                <label>Client Frame</label>
                <div className="stat-bar">
                  <div
                    className="stat-fill"
                    style={{ width: `${Math.min(100, Math.max(0, clientFrameMs ?? 0))}%`, backgroundColor: 'var(--accent-warning, #f59e0b)' }}
                  />
                </div>
                <span>{clientFrameMs !== null ? `${clientFrameMs} ms` : '—'}</span>
              </div>
              {clientFrameHistory.length > 1 && (
                <div style={{ marginBottom: '0.75rem', marginTop: '-2px' }}>
                  <Sparkline data={clientFrameHistory} color="var(--accent-warning, #f59e0b)" height={24} width={140} />
                  <div style={{ fontSize: '10px', color: 'var(--text-secondary)', marginTop: '4px' }}>
                    Avg: {Math.round(clientFrameHistory.reduce((a, b) => a + b, 0) / clientFrameHistory.length)} ms
                  </div>
                </div>
              )}
              <div className="stat-row">
                <label>Server Loop</label>
                <div className="stat-bar">
                  <div
                    className="stat-fill"
                    style={{ width: `${Math.min(100, Math.max(0, eventLoopMean ?? 0))}%`, backgroundColor: 'var(--accent-warning, #f59e0b)' }}
                  />
                </div>
                <span>
                  {eventLoopMean !== null ? `${eventLoopMean} ms` : '—'}
                  {eventLoopMax !== null ? ` (max ${eventLoopMax} ms)` : ''}
                </span>
              </div>

              {/* Disk I/O - Read */}
              {systemStats.disk && (
                <>
                  <div className="stat-row">
                    <label>Disk Read</label>
                    <div className="stat-bar">
                      <div
                        className="stat-fill"
                        style={{ width: `${diskReadPct}%`, backgroundColor: '#06b6d4' }}
                      />
                    </div>
                    <span style={{ color: '#06b6d4' }}>
                      ↓ {formatIORate(systemStats.disk.readMBps)}
                    </span>
                  </div>
                  <div style={{ fontSize: '11px', color: 'var(--text-secondary)', marginBottom: '0.75rem', marginTop: '-4px' }}>
                    Current read throughput across all disks
                  </div>

                  {/* Disk I/O - Write */}
                  <div className="stat-row">
                    <label>Disk Write</label>
                    <div className="stat-bar">
                      <div
                        className="stat-fill"
                        style={{ width: `${diskWritePct}%`, backgroundColor: '#f59e0b' }}
                      />
                    </div>
                    <span style={{ color: '#f59e0b' }}>
                      ↑ {formatIORate(systemStats.disk.writeMBps)}
                    </span>
                  </div>
                  <div style={{ fontSize: '11px', color: 'var(--text-secondary)', marginBottom: '0.5rem', marginTop: '-4px' }}>
                    Current write throughput across all disks
                  </div>
                </>
              )}

              {overallStatus !== 'healthy' && (
                <div style={{
                  fontSize: '11px',
                  padding: '8px 10px',
                  marginTop: '0.5rem',
                  borderRadius: '4px',
                  backgroundColor: getColor(overallStatus) + '15',
                  color: getColor(overallStatus),
                  border: `1px solid ${getColor(overallStatus)}30`
                }}>
                  {overallStatus === 'critical'
                    ? 'VM resources are running low. Consider closing unused sessions or upgrading the VM.'
                    : 'Resource usage is elevated. Monitor for potential slowdowns.'}
                </div>
              )}

              {/* Resource History Charts */}
              <div style={{ marginTop: '1rem', padding: '12px', backgroundColor: 'var(--bg-secondary)', borderRadius: '6px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '10px' }}>
                  <h4 style={{ margin: 0, fontSize: '12px', fontWeight: 500, color: 'var(--text-secondary)' }}>History</h4>
                  <select
                    value={historyRange}
                    onChange={(e) => setHistoryRange(e.target.value)}
                    style={{
                      fontSize: '10px',
                      padding: '2px 6px',
                      border: '1px solid var(--border-dim)',
                      borderRadius: '4px',
                      backgroundColor: 'var(--bg-primary)',
                      color: 'var(--text-primary)',
                      cursor: 'pointer'
                    }}
                  >
                    <option value="1h">Last Hour</option>
                    <option value="6h">Last 6 Hours</option>
                    <option value="24h">Last 24 Hours</option>
                    <option value="7d">Last 7 Days</option>
                    <option value="30d">Last 30 Days</option>
                  </select>
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px' }}>
                  <div>
                    <div style={{ fontSize: '10px', color: 'var(--text-secondary)', marginBottom: '4px' }}>RAM Usage</div>
                    <Sparkline
                      data={statsHistory?.history?.map(p => p.memory) || []}
                      color="#3b82f6"
                      height={36}
                      width={140}
                    />
                    {statsHistory?.history?.length > 0 && (
                      <div style={{ fontSize: '9px', color: 'var(--text-secondary)', marginTop: '2px' }}>
                        Avg: {Math.round(statsHistory.history.reduce((a, p) => a + p.memory, 0) / statsHistory.history.length)}%
                        {' · '}
                        Max: {Math.max(...statsHistory.history.map(p => p.memory))}%
                      </div>
                    )}
                  </div>
                  <div>
                    <div style={{ fontSize: '10px', color: 'var(--text-secondary)', marginBottom: '4px' }}>CPU Usage</div>
                    <Sparkline
                      data={statsHistory?.history?.map(p => p.cpu) || []}
                      color="#22c55e"
                      height={36}
                      width={140}
                    />
                    {statsHistory?.history?.length > 0 && (
                      <div style={{ fontSize: '9px', color: 'var(--text-secondary)', marginTop: '2px' }}>
                        Avg: {Math.round(statsHistory.history.reduce((a, p) => a + p.cpu, 0) / statsHistory.history.length)}%
                        {' · '}
                        Max: {Math.max(...statsHistory.history.map(p => p.cpu))}%
                      </div>
                    )}
                  </div>

                  {/* Disk Read Chart */}
                  <div>
                    <div style={{ fontSize: '10px', color: 'var(--text-secondary)', marginBottom: '4px' }}>
                      Disk Read
                    </div>
                    <Sparkline
                      data={statsHistory?.history?.map(p => p.diskRead || 0) || []}
                      color="#06b6d4"
                      height={36}
                      width={140}
                    />
                    {statsHistory?.history?.length > 0 && (
                      <div style={{ fontSize: '9px', color: 'var(--text-secondary)', marginTop: '2px' }}>
                        Avg: {(statsHistory.history.reduce((a, p) => a + (p.diskRead || 0), 0) / statsHistory.history.length).toFixed(1)} MB/s
                        {' · '}
                        Max: {Math.max(...statsHistory.history.map(p => p.diskRead || 0)).toFixed(1)} MB/s
                      </div>
                    )}
                  </div>

                  {/* Disk Write Chart */}
                  <div>
                    <div style={{ fontSize: '10px', color: 'var(--text-secondary)', marginBottom: '4px' }}>
                      Disk Write
                    </div>
                    <Sparkline
                      data={statsHistory?.history?.map(p => p.diskWrite || 0) || []}
                      color="#f59e0b"
                      height={36}
                      width={140}
                    />
                    {statsHistory?.history?.length > 0 && (
                      <div style={{ fontSize: '9px', color: 'var(--text-secondary)', marginTop: '2px' }}>
                        Avg: {(statsHistory.history.reduce((a, p) => a + (p.diskWrite || 0), 0) / statsHistory.history.length).toFixed(1)} MB/s
                        {' · '}
                        Max: {Math.max(...statsHistory.history.map(p => p.diskWrite || 0)).toFixed(1)} MB/s
                      </div>
                    )}
                  </div>
                </div>
                {statsHistory?.count > 0 && (
                  <div style={{ fontSize: '9px', color: 'var(--text-secondary)', marginTop: '8px', textAlign: 'center' }}>
                    {statsHistory.count} data points
                  </div>
                )}
              </div>

              {/* Top Processes */}
              {systemStats.processes && systemStats.processes.length > 0 && (
                <div className="process-list" style={{ marginTop: '1rem' }}>
                  <h4 style={{ margin: '0 0 0.5rem', fontSize: '12px', fontWeight: 500, color: 'var(--text-secondary)' }}>Top Processes</h4>
                  <div className="process-table" style={{ fontSize: '11px', fontFamily: 'var(--font-mono)' }}>
                    <div className="process-header" style={{ display: 'grid', gridTemplateColumns: '1fr 70px 45px 55px', gap: '6px', padding: '4px 0', borderBottom: '1px solid var(--border-dim)', color: 'var(--text-secondary)', fontWeight: 600 }}>
                      <span>Process</span>
                      <span>Ports</span>
                      <span style={{ textAlign: 'right' }}>CPU</span>
                      <span style={{ textAlign: 'right' }}>Mem</span>
                    </div>
                    {systemStats.processes.map((proc, idx) => (
                      <div
                        key={proc.pid}
                        className="process-row"
                        style={{
                          display: 'grid',
                          gridTemplateColumns: '1fr 70px 45px 55px',
                          gap: '6px',
                          padding: '3px 0',
                          borderBottom: idx < systemStats.processes.length - 1 ? '1px solid var(--border-dim)' : 'none',
                          color: 'var(--text-primary)'
                        }}
                      >
                        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={proc.name}>
                          {proc.name}
                        </span>
                        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: proc.ports?.length ? 'var(--accent-info)' : 'var(--text-secondary)' }} title={proc.ports?.join(', ') || ''}>
                          {proc.ports?.length ? proc.ports.join(', ') : '-'}
                        </span>
                        <span style={{ textAlign: 'right', color: proc.cpu > 50 ? 'var(--accent-error)' : proc.cpu > 20 ? 'var(--accent-warning)' : 'inherit' }}>
                          {proc.cpu.toFixed(1)}%
                        </span>
                        <span style={{ textAlign: 'right' }}>
                          {formatMB(proc.memoryBytes)}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
            );
          })()}
        </div>
        <div className="modal-footer">
          <button className="btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn-secondary"
            onClick={handleDownload}
            disabled={!workingDir && !currentCwd}
            title="Download folder as .zip"
          >
            ⬇ Download
          </button>
          <button className="btn-primary" onClick={handleSave}>
            Save & Navigate
          </button>
        </div>

        <FolderBrowserModal
          isOpen={showFolderBrowser}
          onClose={() => setShowFolderBrowser(false)}
          currentPath={workingDir || currentCwd}
          recentFolders={recentFolders}
          onSelect={(path) => {
            setWorkingDir(path);
            setShowFolderBrowser(false);
          }}
        />
      </div>
    </div>
  );
}

export default SettingsModal;
