import { useEffect, useState, useMemo } from 'react';
import { useBodyScrollLock } from '../hooks/useBodyScrollLock';

export function MobileDrawer({
  isOpen,
  onClose,
  onCreateSession,
  onOpenSettings,
  onOpenApiSettings,
  onOpenBookmarks,
  projects = [],
  projectsLoading = false,
  onFolderSelect,
  currentPath,
  onAddScanFolder = null,
  onNavigateToPath,
  mobileView = 'terminal',
  onViewChange,
  previewUrl,
  inactiveSessions = [],
  onRestoreSession
}) {
  const [projectsExpanded, setProjectsExpanded] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');

  useBodyScrollLock(isOpen);

  // Clear search when drawer closes
  useEffect(() => {
    if (!isOpen) {
      setSearchQuery('');
    }
  }, [isOpen]);

  const normalizePath = (p) => p?.toLowerCase().replace(/\/$/, '');
  const currentNormalized = normalizePath(currentPath);

  // Filter projects based on search query
  const filteredProjects = useMemo(() => {
    if (!searchQuery.trim()) return projects;
    const query = searchQuery.toLowerCase();
    return projects.filter((project) =>
      project.name.toLowerCase().includes(query) ||
      project.path.toLowerCase().includes(query) ||
      (project.branch || '').toLowerCase().includes(query)
    );
  }, [projects, searchQuery]);

  const handleViewChange = (view) => {
    onViewChange?.(view);
    onClose();
  };

  const handleRestoreSession = (sessionId) => {
    onRestoreSession?.(sessionId);
    onClose();
  };

  const handleNavigate = (path) => {
    onNavigateToPath?.(path);
    onClose();
  };

  return (
    <>
      <div className={`mobile-drawer-overlay${isOpen ? ' open' : ''}`} onClick={onClose}></div>
      <div className={`mobile-drawer${isOpen ? ' open' : ''}`}>
        <div className="mobile-drawer-header">
          <h2>Menu</h2>
          <button className="mobile-drawer-close" onClick={onClose} aria-label="Close menu">
            ×
          </button>
        </div>
        <div className="mobile-drawer-content">
          {/* Views Section */}
          <div className="mobile-drawer-views">
            <div className="mobile-drawer-views-title">Views</div>
            <button
              type="button"
              className={`mobile-drawer-view-btn${mobileView === 'terminal' ? ' active' : ''}`}
              onClick={() => handleViewChange('terminal')}
            >
              <span className="mobile-drawer-view-icon">⚡</span>
              Terminal
            </button>
            <button
              type="button"
              className={`mobile-drawer-view-btn${mobileView === 'claude' ? ' active' : ''}`}
              onClick={() => handleViewChange('claude')}
            >
              <span className="mobile-drawer-view-icon">🤖</span>
              Claude
            </button>
            <button
              type="button"
              className={`mobile-drawer-view-btn${mobileView === 'preview' ? ' active' : ''}`}
              onClick={() => handleViewChange('preview')}
            >
              <span className="mobile-drawer-view-icon">👁</span>
              Preview
            </button>
          </div>

          {/* Inactive Sessions Section */}
          {inactiveSessions.length > 0 && (
            <div className="mobile-drawer-inactive-sessions">
              <div className="mobile-drawer-inactive-title">Inactive Sessions</div>
              {inactiveSessions.map((session) => (
                <button
                  key={session.id}
                  type="button"
                  className="mobile-drawer-inactive-session"
                  onClick={() => handleRestoreSession(session.id)}
                >
                  <span className="mobile-drawer-inactive-icon">⏸</span>
                  {session.title || 'Terminal'}
                </button>
              ))}
            </div>
          )}

          {/* Main Menu Items */}
          <button
            className="mobile-drawer-item"
            onClick={() => {
              onCreateSession();
              onClose();
            }}
            type="button"
          >
            <span className="mobile-drawer-icon">+</span>
            New Session
          </button>
          <button
            className="mobile-drawer-item"
            onClick={() => {
              onOpenBookmarks?.();
              onClose();
            }}
            type="button"
          >
            <span className="mobile-drawer-icon">📑</span>
            Bookmarks
          </button>
          <button
            className="mobile-drawer-item"
            onClick={() => {
              onOpenSettings();
              onClose();
            }}
            type="button"
          >
            <span className="mobile-drawer-icon">⚙</span>
            Settings
          </button>
          <button
            className="mobile-drawer-item"
            onClick={() => {
              onOpenApiSettings();
              onClose();
            }}
            type="button"
          >
            <span className="mobile-drawer-icon">🔑</span>
            API Settings
          </button>

          {/* Projects Section */}
          <div className="mobile-drawer-section">
            <button
              className="mobile-drawer-section-header"
              onClick={() => setProjectsExpanded(!projectsExpanded)}
              type="button"
            >
              <span className={`mobile-drawer-chevron ${projectsExpanded ? 'expanded' : ''}`}>
                <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
                  <path d="M6.22 3.22a.75.75 0 0 1 1.06 0l4.25 4.25a.75.75 0 0 1 0 1.06l-4.25 4.25a.751.751 0 0 1-1.042-.018.751.751 0 0 1-.018-1.042L9.94 8 6.22 4.28a.75.75 0 0 1 0-1.06Z" />
                </svg>
              </span>
              <svg className="mobile-drawer-section-icon" width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
                <path d="M9.5 3.25a2.25 2.25 0 1 1 3 2.122V6A2.5 2.5 0 0 1 10 8.5H6a1 1 0 0 0-1 1v1.128a2.251 2.251 0 1 1-1.5 0V5.372a2.25 2.25 0 1 1 1.5 0v1.836A2.492 2.492 0 0 1 6 7h4a1 1 0 0 0 1-1v-.628A2.25 2.25 0 0 1 9.5 3.25Zm-6 0a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0Zm8.25-.75a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5ZM4.25 12a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Z" />
              </svg>
              <span className="mobile-drawer-section-title">Projects</span>
              {projectsLoading && <span className="mobile-drawer-loader" />}
              {onAddScanFolder && (
                <span
                  className="mobile-drawer-section-add"
                  onClick={(e) => {
                    e.stopPropagation();
                    onAddScanFolder();
                  }}
                  role="button"
                  tabIndex={0}
                >
                  <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
                    <path d="M7.75 2a.75.75 0 0 1 .75.75V7h4.25a.75.75 0 0 1 0 1.5H8.5v4.25a.75.75 0 0 1-1.5 0V8.5H2.75a.75.75 0 0 1 0-1.5H7V2.75A.75.75 0 0 1 7.75 2Z" />
                  </svg>
                </span>
              )}
            </button>

            {projectsExpanded && (
              <div className="mobile-drawer-projects">
                {projects.length > 0 && (
                  <div className="mobile-drawer-search">
                    <svg className="mobile-drawer-search-icon" width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
                      <path d="M10.68 11.74a6 6 0 0 1-7.922-8.982 6 6 0 0 1 8.982 7.922l3.04 3.04a.749.749 0 0 1-.326 1.275.749.749 0 0 1-.734-.215ZM11.5 7a4.499 4.499 0 1 0-8.997 0A4.499 4.499 0 0 0 11.5 7Z" />
                    </svg>
                    <input
                      type="text"
                      className="mobile-drawer-search-input"
                      placeholder="Search projects..."
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                    />
                    {searchQuery && (
                      <button
                        className="mobile-drawer-search-clear"
                        onClick={() => setSearchQuery('')}
                        type="button"
                        aria-label="Clear search"
                      >
                        ×
                      </button>
                    )}
                  </div>
                )}
                {projectsLoading && projects.length === 0 ? (
                  <div className="mobile-drawer-empty">Scanning...</div>
                ) : projects.length === 0 ? (
                  <div className="mobile-drawer-empty">No projects found</div>
                ) : filteredProjects.length === 0 ? (
                  <div className="mobile-drawer-empty">No matches for "{searchQuery}"</div>
                ) : (
                  filteredProjects.map((project) => (
                    <button
                      key={project.path}
                      className={`mobile-drawer-project ${normalizePath(project.path) === currentNormalized ? 'active' : ''}`}
                      onClick={() => {
                        onFolderSelect(project.path);
                        onClose();
                      }}
                      type="button"
                    >
                      <span className="mobile-drawer-project-name">{project.name}</span>
                      {project.branch && (
                        <span className="mobile-drawer-project-branch">{project.branch}</span>
                      )}
                    </button>
                  ))
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </>
  );
}
