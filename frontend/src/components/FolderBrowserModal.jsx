import { useState, useEffect, useCallback } from 'react';
import { apiFetch } from '../utils/api';

export function FolderBrowserModal({ isOpen, onClose, currentPath, recentFolders, onSelect }) {
  const [path, setPath] = useState(currentPath || '');
  const [folders, setFolders] = useState([]);
  const [parent, setParent] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [query, setQuery] = useState('');

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
    }
  }, [isOpen, currentPath, loadDirectory]);

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
    onSelect(path);
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

        .folder-browser-search input {
          width: 100%;
          background: var(--bg-surface, #18181b);
          border: 1px solid var(--border-default, #3f3f46);
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

          .folder-browser-search input {
            font-size: 14px;
            padding: 10px 12px;
          }
        }
      `}</style>
    </div>
  );
}
