import { useState, useEffect } from 'react';
import { apiFetch } from '../../../utils/api';

function formatDuration(ms) {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

function StatusBadge({ status }) {
  const colors = {
    pending: '#94a3b8',
    running: '#3b82f6',
    passed: '#10b981',
    failed: '#ef4444'
  };

  return (
    <span className="status-badge" style={{ background: colors[status] || colors.pending }}>
      {status}
    </span>
  );
}

function TestJobRow({ job, onClick }) {
  return (
    <tr className={`job-row ${job.status}`} onClick={() => onClick(job)}>
      <td>
        <StatusBadge status={job.status} />
      </td>
      <td className="job-name">{job.name}</td>
      <td className="job-duration">
        {job.duration ? formatDuration(job.duration) : '-'}
      </td>
      <td className="job-error">
        {job.error ? (
          <span className="error-preview" title={job.error}>
            {job.error.slice(0, 50)}...
          </span>
        ) : (
          '-'
        )}
      </td>
    </tr>
  );
}

function TestJobDetails({ job, onClose }) {
  const [details, setDetails] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    loadDetails();
  }, [job.id]);

  const loadDetails = async () => {
    setLoading(true);
    try {
      const response = await apiFetch(`/api/browser/tests/result/${job.id}`);
      setDetails(response.job);
    } catch (err) {
      console.error('Failed to load job details:', err);
    } finally {
      setLoading(false);
    }
  };

  if (loading) {
    return (
      <div className="job-details-overlay" onClick={onClose}>
        <div className="job-details" onClick={(e) => e.stopPropagation()}>
          <div className="loading">Loading...</div>
        </div>
      </div>
    );
  }

  if (!details) {
    return null;
  }

  return (
    <div className="job-details-overlay" onClick={onClose}>
      <div className="job-details" onClick={(e) => e.stopPropagation()}>
        <div className="job-details-header">
          <h4>{details.name}</h4>
          <button className="close-button" onClick={onClose}>×</button>
        </div>

        <div className="job-details-content">
          <div className="detail-section">
            <h5>Status</h5>
            <StatusBadge status={details.status} />
          </div>

          <div className="detail-section">
            <h5>Duration</h5>
            <p>{details.duration ? formatDuration(details.duration) : 'N/A'}</p>
          </div>

          {details.error && (
            <div className="detail-section">
              <h5>Error</h5>
              <pre className="error-text">{details.error}</pre>
            </div>
          )}

          {details.logs && details.logs.length > 0 && (
            <div className="detail-section">
              <h5>Logs</h5>
              <pre className="logs-text">{details.logs.join('\n')}</pre>
            </div>
          )}

          {details.screenshot && (
            <div className="detail-section">
              <h5>Screenshot</h5>
              <img
                src={`data:image/png;base64,${details.screenshot}`}
                alt="Test failure screenshot"
                className="screenshot-img"
              />
            </div>
          )}
        </div>

        <style jsx>{`
          .job-details-overlay {
            position: fixed;
            top: 0;
            left: 0;
            right: 0;
            bottom: 0;
            background: rgba(0, 0, 0, 0.6);
            display: flex;
            align-items: center;
            justify-content: center;
            z-index: 10001;
          }

          .job-details {
            background: var(--bg-primary, #1e1e1e);
            border: 1px solid var(--border-color, #3a3a3a);
            border-radius: 8px;
            box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
            width: 700px;
            max-width: 90vw;
            max-height: 80vh;
            overflow: hidden;
            display: flex;
            flex-direction: column;
          }

          .loading {
            padding: 40px;
            text-align: center;
            color: var(--text-secondary, #999);
          }

          .job-details-header {
            display: flex;
            align-items: center;
            justify-content: space-between;
            padding: 16px 20px;
            border-bottom: 1px solid var(--border-color, #3a3a3a);
          }

          .job-details-header h4 {
            margin: 0;
            font-size: 16px;
            font-weight: 600;
            color: var(--text-primary, #d4d4d4);
          }

          .close-button {
            background: none;
            border: none;
            color: var(--text-secondary, #999);
            font-size: 28px;
            cursor: pointer;
            padding: 0;
            width: 32px;
            height: 32px;
            display: flex;
            align-items: center;
            justify-content: center;
            border-radius: 4px;
            line-height: 1;
          }

          .close-button:hover {
            background: var(--bg-hover, #2a2a2a);
            color: var(--text-primary, #d4d4d4);
          }

          .job-details-content {
            flex: 1;
            overflow-y: auto;
            padding: 20px;
          }

          .detail-section {
            margin-bottom: 24px;
          }

          .detail-section h5 {
            margin: 0 0 8px 0;
            font-size: 12px;
            font-weight: 600;
            text-transform: uppercase;
            letter-spacing: 0.05em;
            color: var(--text-secondary, #999);
          }

          .detail-section p {
            margin: 0;
            color: var(--text-primary, #d4d4d4);
          }

          .error-text, .logs-text {
            margin: 0;
            padding: 12px;
            background: var(--bg-secondary, #252525);
            border: 1px solid var(--border-color, #3a3a3a);
            border-radius: 4px;
            font-family: 'Monaco', 'Menlo', 'Ubuntu Mono', monospace;
            font-size: 12px;
            line-height: 1.5;
            color: var(--text-primary, #d4d4d4);
            white-space: pre-wrap;
            word-wrap: break-word;
          }

          .error-text {
            color: #ef4444;
          }

          .screenshot-img {
            max-width: 100%;
            border: 1px solid var(--border-color, #3a3a3a);
            border-radius: 4px;
          }
        `}</style>
      </div>
    </div>
  );
}

