import { createContext, useContext, useState, useCallback, useEffect } from 'react';
import { apiFetch } from '../utils/api';
import { normalizeProjectPath } from '../utils/projectPaths';

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

export function FolderProvider({ children }) {
  // Folder state
  const [recentFolders, setRecentFolders] = useState(() => {
    try {
      const stored = localStorage.getItem('recentFolders');
      return stored ? JSON.parse(stored) : [];
    } catch {
      return [];
    }
  });

  const [pinnedFolders, setPinnedFolders] = useState(() => {
    try {
      const stored = localStorage.getItem('pinnedFolders');
      return stored ? JSON.parse(stored) : [];
    } catch {
      return [];
    }
  });

  // Projects state (from scanner)
  const [projects, setProjects] = useState([]);
  const [projectsLoading, setProjectsLoading] = useState(false);

  // Sidebar projects - user-curated list of folders shown in sidebar
  const [sidebarProjects, setSidebarProjects] = useState(() => {
    try {
      const stored = localStorage.getItem('sidebarProjects');
      return stored ? JSON.parse(stored) : [];
    } catch {
      return [];
    }
  });

  // Add a folder to recent list (max 10, no duplicates)
  const addRecentFolder = useCallback((folder) => {
    if (!folder) return;
    setRecentFolders(prev => {
      const filtered = prev.filter(f => f.toLowerCase() !== folder.toLowerCase());
      const updated = [folder, ...filtered].slice(0, 10);
      try {
        localStorage.setItem('recentFolders', JSON.stringify(updated));
      } catch (e) {
        console.error('Failed to save recent folders', e);
      }
      return updated;
    });
  }, []);

  // Pin a folder (max 20)
  const pinFolder = useCallback((folder) => {
    if (!folder) return;
    setPinnedFolders(prev => {
      if (prev.some(f => f.toLowerCase() === folder.toLowerCase())) {
        return prev;
      }
      const updated = [...prev, folder].slice(0, 20);
      try {
        localStorage.setItem('pinnedFolders', JSON.stringify(updated));
      } catch (e) {
        console.error('Failed to save pinned folders', e);
      }
      return updated;
    });
  }, []);

  // Unpin a folder
  const unpinFolder = useCallback((folder) => {
    setPinnedFolders(prev => {
      const updated = prev.filter(f => f.toLowerCase() !== folder.toLowerCase());
      try {
        localStorage.setItem('pinnedFolders', JSON.stringify(updated));
      } catch (e) {
        console.error('Failed to save pinned folders', e);
      }
      return updated;
    });
  }, []);

  // Add a project folder to sidebar
  const addSidebarProject = useCallback((folderPath) => {
    if (!folderPath) return;
    setSidebarProjects(prev => {
      const updated = appendSidebarProject(prev, folderPath);
      try {
        localStorage.setItem('sidebarProjects', JSON.stringify(updated));
      } catch (e) {
        console.error('Failed to save sidebar projects', e);
      }
      return updated;
    });
  }, []);

  // Remove a project folder from sidebar
  const removeSidebarProject = useCallback((folderPath) => {
    setSidebarProjects(prev => {
      const normalizedPath = normalizeProjectPath(folderPath);
      const updated = prev.filter(p => normalizeProjectPath(p.path) !== normalizedPath);
      try {
        localStorage.setItem('sidebarProjects', JSON.stringify(updated));
      } catch (e) {
        console.error('Failed to save sidebar projects', e);
      }
      return updated;
    });
  }, []);

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
          try {
            localStorage.setItem('sidebarProjects', JSON.stringify(updated));
          } catch (e) {
            console.error('Failed to save sidebar projects', e);
          }
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
  }, []);

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
