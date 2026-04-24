import { useState, useEffect, useCallback, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { apiFetch } from '../utils/api';
import { NEW_TAB_AI_OPTIONS } from '../utils/aiProviders';
import './FolderBrowserModal.css';

function resolveInitialAiOptionId(options, preferredId) {
  if (preferredId && options.some((option) => option.id === preferredId)) {
    return preferredId;
  }
  return options[0]?.id || 'cli';
}

function buildAiOptionsSignature(options) {
  return options
    .map((option) => `${option.id}:${option.label}:${option.title ?? ''}:${option.command ?? ''}`)
    .join('|');
}

export function FolderBrowserModal({
  isOpen,
  onClose,
  currentPath,
  recentFolders,
  onSelect,
  showAiSelector = false,
  aiOptions = NEW_TAB_AI_OPTIONS,
  defaultAiOptionId = 'cli'
}) {
  const resolvedAiOptions = useMemo(
    () => (showAiSelector && aiOptions.length > 0 ? aiOptions : NEW_TAB_AI_OPTIONS),
    [showAiSelector, aiOptions]
  );
  const aiOptionsSignature = useMemo(
    () => buildAiOptionsSignature(resolvedAiOptions),
    [resolvedAiOptions]
  );
  const [path, setPath] = useState(currentPath || '');
  const [folders, setFolders] = useState([]);
  const [parent, setParent] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [query, setQuery] = useState('');
  const [selectedAiOptionId, setSelectedAiOptionId] = useState(() => (
    resolveInitialAiOptionId(resolvedAiOptions, defaultAiOptionId)
  ));
  const [tabName, setTabName] = useState('');

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
      setTabName('');
      setSelectedAiOptionId(resolveInitialAiOptionId(resolvedAiOptions, defaultAiOptionId));
    }
  }, [isOpen, currentPath, loadDirectory, aiOptionsSignature, defaultAiOptionId]);

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
    onSelect(path, showAiSelector ? selectedAiOptionId : undefined, showAiSelector ? tabName.trim() : undefined);
    onClose();
  };

  const handleRecentClick = (recentPath) => {
    onSelect(
      recentPath,
      showAiSelector ? selectedAiOptionId : undefined,
      showAiSelector ? tabName.trim() : undefined
    );
    onClose();
  };

  if (!isOpen) return null;

  const normalizedQuery = query.trim().toLowerCase();
  const visibleFolders = normalizedQuery
    ? folders.filter((folder) => folder.toLowerCase().includes(normalizedQuery))
    : folders;
  const selectedAiOption = resolvedAiOptions.find((option) => option.id === selectedAiOptionId) || null;

  const pathSegments = path.split(/([/\\])/).filter(Boolean);
  const breadcrumbs = [];
  let accumulated = '';
  for (const seg of pathSegments) {
    accumulated += seg;
    if (seg !== '/' && seg !== '\\') {
      breadcrumbs.push({ name: seg, path: accumulated });
    }
  }

  const modal = (
    <div className="modal-overlay" onClick={onClose}>
      <div className="pro-folder-browser" onClick={(e) => e.stopPropagation()}>
        {/* Path bar with integrated back button and breadcrumbs */}
        <div className="pro-fb-header">
          {parent && (
            <button
              type="button"
              className="pro-fb-back-btn"
              onClick={handleGoUp}
              disabled={loading}
              aria-label="Go up"
            >
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                <path d="M10 12L6 8L10 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
            </button>
          )}
          <div className="pro-fb-breadcrumbs">
            {breadcrumbs.map((crumb, i) => (
              <span key={i} className="pro-fb-breadcrumb-segment">
                {i > 0 && <span className="pro-fb-breadcrumb-sep">/</span>}
                <button
                  type="button"
                  className={`pro-fb-breadcrumb-btn${i === breadcrumbs.length - 1 ? ' active' : ''}`}
                  onClick={() => loadDirectory(crumb.path)}
                >
                  {crumb.name}
                </button>
              </span>
            ))}
          </div>
        </div>

        <div className="pro-fb-content">
          {/* AI selector and tab name in compact row */}
          {showAiSelector && (
            <div className="pro-fb-config-row">
              <div className="pro-fb-field">
                <label htmlFor="folder-browser-ai-select">AI</label>
                <div className="pro-fb-custom-select" tabIndex={0} onBlur={(e) => {
                  if (!e.currentTarget.contains(e.relatedTarget)) {
                    document.getElementById('folder-browser-ai-options')?.classList.remove('open');
                  }
                }}>
                  <div 
                    className="pro-fb-select-trigger" 
                    onClick={(e) => {
                      const opts = document.getElementById('folder-browser-ai-options');
                      if (opts) opts.classList.toggle('open');
                    }}
                  >
                    <span>{resolvedAiOptions.find(o => o.id === selectedAiOptionId)?.label || 'Select AI'}</span>
                    <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                      <path d="M3 4.5L6 7.5L9 4.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                    </svg>
                  </div>
                  <div id="folder-browser-ai-options" className="pro-fb-options-list">
                    {resolvedAiOptions.map((option) => (
                      <div 
                        key={option.id} 
                        className={`pro-fb-option ${option.id === selectedAiOptionId ? 'selected' : ''}`}
                        onClick={() => {
                          setSelectedAiOptionId(option.id);
                          setTabName(option.label || '');
                          document.getElementById('folder-browser-ai-options')?.classList.remove('open');
                        }}
                      >
                        {option.label}
                      </div>
                    ))}
                  </div>
                </div>
              </div>
              <div className="pro-fb-field grow">
                <label htmlFor="folder-browser-tabname-input">Tab name</label>
                <input
                  id="folder-browser-tabname-input"
                  className="pro-fb-input"
                  type="text"
                  value={tabName}
                  onChange={(e) => setTabName(e.target.value)}
                  placeholder="Optional"
                  maxLength={60}
                />
              </div>
            </div>
          )}

          {/* Search with icon */}
          <div className="pro-fb-search">
            <svg className="pro-fb-search-icon" width="14" height="14" viewBox="0 0 14 14" fill="none">
              <circle cx="6" cy="6" r="4.5" stroke="currentColor" strokeWidth="1.5"/>
              <path d="M9.5 9.5L12.5 12.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
            </svg>
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search folders..."
              aria-label="Search folders"
            />
          </div>

          {/* Folder list */}
          <div className="pro-fb-list">
            {loading && <div className="pro-fb-loading">Loading...</div>}
            {error && <div className="pro-fb-error">{error}</div>}
            {!loading && !error && visibleFolders.length === 0 && (
              <div className="pro-fb-empty">
                <svg width="32" height="32" viewBox="0 0 24 24" fill="none" style={{ opacity: 0.4, marginBottom: 8 }}>
                  <path d="M3 7V17C3 18.1046 3.89543 19 5 19H19C20.1046 19 21 18.1046 21 17V9C21 7.89543 20.1046 7 19 7H12L10 5H5C3.89543 5 3 5.89543 3 7Z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round"/>
                </svg>
                No subfolders
              </div>
            )}
            {!loading && !error && visibleFolders.map((folder) => (
              <button
                type="button"
                key={folder}
                className="pro-fb-item"
                onClick={() => handleFolderClick(folder)}
              >
                <svg className="pro-fb-item-icon" width="18" height="18" viewBox="0 0 24 24" fill="none">
                  <path d="M3 7V17C3 18.1046 3.89543 19 5 19H19C20.1046 19 21 18.1046 21 17V9C21 7.89543 20.1046 7 19 7H12L10 5H5C3.89543 5 3 5.89543 3 7Z" fill="currentColor" fillOpacity="0.2" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round"/>
                </svg>
                <span className="pro-fb-item-name">{folder}</span>
                <svg className="pro-fb-item-arrow" width="14" height="14" viewBox="0 0 14 14" fill="none">
                  <path d="M5 3L9 7L5 11" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                </svg>
              </button>
            ))}
          </div>

          {/* Recent folders */}
          {recentFolders && recentFolders.length > 0 && (
            <div className="pro-fb-recent">
              <div className="pro-fb-recent-label">
                <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                  <circle cx="6" cy="6" r="5" stroke="currentColor" strokeWidth="1.2"/>
                  <path d="M6 3V6L8 7.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
                </svg>
                Recent
              </div>
              <div className="pro-fb-recent-list">
                {recentFolders.slice(0, 5).map((recent, idx) => {
                  const shortName = recent.split(/[/\\]/).pop() || recent;
                  return (
                    <button
                      type="button"
                      key={idx}
                      className="pro-fb-recent-chip"
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

        {/* Footer with path confirmation */}
        <div className="pro-fb-footer">
          <div className="pro-fb-footer-path" title={path}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
              <path d="M3 7V17C3 18.1046 3.89543 19 5 19H19C20.1046 19 21 18.1046 21 17V9C21 7.89543 20.1046 7 19 7H12L10 5H5C3.89543 5 3 5.89543 3 7Z" fill="currentColor" fillOpacity="0.2" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round"/>
            </svg>
            {path.split(/[/\\]/).pop() || path}
          </div>
          <div className="pro-fb-actions">
            <button type="button" className="pro-fb-btn-cancel" onClick={onClose}>Cancel</button>
            <button type="button" className="pro-fb-btn-select" onClick={handleSelect}>
              Open here
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                <path d="M2 7H12M8 3L12 7L8 11" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
            </button>
          </div>
        </div>
      </div>
    </div>
  );

  if (typeof document === 'undefined') {
    return modal;
  }

  return createPortal(modal, document.body);
}
