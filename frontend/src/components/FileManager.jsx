import { useState, useEffect, useCallback, useRef } from 'react';
import { apiGet, apiFetch } from '../utils/api';
import { getAccessToken } from '../utils/auth';

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
  const folderInputRef = useRef(null);

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

  const buildItemPath = useCallback((itemName) => {
    const base = currentPath.endsWith('/') && currentPath.length > 1
      ? currentPath.slice(0, -1)
      : currentPath;
    if (base === '~') return `~/${itemName}`;
    if (base === '/') return `/${itemName}`;
    return `${base}/${itemName}`;
  }, [currentPath]);

  const navigateUp = useCallback(() => {
    if (!currentPath || currentPath === '~' || currentPath === '/') return;
    const trimmed = currentPath.endsWith('/') && currentPath.length > 1
      ? currentPath.slice(0, -1)
      : currentPath;
    const lastSlash = trimmed.lastIndexOf('/');
    if (lastSlash < 0) return;
    if (lastSlash === 0) {
      navigateTo('/');
      return;
    }
    const parentPath = trimmed.slice(0, lastSlash);
    navigateTo(parentPath);
  }, [currentPath, navigateTo]);

  const handleItemClick = useCallback((item) => {
    if (item.type === 'directory') {
      navigateTo(buildItemPath(item.name));
    }
  }, [buildItemPath, navigateTo]);

  const handleItemDoubleClick = useCallback((item) => {
    if (item.type === 'directory' && onNavigateTerminal) {
      const fullPath = buildItemPath(item.name);
      onNavigateTerminal(fullPath);
    }
  }, [buildItemPath, onNavigateTerminal]);

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

  const readAllDirectoryEntries = useCallback(async (directoryReader) => {
    const entries = [];
    while (true) {
      const batch = await new Promise((resolve, reject) => {
        directoryReader.readEntries(resolve, reject);
      });
      if (!batch.length) break;
      entries.push(...batch);
    }
    return entries;
  }, []);

  const readEntryFiles = useCallback(async (entry, prefix = '') => {
    if (entry.isFile) {
      const file = await new Promise((resolve, reject) => {
        entry.file(resolve, reject);
      });
      return [{ file, relativePath: `${prefix}${file.name}` }];
    }
    if (entry.isDirectory) {
      const reader = entry.createReader();
      const entries = await readAllDirectoryEntries(reader);
      const files = [];
      for (const child of entries) {
        const childFiles = await readEntryFiles(child, `${prefix}${entry.name}/`);
        files.push(...childFiles);
      }
      return files;
    }
    return [];
  }, [readAllDirectoryEntries]);

  const getDroppedEntries = useCallback(async (dataTransfer) => {
    const itemsList = Array.from(dataTransfer?.items || []);
    if (itemsList.length === 0) return [];

    const entries = itemsList
      .map((item) => (item.webkitGetAsEntry ? item.webkitGetAsEntry() : null))
      .filter(Boolean);

    if (entries.length === 0) return [];

    const files = [];
    for (const entry of entries) {
      const entryFiles = await readEntryFiles(entry);
      files.push(...entryFiles);
    }
    return files;
  }, [readEntryFiles]);

  const handleUploadEntries = useCallback(async (entries) => {
    if (!entries || entries.length === 0) return;

    setUploadProgress({ current: 0, total: entries.length });

    for (let i = 0; i < entries.length; i++) {
      const { file, relativePath } = entries[i];
      const formData = new FormData();
      formData.append('path', currentPath);
      formData.append('files', file, relativePath || file.name);

      try {
        await fetch('/api/files/upload', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${getAccessToken()}`
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

  const handleUpload = useCallback(async (files) => {
    if (!files || files.length === 0) return;
    const entries = Array.from(files).map((file) => ({
      file,
      relativePath: file.webkitRelativePath || file.name
    }));
    await handleUploadEntries(entries);
  }, [handleUploadEntries]);

  const handleFileSelect = useCallback((e) => {
    handleUpload(e.target.files);
    e.target.value = '';
  }, [handleUpload]);

  const handleFolderSelect = useCallback((e) => {
    handleUpload(e.target.files);
    e.target.value = '';
  }, [handleUpload]);

  const handleDrop = useCallback(async (e) => {
    e.preventDefault();
    setDragOver(false);
    const entries = await getDroppedEntries(e.dataTransfer);
    if (entries.length > 0) {
      await handleUploadEntries(entries);
      return;
    }
    handleUpload(e.dataTransfer.files);
  }, [getDroppedEntries, handleUpload, handleUploadEntries]);

  const handleDragOver = useCallback((e) => {
    e.preventDefault();
    setDragOver(true);
  }, []);

  const handleDragLeave = useCallback(() => {
    setDragOver(false);
  }, []);

  const handleDelete = useCallback(async (item) => {
    const fullPath = buildItemPath(item.name);
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
  }, [buildItemPath, loadDirectory]);

  const handleDownload = useCallback(async (item) => {
    const fullPath = buildItemPath(item.name);
    const token = localStorage.getItem('accessToken');
    window.open(`/api/files/download?path=${encodeURIComponent(fullPath)}&token=${token}`, '_blank');
  }, [buildItemPath]);

  const handleUnzip = useCallback(async (item) => {
    const fullPath = buildItemPath(item.name);
    try {
      await apiFetch('/api/files/unzip', {
        method: 'POST',
        body: { zipPath: fullPath }
      });
      loadDirectory(currentPath);
    } catch (err) {
      setError(err.message || 'Failed to extract zip');
    }
  }, [buildItemPath, currentPath, loadDirectory]);

  const formatSize = (bytes) => {
    if (bytes === 0) return '-';
    const units = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${units[i]}`;
  };

  const getBreadcrumbs = () => {
    if (!currentPath || currentPath === '~') return [{ name: 'Home', path: '~' }];
    if (currentPath.startsWith('~/')) {
      const parts = currentPath.split('/');
      const crumbs = [];
      let path = '';
      for (const part of parts) {
        path = path ? `${path}/${part}` : part;
        crumbs.push({ name: part === '~' ? 'Home' : part, path });
      }
      return crumbs;
    }

    if (currentPath === '/') return [{ name: '/', path: '/' }];

    if (currentPath.startsWith('/')) {
      const parts = currentPath.split('/').filter(Boolean);
      const crumbs = [{ name: '/', path: '/' }];
      let path = '';
      for (const part of parts) {
        path = `${path}/${part}`;
        crumbs.push({ name: part, path });
      }
      return crumbs;
    }

    const parts = currentPath.split('/');
    const crumbs = [];
    let path = '';
    for (const part of parts) {
      path = path ? `${path}/${part}` : part;
      crumbs.push({ name: part, path });
    }
    return crumbs;
  };

  const handleGoToPath = useCallback(() => {
    const nextPath = window.prompt('Go to path:', currentPath);
    if (nextPath) {
      navigateTo(nextPath.trim());
    }
  }, [currentPath, navigateTo]);

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
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M19 12H5M12 19l-7-7 7-7" />
          </svg>
        </button>
        <button onClick={() => loadDirectory(currentPath)} title="Refresh">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M23 4v6h-6M1 20v-6h6M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15" />
          </svg>
        </button>
        <button onClick={() => setShowNewFolderDialog(true)} title="New folder">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 5v14M5 12h14" />
          </svg>
        </button>
        <button onClick={() => fileInputRef.current?.click()} title="Upload">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12" />
          </svg>
        </button>
        <button onClick={() => folderInputRef.current?.click()} title="Upload folder">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
            <line x1="12" y1="11" x2="12" y2="17" />
            <line x1="9" y1="14" x2="15" y2="14" />
          </svg>
        </button>
        <button onClick={handleGoToPath} title="Go to path">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M5 12h14M12 5l7 7-7 7" />
          </svg>
        </button>
        <input
          ref={fileInputRef}
          type="file"
          multiple
          style={{ display: 'none' }}
          onChange={handleFileSelect}
        />
        <input
          ref={folderInputRef}
          type="file"
          multiple
          webkitdirectory="true"
          directory="true"
          style={{ display: 'none' }}
          onChange={handleFolderSelect}
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
                {item.type === 'directory' ? (
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ color: '#fbbf24' }}>
                    <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
                  </svg>
                ) : (
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ color: '#94a3b8' }}>
                    <path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z" />
                    <polyline points="13 2 13 9 20 9" />
                  </svg>
                )}
              </span>
              <span className="file-name">{item.name}</span>
              <span className="file-size">{formatSize(item.size)}</span>
              <div className="file-actions">
                {item.type === 'file' && (
                  <button onClick={(e) => { e.stopPropagation(); handleDownload(item); }} title="Download">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3" />
                    </svg>
                  </button>
                )}
                {item.type === 'directory' && (
                  <button onClick={(e) => { e.stopPropagation(); handleDownload(item); }} title="Download zip">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3" />
                    </svg>
                  </button>
                )}
                {item.type === 'file' && item.name.endsWith('.zip') && (
                  <button onClick={(e) => { e.stopPropagation(); handleUnzip(item); }} title="Extract">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="21 8 21 21 3 21 3 8" />
                      <rect x="1" y="3" width="22" height="5" />
                      <line x1="10" y1="12" x2="14" y2="12" />
                    </svg>
                  </button>
                )}
                <button onClick={(e) => { e.stopPropagation(); handleDelete(item); }} title="Delete">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="3 6 5 6 21 6" />
                    <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                    <line x1="10" y1="11" x2="10" y2="17" />
                    <line x1="14" y1="11" x2="14" y2="17" />
                  </svg>
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
