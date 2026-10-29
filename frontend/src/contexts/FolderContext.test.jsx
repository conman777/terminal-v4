import { StrictMode } from 'react';
import { setActiveEnvironment, getEnvironmentStorage } from '../utils/remoteEnvironments';
import { act, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FolderProvider, useFolders } from './FolderContext';

const { apiFetch } = vi.hoisted(() => ({
  apiFetch: vi.fn(),
}));

vi.mock('../utils/api', () => ({
  apiFetch,
}));

vi.mock('./AuthContext', () => ({
  useAuth: () => ({
    isAuthenticated: true,
  })
}));

function TestConsumer() {
  const { recentFolders, pinnedFolders, sidebarProjects } = useFolders();

  return (
    <>
      <span data-testid="recent-folders">{recentFolders.join('|')}</span>
      <span data-testid="pinned-folders">{pinnedFolders.join('|')}</span>
      <span data-testid="sidebar-projects">{sidebarProjects.map((project) => project.path).join('|')}</span>
    </>
  );
}

describe('FolderContext', () => {
  beforeEach(() => {
    setActiveEnvironment(null);
    localStorage.clear();
    apiFetch.mockReset();
  });

  it('hydrates shared folder state from backend settings', async () => {
    apiFetch.mockImplementation(async (url, options = {}) => {
      if (url === '/api/settings' && !options.method) {
        return {
          ok: true,
          json: async () => ({
            recentFolders: ['C:\\repo-server'],
            pinnedFolders: ['C:\\repo-pinned'],
            sidebarProjects: [{ path: 'C:\\repo-server', name: 'repo-server' }]
          })
        };
      }

      if (url === '/api/projects/scan') {
        return {
          ok: true,
          json: async () => ({ projects: [] })
        };
      }

      throw new Error(`Unexpected apiFetch call: ${url}`);
    });

    render(
      <FolderProvider>
        <TestConsumer />
      </FolderProvider>
    );

    await waitFor(() => {
      expect(screen.getByTestId('recent-folders')).toHaveTextContent('C:\\repo-server');
    });

    expect(screen.getByTestId('pinned-folders')).toHaveTextContent('C:\\repo-pinned');
    expect(screen.getByTestId('sidebar-projects')).toHaveTextContent('C:\\repo-server');
  });

  it('migrates local folder state to backend when shared settings are empty', async () => {
    localStorage.setItem('recentFolders', JSON.stringify(['C:\\repo-local']));
    localStorage.setItem('pinnedFolders', JSON.stringify(['C:\\repo-local']));
    localStorage.setItem('sidebarProjects', JSON.stringify([{ path: 'C:\\repo-local', name: 'repo-local' }]));

    apiFetch.mockImplementation(async (url, options = {}) => {
      if (url === '/api/settings' && !options.method) {
        return {
          ok: true,
          json: async () => ({
            recentFolders: null,
            pinnedFolders: null,
            sidebarProjects: null
          })
        };
      }

      if (url === '/api/settings' && options.method === 'PATCH') {
        return {
          ok: true,
          json: async () => ({ success: true })
        };
      }

      if (url === '/api/projects/scan') {
        return {
          ok: true,
          json: async () => ({ projects: [] })
        };
      }

      throw new Error(`Unexpected apiFetch call: ${url}`);
    });

    render(
      <FolderProvider>
        <TestConsumer />
      </FolderProvider>
    );

    await waitFor(() => {
      expect(screen.getByTestId('recent-folders')).toHaveTextContent('C:\\repo-local');
    });

    await waitFor(() => {
      expect(apiFetch).toHaveBeenCalledWith('/api/settings', expect.objectContaining({
        method: 'PATCH',
        body: {
          recentFolders: ['C:\\repo-local'],
          pinnedFolders: ['C:\\repo-local'],
          sidebarProjects: [{ path: 'C:\\repo-local', name: 'repo-local' }]
        }
      }));
    });
  });
  it('keeps remote folder preferences local without hydrating or updating home account settings', async () => {
    localStorage.setItem('recentFolders',JSON.stringify(['/home-only']));
    setActiveEnvironment({id:'remote'});
    const storage=getEnvironmentStorage();storage.setItem('recentFolders',JSON.stringify(['/remote-only']));
    let folders;
    function Consumer(){folders=useFolders();return <TestConsumer />;}
    apiFetch.mockResolvedValue({ok:true,json:async()=>({projects:[],recentFolders:['/wrong-server']})});
    render(<FolderProvider><Consumer /></FolderProvider>);
    await waitFor(()=>expect(apiFetch).toHaveBeenCalledWith('/api/projects/scan'));
    await act(async()=>folders.addRecentFolder('/new-remote'));
    expect([folders.recentFolders,JSON.parse(localStorage.getItem('recentFolders')),JSON.parse(storage.getItem('recentFolders')),apiFetch.mock.calls.filter(([url])=>url==='/api/settings')]).toEqual([['/new-remote','/remote-only'],['/home-only'],['/new-remote','/remote-only'],[]]);
  });

});


