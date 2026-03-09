import { useEffect, useMemo, useRef, useState } from 'react';
import { useBodyScrollLock } from '../hooks/useBodyScrollLock';
import { getCompactSessionSubtitle, getSessionDisplayInfo } from '../utils/sessionDisplay';

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

const GESTURE_HELP_ITEMS = [
  { glyph: '\u2192', text: 'Swipe right from the left edge to open the drawer.' },
  { glyph: '\u2193', text: 'Swipe down on the header to toggle the keyboard bar.' },
  { glyph: '\u22ef', text: 'Use session actions to rename, change AI, or close.' }
];

function FolderGlyph() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
    </svg>
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
  const [showGestureHelp, setShowGestureHelp] = useState(false);

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
      setShowGestureHelp(false);
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
    { key: 'claude', label: 'Claude' },
    { key: 'preview', label: 'Preview', disabled: !previewUrl }
  ];

  const actionItems = [
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
    }
  ];

  const settingsItems = [
    {
      label: 'API Settings',
      onClick: () => { onOpenApiSettings?.(); onClose(); },
      icon: (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 2l3.09 6.26L22 9l-5 4.87L18.18 22 12 18.56 5.82 22 7 13.87 2 9l6.91-.74L12 2z" />
        </svg>
      )
    },
    {
      label: 'Browser Settings',
      onClick: () => { onOpenBrowserSettings?.(); onClose(); },
      icon: (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="10" />
          <path d="M2 12h20" />
          <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10Z" />
        </svg>
      )
    },
    {
      label: 'Settings',
      onClick: () => { onOpenSettings(); onClose(); },
      icon: (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="3" />
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
        </svg>
      )
    }
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

        <div className="mobile-drawer-content-modern">

          {/* Section 1: View Switcher */}
          <div className="md-view-switcher">
            {viewTabs.map((tab) => (
              <button
                key={tab.key}
                type="button"
                className={`md-view-tab${mobileView === tab.key ? ' active' : ''}${tab.disabled ? ' disabled' : ''}`}
                onClick={() => !tab.disabled && handleViewChange(tab.key)}
                disabled={tab.disabled}
              >
                {tab.label}
              </button>
            ))}
          </div>

          {/* Section 2: Threads */}
          <div className="md-section">
            <div className="md-section-header">
              <span className="md-section-title">Threads</span>
              <span className="md-thread-count">{activeSessions.length}</span>
            </div>

            <button
              type="button"
              className="md-new-terminal-btn"
              onClick={() => { onCreateSession(); onClose(); }}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <line x1="12" y1="5" x2="12" y2="19" />
                <line x1="5" y1="12" x2="19" y2="12" />
              </svg>
              <span>New Terminal</span>
            </button>

            {visibleThreadGroups.length > 0 && (
              <div className="md-thread-list">
                {visibleThreadGroups.map((group) => (
                  <div key={group.projectPath || group.projectName} className="md-thread-group">
                    <div className="md-group-header">
                      <FolderGlyph />
                      <span className="md-group-name">{group.projectName}</span>
                    </div>
                    {group.sessions.map((session) => {
                      const display = getSessionDisplayInfo(session, 'Terminal');
                      const subtitle = getCompactSessionSubtitle(session, 'Terminal');
                      const lastActivity = sessionActivity?.[session.id]?.lastActivity || session.updatedAt;
                      const relativeTime = formatRelativeTime(lastActivity);
                      const isActive = session.id === activeSessionId;
                      const isBusy = typeof sessionActivity?.[session.id]?.isBusy === 'boolean'
                        ? sessionActivity[session.id].isBusy
                        : Boolean(session.isBusy);
                      return (
                        <button
                          key={session.id}
                          type="button"
                          className={`md-thread-item${isActive ? ' active' : ''}`}
                          onClick={() => handleSelectSession(session.id)}
                        >
                          <span className={`md-thread-dot ${isBusy ? 'busy' : 'idle'}`} />
                          <div className="md-thread-info">
                            <span className="md-thread-title">{display.primaryLabel}</span>
                            {subtitle && <span className="md-thread-sub">{subtitle}</span>}
                          </div>
                          {relativeTime && <span className="md-thread-time">{relativeTime}</span>}
                        </button>
                      );
                    })}
                  </div>
                ))}
              </div>
            )}

            {visibleThreadGroups.length === 0 && (
              <div className="md-empty-state">No active threads</div>
            )}
          </div>

          {/* Section 3: Actions */}
          <div className="md-section">
            <span className="md-section-title">Tools</span>
            <div className="md-action-list">
              {actionItems.map((item) => (
                <button key={item.label} type="button" className="md-action-row" onClick={item.onClick}>
                  <span className="md-action-icon">{item.icon}</span>
                  <span className="md-action-label">{item.label}</span>
                  <svg className="md-action-chevron" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="9 18 15 12 9 6" />
                  </svg>
                </button>
              ))}
            </div>
            <div className="md-action-divider" />
            <div className="md-action-list">
              {settingsItems.map((item) => (
                <button key={item.label} type="button" className="md-action-row" onClick={item.onClick}>
                  <span className="md-action-icon">{item.icon}</span>
                  <span className="md-action-label">{item.label}</span>
                  <svg className="md-action-chevron" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="9 18 15 12 9 6" />
                  </svg>
                </button>
              ))}
            </div>
          </div>

          {/* Projects (collapsible) */}
          <div className="md-section">
            <button className="md-collapsible-header" onClick={() => setProjectsExpanded(!projectsExpanded)} type="button">
              <div className="md-collapsible-icon"><FolderGlyph /></div>
              <span className="md-collapsible-title">Projects</span>
              <div className={`md-collapsible-chevron${projectsExpanded ? ' expanded' : ''}`}>
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
                      <button
                        key={project.path}
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
            className={`mobile-drawer-help-btn-modern${showGestureHelp ? ' active' : ''}`}
            onClick={() => setShowGestureHelp((prev) => !prev)}
            aria-expanded={showGestureHelp}
            aria-label="Show mobile gesture help"
          >
            <span className="mobile-drawer-help-icon-modern">?</span>
            <span>Gesture help</span>
          </button>
          {showGestureHelp && (
            <div className="mobile-drawer-help-list-modern" role="note" aria-label="Mobile gesture hints">
              {GESTURE_HELP_ITEMS.map((item) => (
                <div key={item.text} className="mobile-drawer-help-row-modern">
                  <span className="mobile-drawer-help-glyph-modern" aria-hidden="true">{item.glyph}</span>
                  <span>{item.text}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </>
  );
}
