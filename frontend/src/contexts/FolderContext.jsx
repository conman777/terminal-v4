import { createContext, useContext, useState, useCallback, useEffect } from 'react';
import { apiFetch } from '../utils/api';

const FolderContext = createContext(null);

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

  // Projects state
  const [projects, setProjects] = useState([]);
  const [projectsLoading, setProjectsLoading] = useState(false);

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
  const handleAddScanFolder = useCallback(async () => {
    const folderPath = prompt('Enter folder path to scan for git repositories:');
    if (!folderPath || !folderPath.trim()) return;

    setProjectsLoading(true);
    try {
      const response = await apiFetch('/api/projects/scan-dirs', {
        method: 'POST',
        body: { path: folderPath.trim() }
      });
      if (response.ok) {
        const data = await response.json();
        if (data.projects) {
          setProjects(data.projects);
        }
      }
    } catch (error) {
      console.error('Failed to add scan folder', error);
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
    handleAddScanFolder,
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
