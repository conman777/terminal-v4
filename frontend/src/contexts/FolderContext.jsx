import { getEnvironmentStorage, getActiveEnvironment } from '../utils/remoteEnvironments';
import { createContext, useContext, useState, useCallback, useEffect, useRef, useMemo } from 'react';
import { apiFetch } from '../utils/api';
import { normalizeProjectPath } from '../utils/projectPaths';
import { useAuth } from './AuthContext';

const FolderContext = createContext(null);

function getProjectNameFromPath(folderPath) {
  return folderPath.replace(/[\\/]+$/, '').replace(/\\/g, '/').split('/').filter(Boolean).pop() || 'Unknown';
}

function appendSidebarProject(prev, folderPath) {
  if (!folderPath) return prev;
  const normalizedPath = normalizeProjectPath(folderPath);
  if (prev.some((project) => normalizeProjectPath(project.path) === normalizedPath)) {
    return prev;
  }
  return [...prev, { path: folderPath, name: getProjectNameFromPath(folderPath) }];
}

function readStoredJson(storage, key, fallback) {
  try {
    const stored = storage.getItem(key);
    return stored ? JSON.parse(stored) : fallback;
  } catch {
    return fallback;
  }
}

function writeStoredJson(storage, key, value) {
  try {
    storage.setItem(key, JSON.stringify(value));
  } catch (error) {
    console.error(`Failed to save ${key}`, error);
  }
}

function sanitizeStringList(value, limit) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const next = [];
  value.forEach((entry) => {
    if (typeof entry !== 'string') return;
    const trimmed = entry.trim();
    if (!trimmed) return;
    const dedupeKey = trimmed.toLowerCase();
    if (seen.has(dedupeKey)) return;
    seen.add(dedupeKey);
    next.push(trimmed);
  });
  return next.slice(0, limit);
}

function sanitizeSidebarProjects(value) {
  if (!Array.isArray(value)) return [];
  return value.reduce((projects, entry) => {
    if (!entry || typeof entry !== 'object' || typeof entry.path !== 'string') {
      return projects;
    }
    return appendSidebarProject(projects, entry.path);
  }, []);
}

