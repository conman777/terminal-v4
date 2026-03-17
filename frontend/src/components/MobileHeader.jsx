import { useState, useRef, useEffect, useLayoutEffect, useCallback } from 'react';
import { MobileDrawer } from './MobileDrawer';
import { ContextMenu } from './ContextMenu';
import { Dropdown } from './Dropdown';
import { MobileSessionPicker } from './MobileSessionPicker';
import { useTheme } from '../contexts/ThemeContext';
import { AI_TYPE_OPTIONS } from '../utils/aiProviders';
import { getCompactSessionSubtitle, getSessionDisplayInfo } from '../utils/sessionDisplay';

const EDGE_SWIPE_ZONE_PX = 28;
const HORIZONTAL_SWIPE_THRESHOLD_PX = 56;
const VERTICAL_SWIPE_THRESHOLD_PX = 64;
const SWIPE_AXIS_BIAS_PX = 18;
const MAX_GESTURE_DURATION_MS = 700;

function isInteractiveGestureTarget(target) {
  return target instanceof Element && Boolean(
    target.closest('button, a, input, textarea, select, [role="button"], [role="menuitem"], [role="menuitemradio"]')
  );
}

export function MobileHeader({
  activeSessions,
  activeSessionId,
  onSelectSession,
  onCreateSession,
  onRenameSession,
  onCloseSession,
  onOpenSettings,
  onOpenApiSettings,
  onOpenBrowserSettings,
  onOpenBookmarks,
  onOpenNotes,
  onOpenProcessManager,
  keybarOpen,
  onToggleKeybar,
  projects = [],
  projectsLoading = false,
  onFolderSelect,
  currentPath,
  onAddScanFolder = null,
  mobileView = 'terminal',
  onViewChange,
  previewUrl,
  showFileManager,
  onToggleFileManager,
  isNavCollapsed = false,
  sessionActivity,
  sessionsGroupedByProject,
  sessionAiTypes,
  onSetSessionAiType,
  chatMode = false,
  onToggleChatMode,
}) {
  const { theme, toggleTheme } = useTheme();
  const visibleActiveSessions = activeSessions.filter((session) => !session.thread?.archived);
  const activeVisibleSession = visibleActiveSessions.find((session) => session.id === activeSessionId) || null;
  const activeSessionDisplay = getSessionDisplayInfo(activeVisibleSession, 'New terminal');
  const activeSessionSubtitle = getCompactSessionSubtitle(activeVisibleSession, 'New terminal');
  const activeActivity = activeVisibleSession ? sessionActivity?.[activeVisibleSession.id] : null;
  const activeSessionIsBusy = typeof activeActivity?.isBusy === 'boolean'
    ? activeActivity.isBusy
    : Boolean(activeVisibleSession?.isBusy);
  const sessionCountLabel = `${visibleActiveSessions.length} live terminal${visibleActiveSessions.length === 1 ? '' : 's'}`;
  const [showDrawer, setShowDrawer] = useState(false);
  const [tabContextMenu, setTabContextMenu] = useState(null);
  const [previewOpened, setPreviewOpened] = useState(() => mobileView === 'preview' && Boolean(previewUrl));
  const [showSessionPicker, setShowSessionPicker] = useState(false);
  const headerRef = useRef(null);
  const sessionActionsButtonRef = useRef(null);
  const topRowGestureRef = useRef(null);

  useLayoutEffect(() => {
    if (!headerRef.current) return;
    const height = Math.round(headerRef.current.getBoundingClientRect().height || 0);
    if (height > 0) {
      document.documentElement.style.setProperty('--mobile-header-height', `${height}px`);
    }
  }, []);

  useEffect(() => {
    if (!headerRef.current) return;

    const updateHeight = () => {
      if (headerRef.current) {
        const height = Math.round(headerRef.current.getBoundingClientRect().height || headerRef.current.offsetHeight || 0);
        document.documentElement.style.setProperty('--mobile-header-height', `${height}px`);
      }
    };

    updateHeight();
    const observer = new ResizeObserver(updateHeight);
    observer.observe(headerRef.current);

    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!headerRef.current) return;
    const raf = requestAnimationFrame(() => {
      const height = Math.round(headerRef.current?.getBoundingClientRect().height || 0);
      document.documentElement.style.setProperty('--mobile-header-height', `${height}px`);
    });
    return () => cancelAnimationFrame(raf);
  }, [mobileView, previewOpened, previewUrl, visibleActiveSessions.length, isNavCollapsed, chatMode]);

  const handleStartRename = useCallback((sessionId) => {
    const session = visibleActiveSessions.find((item) => item.id === sessionId);
    if (!session) return;

    const nextName = window.prompt('Rename terminal', getSessionDisplayInfo(session, 'New terminal').primaryLabel);
    if (typeof nextName !== 'string') {
      setTabContextMenu(null);
      return;
    }

    const trimmed = nextName.trim();
    if (trimmed) {
      onRenameSession(sessionId, trimmed);
    }
    setTabContextMenu(null);
  }, [onRenameSession, visibleActiveSessions]);

  const handleCloseFromMenu = useCallback((sessionId) => {
    onCloseSession(sessionId);
    setTabContextMenu(null);
  }, [onCloseSession]);

  const handleOpenActiveSessionMenu = useCallback(() => {
    if (!activeSessionId) return;
    const rect = sessionActionsButtonRef.current?.getBoundingClientRect();
    const fallbackX = typeof window !== 'undefined' ? window.innerWidth - 12 : 12;
    const fallbackY = typeof window !== 'undefined' ? 56 : 56;
    const x = rect ? Math.round(rect.left + (rect.width / 2)) : fallbackX;
    const y = rect ? Math.round(rect.bottom + 6) : fallbackY;
    setTabContextMenu({ sessionId: activeSessionId, x, y });
  }, [activeSessionId]);

  const handleTopRowTouchStart = useCallback((event) => {
    if (isInteractiveGestureTarget(event.target)) {
      topRowGestureRef.current = null;
      return;
    }
    const touch = event.touches?.[0];
    if (!touch) return;
    topRowGestureRef.current = {
      x: touch.clientX,
      y: touch.clientY,
      startedAt: Date.now()
    };
  }, []);

  const handleTopRowTouchEnd = useCallback((event) => {
    const gesture = topRowGestureRef.current;
    topRowGestureRef.current = null;
    if (!gesture) return;

    const touch = event.changedTouches?.[0];
    if (!touch) return;

    const deltaX = touch.clientX - gesture.x;
    const deltaY = touch.clientY - gesture.y;
    const absX = Math.abs(deltaX);
    const absY = Math.abs(deltaY);
    const elapsed = Date.now() - gesture.startedAt;
    if (elapsed > MAX_GESTURE_DURATION_MS) return;

    const horizontalSwipe = absX >= HORIZONTAL_SWIPE_THRESHOLD_PX && absX > absY + SWIPE_AXIS_BIAS_PX;
    if (horizontalSwipe) {
      const fromLeftEdge = gesture.x <= EDGE_SWIPE_ZONE_PX;
      if (!showDrawer && fromLeftEdge && deltaX > 0) {
        setShowDrawer(true);
      }
      return;
    }

    if (mobileView === 'preview' || chatMode) {
      return;
    }

    const verticalSwipe = absY >= VERTICAL_SWIPE_THRESHOLD_PX && absY > absX + SWIPE_AXIS_BIAS_PX;
    if (!verticalSwipe) return;

    if (deltaY > 0 && !keybarOpen) {
      onToggleKeybar?.();
      return;
    }
    if (deltaY < 0 && keybarOpen) {
      onToggleKeybar?.();
    }
  }, [chatMode, keybarOpen, mobileView, onToggleKeybar, showDrawer]);

  const handleTopRowTouchCancel = useCallback(() => {
    topRowGestureRef.current = null;
  }, []);

  useEffect(() => {
    if (mobileView === 'preview' && previewUrl) {
      setPreviewOpened(true);
    }
    if (mobileView === 'terminal') {
      setPreviewOpened(false);
    }
  }, [mobileView, previewUrl]);

  useEffect(() => {
    if (!previewUrl) {
      setPreviewOpened(false);
    }
  }, [previewUrl]);

  const isPreviewView = mobileView === 'preview';
  const overflowItems = [
    !isPreviewView ? {
      label: chatMode ? 'Terminal view' : 'Conversation view',
      icon: chatMode ? (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="4 17 10 11 4 5" />
          <line x1="12" y1="19" x2="20" y2="19" />
        </svg>
      ) : (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
        </svg>
      ),
      active: chatMode,
      onClick: () => onToggleChatMode?.()
    } : null,
    activeVisibleSession && !isPreviewView ? {
      label: 'Rename session',
      icon: (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
        </svg>
      ),
      onClick: () => handleStartRename(activeSessionId)
    } : null,
    activeVisibleSession && !isPreviewView ? {
      label: 'Close session',
      icon: (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <line x1="18" y1="6" x2="6" y2="18" />
          <line x1="6" y1="6" x2="18" y2="18" />
        </svg>
      ),
      danger: true,
      onClick: () => handleCloseFromMenu(activeSessionId)
    } : null,
    { separator: true },
    !isPreviewView && !chatMode && previewUrl ? {
      label: 'Preview',
      icon: (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <rect x="3" y="3" width="18" height="18" rx="2" />
          <line x1="12" y1="3" x2="12" y2="21" />
        </svg>
      ),
      onClick: () => onViewChange?.('preview')
    } : null,
    !isPreviewView && !chatMode ? {
      label: keybarOpen ? 'Hide keyboard bar' : 'Show keyboard bar',
      icon: (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <rect x="2" y="4" width="20" height="16" rx="2" ry="2" />
          <path d="M6 8h.001M10 8h.001M14 8h.001M18 8h.001M8 12h.001M12 12h.001M16 12h.001M6 16h12" />
        </svg>
      ),
      onClick: () => onToggleKeybar?.(),
      active: keybarOpen
    } : null,
    {
      label: theme === 'dark' ? 'Light mode' : 'Dark mode',
      icon: theme === 'dark' ? (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="5" />
          <line x1="12" y1="1" x2="12" y2="3" />
          <line x1="12" y1="21" x2="12" y2="23" />
          <line x1="4.22" y1="4.22" x2="5.64" y2="5.64" />
          <line x1="18.36" y1="18.36" x2="19.78" y2="19.78" />
          <line x1="1" y1="12" x2="3" y2="12" />
          <line x1="21" y1="12" x2="23" y2="12" />
          <line x1="4.22" y1="19.78" x2="5.64" y2="18.36" />
          <line x1="18.36" y1="5.64" x2="19.78" y2="4.22" />
        </svg>
      ) : (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
        </svg>
      ),
      onClick: toggleTheme
    },
    {
      label: 'Process Manager',
      icon: (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <rect x="2" y="3" width="20" height="14" rx="2" ry="2" />
          <line x1="8" y1="21" x2="16" y2="21" />
          <line x1="12" y1="17" x2="12" y2="21" />
        </svg>
      ),
      onClick: onOpenProcessManager
    },
    {
      label: 'File Manager',
      icon: (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
        </svg>
      ),
      active: showFileManager,
      onClick: onToggleFileManager
    }
  ].filter(Boolean);

  return (
    <>
      <header
        ref={headerRef}
        className={`mobile-header${isNavCollapsed ? ' nav-collapsed' : ''}${previewOpened ? ' preview-mode' : ''}`}
      >
        <div
          className="mobile-header-top-row"
          onTouchStart={handleTopRowTouchStart}
          onTouchEnd={handleTopRowTouchEnd}
          onTouchCancel={handleTopRowTouchCancel}
        >
          <button
            className="mobile-header-btn-modern"
            onClick={() => setShowDrawer(true)}
            aria-label="Menu"
            type="button"
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="3" y1="12" x2="21" y2="12" />
              <line x1="3" y1="6" x2="21" y2="6" />
              <line x1="3" y1="18" x2="21" y2="18" />
            </svg>
          </button>

          {isPreviewView ? (
            <div className="mobile-header-title-block">
              <span className="mobile-header-title">Preview</span>
            </div>
          ) : (
            <button
              type="button"
              className={`mobile-header-session-switcher${activeSessionIsBusy ? ' busy' : ''}`}
              onClick={() => setShowSessionPicker(true)}
              aria-label="Open session picker"
            >
              <span className={`mobile-header-session-dot ${activeSessionIsBusy ? 'busy' : 'idle'}`} aria-hidden="true" />
              <span className="mobile-header-session-copy">
                <span className="mobile-header-session-name">
                  {activeVisibleSession ? activeSessionDisplay.primaryLabel : 'No active terminal'}
                </span>
                {activeVisibleSession && activeSessionSubtitle && (
                  <span className="mobile-header-session-subtitle">{activeSessionSubtitle}</span>
                )}
              </span>
              {visibleActiveSessions.length > 1 && (
                <span className="mobile-header-session-count" aria-hidden="true">{visibleActiveSessions.length}</span>
              )}
              <svg className="mobile-header-session-chevron" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <polyline points="9 6 15 12 9 18" />
              </svg>
            </button>
          )}

          <div className="mobile-header-actions-right">
            {!isPreviewView && (
              <button
                type="button"
                className="mobile-header-btn-modern"
                onClick={() => onCreateSession?.()}
                aria-label="New terminal"
                title="New terminal"
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="12" y1="5" x2="12" y2="19" />
                  <line x1="5" y1="12" x2="19" y2="12" />
                </svg>
              </button>
            )}
            {isPreviewView ? (
              <button
                className="mobile-header-btn-modern"
                type="button"
                aria-label="Back to terminal"
                onClick={() => onViewChange?.('terminal')}
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="4 17 10 11 4 5" />
                  <line x1="12" y1="19" x2="20" y2="19" />
                </svg>
              </button>
            ) : (
              <Dropdown
                trigger={(
                  <button className="mobile-header-btn-modern" type="button" aria-label="More actions">
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
                      <circle cx="12" cy="5" r="2" />
                      <circle cx="12" cy="12" r="2" />
                      <circle cx="12" cy="19" r="2" />
                    </svg>
                  </button>
                )}
                items={overflowItems}
                align="right"
              />
            )}
          </div>
        </div>
      </header>

      <MobileDrawer
        isOpen={showDrawer}
        onClose={() => setShowDrawer(false)}
        onCreateSession={onCreateSession}
        onOpenSettings={onOpenSettings}
        onOpenApiSettings={onOpenApiSettings}
        onOpenBrowserSettings={onOpenBrowserSettings}
        onOpenBookmarks={onOpenBookmarks}
        onOpenNotes={onOpenNotes}
        onOpenProcessManager={onOpenProcessManager}
        projects={projects}
        projectsLoading={projectsLoading}
        onFolderSelect={onFolderSelect}
        currentPath={currentPath}
        onAddScanFolder={onAddScanFolder}
        mobileView={mobileView}
        onViewChange={onViewChange}
        previewUrl={previewUrl}
        activeSessions={visibleActiveSessions}
        activeSessionId={activeSessionId}
        sessionActivity={sessionActivity}
        onSelectSession={onSelectSession}
        sessionsGroupedByProject={sessionsGroupedByProject}
      />

      <MobileSessionPicker
        isOpen={showSessionPicker}
        onClose={() => setShowSessionPicker(false)}
        sessions={visibleActiveSessions}
        activeSessionId={activeSessionId}
        sessionActivity={sessionActivity}
        sessionAiTypes={sessionAiTypes}
        onSelectSession={onSelectSession}
      />

      {tabContextMenu && (
        <ContextMenu
          x={tabContextMenu.x}
          y={tabContextMenu.y}
          items={[
            {
              label: 'Rename',
              icon: (
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
                </svg>
              ),
              onClick: () => handleStartRename(tabContextMenu.sessionId)
            },
            { separator: true },
            ...AI_TYPE_OPTIONS.map((option) => ({
              label: option.label,
              icon: (
                <span style={{ display: 'inline-block', width: 10, height: 10, borderRadius: '50%', background: option.color, flexShrink: 0 }} />
              ),
              active: (sessionAiTypes?.[tabContextMenu.sessionId] ?? null) === option.id,
              onClick: () => {
                onSetSessionAiType?.(tabContextMenu.sessionId, option.id);
                setTabContextMenu(null);
              }
            })),
            { separator: true },
            {
              label: 'Close',
              icon: (
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              ),
              onClick: () => handleCloseFromMenu(tabContextMenu.sessionId),
              danger: true
            }
          ]}
          onClose={() => setTabContextMenu(null)}
        />
      )}
    </>
  );
}
