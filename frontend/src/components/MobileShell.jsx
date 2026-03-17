import { Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Dropdown } from './Dropdown';
import { MobileDrawer } from './MobileDrawer';
import { MobileKeybar } from './MobileKeybar';
import { MobileSessionPicker } from './MobileSessionPicker';
import { MobileTerminalSurface } from './MobileTerminalSurface';
import { useTheme } from '../contexts/ThemeContext';
import { getCompactSessionSubtitle, getSessionDisplayInfo } from '../utils/sessionDisplay';

const MOBILE_SURFACE_STORAGE_KEY = 'mobileShellSurfaceV1';

function clampSurface(nextSurface, previewUrl) {
  if (nextSurface === 'preview') {
    return previewUrl ? 'preview' : 'terminal';
  }
  return 'terminal';
}

function MenuIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="3" y1="12" x2="21" y2="12" />
      <line x1="3" y1="6" x2="21" y2="6" />
      <line x1="3" y1="18" x2="21" y2="18" />
    </svg>
  );
}

function PlusIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <line x1="12" y1="5" x2="12" y2="19" />
      <line x1="5" y1="12" x2="19" y2="12" />
    </svg>
  );
}

function KeyboardIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="4" width="20" height="16" rx="2" ry="2" />
      <path d="M6 8h.001M10 8h.001M14 8h.001M18 8h.001M8 12h.001M12 12h.001M16 12h.001M6 16h12" />
    </svg>
  );
}

function MoreIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
      <circle cx="12" cy="5" r="2" />
      <circle cx="12" cy="12" r="2" />
      <circle cx="12" cy="19" r="2" />
    </svg>
  );
}

