import { useState, useEffect, useCallback } from 'react';
import { apiFetch } from '../utils/api';

export function ProcessManagerModal({ isOpen, onClose, projects }) {
  const [repos, setRepos] = useState([]);
  const [loading, setLoading] = useState(false);
  const [actionLoading, setActionLoading] = useState(null); // path or pid being acted on
  const [error, setError] = useState(null);

  const fetchProcesses = useCallback(async (options = {}) => {
    const { silent = false } = options;
    if (!projects || projects.length === 0) {
      setRepos([]);
      return;
    }

    if (!silent) {
      setLoading(true);
    }
    setError(null);
    try {
      const paths = projects.map((p) => p.path).join(',');
      const response = await apiFetch(`/api/processes?paths=${encodeURIComponent(paths)}`);
      if (!response.ok) {
        throw new Error('Failed to fetch processes');
      }
      const data = await response.json();
      setRepos(data.repos || []);
      return true;
    } catch (err) {
      setError(err.message);
      return false;
    } finally {
      if (!silent) {
        setLoading(false);
      }
    }
  }, [projects]);

  // Fetch on open and poll while visible with backoff on errors
  useEffect(() => {
    if (!isOpen) return;
    let isActive = true;
    let pollTimer = null;

    const FAST_POLL_MS = 5000;
    const HIDDEN_POLL_MS = 15000;
    const ERROR_POLL_MS = 10000;

    const schedule = (succeeded = true) => {
      if (!isActive) return;
      if (pollTimer) {
        clearTimeout(pollTimer);
      }
      const visible = document.visibilityState === 'visible';
      const nextDelay = succeeded ? (visible ? FAST_POLL_MS : HIDDEN_POLL_MS) : ERROR_POLL_MS;
      pollTimer = setTimeout(async () => {
        const ok = await fetchProcesses({ silent: true });
        schedule(ok);
      }, nextDelay);
    };

    const runNow = async () => {
      const ok = await fetchProcesses();
      schedule(ok);
    };

    const onVisibilityChange = () => {
      if (!isActive) return;
      if (document.visibilityState === 'visible') {
        void runNow();
      } else {
        schedule(true);
      }
    };

    void runNow();
    document.addEventListener('visibilitychange', onVisibilityChange);

    return () => {
      isActive = false;
      document.removeEventListener('visibilitychange', onVisibilityChange);
      if (pollTimer) {
        clearTimeout(pollTimer);
      }
    };
  }, [isOpen, fetchProcesses]);

  const handleStart = async (path) => {
    setActionLoading(path);
    setError(null);
    try {
      const response = await apiFetch('/api/processes/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path }),
      });
      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || 'Failed to start');
      }
      // Refresh after a short delay to let process start
      setTimeout(() => {
        void fetchProcesses({ silent: true });
      }, 1500);
    } catch (err) {
      setError(err.message);
    } finally {
      setActionLoading(null);
    }
  };

  const handleStop = async (pid) => {
    setActionLoading(pid);
    setError(null);
    try {
      const response = await apiFetch('/api/processes/stop', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pid }),
      });
      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || 'Failed to stop');
      }
      // Refresh immediately
      void fetchProcesses({ silent: true });
    } catch (err) {
      setError(err.message);
    } finally {
      setActionLoading(null);
    }
  };

  if (!isOpen) return null;

  const runningRepos = repos.filter((r) => r.running);
  const stoppedRepos = repos.filter((r) => !r.running);

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="process-modal" onClick={(e) => e.stopPropagation()}>
        <div className="process-modal-header">
          <h2>Process Manager</h2>
          <button className="modal-close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>

        {error && <div className="process-error">{error}</div>}

        <div className="process-modal-body">
          {loading && repos.length === 0 && <div className="process-loading">Loading...</div>}

          {!loading && repos.length === 0 && (
            <div className="process-empty">No projects found. Add some projects to the sidebar first.</div>
          )}

          {runningRepos.length > 0 && (
            <div className="process-section">
              <h3 className="process-section-title">Running ({runningRepos.length})</h3>
              {runningRepos.map((repo) => (
                <div key={repo.path} className="process-item">
                  <div className="process-status running" title="Running" />
                  <div className="process-info">
                    <div className="process-name">{repo.name}</div>
                    <div className="process-path">{repo.path}</div>
                    <div className="process-details">
                      {repo.processes.map((proc) => (
                        <span key={proc.pid} className="process-badge">
                          :{proc.port} (PID {proc.pid})
                        </span>
                      ))}
                      <span className="process-type-badge">{repo.projectType}</span>
                    </div>
                  </div>
                  <div className="process-actions">
                    {repo.processes.map((proc) => (
                      <button
                        key={proc.pid}
                        className="process-stop-btn"
                        onClick={() => handleStop(proc.pid)}
                        disabled={actionLoading === proc.pid}
                        title={`Stop process on port ${proc.port}`}
                      >
                        {actionLoading === proc.pid ? '...' : 'Stop'}
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}

          {stoppedRepos.length > 0 && (
            <div className="process-section">
              <h3 className="process-section-title">Stopped ({stoppedRepos.length})</h3>
              {stoppedRepos.map((repo) => (
                <div key={repo.path} className="process-item">
                  <div className="process-status stopped" title="Stopped" />
                  <div className="process-info">
                    <div className="process-name">{repo.name}</div>
                    <div className="process-path">{repo.path}</div>
                    <div className="process-details">
                      <span className="process-type-badge">{repo.projectType}</span>
                    </div>
                  </div>
                  <div className="process-actions">
                    <button
                      className="process-start-btn"
                      onClick={() => handleStart(repo.path)}
                      disabled={actionLoading === repo.path || repo.projectType === 'unknown'}
                      title={repo.projectType === 'unknown' ? 'Cannot start unknown project type' : 'Start application'}
                    >
                      {actionLoading === repo.path ? '...' : 'Start'}
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="process-modal-footer">
          <button className="btn-secondary" onClick={() => void fetchProcesses()} disabled={loading}>
            {loading ? 'Refreshing...' : 'Refresh'}
          </button>
          <button className="btn-primary" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
