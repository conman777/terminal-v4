import { resolveApiUrl } from '../utils/apiBase';
import { useState, useEffect, useLayoutEffect, useCallback, useRef, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { apiGet, apiFetch } from '../utils/api';
import { captureAuthScope, getAccessToken, isAuthScopeCurrent, subscribeAuth } from '../utils/auth';
import { getActiveEnvironment, getEnvironmentSignal, subscribeEnvironment } from '../utils/remoteEnvironments';
import { environmentAllows, requireEnvironmentCapability } from '../utils/runtimePermissions';
import { validProjectFilePath } from '../utils/projectFileReference';
import { ProjectFilePreview, validProjectFilePreview } from './ProjectFilePreview';
import '../ProFileManager.css';

function normalizeFilePath(path) {
  return /^[a-z]:[\\/]/i.test(path) || path.startsWith('\\\\') ? path.replaceAll('\\', '/') : path;
}

function scopedDirectory(root, path) {
  if (typeof root !== 'string' || !root.startsWith('/') || typeof path !== 'string') return null;
  const base = root === '/' ? '/' : root.replace(/\/+$/, '');
  if (path === base) return '';
  const prefix = base === '/' ? '/' : `${base}/`;
  if (!path.startsWith(prefix)) return null;
  const relative = path.slice(prefix.length);
  return relative && !relative.includes('\\') && !/[\x00-\x1f\x7f-\x9f]/.test(relative)
    && relative.split('/').every(part => part && part !== '.' && part !== '..') ? relative : null;
}

function scopedFile(root, directory, name) {
  const relative = scopedDirectory(root, directory);
  if (relative === null) return null;
  const path = relative ? `${relative}/${name}` : name;
  return validProjectFilePath(path, root) ? { path, line: 1 } : null;
}

function isRequestScopeCurrent(auth, environment) {
  return environment === getEnvironmentSignal() && !environment.aborted
    && isAuthScopeCurrent(auth) && captureAuthScope().userId === auth.userId;
}

function FileIcon({ name }) {
  const paths = {
    more: <><circle cx="5" cy="12" r="1" /><circle cx="12" cy="12" r="1" /><circle cx="19" cy="12" r="1" /></>,
    close: <path d="m6 6 12 12M6 18 18 6" />,
    up: <path d="m6 10 6-6 6 6M12 4v16" />,
    refresh: <><path d="M20 7v5h-5M4 17v-5h5" /><path d="M6 7a7 7 0 0 1 12-1l2 6M4 12l2 6a7 7 0 0 0 12-1" /></>,
    folder: <path d="M3 7V5h6l2 2h10v13H3Z" />,
    file: <><path d="M14 3H5v18h14V8Z" /><path d="M14 3v5h5" /></>,
    newFolder: <><path d="M3 7V5h6l2 2h10v13H3Z" /><path d="M12 10v7m-3-3h6" /></>,
    upload: <path d="m7 8 5-5 5 5M12 3v12M4 15v6h16v-6" />,
    uploadFolder: <><path d="M3 7V5h6l2 2h10v13H3Z" /><path d="m9 14 3-3 3 3m-3-3v7" /></>,
    download: <path d="m7 11 5 5 5-5M12 3v13M4 16v5h16v-5" />,
    path: <path d="M4 5v7h16m-5-5 5 5-5 5" />,
    preview: <><path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7-10-7-10-7Z" /><circle cx="12" cy="12" r="3" /></>,
    extract: <><path d="M3 4h18v5H3Zm2 5v12h14V9M9 13h6" /></>,
    delete: <path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7m4-7v7" />,
  };
  return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}

async function checkOperationResponse(response, fallback) {
  if (response.ok) return;
  let message = fallback;
  try {
    const payload = await response.json();
    const detail = payload?.error || payload?.message;
    if (typeof detail === 'string' && detail) message = detail;
  } catch {
    // Error responses may contain plain text or HTML.
  }
  throw new Error(message);
}

export function FileManager({ isOpen, onClose, onNavigateTerminal, initialPath = '~', sessionId = null, projectTarget = null }) {
  const environment = useSyncExternalStore(subscribeEnvironment, getActiveEnvironment);
  const [searchScope, setSearchScope] = useState(null);
  const currentSearchScope = searchScope?.sessionId === sessionId && isRequestScopeCurrent(searchScope.auth, searchScope.environment) ? searchScope : null;
  const activeTarget = projectTarget || currentSearchScope;
  const isScoped = Boolean(activeTarget);
  const projectRoot = typeof activeTarget?.root === 'string' ? normalizeFilePath(activeTarget.root).replace(/\/+$/, '') || '/' : null;
  const targetPath = typeof activeTarget?.path === 'string' ? activeTarget.path : '';
  const validTarget = validProjectFilePath(targetPath, projectRoot) ? { path: targetPath } : null;
  const canWrite = !isScoped && environmentAllows(environment, 'fileWrite');
  const canReadContents = environmentAllows(environment, 'transfer');
  const [actionMenu, setActionMenu] = useState(null);
  const menuRef = useRef(null);
  const [rename, setRename] = useState(null);
  const renameRef = useRef(null);
  renameRef.current = rename;
  const [renameName, setRenameName] = useState('');
  const [renameError, setRenameError] = useState('');
  const [renaming, setRenaming] = useState(false);
  const renameRequest = useRef(false);
  const [notice, setNotice] = useState('');
  const [currentPath, setCurrentPath] = useState(() => normalizeFilePath(initialPath || '~'));
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [operationError, setOperationError] = useState(null);
  const [showNewFolderDialog, setShowNewFolderDialog] = useState(false);
  const [newFolderName, setNewFolderName] = useState('');
  const [creatingFolder, setCreatingFolder] = useState(false);
  const folderRequest = useRef(false);
  const folderDraftGeneration = useRef(0);
  const [uploadProgress, setUploadProgress] = useState(null);
  const [dragOver, setDragOver] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [contentMode, setContentMode] = useState(false);
  const [contentQuery, setContentQuery] = useState('');
  const [contentResults, setContentResults] = useState(null);
  const [contentError, setContentError] = useState('');
  const [contentLoading, setContentLoading] = useState(false);
  const [selectedContentMatch, setSelectedContentMatch] = useState(null);
  const contentRequest = useRef(null);
  const previewRequest = useRef(null);
  const [linePreview, setLinePreview] = useState(null);
  const [linePreviewError, setLinePreviewError] = useState('');
  const [linePreviewLoading, setLinePreviewLoading] = useState(false);
  const previewLineRef = useRef(null);
  const [previewImage, setPreviewImage] = useState(null);
  const [scopedPreview, setScopedPreview] = useState(null);
  const [selectedFile, setSelectedFile] = useState('');
  const directoryGeneration = useRef(0);
  const directoryRequest = useRef(null);
  const initialSelectionPending = useRef(isScoped);
  const scopeInvalidated = useRef(false);
  const navigationGeneration = useRef(0);
  const directoryScope = useRef({ sessionId, signal: getEnvironmentSignal() });
  const environmentSignal = useRef(getEnvironmentSignal());
  const panelRef = useRef(null);
  const breadcrumbsRef = useRef(null);
  const atRoot = isScoped ? currentPath === projectRoot : currentPath === '~' || currentPath === '/' || /^[a-z]:\/$/i.test(currentPath) || /^\/\/[^/]+\/[^/]+\/?$/.test(currentPath);

  useLayoutEffect(() => {
    const breadcrumbs = breadcrumbsRef.current;
    if (breadcrumbs) breadcrumbs.scrollLeft = breadcrumbs.scrollWidth - breadcrumbs.clientWidth;
  }, [currentPath]);
  const fileInputRef = useRef(null);
  const folderInputRef = useRef(null);
  const newFolderButtonRef = useRef(null);
  const previewRef = useRef(null);
  const selectedContentRef = useRef(null);
  const contentResultsRef = useRef(null);
  const restoreContentFocus = useRef(null);

  useLayoutEffect(() => {
    if (!contentMode && selectedContentMatch) selectedContentRef.current?.focus({ preventScroll: true });
    if (contentMode && restoreContentFocus.current) {
      const { path, line } = restoreContentFocus.current;
      const result = [...(contentResultsRef.current?.querySelectorAll('button[data-result-path]') || [])]
        .find(button => button.dataset.resultPath === path && Number(button.dataset.resultLine) === line);
      result?.focus({ preventScroll: true });
      restoreContentFocus.current = null;
    }
  }, [contentMode, selectedContentMatch]);

  const cancelContentSearch = useCallback(() => {
    contentRequest.current?.abort();
    contentRequest.current = null;
  }, []);
  const cancelLinePreview = useCallback(() => {
    previewRequest.current?.abort();
    previewRequest.current = null;
  }, []);
  useLayoutEffect(() => {
    setLinePreview(null); setLinePreviewError(''); setLinePreviewLoading(false);
    return cancelLinePreview;
  }, [cancelLinePreview, selectedContentMatch]);
  useLayoutEffect(() => {
    if (!linePreview) return undefined;
    const reveal = () => previewLineRef.current?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
    const viewport = window.visualViewport;
    reveal();
    window.addEventListener('resize', reveal);
    viewport?.addEventListener('resize', reveal);
    return () => { window.removeEventListener('resize', reveal); viewport?.removeEventListener('resize', reveal); };
  }, [linePreview]);
  useLayoutEffect(() => {
    cancelContentSearch();
    cancelLinePreview();
    directoryGeneration.current += 1; navigationGeneration.current += 1;
    setItems([]); setLoading(false); setSelectedFile(''); setScopedPreview(null);
    setContentResults(null); setContentError(''); setContentLoading(false); setSelectedContentMatch(null); setContentMode(false); setContentQuery(''); setSearchScope(null);
    return () => { cancelContentSearch(); cancelLinePreview(); };
  }, [cancelContentSearch, cancelLinePreview, sessionId, isOpen, projectTarget?.root, projectTarget?.path]);
  useEffect(() => subscribeEnvironment(() => {
    directoryRequest.current?.abort();
    cancelContentSearch();
    cancelLinePreview();
    if (environmentSignal.current !== getEnvironmentSignal()) {
      environmentSignal.current = getEnvironmentSignal();
      scopeInvalidated.current = true;
      directoryGeneration.current += 1; navigationGeneration.current += 1;
      setItems([]); setLoading(false); setSelectedFile(''); setScopedPreview(null);
      setCurrentPath('~');
      setError('Account or server changed. Close and reopen Files to load the current workspace.');
      setContentMode(false); setContentQuery(''); setSearchScope(null);
    }
    setContentResults(null); setContentError(''); setContentLoading(false); setSelectedContentMatch(null);
  }), [cancelContentSearch, cancelLinePreview]);
  useEffect(() => {
    let scope = captureAuthScope();
    return subscribeAuth(() => {
      const next = captureAuthScope();
      if (isAuthScopeCurrent(scope) && scope.userId === next.userId) return;
      scope = next;
      scopeInvalidated.current = true;
      directoryRequest.current?.abort();
      cancelContentSearch(); cancelLinePreview();
      directoryGeneration.current += 1; navigationGeneration.current += 1;
      setItems([]); setLoading(false); setSelectedFile(''); setSelectedContentMatch(null); setScopedPreview(null);
      setCurrentPath('~'); setContentMode(false); setContentQuery(''); setContentResults(null); setSearchScope(null);
      setContentError(''); setContentLoading(false); setPreviewImage(null); setActionMenu(null); setRename(null);
      setNotice(''); setOperationError(null);
      setError('Account or server changed. Close and reopen Files to load the current workspace.');
    });
  }, [cancelContentSearch, cancelLinePreview]);

  async function searchProject(event) {
    event.preventDefault();
    const query = contentQuery.trim();
    if (!sessionId || !canReadContents || !query || query.length > 200) return;
    cancelContentSearch();
    const controller = new AbortController();
    const auth = captureAuthScope();
    const environment = getEnvironmentSignal();
    contentRequest.current = controller;
    const current = () => contentRequest.current === controller && !controller.signal.aborted && isRequestScopeCurrent(auth, environment);
    setContentResults(null); setContentError(''); setContentLoading(true); setSelectedContentMatch(null);
    try {
      const response = await apiFetch(`/api/workspace/files/search-content?${new URLSearchParams({ sessionId, query })}`, { signal: controller.signal });
      const data = await response.json().catch(() => null);
      if (!response.ok) throw new Error(data?.error || 'Could not search project contents.');
      if (typeof data?.root !== 'string' || !Array.isArray(data?.matches) || data.matches.some(match => typeof match?.path !== 'string' || !Number.isSafeInteger(match?.line) || match.line < 1 || typeof match?.text !== 'string')) throw new Error('Project search returned an invalid response.');
      if (current()) setContentResults(data);
    } catch (failure) {
      if (current()) setContentError(failure.message || 'Could not search project contents.');
    } finally {
      if (contentRequest.current === controller) { contentRequest.current = null; setContentLoading(false); }
    }
  }

  function showContentMatch(root, match) {
    const relative = match.path;
    if (!validProjectFilePath(relative, root) || !Number.isSafeInteger(match.line) || match.line < 1 || match.line > 1_000_000) {
      setContentError('This result cannot be opened safely in the selected project.');
      return;
    }
    const parts = relative.split('/');
    const name = parts.pop();
    const base = root === '/' ? '' : root.replace(/\/+$/, '');
    const folder = `${base}/${parts.join('/')}`.replace(/\/$/, '') || '/';
    directoryRequest.current?.abort();
    directoryGeneration.current += 1; navigationGeneration.current += 1;
    setItems([]); setError(null); setNotice(''); setSearchQuery('');
    setSearchScope({ root, path: relative, sessionId, auth: captureAuthScope(), environment: getEnvironmentSignal(), previousPath: currentPath, match });
    initialSelectionPending.current = true;
    setCurrentPath(folder);
    setContentMode(false);
    setSelectedFile(name);
    setSelectedContentMatch({ ...match, root });
  }

  function returnToContentResults() {
    cancelLinePreview();
    directoryRequest.current?.abort();
    directoryGeneration.current += 1; navigationGeneration.current += 1;
    restoreContentFocus.current = selectedContentMatch || currentSearchScope?.match;
    setCurrentPath(currentSearchScope?.previousPath || normalizeFilePath(initialPath || '~'));
    setSearchScope(null); setItems([]); setLoading(false); setError(null);
    setContentMode(true); setSelectedContentMatch(null); setScopedPreview(null);
  }

  async function openCurrentLine() {
    const match = selectedContentMatch;
    if (!match || !sessionId || !canReadContents) return;
    cancelLinePreview();
    const controller = new AbortController();
    const auth = captureAuthScope();
    const environment = getEnvironmentSignal();
    previewRequest.current = controller;
    setLinePreview(null); setLinePreviewError(''); setLinePreviewLoading(true);
    const current = () => previewRequest.current === controller && !controller.signal.aborted && isRequestScopeCurrent(auth, environment);
    try {
      const params = new URLSearchParams({ sessionId, root: match.root, path: match.path, line: String(match.line), query: contentQuery.trim() });
      const response = await apiFetch(`/api/workspace/files/read-content?${params}`, { signal: controller.signal });
      const data = await response.json().catch(() => null);
      if (!response.ok) throw new Error(data?.error || 'Could not open this file.');
      if (!validProjectFilePreview(data, match.root, { path: match.path, line: match.line })) {
        throw new Error('File preview returned an invalid response.');
      }
      if (current()) setLinePreview(data);
    } catch (failure) {
      if (current()) setLinePreviewError(failure.message || 'Could not open this file.');
    } finally {
      if (previewRequest.current === controller) { previewRequest.current = null; setLinePreviewLoading(false); }
    }
  }

  useLayoutEffect(() => {
    if (!isOpen) return;
    const panel = panelRef.current;
    const opener = document.activeElement;
    panel?.querySelector('.file-manager-close')?.focus({ preventScroll: true });
    return () => {
      if (opener?.isConnected && (panel?.contains(document.activeElement) || document.activeElement === document.body)) opener.focus({ preventScroll: true });
    };
  }, [isOpen]);

  function handlePanelKeyDown(event) {
    if (event.isComposing || event.keyCode === 229 || event.defaultPrevented || event.key !== 'Escape') return;
    event.preventDefault(); event.stopPropagation(); onClose?.();
  }

  useLayoutEffect(() => {
    if (!actionMenu || !menuRef.current) return;
    const menu = menuRef.current;
    const trigger = actionMenu.trigger.getBoundingClientRect();
    const size = menu.getBoundingClientRect();
    menu.style.left = Math.max(8, Math.min(window.innerWidth - size.width - 8, trigger.right - size.width)) + 'px';
    menu.style.top = Math.max(8, trigger.bottom + size.height + 4 > window.innerHeight ? trigger.top - size.height - 4 : trigger.bottom + 4) + 'px';
    (menu.querySelector('button:not(:disabled)') || menu).focus({ preventScroll: true });
    const outside = event => { if (!menu.contains(event.target) && !actionMenu.trigger.contains(event.target)) setActionMenu(null); };
    const close = () => setActionMenu(null);
    document.addEventListener('pointerdown', outside);
    window.addEventListener('resize', close);
    return () => { document.removeEventListener('pointerdown', outside); window.removeEventListener('resize', close); };
  }, [actionMenu]);

  useEffect(() => {
    if (!previewImage) return;
    const opener = document.activeElement;
    previewRef.current?.focus();
    return () => { if (opener?.isConnected) opener.focus({ preventScroll: true }); };
  }, [previewImage]);

  const loadDirectory = useCallback(async (path) => {
    if (scopeInvalidated.current) return;
    const generation = ++directoryGeneration.current;
    directoryRequest.current?.abort();
    const controller = new AbortController();
    directoryRequest.current = controller;
    const auth = captureAuthScope();
    const environment = getEnvironmentSignal();
    const current = () => generation === directoryGeneration.current && !controller.signal.aborted && isRequestScopeCurrent(auth, environment);
    setLoading(true);
    setError(null);
    try {
      let response;
      if (isScoped) {
        const relative = scopedDirectory(projectRoot, path);
        if (!sessionId || !validTarget || validTarget.path !== targetPath || relative === null || !canReadContents) throw new Error('Project folder is unavailable in this thread.');
        const params = new URLSearchParams({ sessionId, root: projectRoot, path: relative });
        const result = await apiFetch(`/api/workspace/files/list-directory?${params}`, { signal: controller.signal });
        response = await result.json().catch(() => null);
        if (!result.ok) throw new Error(response?.error || 'Could not load project files.');
        if (response?.root !== projectRoot || response.path !== relative || typeof response.truncated !== 'boolean'
          || !Array.isArray(response.items) || response.items.length > 2000
          || response.items.some(item => typeof item?.name !== 'string' || !item.name || item.name === '.' || item.name === '..'
            || /[\/\\\x00-\x1f\x7f-\x9f]/.test(item.name) || !['file', 'directory'].includes(item.type) || !Number.isFinite(item.size) || item.size < 0)
          || new Set(response.items.map(item => item.name)).size !== response.items.length) throw new Error('Project directory returned an invalid response.');
        response = { ...response, path };
      } else response = await apiGet(`/api/files/list?path=${encodeURIComponent(path)}`);
      if (!current()) return;
      setCurrentPath(normalizeFilePath(response?.path || path));
      setItems(Array.isArray(response?.items) ? response.items : []);
      if (isScoped) {
        if (response.truncated) setNotice('Some project files may not be shown.');
        if (initialSelectionPending.current) {
          const parts = targetPath.split('/');
          const name = parts.pop();
          if (scopedDirectory(projectRoot, path) === parts.join('/')) {
            initialSelectionPending.current = false;
            if (response.items.some(item => item.type === 'file' && item.name === name)) setSelectedFile(name);
            else setNotice('The referenced file is not listed; it may have changed or the folder is too large.');
          }
        }
      }
    } catch (err) {
      if (current()) setError(err.message || 'Failed to load directory');
    } finally {
      if (generation === directoryGeneration.current) setLoading(false);
      if (directoryRequest.current === controller) directoryRequest.current = null;
    }
  }, [isScoped, projectRoot, sessionId, targetPath, canReadContents, validTarget?.path]);

  useEffect(() => {
    if (!isOpen) scopeInvalidated.current = false;
    if (isOpen && initialPath !== null && !contentMode && (!searchScope || currentSearchScope)) {
      const signal = getEnvironmentSignal();
      const sameScope = directoryScope.current.sessionId === sessionId && directoryScope.current.signal === signal;
      const requested = sameScope ? currentPath : normalizeFilePath(initialPath || '~');
      directoryScope.current = { sessionId, signal };
      loadDirectory(requested);
    }
    return () => { directoryGeneration.current += 1; navigationGeneration.current += 1; directoryRequest.current?.abort(); };
  }, [isOpen, loadDirectory, initialPath, sessionId, contentMode, searchScope, currentSearchScope]);

  const navigateTo = useCallback((path) => {
    navigationGeneration.current += 1;
    setActionMenu(null); setRename(null); setRenameError(''); setNotice('');
    setOperationError(null);
    setSearchQuery('');
    setSelectedFile('');
    setSelectedContentMatch(null);
    loadDirectory(normalizeFilePath(path));
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
    if (!currentPath || atRoot) return;
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
  }, [currentPath, navigateTo, atRoot]);

  const handleItemClick = useCallback((item) => {
    if (item.type === 'directory') {
      navigateTo(buildItemPath(item.name));
    } else { setSelectedFile(item.name); setSelectedContentMatch(null); }
  }, [buildItemPath, navigateTo]);

  const handleItemDoubleClick = useCallback((item) => {
    if (!isScoped && item.type === 'directory' && onNavigateTerminal) {
      const fullPath = buildItemPath(item.name);
      onNavigateTerminal(fullPath);
    }
  }, [buildItemPath, isScoped, onNavigateTerminal]);

  const handleCreateFolder = useCallback(async () => {
    if (!canWrite || !newFolderName.trim() || loading || folderRequest.current) return;
    folderRequest.current = true;
    setCreatingFolder(true);
    const draftGeneration = folderDraftGeneration.current;
    const navigation = navigationGeneration.current;
    setOperationError(null);

    try {
      const path = currentPath === '~' ? `~/${newFolderName}` : `${currentPath}/${newFolderName}`;
      const response = await apiFetch('/api/files/mkdir', {
        method: 'POST',
        body: { path }
      });
      await checkOperationResponse(response, 'Failed to create folder');
      if (navigation !== navigationGeneration.current) return;
      if (draftGeneration === folderDraftGeneration.current) {
        setNewFolderName('');
        setShowNewFolderDialog(false);
        newFolderButtonRef.current?.focus();
      }
      loadDirectory(currentPath);
    } catch (err) {
      setOperationError(err.message || 'Failed to create folder');
    } finally {
      folderRequest.current = false; setCreatingFolder(false);
    }
  }, [currentPath, newFolderName, loadDirectory, loading, canWrite]);

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
    if (!canWrite || !entries || entries.length === 0 || loading) return;
    const navigation = navigationGeneration.current;

    setOperationError(null);
    setUploadProgress({ current: 0, total: entries.length });
    const failures = [];
    let uploaded = 0;

    for (let i = 0; i < entries.length; i++) {
      const { file, relativePath } = entries[i];
      const formData = new FormData();
      formData.append('path', currentPath);
      formData.append('files', file, relativePath || file.name);

      try {
        const token = getAccessToken();
        const response = await apiFetch('/api/files/upload', {
          method: 'POST',
          headers: token ? { 'Authorization': `Bearer ${token}` } : {},
          body: formData
        });
        await checkOperationResponse(response, 'Upload failed');
        uploaded += 1;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        failures.push(`Failed to upload ${relativePath || file.name}: ${message}`);
      } finally {
        setUploadProgress({ current: i + 1, total: entries.length });
      }
    }

    setUploadProgress(null);
    if (failures.length) {
      setOperationError(`${uploaded}/${entries.length} files uploaded. ${failures.join(' ')}`);
    }
    if (navigation === navigationGeneration.current) await loadDirectory(currentPath);
  }, [currentPath, loadDirectory, loading, canWrite]);

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
    if (!canWrite || loading || uploadProgress) return;
    const navigation = navigationGeneration.current;
    let entries;
    try { entries = await getDroppedEntries(e.dataTransfer); }
    catch (failure) { setOperationError(failure.message || 'Could not read dropped files. Try choosing the files again.'); return; }
    if (navigation !== navigationGeneration.current) {
      setOperationError('The folder changed before files were ready. Drop them again in the current folder.');
      return;
    }
    if (entries.length > 0) {
      await handleUploadEntries(entries);
      return;
    }
    handleUpload(e.dataTransfer.files);
  }, [getDroppedEntries, handleUpload, handleUploadEntries, loading, uploadProgress, canWrite]);

  const handleDragOver = useCallback((e) => {
    e.preventDefault();
    if (canWrite) setDragOver(true);
  }, [canWrite]);

  const handleDragLeave = useCallback(() => {
    setDragOver(false);
  }, []);

  const handleDelete = useCallback(async (item) => {
    if (!canWrite) return;
    const fullPath = buildItemPath(item.name);
    const navigation = navigationGeneration.current;
    if (!confirm(`Delete "${item.name}"?`)) return;
    setOperationError(null);

    try {
      const response = await apiFetch('/api/files/delete', {
        method: 'DELETE',
        body: { path: fullPath }
      });
      await checkOperationResponse(response, 'Failed to delete');
      if (navigation !== navigationGeneration.current) return;
      loadDirectory(currentPath);
    } catch (err) {
      setOperationError(err.message || 'Failed to delete');
    }
  }, [buildItemPath, currentPath, loadDirectory, canWrite]);

  const handleDownload = useCallback(async (item) => {
    const fullPath = buildItemPath(item.name);
    const token = getAccessToken();
    window.open(resolveApiUrl(`/api/files/download?path=${encodeURIComponent(fullPath)}&token=${encodeURIComponent(token)}`), '_blank');
  }, [buildItemPath]);

  const handleUnzip = useCallback(async (item) => {
    if (!canWrite) return;
    const navigation = navigationGeneration.current;
    const fullPath = buildItemPath(item.name);
    setOperationError(null);
    try {
      const response = await apiFetch('/api/files/unzip', {
        method: 'POST',
        body: { zipPath: fullPath }
      });
      await checkOperationResponse(response, 'Failed to extract zip');
      if (navigation !== navigationGeneration.current) return;
      loadDirectory(currentPath);
    } catch (err) {
      setOperationError(err.message || 'Failed to extract zip');
    }
  }, [buildItemPath, currentPath, loadDirectory, canWrite]);

  const isImage = useCallback((filename) => {
    const ext = filename.toLowerCase().split('.').pop();
    return ['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'bmp'].includes(ext);
  }, []);

  const handlePreviewImage = useCallback((item) => {
    const fullPath = buildItemPath(item.name);
    const token = getAccessToken();
    const imageUrl = resolveApiUrl(`/api/files/download?path=${encodeURIComponent(fullPath)}&token=${encodeURIComponent(token)}`);
    setPreviewImage({ name: item.name, url: imageUrl });
  }, [buildItemPath]);

  const formatSize = (bytes) => {
    if (!Number.isFinite(bytes) || bytes < 0) return '—';
    if (bytes === 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB'];
    const i = Math.min(units.length - 1, Math.max(0, Math.floor(Math.log(bytes) / Math.log(1024))));
    return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${units[i]}`;
  };

  const getBreadcrumbs = () => {
    if (isScoped) {
      const relative = scopedDirectory(projectRoot, currentPath);
      const crumbs = [{ name: 'Project', path: projectRoot }];
      let path = projectRoot === '/' ? '' : projectRoot;
      for (const part of relative ? relative.split('/') : []) { path += `/${part}`; crumbs.push({ name: part, path }); }
      return crumbs;
    }
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

    if (/^[a-z]:\//i.test(currentPath) || currentPath.startsWith('//')) {
      const parts = currentPath.split('/').filter(Boolean);
      const root = currentPath.startsWith('//') ? '//' + parts.splice(0, 2).join('/') : parts.shift() + '/';
      const crumbs = [{ name: root.replace(/\/$/, ''), path: root }];
      let path = root.replace(/\/$/, '');
      for (const part of parts) { path += '/' + part; crumbs.push({ name: part, path }); }
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

  const filteredItems = items.filter(item => {
    if (!searchQuery.trim()) return true;
    return item.name.toLowerCase().includes(searchQuery.trim().toLowerCase());
  });

  function closeActionMenu() {
    const trigger = actionMenu?.trigger;
    setActionMenu(null);
    if (trigger?.isConnected) trigger.focus({ preventScroll: true });
  }

  function cancelRename() {
    const trigger = rename?.trigger;
    setRename(null); setRenameError('');
    if (trigger?.isConnected) trigger.focus({ preventScroll: true });
  }

  async function handleRename(event) {
    event.preventDefault();
    if (!rename || loading || renameRequest.current) return;
    const edit = rename;
    const name = renameName.trim();
    setRenameError(''); setNotice('');
    if (!name || name === '.' || name === '..' || /[\\/\x00]/.test(name)) {
      setRenameError('Enter a name without path separators. This action renames within the current folder.'); return;
    }
    if (items.some(item => item.name !== edit.item.name && item.name.toLowerCase() === name.toLowerCase())) {
      setRenameError('That name already exists in this folder. Choose a different name.'); return;
    }
    renameRequest.current = true; setRenaming(true);
    try {
      requireEnvironmentCapability('fileWrite', 'renaming files');
      const response = await apiFetch('/api/files/rename', { method: 'POST', body: { from: edit.from, to: edit.from.slice(0, -edit.item.name.length) + name } });
      await checkOperationResponse(response, 'Could not rename. Your new name is still here; try again.');
      if (edit.navigation !== navigationGeneration.current) return;
      if (renameRef.current === edit) { setRename(null); setRenameError(''); panelRef.current?.querySelector('input[type="search"]')?.focus({ preventScroll: true }); }
      setSelectedFile(name); setSearchQuery(''); setNotice('Renamed ' + edit.item.name + ' to ' + name + '.');
      await loadDirectory(edit.base);
    } catch (failure) {
      if (renameRef.current === edit && edit.navigation === navigationGeneration.current) setRenameError(failure.message || 'Could not rename. Try again.');
    } finally { renameRequest.current = false; setRenaming(false); }
  }

  function cancelFolder() {
    folderDraftGeneration.current += 1;
    setShowNewFolderDialog(false);
    setNewFolderName('');
    newFolderButtonRef.current?.focus();
  }

  if (!isOpen) return null;
  if (initialPath === null) return (
    <div ref={panelRef} className="pro-file-manager" role="region" aria-label="Files" onKeyDown={handlePanelKeyDown}>
      <div className="file-manager-header"><h3>Files</h3><button type="button" className="file-manager-close" aria-label="Close files" onClick={onClose}><FileIcon name="close" /></button></div>
      <p role="status">Selected workspace is loading or unavailable.</p>
    </div>
  );

  return (
    <div ref={panelRef} className="pro-file-manager" role="region" aria-label="Files" onKeyDown={handlePanelKeyDown}>
      <div className="file-manager-header">
        <h3>Files</h3>
        <button type="button" className="file-manager-close" aria-label="Close files" onClick={onClose}><FileIcon name="close" /></button>
      </div>

      <nav ref={breadcrumbsRef} className="file-manager-breadcrumbs" aria-label="File path">
        {getBreadcrumbs().map((crumb, index) => (
          <span key={crumb.path}>
            {index > 0 && <span className="breadcrumb-separator" aria-hidden="true">/</span>}
            <button
              className="breadcrumb-item"
              type="button"
              title={crumb.path}
              aria-current={crumb.path === currentPath ? 'location' : undefined}
              onClick={() => navigateTo(crumb.path)}
            >
              {crumb.name}
            </button>
          </span>
        ))}
      </nav>

      <div className="file-manager-toolbar">
        <button type="button" onClick={navigateUp} disabled={atRoot} title="Go up" aria-label="Go up">
          <FileIcon name="up" />
        </button>
        <button type="button" onClick={() => loadDirectory(currentPath)} title="Refresh" aria-label="Refresh" disabled={loading}>
          <FileIcon name="refresh" />
        </button>
        {!isScoped && <><button type="button" ref={newFolderButtonRef} disabled={loading || !canWrite} onClick={() => { if (!showNewFolderDialog) folderDraftGeneration.current += 1; setShowNewFolderDialog(true); }} title="New folder" aria-label="New folder">
          <FileIcon name="newFolder" />
        </button>
        <button type="button" onClick={() => fileInputRef.current?.click()} title="Upload" aria-label="Upload" disabled={loading || !!uploadProgress || !canWrite}>
          <FileIcon name="upload" />
        </button>
        <button type="button" onClick={() => folderInputRef.current?.click()} title="Upload folder" aria-label="Upload folder" disabled={loading || !!uploadProgress || !canWrite}>
          <FileIcon name="uploadFolder" />
        </button></>}
        {!isScoped && <button type="button" onClick={handleGoToPath} title="Go to path" aria-label="Go to path">
          <FileIcon name="path" />
        </button>}
        {!isScoped && <button type="button" className="file-content-toggle" onClick={() => { cancelContentSearch(); setContentResults(null); setContentError(''); setContentLoading(false); setSelectedContentMatch(null); setContentMode(value => !value); }} aria-pressed={contentMode} aria-label="Search project contents">Content</button>}
        {currentSearchScope && !selectedContentMatch && <button type="button" className="file-content-toggle" onClick={returnToContentResults} aria-label="Back to search results">Results</button>}
        <input
          type="search"
          aria-label="Search files"
          placeholder="Search files..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
        />
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

      {contentMode && <section className="file-manager-content-search" aria-label="Project content search">
        {!sessionId ? <p role="status">Select a thread to search its project.</p> : !canReadContents ? <p role="status">File transfer permission is required to search contents on this server.</p> : <>
          <form onSubmit={searchProject}>
            <input type="search" aria-label="Search project contents" placeholder="Find text in project" value={contentQuery} maxLength={200} onChange={event => { cancelContentSearch(); setContentResults(null); setContentError(''); setContentLoading(false); setSelectedContentMatch(null); setContentQuery(event.target.value); }} />
            <button type="submit" disabled={contentLoading || !contentQuery.trim()}>Search project</button>
          </form>
          <p>Searches the selected thread’s project; large, binary and dependency files are skipped.</p>
          {contentLoading && <p role="status">Searching project…</p>}
          {contentError && <p role="alert">{contentError}</p>}
          {contentResults && <div className="file-manager-content-results" ref={contentResultsRef}>
            {!contentResults.matches?.length && <p>No matches found.</p>}
            {contentResults.matches?.map(match => <button type="button" key={`${match.path}:${match.line}`} data-result-path={match.path} data-result-line={match.line} onClick={() => showContentMatch(contentResults.root, match)}>
              <span>{match.path}:{match.line}</span><small>{match.text}</small>
            </button>)}
            {contentResults.truncated && <p>Results are limited. Narrow your search to see more.</p>}
          </div>}
        </>}
      </section>}

      {!contentMode && selectedContentMatch && <section className="file-manager-selected-result" aria-label="Selected search result" tabIndex={-1} ref={selectedContentRef}>
        <div className="file-manager-selected-heading">
          <strong>Search result · {selectedContentMatch.path}:{selectedContentMatch.line}</strong>
          <button type="button" aria-label="Back to search results" onClick={returnToContentResults}>Results</button>
        </div>
        <pre>{selectedContentMatch.text}</pre>
        <p>File may have changed since search.</p>
        <button type="button" onClick={openCurrentLine} disabled={linePreviewLoading || !canReadContents}>Open current file at line</button>
        {linePreviewLoading && <p role="status">Opening file…</p>}
        {linePreviewError && <p role="alert">{linePreviewError}</p>}
        {linePreview && <><p>Current file preview</p><div className="file-manager-live-preview" role="region" aria-label="Current file preview" tabIndex={0}>
          {linePreview.totalLines === 0 && <p>This file is now empty.</p>}
          {linePreview.lines.map(row => <div key={row.line} ref={row.line === linePreview.line ? previewLineRef : undefined} aria-current={row.line === linePreview.line ? 'true' : undefined}>
            <span>{row.line}</span><code>{row.text}{row.truncated ? '…' : ''}</code>
          </div>)}
        </div></>}
      </section>}

      {!isScoped && showNewFolderDialog && (
        <form className="file-manager-dialog" aria-label="New folder" onSubmit={event => { event.preventDefault(); handleCreateFolder(); }} onKeyDown={event => { if (event.isComposing || event.keyCode === 229) return; if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); cancelFolder(); } }}>
          <input
            type="text"
            placeholder="Folder name"
            aria-label="Folder name"
            value={newFolderName}
            onChange={(e) => { folderDraftGeneration.current += 1; setNewFolderName(e.target.value); }}
            autoFocus
          />
          <button type="submit" disabled={loading || creatingFolder || !newFolderName.trim() || !canWrite}>{creatingFolder ? 'Creating…' : 'Create'}</button>
          <button type="button" onClick={cancelFolder}>Cancel</button>
        </form>
      )}

      {isScoped ? <p className="file-manager-notice">Project files · read-only</p> : !canWrite && <p className="file-manager-notice">File changes are not allowed on this server. Ask its owner for File changes permission.</p>}
      {!isScoped && rename && <form className="file-manager-rename" aria-label={'Rename ' + rename.item.name} onSubmit={handleRename} onKeyDown={event => {
        if (event.isComposing || event.keyCode === 229 || event.key !== 'Escape') return;
        event.preventDefault(); event.stopPropagation(); cancelRename();
      }}>
        <p title={rename.from}>Rename <strong>{rename.item.name}</strong> within this folder.</p>
        <label>New name<input autoFocus value={renameName} maxLength={255} disabled={renaming} onChange={event => { setRenameName(event.target.value); setRenameError(''); }} /></label>
        {renameError && <p role="alert">{renameError}</p>}
        <div><button type="submit" disabled={renaming || loading || !canWrite || !renameName.trim() || renameName.trim() === rename.item.name}>{renaming ? 'Renaming…' : 'Rename'}</button><button type="button" onClick={cancelRename}>Cancel rename</button></div>
      </form>}
      {notice && <p className="file-manager-notice" role="status">{notice}</p>}

      {uploadProgress && (
        <div className="file-manager-progress" role="status">
          <span>Uploading {uploadProgress.current}/{uploadProgress.total}…</span>
          <progress aria-label="File upload progress" value={uploadProgress.current} max={uploadProgress.total} />
        </div>
      )}

      {(error || operationError) && (
        <div className="file-manager-error" role="alert">
          {[operationError, error].filter(Boolean).join(' ')}
          <button type="button" aria-label="Dismiss file error" onClick={() => { setError(null); setOperationError(null); }}><FileIcon name="close" /></button>
        </div>
      )}

      <div
        className={`file-manager-list ${dragOver ? 'drag-over' : ''} ${selectedContentMatch ? 'has-selected-result' : ''}`}
        hidden={contentMode}
        aria-busy={loading}
        onDrop={handleDrop}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
      >
        {loading ? (
          <div className="file-manager-loading" role="status">Loading files…</div>
        ) : filteredItems.length === 0 ? (
          <div className="file-manager-empty">{searchQuery ? 'No matching files' : 'Empty folder'}</div>
        ) : (
          filteredItems.map((item) => (
            <div
              key={item.name}
              className={`file-item ${item.type}${selectedFile === item.name ? ' selected' : ''}`}
            >
              <button type="button" className="file-entry" title={item.name} aria-label={(item.type === 'directory' ? 'Open folder ' : 'Select file ') + item.name}
                aria-pressed={item.type === 'file' ? selectedFile === item.name : undefined}
                onClick={() => handleItemClick(item)} onDoubleClick={() => handleItemDoubleClick(item)}>
                <span className="file-icon"><FileIcon name={item.type === 'directory' ? 'folder' : 'file'} /></span>
                <span className="file-name">{item.name}</span>
                <span className="file-size">{item.type === 'directory' ? 'Folder' : formatSize(item.size)}</span>
              </button>
              {isScoped && item.type === 'file' && <div className="file-actions">
                <button type="button" className="scoped-file-open" aria-label={'Preview ' + item.name} title="Preview text file"
                  disabled={!canReadContents || !scopedFile(projectRoot, currentPath, item.name)}
                  onClick={() => { if (!scopeInvalidated.current) setScopedPreview(scopedFile(projectRoot, currentPath, item.name)); }}>
                  <FileIcon name="preview" /> <span>Open</span>
                </button>
              </div>}
              {!isScoped && <div className="file-actions">
                {item.type === 'file' && isImage(item.name) && (
                  <button type="button" onClick={() => handlePreviewImage(item)} title="Preview" aria-label={'Preview ' + item.name}>
                    <FileIcon name="preview" />
                  </button>
                )}
                {item.type === 'file' && (
                  <button type="button" onClick={() => handleDownload(item)} title="Download" aria-label={'Download ' + item.name}>
                    <FileIcon name="download" />
                  </button>
                )}
                {item.type === 'directory' && (
                  <button type="button" onClick={() => handleDownload(item)} title="Download zip" aria-label={'Download zip ' + item.name}>
                    <FileIcon name="download" />
                  </button>
                )}
                {item.type === 'file' && item.name.endsWith('.zip') && (
                  <button type="button" disabled={!canWrite} onClick={() => handleUnzip(item)} title="Extract" aria-label={'Extract ' + item.name}>
                    <FileIcon name="extract" />
                  </button>
                )}
                <button type="button" title="More file actions" aria-label={'More actions for ' + item.name} aria-haspopup="menu" aria-expanded={actionMenu?.item.name === item.name}
                  onClick={event => { if (actionMenu?.item.name === item.name) closeActionMenu(); else setActionMenu({ item, trigger: event.currentTarget }); }}><FileIcon name="more" /></button>
              </div>}
            </div>
          ))
        )}

        {dragOver && (
          <div className="file-manager-dropzone">
            Drop files here to upload
          </div>
        )}
      </div>

      {scopedPreview && <ProjectFilePreview sessionId={sessionId} root={projectRoot} file={scopedPreview} onClose={() => setScopedPreview(null)} />}

      {actionMenu && createPortal(<div ref={menuRef} className="file-manager-action-menu" role="menu" tabIndex={-1} aria-label={'Actions for ' + actionMenu.item.name} onKeyDown={event => {
        if (event.isComposing || event.keyCode === 229) return;
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeActionMenu(); return; }
        if (event.key === 'Tab') { closeActionMenu(); return; }
        if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault(); const controls = [...menuRef.current.querySelectorAll('button:not(:disabled)')];
        const index = controls.indexOf(document.activeElement);
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? controls.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + controls.length) % controls.length;
        controls[next]?.focus();
      }}>
        <button type="button" role="menuitem" disabled={!canWrite || renaming || loading} onClick={() => {
          const { item, trigger } = actionMenu; setActionMenu(null); setRename({ item, trigger, from: buildItemPath(item.name), base: currentPath, navigation: navigationGeneration.current }); setRenameName(item.name); setRenameError(''); setNotice('');
        }}>Rename</button>
        <button type="button" role="menuitem" className="file-delete" disabled={!canWrite} onClick={() => { const { item } = actionMenu; closeActionMenu(); handleDelete(item); }}>Delete</button>
      </div>, document.body)}

      {previewImage && createPortal(
        <div className="file-manager-image-preview-overlay" role="dialog" aria-modal="true" aria-label={'Preview ' + previewImage.name}
          tabIndex={-1} ref={previewRef} onClick={event => { if (event.target === event.currentTarget) setPreviewImage(null); }}
          onKeyDown={event => {
            if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setPreviewImage(null); }
            if (event.key !== 'Tab') return;
            const buttons = previewRef.current.querySelectorAll('button');
            if (event.shiftKey && (document.activeElement === buttons[0] || document.activeElement === previewRef.current)) {
              event.preventDefault(); buttons[buttons.length - 1].focus();
            } else if (!event.shiftKey && document.activeElement === buttons[buttons.length - 1]) {
              event.preventDefault(); buttons[0].focus();
            }
          }}>
          <div className="file-manager-preview-header">
            <strong title={previewImage.name}>{previewImage.name}</strong>
            <button type="button" onClick={() => handleDownload({ name: previewImage.name })}>Download</button>
            <button type="button" onClick={() => setPreviewImage(null)}>Close</button>
          </div>
          <img src={previewImage.url} alt={previewImage.name} />
        </div>, document.body
      )}
    </div>
  );
}