export function MobileShell({
  activeSessions,
  activeSessionId,
  sessionActivity,
  sessionAiTypes,
  customAiProviders,
  projects,
  projectsLoading,
  currentPath,
  sessionsGroupedByProject,
  previewUrl,
  projectInfo,
  showFileManager,
  showStatusLabels,
  fontSize,
  webglEnabled,
  viewportHeight,
  onSelectSession,
  onCreateSession,
  onRenameSession,
  onCloseSession,
  onSetSessionAiType,
  onAddCustomAiProvider,
  onFolderSelect,
  onAddScanFolder,
  onOpenSettings,
  onOpenApiSettings,
  onOpenBrowserSettings,
  onOpenBookmarks,
  onOpenNotes,
  onOpenProcessManager,
  onToggleFileManager,
  onPreviewUrlChange,
  onStartProject,
  onSendToTerminal,
  onSendToClaudeCode,
  onUrlDetected,
  onSessionBusyChange,
  PreviewPanelComponent,
}) {
  const { theme, toggleTheme } = useTheme();
  const headerRef = useRef(null);
  const focusTerminalRef = useRef(null);
  const [showDrawer, setShowDrawer] = useState(false);
  const [showSessionPicker, setShowSessionPicker] = useState(false);
  const [keybarOpen, setKeybarOpen] = useState(false);
  const [keybarHeight, setKeybarHeight] = useState(0);

  const activeSession = useMemo(
    () => activeSessions.find((session) => session.id === activeSessionId) || activeSessions[0] || null,
    [activeSessionId, activeSessions]
  );
  const [activeSurface, setActiveSurface] = useState(() => {
    try {
      const stored = localStorage.getItem(MOBILE_SURFACE_STORAGE_KEY);
      return clampSurface(stored || 'terminal', previewUrl);
    } catch {
      return 'terminal';
    }
  });

  const activeSessionDisplay = getSessionDisplayInfo(activeSession, 'No active terminal');
  const activeSessionSubtitle = getCompactSessionSubtitle(activeSession, 'No active terminal');
  const activeActivity = activeSession ? sessionActivity?.[activeSession.id] : null;
  const activeSessionIsBusy = typeof activeActivity?.isBusy === 'boolean'
    ? activeActivity.isBusy
    : Boolean(activeSession?.isBusy);

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
      if (!headerRef.current) return;
      const height = Math.round(headerRef.current.getBoundingClientRect().height || headerRef.current.offsetHeight || 0);
      document.documentElement.style.setProperty('--mobile-header-height', `${height}px`);
    };

    updateHeight();
    const observer = new ResizeObserver(updateHeight);
    observer.observe(headerRef.current);

    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const normalizedSurface = clampSurface(activeSurface, previewUrl);
    if (normalizedSurface !== activeSurface) {
      setActiveSurface(normalizedSurface);
    }
  }, [activeSurface, previewUrl]);

  useEffect(() => {
    try {
      localStorage.setItem(MOBILE_SURFACE_STORAGE_KEY, activeSurface);
    } catch {
      // Ignore storage failures.
    }
  }, [activeSurface]);

  useEffect(() => {
    if (activeSurface === 'terminal') return;
    setKeybarOpen(false);
  }, [activeSurface]);

  const handleRegisterFocusTerminal = useCallback((focusFn) => {
    focusTerminalRef.current = focusFn;
  }, []);

  const handleSetSurface = useCallback((nextSurface) => {
    setActiveSurface(clampSurface(nextSurface, previewUrl));
  }, [previewUrl]);

  const handleToggleKeybar = useCallback(() => {
    if (activeSurface !== 'terminal') return;
    setKeybarOpen((current) => {
      const next = !current;
      if (next) {
        focusTerminalRef.current?.();
      }
      return next;
    });
  }, [activeSurface]);

  const handleRenameActiveSession = useCallback(() => {
    if (!activeSession) return;
    const nextName = window.prompt('Rename terminal', activeSessionDisplay.primaryLabel);
    if (typeof nextName !== 'string') {
      return;
    }
    const trimmed = nextName.trim();
    if (trimmed) {
      onRenameSession?.(activeSession.id, trimmed);
    }
  }, [activeSession, activeSessionDisplay.primaryLabel, onRenameSession]);

  const overflowItems = [
    activeSession ? {
      label: 'Rename session',
      onClick: handleRenameActiveSession,
    } : null,
    activeSession ? {
      label: 'Close session',
      danger: true,
      onClick: () => onCloseSession?.(activeSession.id),
    } : null,
    activeSession ? { separator: true } : null,
    {
      label: showFileManager ? 'Hide file manager' : 'File manager',
      active: showFileManager,
      onClick: () => onToggleFileManager?.(),
    },
    {
      label: 'Bookmarks',
      onClick: () => onOpenBookmarks?.(),
    },
    {
      label: 'Notes',
      onClick: () => onOpenNotes?.(),
    },
    {
      label: 'Process manager',
      onClick: () => onOpenProcessManager?.(),
    },
    {
      label: theme === 'dark' ? 'Light mode' : 'Dark mode',
      onClick: toggleTheme,
    },
    {
      label: 'Settings',
      onClick: () => onOpenSettings?.(),
    },
  ].filter(Boolean);

  const mobileView = activeSurface === 'preview' ? 'preview' : 'terminal';
  const mobileKeybarOffset = activeSurface === 'terminal' && keybarOpen ? keybarHeight : 0;

  return (
    <>
      <header ref={headerRef} className="mobile-shell-header">
        <div className="mobile-shell-top-row">
          <button
            className="mobile-header-btn-modern"
            onClick={() => setShowDrawer(true)}
            aria-label="Menu"
            type="button"
          >
            <MenuIcon />
          </button>

          <button
            type="button"
            className={`mobile-header-session-switcher${activeSessionIsBusy ? ' busy' : ''}`}
            onClick={() => setShowSessionPicker(true)}
            aria-label="Open session picker"
          >
            <span className={`mobile-header-session-dot ${activeSessionIsBusy ? 'busy' : 'idle'}`} aria-hidden="true" />
            <span className="mobile-header-session-copy">
              <span className="mobile-header-session-name">{activeSessionDisplay.primaryLabel}</span>
              {activeSessionSubtitle && (
                <span className="mobile-header-session-subtitle">{activeSessionSubtitle}</span>
              )}
            </span>
            {activeSessions.length > 1 && (
              <span className="mobile-header-session-count" aria-hidden="true">{activeSessions.length}</span>
            )}
          </button>

          <div className="mobile-header-actions-right">
            {activeSurface === 'terminal' && (
              <button
                type="button"
                className={`mobile-header-btn-modern${keybarOpen ? ' active' : ''}`}
                onClick={handleToggleKeybar}
                aria-label={keybarOpen ? 'Hide keyboard bar' : 'Show keyboard bar'}
                title={keybarOpen ? 'Hide keyboard bar' : 'Show keyboard bar'}
              >
                <KeyboardIcon />
              </button>
            )}
            <button
              type="button"
              className="mobile-header-btn-modern"
              onClick={() => onCreateSession?.()}
              aria-label="New terminal"
              title="New terminal"
            >
              <PlusIcon />
            </button>
            <Dropdown
              trigger={(
                <button className="mobile-header-btn-modern" type="button" aria-label="More actions">
                  <MoreIcon />
                </button>
              )}
              items={overflowItems}
              align="right"
            />
          </div>
        </div>

      </header>

      <MobileKeybar
        sessionId={activeSession?.id || null}
        isOpen={activeSurface === 'terminal' ? keybarOpen : false}
        onHeightChange={(height) => setKeybarHeight(Math.max(0, Math.round(height)))}
      />

      <div className="main-pane mobile-shell-pane">
        <main
          className="terminal-main mobile-shell-main"
          style={{ '--mobile-keybar-offset': `${mobileKeybarOffset}px` }}
        >
          {activeSurface === 'terminal' && (
            <div className="terminal-pane">
              <MobileTerminalSurface
                session={activeSession}
                keybarOpen={keybarOpen}
                viewportHeight={viewportHeight}
                onUrlDetected={onUrlDetected}
                fontSize={fontSize}
                webglEnabled={webglEnabled}
                onRegisterFocusTerminal={handleRegisterFocusTerminal}
                onSessionBusyChange={onSessionBusyChange}
                sessionAiTypes={sessionAiTypes}
                customAiProviders={customAiProviders}
                onSetSessionAiType={onSetSessionAiType}
                onAddCustomAiProvider={onAddCustomAiProvider}
              />
            </div>
          )}

          {activeSurface === 'preview' && PreviewPanelComponent && (
            <Suspense fallback={<div className="empty-state"><p>Loading preview...</p></div>}>
              <PreviewPanelComponent
                url={previewUrl}
                onClose={() => handleSetSurface('terminal')}
                onUrlChange={onPreviewUrlChange}
                projectInfo={projectInfo}
                onStartProject={onStartProject}
                onSendToTerminal={onSendToTerminal}
                onSendToClaudeCode={onSendToClaudeCode}
                activeSessions={activeSessions}
                activeSessionId={activeSessionId}
                sessionActivity={sessionActivity}
                onSessionBusyChange={onSessionBusyChange}
                fontSize={fontSize}
                webglEnabled={webglEnabled}
                onUrlDetected={onPreviewUrlChange || onUrlDetected}
                showStatusLabels={showStatusLabels}
                mobileShellMode="integrated"
              />
            </Suspense>
          )}
        </main>
      </div>

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
        onViewChange={handleSetSurface}
        previewUrl={previewUrl}
        activeSessions={activeSessions}
        activeSessionId={activeSessionId}
        sessionActivity={sessionActivity}
        onSelectSession={onSelectSession}
        sessionsGroupedByProject={sessionsGroupedByProject}
      />

      <MobileSessionPicker
        isOpen={showSessionPicker}
        onClose={() => setShowSessionPicker(false)}
        sessions={activeSessions}
        activeSessionId={activeSessionId}
        sessionActivity={sessionActivity}
        sessionAiTypes={sessionAiTypes}
        onSelectSession={onSelectSession}
      />
    </>
  );
}
