import { useState, useEffect, useCallback } from 'react';
import { apiFetch } from '../utils/api';

const DEFAULT_AI_OPTIONS = [
  { id: 'cli', label: 'CLI' },
  { id: 'claude', label: 'Claude Code', command: 'claude --dangerously-skip-permissions' },
  { id: 'codex', label: 'Codex', command: 'codex --yolo' },
  { id: 'gemini', label: 'Gemini CLI', command: 'gemini --yolo' }
];

function resolveInitialAiOptionId(options, preferredId) {
  if (preferredId && options.some((option) => option.id === preferredId)) {
    return preferredId;
  }
  return options[0]?.id || 'cli';
}

export function FolderBrowserModal({
  isOpen,
  onClose,
  currentPath,
  recentFolders,
  onSelect,
  showAiSelector = false,
  aiOptions = DEFAULT_AI_OPTIONS,
  defaultAiOptionId = 'cli'
}) {
  const resolvedAiOptions = showAiSelector && aiOptions.length > 0 ? aiOptions : DEFAULT_AI_OPTIONS;
  const [path, setPath] = useState(currentPath || '');
  const [folders, setFolders] = useState([]);
  const [parent, setParent] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [query, setQuery] = useState('');
  const [selectedAiOptionId, setSelectedAiOptionId] = useState(() => (
    resolveInitialAiOptionId(resolvedAiOptions, defaultAiOptionId)
  ));

  const loadDirectory = useCallback(async (dirPath) => {
    setLoading(true);
    setError(null);
    try {
      const url = dirPath
        ? `/api/fs/list?path=${encodeURIComponent(dirPath)}`
        : '/api/fs/list';
      const res = await apiFetch(url);
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.message || data.error || 'Failed to load directory');
      }
      const data = await res.json();
      setPath(data.path);
      setFolders(data.folders);
      setParent(data.parent);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (isOpen) {
      loadDirectory(currentPath);
      setQuery('');
      setSelectedAiOptionId(resolveInitialAiOptionId(resolvedAiOptions, defaultAiOptionId));
    }
  }, [isOpen, currentPath, loadDirectory, resolvedAiOptions, defaultAiOptionId]);

  const handleFolderClick = (folderName) => {
    const separator = path.includes('\\') ? '\\' : '/';
    const basePath = path.endsWith('/') || path.endsWith('\\') ? path : `${path}${separator}`;
    const newPath = `${basePath}${folderName}`;
    loadDirectory(newPath);
  };

  const handleGoUp = () => {
    if (parent) {
      loadDirectory(parent);
    }
  };

  const handleSelect = () => {
    onSelect(path, showAiSelector ? selectedAiOptionId : undefined);
    onClose();
  };

  const handleRecentClick = (recentPath) => {
    loadDirectory(recentPath);
  };

  if (!isOpen) return null;

  const normalizedQuery = query.trim().toLowerCase();
  const visibleFolders = normalizedQuery
    ? folders.filter((folder) => folder.toLowerCase().includes(normalizedQuery))
    : folders;
  const selectedAiOption = resolvedAiOptions.find((option) => option.id === selectedAiOptionId) || null;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="folder-browser-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>Select Folder</h2>
          <button className="modal-close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>

        <div className="folder-browser-content">
          {/* Current path */}
          <div className="folder-browser-path">
            <span className="folder-icon">📁</span>
            <span className="path-text">{path}</span>
          </div>

          {showAiSelector && (
            <div className="folder-browser-ai">
              <label htmlFor="folder-browser-ai-select">AI to launch</label>
              <select
                id="folder-browser-ai-select"
                value={selectedAiOptionId}
                onChange={(e) => setSelectedAiOptionId(e.target.value)}
              >
                {resolvedAiOptions.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.label}
                  </option>
                ))}
              </select>
              {selectedAiOption?.command && (
                <small className="folder-browser-ai-command">{selectedAiOption.command}</small>
              )}
            </div>
          )}

          <div className="folder-browser-search">
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search folders"
              aria-label="Search folders"
            />
          </div>

          {/* Go up button */}
          {parent && (
            <button
              className="folder-browser-up"
              onClick={handleGoUp}
              disabled={loading}
            >
              ⬆ Go Up
            </button>
          )}

          {/* Folder list */}
          <div className="folder-browser-list">
            {loading && <div className="folder-browser-loading">Loading...</div>}
            {error && <div className="folder-browser-error">{error}</div>}
            {!loading && !error && visibleFolders.length === 0 && (
              <div className="folder-browser-empty">No subfolders</div>
            )}
            {!loading && !error && visibleFolders.map((folder) => (
              <button
                key={folder}
                className="folder-browser-item"
                onClick={() => handleFolderClick(folder)}
              >
                <span className="folder-icon">📁</span>
                <span className="folder-name">{folder}</span>
              </button>
            ))}
          </div>

          {/* Recent folders */}
          {recentFolders && recentFolders.length > 0 && (
            <div className="folder-browser-recent">
              <div className="recent-label">Recent:</div>
              <div className="recent-list">
                {recentFolders.slice(0, 5).map((recent, idx) => {
                  const shortName = recent.split(/[/\\]/).pop() || recent;
                  return (
                    <button
                      key={idx}
                      className="recent-chip"
                      onClick={() => handleRecentClick(recent)}
                      title={recent}
                    >
                      {shortName}
                    </button>
                  );
                })}
              </div>
            </div>
          )}
        </div>

        <div className="modal-footer">
          <button className="btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button className="btn-primary" onClick={handleSelect}>
            Select
          </button>
        </div>
      </div>
      <style jsx>{`
        .folder-browser-search {
          padding: 8px 16px 10px;
        }

        .folder-browser-ai {
          display: flex;
          flex-direction: column;
          gap: 6px;
          padding: 4px 16px 2px;
        }

        .folder-browser-ai label {
          font-size: 12px;
          font-weight: 600;
          color: var(--text-muted, #71717a);
          text-transform: uppercase;
          letter-spacing: 0.6px;
        }

        .folder-browser-ai select {
          width: 100%;
          background: var(--bg-surface, #141416);
          border: 1px solid var(--border-default, #2a2a2e);
          color: var(--text-primary, #fafafa);
          border-radius: 8px;
          padding: 8px 10px;
          font-size: 13px;
          outline: none;
        }

        .folder-browser-ai select:focus {
          border-color: var(--accent-primary, #f59e0b);
          box-shadow: 0 0 0 2px rgba(245, 158, 11, 0.2);
        }

        .folder-browser-ai-command {
          color: var(--text-muted, #71717a);
          font-size: 12px;
          font-family: 'JetBrains Mono', monospace;
        }

        .folder-browser-search input {
          width: 100%;
          background: var(--bg-surface, #141416);
          border: 1px solid var(--border-default, #2a2a2e);
          color: var(--text-primary, #fafafa);
          border-radius: 8px;
          padding: 8px 10px;
          font-size: 13px;
          outline: none;
        }

        .folder-browser-search input:focus {
          border-color: var(--accent-primary, #f59e0b);
          box-shadow: 0 0 0 2px rgba(245, 158, 11, 0.2);
        }

        @media (max-width: 768px) {
          .folder-browser-search {
            padding: 10px 14px 12px;
          }

          .folder-browser-ai {
            padding: 6px 14px 2px;
          }

          .folder-browser-search input {
            font-size: 14px;
            padding: 10px 12px;
          }
        }
      `}</style>
    </div>
  );
}
