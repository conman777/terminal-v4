import { useEffect, useState, useMemo } from 'react';
import { useBodyScrollLock } from '../hooks/useBodyScrollLock';

/**
 * Format a timestamp as relative time (e.g., "2m ago", "1h ago")
 */
function formatRelativeTime(timestamp) {
  if (!timestamp) return null;

  const now = Date.now();
  const time = typeof timestamp === 'string' ? new Date(timestamp).getTime() : timestamp;
  const diff = now - time;

  if (diff < 0) return 'just now';

  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return 'just now';

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;

  const days = Math.floor(hours / 24);
  if (days === 1) return 'yesterday';
  if (days < 7) return `${days}d ago`;

  return `${Math.floor(days / 7)}w ago`;
}

export function MobileDrawer({
  isOpen,
  onClose,
  onCreateSession,
  onOpenSettings,
  onOpenApiSettings,
  onOpenBrowserSettings,
  onOpenBookmarks,
  onOpenNotes,
  onOpenProcessManager,
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
  onRestoreSession,
  activeSessions = [],
  activeSessionId,
  sessionActivity,
  onSelectSession,
  sessionsGroupedByProject = []
}) {
  const [projectsExpanded, setProjectsExpanded] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');

  const visibleThreadGroups = useMemo(() => {
    return (sessionsGroupedByProject || []).filter((group) => group.sessions && group.sessions.length > 0);
  }, [sessionsGroupedByProject]);

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

  const handleSelectSession = (sessionId) => {
    onSelectSession?.(sessionId);
    onClose();
  };

  const handleNavigate = (path) => {
    onNavigateToPath?.(path);
    onClose();
  };

  return (
    <>
      <div className={`mobile-drawer-overlay-modern${isOpen ? ' open' : ''}`} onClick={onClose}></div>
      <div className={`mobile-drawer-modern${isOpen ? ' open' : ''}`}>
        <div className="mobile-drawer-header-modern">
          <h2>Menu</h2>
          <button className="mobile-drawer-close-modern" onClick={onClose} aria-label="Close menu">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>
        <div className="mobile-drawer-content-modern">
          {/* Threads Section */}
          {visibleThreadGroups.length > 0 && (
            <div className="mobile-drawer-section-modern">
              <div className="mobile-drawer-section-title-modern">Threads</div>
              <div className="mobile-drawer-threads-modern">
                {visibleThreadGroups.map((group) => (
                  <div key={group.projectPath || group.projectName} className="mobile-drawer-project-modern">
                    <div className="mobile-drawer-project-header-modern">
                      <span className="mobile-drawer-project-icon-modern">📁</span>
                      <span className="mobile-drawer-project-name-modern">{group.projectName}</span>
                    </div>
                    <div className="mobile-drawer-project-sessions-modern">
                      {group.sessions.map((session) => {
                        const lastActivity = sessionActivity?.[session.id]?.lastActivity || session.updatedAt;
                        const relativeTime = formatRelativeTime(lastActivity);
                        const isActive = session.id === activeSessionId;
                        return (
                          <button
                            key={session.id}
                            type="button"
                            className={`mobile-drawer-thread-item-modern${isActive ? ' active' : ''}`}
                            onClick={() => handleSelectSession(session.id)}
                          >
                            <span className="thread-item-title-modern">{session.thread?.topic || session.title || 'Terminal'}</span>
                            {relativeTime && (
                              <span className="thread-item-time-modern">{relativeTime}</span>
                            )}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Views Section */}
          <div className="mobile-drawer-section-modern">
            <div className="mobile-drawer-section-title-modern">Views</div>
            <div className="mobile-drawer-grid-modern">
              <button
                type="button"
                className={`mobile-drawer-grid-btn-modern${mobileView === 'terminal' ? ' active' : ''}`}
                onClick={() => handleViewChange('terminal')}
              >
                <div className="grid-btn-icon-modern">
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="4 17 10 11 4 5" />
                    <line x1="12" y1="19" x2="20" y2="19" />
                  </svg>
                </div>
                <span>Terminal</span>
              </button>
              <button
                type="button"
                className={`mobile-drawer-grid-btn-modern${mobileView === 'claude' ? ' active' : ''}`}
                onClick={() => handleViewChange('claude')}
              >
                <div className="grid-btn-icon-modern">
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="12" cy="12" r="10" />
                    <path d="M12 16v-4" />
                    <path d="M12 8h.01" />
                  </svg>
                </div>
                <span>Claude</span>
              </button>
              <button
                type="button"
                className={`mobile-drawer-grid-btn-modern${mobileView === 'preview' ? ' active' : ''}`}
                onClick={() => handleViewChange('preview')}
              >
                <div className="grid-btn-icon-modern">
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="3" y="3" width="18" height="18" rx="2" />
                    <line x1="12" y1="3" x2="12" y2="21" />
                  </svg>
                </div>
                <span>Preview</span>
              </button>
            </div>
          </div>

          {/* Actions Section */}
          <div className="mobile-drawer-section-modern">
            <div className="mobile-drawer-section-title-modern">Actions</div>
            <div className="mobile-drawer-list-modern">
              <button
                className="mobile-drawer-list-item-modern"
                onClick={() => {
                  onCreateSession();
                  onClose();
                }}
                type="button"
              >
                <div className="list-item-icon-modern">
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <line x1="12" y1="5" x2="12" y2="19" />
                    <line x1="5" y1="12" x2="19" y2="12" />
                  </svg>
                </div>
                <span>New Terminal</span>
              </button>
              <button
                className="mobile-drawer-list-item-modern"
                onClick={() => {
                  onOpenProcessManager?.();
                  onClose();
                }}
                type="button"
              >
                <div className="list-item-icon-modern">
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="2" y="3" width="20" height="14" rx="2" ry="2" />
                    <line x1="8" y1="21" x2="16" y2="21" />
                    <line x1="12" y1="17" x2="12" y2="21" />
                  </svg>
                </div>
                <span>Process Manager</span>
              </button>
              <button
                className="mobile-drawer-list-item-modern"
                onClick={() => {
                  onOpenBookmarks?.();
                  onClose();
                }}
                type="button"
              >
                <div className="list-item-icon-modern">
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" />
                  </svg>
                </div>
                <span>Bookmarks</span>
              </button>
              <button
                className="mobile-drawer-list-item-modern"
                onClick={() => {
                  onOpenNotes?.();
                  onClose();
                }}
                type="button"
              >
                <div className="list-item-icon-modern">
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                    <polyline points="14 2 14 8 20 8" />
                    <line x1="16" y1="13" x2="8" y2="13" />
                    <line x1="16" y1="17" x2="8" y2="17" />
                  </svg>
                </div>
                <span>Notes</span>
              </button>
              <button
                className="mobile-drawer-list-item-modern"
                onClick={() => {
                  onOpenSettings();
                  onClose();
                }}
                type="button"
              >
                <div className="list-item-icon-modern">
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="12" cy="12" r="3" />
                    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
                  </svg>
                </div>
                <span>Settings</span>
              </button>
            </div>
          </div>

          {/* Projects Section */}
          <div className="mobile-drawer-section-modern">
            <button
              className="mobile-drawer-section-collapsible-modern"
              onClick={() => setProjectsExpanded(!projectsExpanded)}
              type="button"
            >
              <div className="collapsible-icon-modern">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
                </svg>
              </div>
              <span className="collapsible-title-modern">Projects</span>
              <div className={`collapsible-chevron-modern ${projectsExpanded ? 'expanded' : ''}`}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="6 9 12 15 18 9" />
                </svg>
              </div>
            </button>

            {projectsExpanded && (
              <div className="mobile-drawer-projects-modern">
                {projects.length > 0 && (
                  <div className="mobile-drawer-search-modern">
                    <svg className="search-icon-modern" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <circle cx="11" cy="11" r="8" />
                      <line x1="21" y1="21" x2="16.65" y2="16.65" />
                    </svg>
                    <input
                      type="text"
                      className="mobile-drawer-search-input-modern"
                      placeholder="Search projects..."
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                    />
                  </div>
                )}
                <div className="projects-list-modern">
                  {projectsLoading && projects.length === 0 ? (
                    <div className="empty-state-modern">Scanning...</div>
                  ) : projects.length === 0 ? (
                    <div className="empty-state-modern">No projects found</div>
                  ) : filteredProjects.length === 0 ? (
                    <div className="empty-state-modern">No matches found</div>
                  ) : (
                    filteredProjects.map((project) => (
                      <button
                        key={project.path}
                        className={`project-item-modern ${normalizePath(project.path) === currentNormalized ? 'active' : ''}`}
                        onClick={() => {
                          onFolderSelect(project.path);
                          onClose();
                        }}
                        type="button"
                      >
                        <div className="project-item-info-modern">
                          <span className="project-name-modern">{project.name}</span>
                          <span className="project-path-modern">{project.path}</span>
                        </div>
                        {project.branch && (
                          <div className="project-branch-modern">
                            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                              <line x1="6" y1="3" x2="6" y2="15" />
                              <circle cx="18" cy="6" r="3" />
                              <circle cx="6" cy="18" r="3" />
                              <path d="M18 9a9 9 0 0 1-9 9" />
                            </svg>
                            {project.branch}
                          </div>
                        )}
                      </button>
                    ))
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      <style>{`
        .mobile-drawer-modern {
          position: fixed;
          top: 0;
          left: 0;
          bottom: 0;
          width: min(90vw, 360px);
          background: var(--bg-primary, #0a0a0c);
          z-index: 1500;
          transform: translateX(-100%);
          transition: transform 0.3s cubic-bezier(0.4, 0, 0.2, 1);
          display: flex;
          flex-direction: column;
          box-shadow: none;
        }

        .mobile-drawer-modern.open {
          transform: translateX(0);
          box-shadow: 20px 0 50px rgba(0, 0, 0, 0.5);
        }

        .mobile-drawer-overlay-modern {
          position: fixed;
          top: 0;
          left: 0;
          right: 0;
          bottom: 0;
          background: rgba(0, 0, 0, 0.7);
          backdrop-filter: blur(4px);
          z-index: 1499;
          opacity: 0;
          pointer-events: none;
          transition: opacity 0.3s ease;
        }

        .mobile-drawer-overlay-modern.open {
          opacity: 1;
          pointer-events: auto;
        }

        .mobile-drawer-header-modern {
          height: 52px;
          padding: 0 16px;
          display: flex;
          align-items: center;
          justify-content: space-between;
          border-bottom: 1px solid var(--border-subtle, #1e1e21);
        }

        .mobile-drawer-header-modern h2 {
          font-size: 16px;
          font-weight: 700;
          margin: 0;
          color: var(--accent-primary, #f59e0b);
          letter-spacing: -0.5px;
        }

        .mobile-drawer-close-modern {
          width: 36px;
          height: 36px;
          border-radius: 50%;
          background: var(--bg-surface, #141416);
          border: 1px solid var(--border-default, #2a2a2e);
          color: var(--text-secondary, #a1a1aa);
          display: flex;
          align-items: center;
          justify-content: center;
          transition: all 0.2s ease;
        }

        .mobile-drawer-content-modern {
          flex: 1;
          overflow-y: auto;
          padding: 14px 0 18px;
        }

        .mobile-drawer-section-modern {
          margin-bottom: 16px;
          padding: 0 14px;
        }

        .mobile-drawer-section-title-modern {
          font-size: 11px;
          font-weight: 700;
          color: var(--text-muted, #71717a);
          text-transform: uppercase;
          letter-spacing: 0.8px;
          margin-bottom: 8px;
          padding-left: 4px;
        }

        .mobile-drawer-grid-modern {
          display: grid;
          grid-template-columns: repeat(3, 1fr);
          gap: 8px;
        }

        .mobile-drawer-grid-btn-modern {
          display: flex;
          flex-direction: column;
          align-items: center;
          gap: 8px;
          padding: 10px 4px;
          background: var(--bg-surface, #141416);
          border: 1px solid var(--border-subtle, #1e1e21);
          border-radius: 12px;
          color: var(--text-secondary, #a1a1aa);
          font-size: 12px;
          line-height: 1.25;
          font-weight: 600;
          transition: all 0.2s ease;
        }

        .mobile-drawer-grid-btn-modern.active {
          background: var(--accent-primary-dim);
          border-color: var(--accent-primary, #f59e0b);
          color: var(--accent-primary, #f59e0b);
        }

        .grid-btn-icon-modern {
          width: 34px;
          height: 34px;
          border-radius: 10px;
          background: var(--bg-elevated, #1e1e21);
          display: flex;
          align-items: center;
          justify-content: center;
          transition: all 0.2s ease;
        }

        .mobile-drawer-grid-btn-modern.active .grid-btn-icon-modern {
          background: var(--accent-primary, #f59e0b);
          color: var(--bg-primary, #0a0a0c);
        }

        .mobile-drawer-list-modern {
          display: flex;
          flex-direction: column;
          gap: 2px;
        }

        .mobile-drawer-list-item-modern {
          display: flex;
          align-items: center;
          gap: 12px;
          padding: 8px 10px;
          background: transparent;
          border: none;
          color: var(--text-primary, #fafafa);
          font-size: 13px;
          font-weight: 500;
          text-align: left;
          border-radius: 8px;
          transition: background 0.2s ease;
        }

        .mobile-drawer-list-item-modern:active {
          background: var(--bg-surface, #141416);
        }

        .mobile-drawer-list-item-modern.active {
          background: var(--accent-primary-dim);
          color: var(--accent-primary, #f59e0b);
        }

        .list-item-title-modern {
          flex: 1;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }

        .list-item-time-modern {
          font-size: 12px;
          color: var(--text-muted, #71717a);
          white-space: nowrap;
          flex-shrink: 0;
        }

        .mobile-drawer-list-item-modern.active .list-item-time-modern {
          color: var(--accent-primary, #f59e0b);
          opacity: 0.7;
        }

        .list-item-icon-modern {
          width: 28px;
          height: 28px;
          border-radius: 8px;
          background: var(--bg-surface, #141416);
          color: var(--text-muted, #71717a);
          display: flex;
          align-items: center;
          justify-content: center;
          flex-shrink: 0;
        }

        .list-item-icon-modern.active {
          background: var(--accent-primary, #f59e0b);
          color: var(--bg-primary, #0a0a0c);
        }

        .mobile-drawer-section-collapsible-modern {
          width: 100%;
          display: flex;
          align-items: center;
          gap: 12px;
          padding: 10px 0;
          background: transparent;
          border: none;
          color: var(--text-primary, #fafafa);
          cursor: pointer;
        }

        .collapsible-icon-modern {
          width: 28px;
          height: 28px;
          border-radius: 8px;
          background: var(--accent-primary-dim);
          color: var(--accent-primary, #f59e0b);
          display: flex;
          align-items: center;
          justify-content: center;
        }

        .collapsible-title-modern {
          flex: 1;
          font-size: 13px;
          font-weight: 600;
          text-align: left;
        }

        .collapsible-chevron-modern {
          color: var(--text-muted, #71717a);
          transition: transform 0.3s ease;
        }

        .collapsible-chevron-modern.expanded {
          transform: rotate(180deg);
        }

        .mobile-drawer-threads-modern {
          display: flex;
          flex-direction: column;
          gap: 8px;
        }

        .mobile-drawer-project-modern {
          display: flex;
          flex-direction: column;
          gap: 4px;
        }

        .mobile-drawer-project-header-modern {
          display: flex;
          align-items: center;
          gap: 8px;
          padding: 0 4px;
          color: var(--text-secondary, #a1a1aa);
          font-size: 12px;
          font-weight: 600;
        }

        .mobile-drawer-project-icon-modern {
          font-size: 14px;
        }

        .mobile-drawer-project-name-modern {
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }

        .mobile-drawer-project-sessions-modern {
          display: flex;
          flex-direction: column;
          gap: 3px;
        }

        .mobile-drawer-thread-item-modern {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 8px;
          padding: 7px 9px;
          background: var(--bg-surface, #141416);
          border: 1px solid var(--border-subtle, #1e1e21);
          border-radius: 10px;
          color: var(--text-primary, #fafafa);
          font-size: 12.5px;
          text-align: left;
          cursor: pointer;
        }

        .mobile-drawer-thread-item-modern.active {
          background: var(--bg-elevated, #1e1e21);
          border-color: var(--accent-primary, #f59e0b);
        }

        .thread-item-title-modern {
          flex: 1;
          min-width: 0;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }

        .thread-item-time-modern {
          font-size: 11px;
          color: var(--text-muted, #71717a);
          white-space: nowrap;
        }

        .mobile-drawer-projects-modern {
          padding-top: 8px;
        }

        .mobile-drawer-search-modern {
          position: relative;
          margin-bottom: 12px;
        }

        .search-icon-modern {
          position: absolute;
          left: 12px;
          top: 50%;
          transform: translateY(-50%);
          color: var(--text-muted, #71717a);
        }

        .mobile-drawer-search-input-modern {
          width: 100%;
          height: 40px;
          background: var(--bg-surface, #141416);
          border: 1px solid var(--border-subtle, #1e1e21);
          border-radius: 10px;
          padding: 0 12px 0 36px;
          color: var(--text-primary, #fafafa);
          font-size: 16px;
          outline: none;
        }

        .projects-list-modern {
          display: flex;
          flex-direction: column;
          gap: 8px;
        }

        .project-item-modern {
          display: flex;
          flex-direction: column;
          gap: 4px;
          padding: 12px;
          background: var(--bg-surface, #141416);
          border: 1px solid var(--border-subtle, #1e1e21);
          border-radius: 12px;
          text-align: left;
          transition: all 0.2s ease;
        }

        .project-item-modern.active {
          border-color: var(--accent-primary, #f59e0b);
          background: var(--accent-primary-dim);
        }

        .project-item-info-modern {
          display: flex;
          flex-direction: column;
        }

        .project-name-modern {
          font-size: 14px;
          font-weight: 700;
          color: var(--text-primary, #fafafa);
        }

        .project-path-modern {
          font-size: 12px;
          color: var(--text-muted, #71717a);
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }

        .project-branch-modern {
          align-self: flex-start;
          display: flex;
          align-items: center;
          gap: 4px;
          font-size: 11px;
          font-weight: 600;
          background: var(--bg-elevated, #1e1e21);
          color: var(--text-secondary, #a1a1aa);
          padding: 2px 8px;
          border-radius: 6px;
          margin-top: 4px;
        }

        .empty-state-modern {
          padding: 20px;
          text-align: center;
          font-size: 14px;
          color: var(--text-muted, #71717a);
          font-style: italic;
        }

        @media (max-width: 480px) {
          .mobile-drawer-header-modern {
            height: 48px;
            padding: 0 14px;
          }

          .mobile-drawer-header-modern h2 {
            font-size: 15px;
          }

          .mobile-drawer-content-modern {
            padding: 12px 0 14px;
          }

          .mobile-drawer-section-modern {
            padding: 0 12px;
            margin-bottom: 12px;
          }

          .mobile-drawer-grid-btn-modern {
            padding: 8px 4px;
            font-size: 11px;
          }

          .grid-btn-icon-modern {
            width: 30px;
            height: 30px;
          }

          .mobile-drawer-list-item-modern {
            padding: 7px 8px;
            font-size: 12.5px;
          }

          .mobile-drawer-thread-item-modern {
            padding: 6px 8px;
            font-size: 12px;
          }
        }
      `}</style>
    </>
  );
}