export function FolderProvider({ children }) {
  const storage = useMemo(() => getEnvironmentStorage(), []);
  const remotePreferences = useMemo(() => Boolean(getActiveEnvironment()), []);
  const { isAuthenticated } = useAuth();
  const settingsHydratedRef = useRef(false);
  const modifiedSettingsRef = useRef(new Set());

  // Folder state
  const [recentFolders, setRecentFolders] = useState(() => sanitizeStringList(readStoredJson(storage, 'recentFolders', []), 10));

  const [pinnedFolders, setPinnedFolders] = useState(() => sanitizeStringList(readStoredJson(storage, 'pinnedFolders', []), 20));

  // Projects state (from scanner)
  const [projects, setProjects] = useState([]);
  const [projectsLoading, setProjectsLoading] = useState(false);

  // Sidebar projects - user-curated list of folders shown in sidebar
  const [sidebarProjects, setSidebarProjects] = useState(() => sanitizeSidebarProjects(readStoredJson(storage, 'sidebarProjects', [])));

  const syncFolderSettings = useCallback(async (updates) => {
    if (!isAuthenticated || remotePreferences || getActiveEnvironment()) return;
    try {
      const response = await apiFetch('/api/settings', {
        method: 'PATCH',
        body: updates
      });
      if (!response.ok) {
        throw new Error(`Failed to sync folder settings (${response.status})`);
      }
    } catch (error) {
      console.error('Failed to sync folder settings', error);
    }
  }, [isAuthenticated]);

  // Add a folder to recent list (max 10, no duplicates)
  const addRecentFolder = useCallback((folder) => {
    if (!folder) return;
    modifiedSettingsRef.current.add('recentFolders');
    setRecentFolders(prev => {
      const filtered = prev.filter(f => f.toLowerCase() !== folder.toLowerCase());
      const updated = sanitizeStringList([folder, ...filtered], 10);
      writeStoredJson(storage, 'recentFolders', updated);
      void syncFolderSettings({ recentFolders: updated });
      return updated;
    });
  }, [syncFolderSettings]);

  // Pin a folder (max 20)
  const pinFolder = useCallback((folder) => {
    if (!folder) return;
    modifiedSettingsRef.current.add('pinnedFolders');
    setPinnedFolders(prev => {
      if (prev.some(f => f.toLowerCase() === folder.toLowerCase())) {
        return prev;
      }
      const updated = sanitizeStringList([...prev, folder], 20);
      writeStoredJson(storage, 'pinnedFolders', updated);
      void syncFolderSettings({ pinnedFolders: updated });
      return updated;
    });
  }, [syncFolderSettings]);

  // Unpin a folder
  const unpinFolder = useCallback((folder) => {
    modifiedSettingsRef.current.add('pinnedFolders');
    setPinnedFolders(prev => {
      const updated = sanitizeStringList(
        prev.filter(f => f.toLowerCase() !== folder.toLowerCase()),
        20
      );
      writeStoredJson(storage, 'pinnedFolders', updated);
      void syncFolderSettings({ pinnedFolders: updated });
      return updated;
    });
  }, [syncFolderSettings]);

  // Add a project folder to sidebar
  const addSidebarProject = useCallback((folderPath) => {
    if (!folderPath) return;
    modifiedSettingsRef.current.add('sidebarProjects');
    setSidebarProjects(prev => {
      const updated = appendSidebarProject(prev, folderPath);
      writeStoredJson(storage, 'sidebarProjects', updated);
      void syncFolderSettings({ sidebarProjects: updated });
      return updated;
    });
  }, [syncFolderSettings]);

  // Remove a project folder from sidebar
  const removeSidebarProject = useCallback((folderPath) => {
    modifiedSettingsRef.current.add('sidebarProjects');
    setSidebarProjects(prev => {
      const normalizedPath = normalizeProjectPath(folderPath);
      const updated = prev.filter(p => normalizeProjectPath(p.path) !== normalizedPath);
      writeStoredJson(storage, 'sidebarProjects', updated);
      void syncFolderSettings({ sidebarProjects: updated });
      return updated;
    });
  }, [syncFolderSettings]);

  // Load projects
  const loadProjects = useCallback(async () => {
    setProjectsLoading(true);
    try {
      const response = await apiFetch('/api/projects/scan');
      if (response.ok) {
        const data = await response.json();
        setProjects(data.projects || []);
      }
    } catch (error) {
      console.error('Failed to load projects', error);
    } finally {
      setProjectsLoading(false);
    }
  }, []);

  // Add scan folder
  const addScanFolder = useCallback(async (folderPath) => {
    const normalizedPath = typeof folderPath === 'string' ? folderPath.trim() : '';
    if (!normalizedPath) {
      return { ok: false, error: 'Folder path is required' };
    }
    setProjectsLoading(true);
    try {
      const response = await apiFetch('/api/projects/scan-dirs', {
        method: 'POST',
        body: { path: normalizedPath }
      });
      if (response.ok) {
        const data = await response.json();
        if (data.projects) {
          setProjects(data.projects);
        }
        modifiedSettingsRef.current.add('sidebarProjects');
        setSidebarProjects(prev => {
          const updated = appendSidebarProject(prev, normalizedPath);
          writeStoredJson(storage, 'sidebarProjects', updated);
          void syncFolderSettings({ sidebarProjects: updated });
          return updated;
        });
        return { ok: true };
      }
      let message = 'Failed to add scan folder';
      try {
        const data = await response.json();
        if (typeof data?.error === 'string' && data.error.trim()) {
          message = data.error.trim();
        }
      } catch {
        // Keep default error.
      }
      return { ok: false, error: message };
    } catch (error) {
      console.error('Failed to add scan folder', error);
      return { ok: false, error: 'Failed to add scan folder' };
    } finally {
      setProjectsLoading(false);
    }
  }, [syncFolderSettings]);

  const folderSettingsRef = useRef(null);
  folderSettingsRef.current = { recentFolders, pinnedFolders, sidebarProjects };

  useEffect(() => {
    if (!isAuthenticated || remotePreferences || getActiveEnvironment() || settingsHydratedRef.current) return;
    let cancelled = false;
    let pending = false;

    const hydrateFromSettings = async () => {
      if (pending || settingsHydratedRef.current || cancelled || getActiveEnvironment()) return;
      pending = true;
      try {
        const response = await apiFetch('/api/settings');
        if (!response.ok) throw new Error(`Failed to load folder settings (${response.status})`);
        const data = await response.json();
        if (cancelled) return;

        const setters = { recentFolders: setRecentFolders, pinnedFolders: setPinnedFolders, sidebarProjects: setSidebarProjects };
        const migrationPayload = {};
        for (const key of Object.keys(setters)) {
          const local = folderSettingsRef.current[key];
          if (modifiedSettingsRef.current.has(key)) continue;
          if (Array.isArray(data[key])) {
            const next = key === 'sidebarProjects' ? sanitizeSidebarProjects(data[key])
              : sanitizeStringList(data[key], key === 'recentFolders' ? 10 : 20);
            setters[key](next);
            writeStoredJson(storage, key, next);
          } else if (local.length > 0) {
            migrationPayload[key] = local;
          }
        }
        settingsHydratedRef.current = true;
        if (Object.keys(migrationPayload).length > 0) void syncFolderSettings(migrationPayload);
      } catch (error) {
        if (!cancelled) console.error('Failed to hydrate folder settings', error);
      } finally {
        pending = false;
      }
    };

    void hydrateFromSettings();
    window.addEventListener('focus', hydrateFromSettings);
    window.addEventListener('online', hydrateFromSettings);
    return () => {
      cancelled = true;
      window.removeEventListener('focus', hydrateFromSettings);
      window.removeEventListener('online', hydrateFromSettings);
    };
  }, [isAuthenticated, remotePreferences, storage, syncFolderSettings]);

  useEffect(() => {
    loadProjects();
  }, [loadProjects]);

  const value = {
    recentFolders,
    pinnedFolders,
    addRecentFolder,
    pinFolder,
    unpinFolder,
    projects,
    projectsLoading,
    loadProjects,
    addScanFolder,
    sidebarProjects,
    addSidebarProject,
    removeSidebarProject,
  };

  return (
    <FolderContext.Provider value={value}>
      {children}
    </FolderContext.Provider>
  );
}

export function useFolders() {
  const context = useContext(FolderContext);
  if (!context) {
    throw new Error('useFolders must be used within a FolderProvider');
  }
  return context;
}