export function TestResults({ run, onClose, onRetry }) {
  const [selectedJob, setSelectedJob] = useState(null);

  const handleExportResults = () => {
    const data = JSON.stringify(run, null, 2);
    const blob = new Blob([data], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `test-results-${run.id}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleRetryFailed = () => {
    // This would filter to only failed tests and retry
    onRetry();
  };

  const summary = run.summary || {
    total: 0,
    passed: 0,
    failed: 0,
    pending: 0,
    running: 0
  };

  const progress = summary.total > 0
    ? ((summary.passed + summary.failed) / summary.total) * 100
    : 0;

  const isComplete = run.status === 'completed' || run.status === 'failed';

  return (
    <>
      <div className="test-results-overlay" onClick={(e) => e.target.className === 'test-results-overlay' && onClose()}>
        <div className="test-results">
          <div className="test-results-header">
            <h3>Test Results</h3>
            <button className="close-button" onClick={onClose}>×</button>
          </div>

          <div className="test-results-summary">
            <div className="summary-stats">
              <div className="stat">
                <div className="stat-value">{summary.total}</div>
                <div className="stat-label">Total</div>
              </div>
              <div className="stat success">
                <div className="stat-value">{summary.passed}</div>
                <div className="stat-label">Passed</div>
              </div>
              <div className="stat danger">
                <div className="stat-value">{summary.failed}</div>
                <div className="stat-label">Failed</div>
              </div>
              <div className="stat">
                <div className="stat-value">{summary.running}</div>
                <div className="stat-label">Running</div>
              </div>
            </div>

            <div className="progress-bar">
              <div className="progress-fill" style={{ width: `${progress}%` }} />
            </div>

            <div className="summary-meta">
              <span>Status: {run.status}</span>
              {run.endTime && run.startTime && (
                <span>Duration: {formatDuration(run.endTime - run.startTime)}</span>
              )}
            </div>
          </div>

          <div className="test-results-actions">
            {isComplete && summary.failed > 0 && (
              <button className="btn-secondary" onClick={handleRetryFailed}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <polyline points="23 4 23 10 17 10"></polyline>
                  <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"></path>
                </svg>
                Retry Failed
              </button>
            )}
            <button className="btn-outline" onClick={handleExportResults}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
                <polyline points="7 10 12 15 17 10"></polyline>
                <line x1="12" y1="15" x2="12" y2="3"></line>
              </svg>
              Export JSON
            </button>
          </div>

          <div className="test-results-table-container">
            <table className="test-results-table">
              <thead>
                <tr>
                  <th>Status</th>
                  <th>Name</th>
                  <th>Duration</th>
                  <th>Error</th>
                </tr>
              </thead>
              <tbody>
                {run.jobs && run.jobs.length > 0 ? (
                  run.jobs.map(job => (
                    <TestJobRow
                      key={job.id}
                      job={job}
                      onClick={setSelectedJob}
                    />
                  ))
                ) : (
                  <tr>
                    <td colSpan="4" className="no-jobs">No test jobs</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {selectedJob && (
        <TestJobDetails
          job={selectedJob}
          onClose={() => setSelectedJob(null)}
        />
      )}

      <style jsx>{`
        .test-results-overlay {
          position: fixed;
          top: 0;
          left: 0;
          right: 0;
          bottom: 0;
          background: rgba(0, 0, 0, 0.5);
          backdrop-filter: blur(4px);
          display: flex;
          align-items: center;
          justify-content: center;
          z-index: 10000;
        }

        .test-results {
          background: var(--bg-primary, #1e1e1e);
          border: 1px solid var(--border-color, #3a3a3a);
          border-radius: 8px;
          box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
          width: 900px;
          max-width: 95vw;
          max-height: 90vh;
          display: flex;
          flex-direction: column;
          overflow: hidden;
        }

        .test-results-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 16px 20px;
          border-bottom: 1px solid var(--border-color, #3a3a3a);
        }

        .test-results-header h3 {
          margin: 0;
          font-size: 18px;
          font-weight: 600;
          color: var(--text-primary, #d4d4d4);
        }

        .close-button {
          background: none;
          border: none;
          color: var(--text-secondary, #999);
          font-size: 28px;
          cursor: pointer;
          padding: 0;
          width: 32px;
          height: 32px;
          display: flex;
          align-items: center;
          justify-content: center;
          border-radius: 4px;
          line-height: 1;
        }

        .close-button:hover {
          background: var(--bg-hover, #2a2a2a);
          color: var(--text-primary, #d4d4d4);
        }

        .test-results-summary {
          padding: 20px;
          border-bottom: 1px solid var(--border-color, #3a3a3a);
          background: var(--bg-secondary, #252525);
        }

        .summary-stats {
          display: grid;
          grid-template-columns: repeat(4, 1fr);
          gap: 16px;
          margin-bottom: 20px;
        }

        .stat {
          text-align: center;
          padding: 16px;
          background: var(--bg-primary, #1e1e1e);
          border-radius: 6px;
          border: 1px solid var(--border-color, #3a3a3a);
        }

        .stat.success {
          border-color: #10b981;
          background: rgba(16, 185, 129, 0.05);
        }

        .stat.danger {
          border-color: #ef4444;
          background: rgba(239, 68, 68, 0.05);
        }

        .stat-value {
          font-size: 32px;
          font-weight: 700;
          color: var(--text-primary, #d4d4d4);
          margin-bottom: 4px;
        }

        .stat.success .stat-value {
          color: #10b981;
        }

        .stat.danger .stat-value {
          color: #ef4444;
        }

        .stat-label {
          font-size: 12px;
          text-transform: uppercase;
          letter-spacing: 0.05em;
          color: var(--text-secondary, #999);
        }

        .progress-bar {
          width: 100%;
          height: 8px;
          background: var(--bg-primary, #1e1e1e);
          border-radius: 4px;
          overflow: hidden;
          margin-bottom: 12px;
        }

        .progress-fill {
          height: 100%;
          background: linear-gradient(90deg, #3b82f6, #10b981);
          transition: width 0.3s ease;
        }

        .summary-meta {
          display: flex;
          justify-content: space-between;
          font-size: 13px;
          color: var(--text-secondary, #999);
        }

        .test-results-actions {
          display: flex;
          gap: 8px;
          padding: 16px 20px;
          border-bottom: 1px solid var(--border-color, #3a3a3a);
        }

        .btn-secondary, .btn-outline {
          display: flex;
          align-items: center;
          gap: 8px;
          padding: 8px 16px;
          border: 1px solid;
          border-radius: 6px;
          font-size: 14px;
          font-weight: 500;
          cursor: pointer;
          transition: all 0.2s;
        }

        .btn-secondary {
          background: #f59e0b;
          border-color: #f59e0b;
          color: white;
        }

        .btn-secondary:hover {
          background: #d97706;
        }

        .btn-outline {
          background: transparent;
          border-color: var(--border-color, #3a3a3a);
          color: var(--text-primary, #d4d4d4);
        }

        .btn-outline:hover {
          background: var(--bg-hover, #2a2a2a);
          border-color: #3b82f6;
        }

        .test-results-table-container {
          flex: 1;
          overflow: auto;
        }

        .test-results-table {
          width: 100%;
          border-collapse: collapse;
        }

        .test-results-table thead {
          position: sticky;
          top: 0;
          background: var(--bg-secondary, #252525);
          z-index: 1;
        }

        .test-results-table th {
          padding: 12px 16px;
          text-align: left;
          font-size: 12px;
          font-weight: 600;
          text-transform: uppercase;
          letter-spacing: 0.05em;
          color: var(--text-secondary, #999);
          border-bottom: 1px solid var(--border-color, #3a3a3a);
        }

        .test-results-table tbody tr {
          cursor: pointer;
          transition: background 0.2s;
        }

        .test-results-table tbody tr:hover {
          background: var(--bg-hover, #2a2a2a);
        }

        .test-results-table tbody tr.failed {
          background: rgba(239, 68, 68, 0.05);
        }

        .test-results-table td {
          padding: 12px 16px;
          border-bottom: 1px solid var(--border-color, #3a3a3a);
          font-size: 13px;
          color: var(--text-primary, #d4d4d4);
        }

        .job-name {
          font-weight: 500;
        }

        .job-duration {
          color: var(--text-secondary, #999);
        }

        .job-error {
          font-family: 'Monaco', 'Menlo', 'Ubuntu Mono', monospace;
          font-size: 12px;
          color: #ef4444;
        }

        .error-preview {
          display: block;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }

        .no-jobs {
          padding: 40px;
          text-align: center;
          color: var(--text-secondary, #999);
        }

        .status-badge {
          display: inline-block;
          padding: 4px 10px;
          border-radius: 12px;
          font-size: 11px;
          font-weight: 600;
          text-transform: uppercase;
          letter-spacing: 0.05em;
          color: white;
        }
      `}</style>
    </>
  );
}
