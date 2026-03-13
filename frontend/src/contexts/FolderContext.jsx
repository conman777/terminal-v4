import { createContext, useContext, useState, useCallback, useEffect, useRef } from 'react';
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

function readStoredJson(key, fallback) {
  try {
    const stored = localStorage.getItem(key);
    return stored ? JSON.parse(stored) : fallback;
  } catch {
    return fallback;
  }
}

function writeStoredJson(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
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
  const { isAuthenticated } = useAuth();
  const settingsHydratedRef = useRef(false);

  // Folder state
  const [recentFolders, setRecentFolders] = useState(() => sanitizeStringList(readStoredJson('recentFolders', []), 10));

  const [pinnedFolders, setPinnedFolders] = useState(() => sanitizeStringList(readStoredJson('pinnedFolders', []), 20));

  // Projects state (from scanner)
  const [projects, setProjects] = useState([]);
  const [projectsLoading, setProjectsLoading] = useState(false);

  // Sidebar projects - user-curated list of folders shown in sidebar
  const [sidebarProjects, setSidebarProjects] = useState(() => sanitizeSidebarProjects(readStoredJson('sidebarProjects', [])));

  const syncFolderSettings = useCallback(async (updates) => {
    if (!isAuthenticated) return;
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
    setRecentFolders(prev => {
      const filtered = prev.filter(f => f.toLowerCase() !== folder.toLowerCase());
      const updated = sanitizeStringList([folder, ...filtered], 10);
      writeStoredJson('recentFolders', updated);
      void syncFolderSettings({ recentFolders: updated });
      return updated;
    });
  }, [syncFolderSettings]);

  // Pin a folder (max 20)
  const pinFolder = useCallback((folder) => {
    if (!folder) return;
    setPinnedFolders(prev => {
      if (prev.some(f => f.toLowerCase() === folder.toLowerCase())) {
        return prev;
      }
      const updated = sanitizeStringList([...prev, folder], 20);
      writeStoredJson('pinnedFolders', updated);
      void syncFolderSettings({ pinnedFolders: updated });
      return updated;
    });
  }, [syncFolderSettings]);

  // Unpin a folder
  const unpinFolder = useCallback((folder) => {
    setPinnedFolders(prev => {
      const updated = sanitizeStringList(
        prev.filter(f => f.toLowerCase() !== folder.toLowerCase()),
        20
      );
      writeStoredJson('pinnedFolders', updated);
      void syncFolderSettings({ pinnedFolders: updated });
      return updated;
    });
  }, [syncFolderSettings]);

  // Add a project folder to sidebar
  const addSidebarProject = useCallback((folderPath) => {
    if (!folderPath) return;
    setSidebarProjects(prev => {
      const updated = appendSidebarProject(prev, folderPath);
      writeStoredJson('sidebarProjects', updated);
      void syncFolderSettings({ sidebarProjects: updated });
      return updated;
    });
  }, [syncFolderSettings]);

  // Remove a project folder from sidebar
  const removeSidebarProject = useCallback((folderPath) => {
    setSidebarProjects(prev => {
      const normalizedPath = normalizeProjectPath(folderPath);
      const updated = prev.filter(p => normalizeProjectPath(p.path) !== normalizedPath);
      writeStoredJson('sidebarProjects', updated);
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
        setSidebarProjects(prev => {
          const updated = appendSidebarProject(prev, normalizedPath);
          writeStoredJson('sidebarProjects', updated);
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

  useEffect(() => {
    if (!isAuthenticated || settingsHydratedRef.current) {
      return;
    }
    settingsHydratedRef.current = true;

    let cancelled = false;

    const hydrateFromSettings = async () => {
      try {
        const response = await apiFetch('/api/settings');
        if (!response.ok) {
          return;
        }
        const data = await response.json();
        if (cancelled) {
          return;
        }

        const nextRecentFolders = Array.isArray(data.recentFolders)
          ? sanitizeStringList(data.recentFolders, 10)
          : recentFolders;
        const nextPinnedFolders = Array.isArray(data.pinnedFolders)
          ? sanitizeStringList(data.pinnedFolders, 20)
          : pinnedFolders;
        const nextSidebarProjects = Array.isArray(data.sidebarProjects)
          ? sanitizeSidebarProjects(data.sidebarProjects)
          : sidebarProjects;

        setRecentFolders(nextRecentFolders);
        setPinnedFolders(nextPinnedFolders);
        setSidebarProjects(nextSidebarProjects);
        writeStoredJson('recentFolders', nextRecentFolders);
        writeStoredJson('pinnedFolders', nextPinnedFolders);
        writeStoredJson('sidebarProjects', nextSidebarProjects);

        const migrationPayload = {};
        if (!Array.isArray(data.recentFolders) && recentFolders.length > 0) {
          migrationPayload.recentFolders = recentFolders;
        }
        if (!Array.isArray(data.pinnedFolders) && pinnedFolders.length > 0) {
          migrationPayload.pinnedFolders = pinnedFolders;
        }
        if (!Array.isArray(data.sidebarProjects) && sidebarProjects.length > 0) {
          migrationPayload.sidebarProjects = sidebarProjects;
        }
        if (Object.keys(migrationPayload).length > 0) {
          void syncFolderSettings(migrationPayload);
        }
      } catch (error) {
        console.error('Failed to hydrate folder settings', error);
      }
    };

    void hydrateFromSettings();

    return () => {
      cancelled = true;
    };
  }, [isAuthenticated, pinnedFolders, recentFolders, sidebarProjects, syncFolderSettings]);

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
