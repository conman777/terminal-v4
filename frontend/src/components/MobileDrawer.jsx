import { useEffect, useMemo, useRef, useState } from 'react';
import { useBodyScrollLock } from '../hooks/useBodyScrollLock';
import { getCompactSessionSubtitle, getSessionDisplayInfo } from '../utils/sessionDisplay';
import { downloadProjectArchive } from '../utils/projectArchiveDownload';

function formatRelativeTime(timestamp) {
  if (!timestamp) return null;

  const now = Date.now();
  const time = typeof timestamp === 'string' ? new Date(timestamp).getTime() : timestamp;
  const diff = now - time;

  if (!Number.isFinite(diff) || diff < 0) return 'just now';

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

function FolderGlyph() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
    </svg>
  );
}

function TerminalGlyph() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polyline points="4 17 10 11 4 5" />
      <line x1="12" y1="19" x2="20" y2="19" />
    </svg>
  );
}

function SessionStateIndicator({ isBusy, showReady }) {
  if (!isBusy && !showReady) return null;

  return (
    <span
      className={`mobile-session-state-indicator${isBusy ? ' busy' : ' ready'}`}
      aria-label={isBusy ? 'Working' : 'Ready to review'}
    >
      {isBusy ? (
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <circle cx="8" cy="8" r="6" stroke="rgba(255,255,255,0.1)" strokeWidth="2" />
          <path d="M14 8a6 6 0 0 0-6-6" stroke="#93c5fd" strokeWidth="2" strokeLinecap="round" />
        </svg>
      ) : (
        <span className="mobile-session-state-dot" aria-hidden="true" />
      )}
    </span>
  );
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
  mobileView = 'terminal',
  onViewChange,
  previewUrl,
  activeSessions = [],
  activeSessionId,
  sessionActivity,
  onSelectSession,
  sessionsGroupedByProject = []
}) {
  const drawerSwipeRef = useRef(null);
  const drawerRef = useRef(null);
  const closeButtonRef = useRef(null);
  const previousFocusedElementRef = useRef(null);
  const [projectsExpanded, setProjectsExpanded] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');

  const visibleThreadGroups = useMemo(() => {
    return (sessionsGroupedByProject || [])
      .map((group) => ({
        ...group,
        sessions: (group.sessions || []).filter((session) => !session.thread?.archived)
      }))
      .filter((group) => group.sessions.length > 0);
  }, [sessionsGroupedByProject]);

  useBodyScrollLock(isOpen);

  useEffect(() => {
    if (!isOpen) {
      setSearchQuery('');
    }
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen || typeof document === 'undefined') return;

    previousFocusedElementRef.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;

    const scheduleFrame = typeof window.requestAnimationFrame === 'function'
      ? window.requestAnimationFrame
      : (callback) => setTimeout(callback, 0);
    const cancelFrame = typeof window.cancelAnimationFrame === 'function'
      ? window.cancelAnimationFrame
      : clearTimeout;

    const frameId = scheduleFrame(() => {
      closeButtonRef.current?.focus();
    });

    return () => cancelFrame(frameId);
  }, [isOpen]);

  useEffect(() => {
    if (isOpen || typeof document === 'undefined') return;

    const previousFocused = previousFocusedElementRef.current;
    if (previousFocused && typeof previousFocused.focus === 'function') {
      previousFocused.focus();
    }
    previousFocusedElementRef.current = null;
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen || typeof document === 'undefined') return;

    const focusableSelector = [
      'button:not([disabled])',
      '[href]',
      'input:not([disabled])',
      'select:not([disabled])',
      'textarea:not([disabled])',
      '[tabindex]:not([tabindex="-1"])'
    ].join(', ');

    const handleKeyDown = (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
        return;
      }

      if (event.key !== 'Tab') return;

      const drawer = drawerRef.current;
      if (!drawer) return;

      const focusableElements = Array.from(drawer.querySelectorAll(focusableSelector));
      if (focusableElements.length === 0) {
        event.preventDefault();
        drawer.focus();
        return;
      }

      const firstFocusable = focusableElements[0];
      const lastFocusable = focusableElements[focusableElements.length - 1];
      const activeElement = document.activeElement;

      if (!drawer.contains(activeElement)) {
        event.preventDefault();
        firstFocusable.focus();
        return;
      }

      if (event.shiftKey && activeElement === firstFocusable) {
        event.preventDefault();
        lastFocusable.focus();
        return;
      }

      if (!event.shiftKey && activeElement === lastFocusable) {
        event.preventDefault();
        firstFocusable.focus();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  const normalizePath = (value) => value?.toLowerCase().replace(/\/$/, '');
  const currentNormalized = normalizePath(currentPath);

  const filteredProjects = useMemo(() => {
    if (!searchQuery.trim()) return projects;
    const query = searchQuery.toLowerCase();
    return projects.filter((project) =>
      project.name.toLowerCase().includes(query)
      || project.path.toLowerCase().includes(query)
      || (project.branch || '').toLowerCase().includes(query)
    );
  }, [projects, searchQuery]);

  const handleViewChange = (view) => {
    onViewChange?.(view);
    onClose();
  };

  const handleSelectSession = (sessionId) => {
    onSelectSession?.(sessionId);
    onClose();
  };

  const handleDrawerSwipeStart = (event) => {
    if (!isOpen) return;
    const touch = event.touches?.[0];
    if (!touch) return;
    drawerSwipeRef.current = { x: touch.clientX, y: touch.clientY, startedAt: Date.now() };
  };

  const handleDrawerSwipeEnd = (event) => {
    const swipe = drawerSwipeRef.current;
    drawerSwipeRef.current = null;
    if (!swipe) return;

    const touch = event.changedTouches?.[0];
    if (!touch) return;

    const elapsed = Date.now() - swipe.startedAt;
    const deltaX = touch.clientX - swipe.x;
    const deltaY = touch.clientY - swipe.y;
    const absX = Math.abs(deltaX);
    const absY = Math.abs(deltaY);
    if (elapsed <= 700 && deltaX <= -56 && absX > absY + 16) {
      onClose();
    }
  };

  const viewTabs = [
    { key: 'terminal', label: 'Terminal' },
    ...(previewUrl ? [{ key: 'preview', label: 'Preview' }] : [])
  ];

  const menuItems = [
    {
      label: 'Process Manager',
      onClick: () => { onOpenProcessManager?.(); onClose(); },
      icon: (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <rect x="2" y="3" width="20" height="14" rx="2" ry="2" />
          <line x1="8" y1="21" x2="16" y2="21" />
          <line x1="12" y1="17" x2="12" y2="21" />
        </svg>
      )
    },
    {
      label: 'Bookmarks',
      onClick: () => { onOpenBookmarks?.(); onClose(); },
      icon: (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" />
        </svg>
      )
    },
    {
      label: 'Notes',
      onClick: () => { onOpenNotes?.(); onClose(); },
      icon: (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
          <polyline points="14 2 14 8 20 8" />
          <line x1="16" y1="13" x2="8" y2="13" />
          <line x1="16" y1="17" x2="8" y2="17" />
        </svg>
      )
    },
  ];

  return (
    <>
      <div className={`mobile-drawer-overlay-modern${isOpen ? ' open' : ''}`} onClick={onClose} aria-hidden="true" />
      <div
        ref={drawerRef}
        className={`mobile-drawer-modern${isOpen ? ' open' : ''}`}
        aria-hidden={!isOpen}
        role="dialog"
        aria-modal="true"
        aria-label="Mobile menu"
        tabIndex={-1}
        onTouchStart={handleDrawerSwipeStart}
        onTouchEnd={handleDrawerSwipeEnd}
        onTouchCancel={() => { drawerSwipeRef.current = null; }}
      >
        {/* Header */}
        <div className="mobile-drawer-header-modern">
          <div className="mobile-drawer-header-top">
            <div className="mobile-drawer-header-copy">
              <h2>Workspace</h2>
              <span>{activeSessions.length} active</span>
            </div>
            <button ref={closeButtonRef} className="mobile-drawer-close-modern" onClick={onClose} aria-label="Close menu">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          </div>
          <div className="mobile-drawer-toolbar-modern">
            {viewTabs.map((tab) => {
              const icon = tab.key === 'terminal'
                ? <TerminalGlyph />
                : <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="2" /><line x1="12" y1="3" x2="12" y2="21" /></svg>;

              return (
                <button
                  key={tab.key}
                  type="button"
                  className={`mobile-drawer-toolbar-btn-modern${mobileView === tab.key ? ' active' : ''}${tab.disabled ? ' disabled' : ''}`}
                  onClick={() => !tab.disabled && handleViewChange(tab.key)}
                  disabled={tab.disabled}
                >
                  {icon}
                  <span>{tab.label}</span>
                </button>
              );
            })}
          </div>
        </div>

        <div className="mobile-drawer-content-modern">
          <div className="mobile-drawer-section-modern">
            <button
              type="button"
              className="md-new-session-btn"
              onClick={() => { onCreateSession(); onClose(); }}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="12" y1="5" x2="12" y2="19" />
                <line x1="5" y1="12" x2="19" y2="12" />
              </svg>
              <span>New Terminal</span>
            </button>
            <div className="mobile-drawer-section-title-modern">Threads</div>
            <div className="mobile-drawer-threads-modern">
              {visibleThreadGroups.map((group) => (
                <div key={group.projectPath || group.projectName} className="mobile-drawer-project-modern">
                  <div className="mobile-drawer-project-header-modern">
                    <span className="mobile-drawer-project-icon-modern"><FolderGlyph /></span>
                    <span className="mobile-drawer-project-name-modern">{group.projectName}</span>
                    <span className="mobile-drawer-project-count-modern">{group.sessions.length}</span>
                  </div>
                  <div className="mobile-drawer-project-sessions-modern">
                    {group.sessions.map((session) => {
                      const display = getSessionDisplayInfo(session, 'Terminal');
                      const subtitle = getCompactSessionSubtitle(session, 'Terminal');
                      const lastActivity = sessionActivity?.[session.id]?.lastActivity || session.updatedAt;
                      const relativeTime = formatRelativeTime(lastActivity);
                      const isActive = session.id === activeSessionId;
                      const hasAttention = Boolean(sessionActivity?.[session.id]?.needsAttention);
                      const isBusy = typeof sessionActivity?.[session.id]?.isBusy === 'boolean'
                        ? sessionActivity[session.id].isBusy
                        : Boolean(session.isBusy);
                      const showReady = !isBusy && hasAttention && !isActive;
                      return (
                        <button
                          key={session.id}
                          type="button"
                          className={`mobile-drawer-thread-item-modern${isActive ? ' active' : ''}`}
                          onClick={() => handleSelectSession(session.id)}
                        >
                          <div className="thread-item-main-modern">
                            <span className="thread-item-title-modern">{display.primaryLabel}</span>
                            {subtitle && <span className="thread-item-subtitle-modern">{subtitle}</span>}
                          </div>
                          <div className="thread-item-meta-modern">
                            <SessionStateIndicator isBusy={isBusy} showReady={showReady} />
                            {relativeTime && <span className="thread-item-time-modern">{relativeTime}</span>}
                          </div>
                        </button>
                      );
                    })}
                  </div>
                </div>
              ))}
              {visibleThreadGroups.length === 0 && (
                <div className="md-empty-state">No active threads</div>
              )}
            </div>
          </div>

          <div className="mobile-drawer-section-modern">
            <div className="md-action-list">
              {menuItems.map((item) => (
                <button
                  key={item.label}
                  type="button"
                  className="md-action-item"
                  onClick={item.onClick}
                >
                  {item.icon}
                  <span>{item.label}</span>
                </button>
              ))}
            </div>
          </div>

          <div className="mobile-drawer-section-modern">
            <button className="mobile-drawer-section-collapsible-modern" onClick={() => setProjectsExpanded(!projectsExpanded)} type="button">
              <div className="collapsible-icon-modern"><FolderGlyph /></div>
              <span className="collapsible-title-modern">Projects</span>
              <div className={`collapsible-chevron-modern${projectsExpanded ? ' expanded' : ''}`}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="6 9 12 15 18 9" />
                </svg>
              </div>
            </button>

            {projectsExpanded && (
              <div className="md-projects-body">
                {(projects.length > 0 || onAddScanFolder) && (
                  <div className="md-project-toolbar">
                    {projects.length > 0 && (
                      <div className="md-search-wrap">
                        <svg className="md-search-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <circle cx="11" cy="11" r="8" />
                          <line x1="21" y1="21" x2="16.65" y2="16.65" />
                        </svg>
                        <input
                          type="text"
                          className="md-search-input"
                          placeholder="Search projects..."
                          value={searchQuery}
                          onChange={(event) => setSearchQuery(event.target.value)}
                        />
                      </div>
                    )}
                    {onAddScanFolder && (
                      <button
                        type="button"
                        className="md-add-project-btn"
                        onClick={() => { onAddScanFolder?.(); onClose(); }}
                      >
                        Add project
                      </button>
                    )}
                  </div>
                )}

                <div className="md-projects-list">
                  {projectsLoading && projects.length === 0 ? (
                    <div className="md-empty-state">Scanning...</div>
                  ) : projects.length === 0 ? (
                    <div className="md-empty-state">No projects found</div>
                  ) : filteredProjects.length === 0 ? (
                    <div className="md-empty-state">No matches found</div>
                  ) : (
                    filteredProjects.map((project) => (
                      <div
                        key={project.path}
                        className={`md-project-row${normalizePath(project.path) === currentNormalized ? ' active' : ''}`}
                      >
                        <button
                          className={`md-project-item${normalizePath(project.path) === currentNormalized ? ' active' : ''}`}
                          onClick={() => { onFolderSelect(project.path); onClose(); }}
                          type="button"
                        >
                          <div className="md-project-info">
                            <span className="md-project-name">{project.name}</span>
                            <span className="md-project-path">{project.path}</span>
                          </div>
                          {project.branch && (
                            <div className="md-project-branch">
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
                        <button
                          type="button"
                          className="md-project-download-btn"
                          onClick={() => downloadProjectArchive(project.path)}
                          aria-label={`Zip and download ${project.name}`}
                          title="Zip and download project"
                        >
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                            <polyline points="7 10 12 15 17 10" />
                            <line x1="12" y1="15" x2="12" y2="3" />
                          </svg>
                        </button>
                      </div>
                    ))
                  )}
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="mobile-drawer-footer-modern">
          <button
            type="button"
            className="md-footer-settings-btn"
            onClick={() => { onOpenSettings(); onClose(); }}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
            </svg>
            <span>Settings</span>
          </button>
        </div>
      </div>
    </>
  );
}
