import SidebarSection from './SidebarSection';

export default function Sidebar({
  isCollapsed,
  onToggle,
  recentFolders = [],
  pinnedFolders = [],
  projects = [],
  projectsLoading = false,
  onFolderSelect,
  onPinFolder,
  onUnpinFolder,
  currentPath,
  onAddScanFolder = null,
  sidebarMode,
  onToggleSidebarMode,
  onCreateSession
}) {
  return (
    <aside className={`explorer-sidebar ${isCollapsed ? 'collapsed' : ''}`}>
      {/* Top bar: title + collapse */}
      <div className="es-topbar">
        {!isCollapsed && (
          <div className="es-title">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="4 17 10 11 4 5" />
              <line x1="12" y1="19" x2="20" y2="19" />
            </svg>
            <span>Terminal</span>
          </div>
        )}
        <button
          className="es-collapse-btn"
          onClick={onToggle}
          title={isCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          type="button"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <polyline points={isCollapsed ? '9 18 15 12 9 6' : '15 18 9 12 15 6'} />
          </svg>
        </button>
      </div>

      {/* Toolbar: view toggle + label + new session */}
      {!isCollapsed && (
        <div className="es-toolbar">
          <div className="es-toolbar-left">
            {onToggleSidebarMode ? (
              <div className="es-mode-toggle">
                <button
                  className="es-mode-btn"
                  onClick={onToggleSidebarMode}
                  type="button"
                >Threads</button>
                <button
                  className="es-mode-btn active"
                  type="button"
                >Explorer</button>
              </div>
            ) : (
              <span className="es-toolbar-label">Explorer</span>
            )}
          </div>
          {onCreateSession && (
            <button
              className="es-new-btn"
              onClick={onCreateSession}
              title="New session"
              type="button"
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <line x1="12" y1="5" x2="12" y2="19" />
                <line x1="5" y1="12" x2="19" y2="12" />
              </svg>
            </button>
          )}
        </div>
      )}

      {!isCollapsed && (
        <div className="es-content">
          {pinnedFolders.length > 0 && (
            <SidebarSection
              title="Pinned"
              icon="pin"
              items={pinnedFolders}
              onSelect={onFolderSelect}
              onUnpin={onUnpinFolder}
              pinnedFolders={pinnedFolders}
              currentPath={currentPath}
              showPinAction={true}
              defaultExpanded={true}
            />
          )}

          <SidebarSection
            title="Projects"
            icon="folder-git"
            items={projects}
            onSelect={onFolderSelect}
            onPin={onPinFolder}
            onUnpin={onUnpinFolder}
            pinnedFolders={pinnedFolders}
            currentPath={currentPath}
            loading={projectsLoading}
            showPinAction={true}
            defaultExpanded={true}
            showSearch={true}
            onAddFolder={onAddScanFolder}
          />

          <SidebarSection
            title="Recent"
            icon="clock"
            items={recentFolders.slice(0, 5)}
            onSelect={onFolderSelect}
            onPin={onPinFolder}
            onUnpin={onUnpinFolder}
            pinnedFolders={pinnedFolders}
            currentPath={currentPath}
            showPinAction={true}
            defaultExpanded={true}
          />
        </div>
      )}

      <style jsx>{`
        .explorer-sidebar {
          width: 280px;
          height: 100%;
          background: linear-gradient(180deg, rgba(10, 16, 30, 0.95), rgba(8, 13, 24, 0.95));
          border-right: 1px solid rgba(148, 163, 184, 0.16);
          display: flex;
          flex-direction: column;
          transition: width 0.3s cubic-bezier(0.4, 0, 0.2, 1);
          flex-shrink: 0;
          z-index: 50;
          position: relative;
        }

        .explorer-sidebar::after {
          content: '';
          position: absolute;
          top: 0;
          right: 0;
          bottom: 0;
          width: 1px;
          background: linear-gradient(180deg, rgba(56, 189, 248, 0.6) 0%, rgba(56, 189, 248, 0.2) 35%, transparent 100%);
          opacity: 0.55;
          pointer-events: none;
        }

        .explorer-sidebar.collapsed {
          width: 54px;
        }

        .explorer-sidebar.collapsed::after {
          opacity: 0.2;
        }

        /* ── Top bar ── */
        .es-topbar {
          height: 52px;
          display: flex;
          align-items: center;
          gap: 6px;
          padding: 0 10px;
          border-bottom: 1px solid rgba(148, 163, 184, 0.14);
          box-shadow: 0 1px 0 rgba(255, 255, 255, 0.04);
          flex-shrink: 0;
        }

        .explorer-sidebar.collapsed .es-topbar {
          justify-content: center;
          padding: 0;
        }

        .es-title {
          flex: 1;
          display: flex;
          align-items: center;
          gap: 8px;
          color: #67e8f9;
          font-size: 12px;
          font-weight: 700;
          text-transform: uppercase;
          letter-spacing: 0.09em;
        }

        .es-title svg {
          opacity: 0.8;
        }

        .es-collapse-btn {
          width: 32px;
          height: 32px;
          display: flex;
          align-items: center;
          justify-content: center;
          background: transparent;
          border: none;
          color: var(--text-muted, #71717a);
          border-radius: 9px;
          cursor: pointer;
          transition: all 0.15s ease;
          flex-shrink: 0;
        }

        .es-collapse-btn:hover {
          background: rgba(56, 189, 248, 0.18);
          color: #e2e8f0;
        }

        /* ── Toolbar ── */
        .es-toolbar {
          height: 40px;
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 0 10px 0 12px;
          border-bottom: 1px solid rgba(148, 163, 184, 0.12);
          box-shadow: 0 1px 0 rgba(255, 255, 255, 0.02);
          flex-shrink: 0;
        }

        .es-toolbar-left {
          display: flex;
          align-items: center;
          gap: 6px;
        }

        .es-mode-toggle {
          display: flex;
          background: rgba(30, 41, 59, 0.5);
          border: 1px solid rgba(148, 163, 184, 0.2);
          border-radius: 8px;
          padding: 2px;
          gap: 1px;
        }

        .es-mode-btn {
          height: 24px;
          padding: 0 10px;
          background: transparent;
          border: none;
          color: var(--text-muted, #71717a);
          font-size: 11px;
          font-weight: 600;
          letter-spacing: 0.3px;
          border-radius: 4px;
          cursor: pointer;
          transition: all 0.15s ease;
        }

        .es-mode-btn:hover:not(.active) {
          color: var(--text-primary, #fafafa);
          background: rgba(255, 255, 255, 0.04);
        }

        .es-mode-btn.active {
          background: rgba(34, 211, 238, 0.18);
          color: #67e8f9;
          cursor: default;
        }

        .es-toolbar-label {
          font-size: 10px;
          font-weight: 600;
          color: var(--text-muted, #71717a);
          text-transform: uppercase;
          letter-spacing: 1px;
        }

        .es-new-btn {
          width: 26px;
          height: 26px;
          display: flex;
          align-items: center;
          justify-content: center;
          background: transparent;
          border: none;
          color: var(--text-muted, #71717a);
          border-radius: 8px;
          cursor: pointer;
          transition: all 0.15s ease;
        }

        .es-new-btn:hover {
          background: rgba(34, 211, 238, 0.18);
          color: #e2e8f0;
        }

        /* ── Content area ── */
        .es-content {
          flex: 1;
          overflow-y: auto;
          scrollbar-width: thin;
          scrollbar-color: var(--border-default) transparent;
          padding-top: 6px;
        }

        .es-content::-webkit-scrollbar {
          width: 4px;
        }

        .es-content::-webkit-scrollbar-thumb {
          background: var(--border-default, #2a2a2e);
          border-radius: 2px;
        }
      `}</style>
    </aside>
  );
}
