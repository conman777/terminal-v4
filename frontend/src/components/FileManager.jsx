import { useState, useEffect, useCallback, useRef } from 'react';
import { apiGet, apiFetch } from '../utils/api';

export function FileManager({ isOpen, onClose, onNavigateTerminal }) {
  const [currentPath, setCurrentPath] = useState('~');
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [showNewFolderDialog, setShowNewFolderDialog] = useState(false);
  const [newFolderName, setNewFolderName] = useState('');
  const [uploadProgress, setUploadProgress] = useState(null);
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef(null);

  const loadDirectory = useCallback(async (path) => {
    setLoading(true);
    setError(null);
    try {
      const response = await apiGet(`/api/files/list?path=${encodeURIComponent(path)}`);
      setCurrentPath(response?.path || path);
      setItems(Array.isArray(response?.items) ? response.items : []);
    } catch (err) {
      setError(err.message || 'Failed to load directory');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (isOpen) {
      loadDirectory(currentPath);
    }
  }, [isOpen, loadDirectory]);

  const navigateTo = useCallback((path) => {
    loadDirectory(path);
  }, [loadDirectory]);

  const navigateUp = useCallback(() => {
    if (!currentPath || currentPath === '~') return;
    const parts = currentPath.split('/');
    parts.pop();
    const parentPath = parts.length === 1 && parts[0] === '~' ? '~' : parts.join('/');
    navigateTo(parentPath);
  }, [currentPath, navigateTo]);

  const handleItemClick = useCallback((item) => {
    if (item.type === 'directory') {
      const newPath = currentPath === '~' ? `~/${item.name}` : `${currentPath}/${item.name}`;
      navigateTo(newPath);
    }
  }, [currentPath, navigateTo]);

  const handleItemDoubleClick = useCallback((item) => {
    if (item.type === 'directory' && onNavigateTerminal) {
      const fullPath = currentPath === '~' ? `~/${item.name}` : `${currentPath}/${item.name}`;
      onNavigateTerminal(fullPath);
    }
  }, [currentPath, onNavigateTerminal]);

  const handleCreateFolder = useCallback(async () => {
    if (!newFolderName.trim()) return;

    try {
      const path = currentPath === '~' ? `~/${newFolderName}` : `${currentPath}/${newFolderName}`;
      await apiFetch('/api/files/mkdir', {
        method: 'POST',
        body: { path }
      });
      setNewFolderName('');
      setShowNewFolderDialog(false);
      loadDirectory(currentPath);
    } catch (err) {
      setError(err.message || 'Failed to create folder');
    }
  }, [currentPath, newFolderName, loadDirectory]);

  const handleUpload = useCallback(async (files) => {
    if (!files || files.length === 0) return;

    setUploadProgress({ current: 0, total: files.length });

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const formData = new FormData();
      formData.append('path', currentPath);
      formData.append('files', file);

      try {
        await fetch('/api/files/upload', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${localStorage.getItem('accessToken')}`
          },
          body: formData
        });
        setUploadProgress({ current: i + 1, total: files.length });
      } catch (err) {
        setError(`Failed to upload ${file.name}: ${err.message}`);
      }
    }

    setUploadProgress(null);
    loadDirectory(currentPath);
  }, [currentPath, loadDirectory]);

  const handleFileSelect = useCallback((e) => {
    handleUpload(e.target.files);
    e.target.value = '';
  }, [handleUpload]);

  const handleDrop = useCallback((e) => {
    e.preventDefault();
    setDragOver(false);
    handleUpload(e.dataTransfer.files);
  }, [handleUpload]);

  const handleDragOver = useCallback((e) => {
    e.preventDefault();
    setDragOver(true);
  }, []);

  const handleDragLeave = useCallback(() => {
    setDragOver(false);
  }, []);

  const handleDelete = useCallback(async (item) => {
    const fullPath = currentPath === '~' ? `~/${item.name}` : `${currentPath}/${item.name}`;
    if (!confirm(`Delete "${item.name}"?`)) return;

    try {
      await apiFetch('/api/files/delete', {
        method: 'DELETE',
        body: { path: fullPath }
      });
      loadDirectory(currentPath);
    } catch (err) {
      setError(err.message || 'Failed to delete');
    }
  }, [currentPath, loadDirectory]);

  const handleDownload = useCallback(async (item) => {
    const fullPath = currentPath === '~' ? `~/${item.name}` : `${currentPath}/${item.name}`;
    const token = localStorage.getItem('accessToken');
    window.open(`/api/files/download?path=${encodeURIComponent(fullPath)}&token=${token}`, '_blank');
  }, [currentPath]);

  const handleUnzip = useCallback(async (item) => {
    const fullPath = currentPath === '~' ? `~/${item.name}` : `${currentPath}/${item.name}`;
    try {
      await apiFetch('/api/files/unzip', {
        method: 'POST',
        body: { zipPath: fullPath }
      });
      loadDirectory(currentPath);
    } catch (err) {
      setError(err.message || 'Failed to extract zip');
    }
  }, [currentPath, loadDirectory]);

  const formatSize = (bytes) => {
    if (bytes === 0) return '-';
    const units = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${units[i]}`;
  };

  const getBreadcrumbs = () => {
    if (!currentPath || currentPath === '~') return [{ name: 'Home', path: '~' }];
    const parts = currentPath.split('/');
    const crumbs = [];
    let path = '';
    for (const part of parts) {
      path = path ? `${path}/${part}` : part;
      crumbs.push({ name: part === '~' ? 'Home' : part, path });
    }
    return crumbs;
  };

  if (!isOpen) return null;

  return (
    <div className="file-manager">
      <div className="file-manager-header">
        <h3 style={{ color: 'white', margin: 0 }}>Files</h3>
        <button className="file-manager-close" onClick={onClose}>×</button>
      </div>

      <div className="file-manager-breadcrumbs">
        {getBreadcrumbs().map((crumb, index) => (
          <span key={crumb.path}>
            {index > 0 && <span className="breadcrumb-separator">/</span>}
            <button
              className="breadcrumb-item"
              onClick={() => navigateTo(crumb.path)}
            >
              {crumb.name}
            </button>
          </span>
        ))}
      </div>

      <div className="file-manager-toolbar">
        <button onClick={navigateUp} disabled={currentPath === '~'} title="Go up">
          ↑
        </button>
        <button onClick={() => loadDirectory(currentPath)} title="Refresh">
          ↻
        </button>
        <button onClick={() => setShowNewFolderDialog(true)} title="New folder">
          +
        </button>
        <button onClick={() => fileInputRef.current?.click()} title="Upload">
          ⬆
        </button>
        <input
          ref={fileInputRef}
          type="file"
          multiple
          style={{ display: 'none' }}
          onChange={handleFileSelect}
        />
      </div>

      {showNewFolderDialog && (
        <div className="file-manager-dialog">
          <input
            type="text"
            placeholder="Folder name"
            value={newFolderName}
            onChange={(e) => setNewFolderName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleCreateFolder()}
            autoFocus
          />
          <button onClick={handleCreateFolder}>Create</button>
          <button onClick={() => { setShowNewFolderDialog(false); setNewFolderName(''); }}>Cancel</button>
        </div>
      )}

      {uploadProgress && (
        <div className="file-manager-progress">
          Uploading {uploadProgress.current}/{uploadProgress.total}...
        </div>
      )}

      {error && (
        <div className="file-manager-error">
          {error}
          <button onClick={() => setError(null)}>×</button>
        </div>
      )}

      <div
        className={`file-manager-list ${dragOver ? 'drag-over' : ''}`}
        onDrop={handleDrop}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
      >
        {loading ? (
          <div className="file-manager-loading">Loading...</div>
        ) : items.length === 0 ? (
          <div className="file-manager-empty">Empty folder</div>
        ) : (
          items.map((item) => (
            <div
              key={item.name}
              className={`file-item ${item.type}`}
              onClick={() => handleItemClick(item)}
              onDoubleClick={() => handleItemDoubleClick(item)}
            >
              <span className="file-icon">
                {item.type === 'directory' ? '📁' : '📄'}
              </span>
              <span className="file-name">{item.name}</span>
              <span className="file-size">{formatSize(item.size)}</span>
              <div className="file-actions">
                {item.type === 'file' && (
                  <button onClick={(e) => { e.stopPropagation(); handleDownload(item); }} title="Download">
                    ⬇
                  </button>
                )}
                {item.type === 'file' && item.name.endsWith('.zip') && (
                  <button onClick={(e) => { e.stopPropagation(); handleUnzip(item); }} title="Extract">
                    📦
                  </button>
                )}
                <button onClick={(e) => { e.stopPropagation(); handleDelete(item); }} title="Delete">
                  🗑
                </button>
              </div>
            </div>
          ))
        )}

        {dragOver && (
          <div className="file-manager-dropzone">
            Drop files here to upload
          </div>
        )}
      </div>
    </div>
  );
}