describe('FolderContext pending hydration', () => {
  beforeEach(() => { setActiveEnvironment(null); localStorage.clear(); apiFetch.mockReset(); });

  it.each(['recent', 'pin', 'remove'])('hydrates untouched fields while preserving a newer %s action', async action => {
    localStorage.setItem('sidebarProjects', JSON.stringify([{ path: '/removed-project' }]));
    let finishSettings;
    let folders;
    function Consumer() { folders = useFolders(); return <TestConsumer />; }
    apiFetch.mockImplementation(async (url, options = {}) => {
      if (url === '/api/settings' && !options.method) return new Promise(resolve => { finishSettings = resolve; });
      return { ok: true, json: async () => ({ projects: [] }) };
    });
    render(<FolderProvider><Consumer /></FolderProvider>);
    await act(async () => {
      if (action === 'recent') folders.addRecentFolder('/new-active');
      if (action === 'pin') folders.pinFolder('/new-pin');
      if (action === 'remove') folders.removeSidebarProject('/removed-project');
    });
    await act(async () => finishSettings({ ok: true, json: async () => ({ recentFolders: ['/server-recent'], pinnedFolders: ['/server-pin'], sidebarProjects: [{ path: '/removed-project' }] }) }));
    expect({ recent: folders.recentFolders, pinned: folders.pinnedFolders, projects: folders.sidebarProjects.map(p => p.path) }).toEqual({
      recent: action === 'recent' ? ['/new-active'] : ['/server-recent'],
      pinned: action === 'pin' ? ['/new-pin'] : ['/server-pin'],
      projects: action === 'remove' ? [] : ['/removed-project'],
    });
    expect(apiFetch.mock.calls.filter(([url, options]) => url === '/api/settings' && !options?.method)).toHaveLength(1);
  });

  it('retries failed settings on focus without repeating successful hydration or losing local actions', async () => {
    let folders;
    let reads = 0;
    function Consumer() { folders = useFolders(); return <TestConsumer />; }
    apiFetch.mockImplementation(async (url, options = {}) => {
      if (url === '/api/settings' && !options.method) {
        reads++;
        return reads === 1 ? { ok: false, status: 503 } : { ok: true, json: async () => ({ recentFolders: ['/stale'], pinnedFolders: ['/recovered-pin'] }) };
      }
      return { ok: true, json: async () => ({ projects: [] }) };
    });
    render(<FolderProvider><Consumer /></FolderProvider>);
    await act(async () => {});
    await act(async () => folders.addRecentFolder('/new-active'));
    await act(async () => window.dispatchEvent(new Event('focus')));
    expect([reads, folders.recentFolders, folders.pinnedFolders]).toEqual([2, ['/new-active'], ['/recovered-pin']]);
    await act(async () => window.dispatchEvent(new Event('focus')));
    expect(reads).toBe(2);
  });
});


describe('FolderContext effect lifecycle', () => {
  it('hydrates the current StrictMode effect after the abandoned request resolves late', async () => {
    setActiveEnvironment(null); localStorage.clear(); apiFetch.mockReset();
    const reads = [];
    apiFetch.mockImplementation(async (url, options = {}) => {
      if (url === '/api/settings' && !options.method) return new Promise(resolve => reads.push(resolve));
      return {ok: true, json: async () => ({projects: []})};
    });
    render(<StrictMode><FolderProvider><TestConsumer /></FolderProvider></StrictMode>);
    expect(reads).toHaveLength(2);
    await act(async () => reads[1]({ok: true, json: async () => ({pinnedFolders: ['/current-pin']})}));
    await act(async () => reads[0]({ok: true, json: async () => ({pinnedFolders: ['/stale-pin']})}));
    expect(screen.getByTestId('pinned-folders')).toHaveTextContent('/current-pin');
    expect(JSON.parse(localStorage.getItem('pinnedFolders'))).toEqual(['/current-pin']);
  });
});
