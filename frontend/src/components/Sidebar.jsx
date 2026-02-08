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
            {onToggleSidebarMode && (
              <button
                className="es-view-toggle"
                onClick={onToggleSidebarMode}
                title="Switch to Threads"
                type="button"
              >
                <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
                  <path d="M1.75 1A1.75 1.75 0 0 0 0 2.75v10.5C0 14.216.784 15 1.75 15h12.5A1.75 1.75 0 0 0 16 13.25v-8.5A1.75 1.75 0 0 0 14.25 3H7.5a.25.25 0 0 1-.2-.1l-.9-1.2C6.07 1.26 5.55 1 5 1H1.75Z" />
                </svg>
              </button>
            )}
            <span className="es-toolbar-label">Explorer</span>
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
          width: 272px;
          height: 100%;
          background: var(--bg-primary, #09090b);
          border-right: 1px solid var(--border-default, #3f3f46);
          display: flex;
          flex-direction: column;
          transition: width 0.3s cubic-bezier(0.4, 0, 0.2, 1);
          flex-shrink: 0;
          z-index: 50;
        }

        .explorer-sidebar.collapsed {
          width: 48px;
        }

        /* ── Top bar ── */
        .es-topbar {
          height: 48px;
          display: flex;
          align-items: center;
          gap: 6px;
          padding: 0 8px;
          border-bottom: 1px solid var(--border-subtle, #27272a);
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
          color: var(--accent-primary, #f59e0b);
          font-size: 13px;
          font-weight: 700;
          text-transform: uppercase;
          letter-spacing: 0.5px;
        }

        .es-title svg {
          opacity: 0.8;
        }

        .es-collapse-btn {
          width: 30px;
          height: 30px;
          display: flex;
          align-items: center;
          justify-content: center;
          background: transparent;
          border: none;
          color: var(--text-muted, #71717a);
          border-radius: 6px;
          cursor: pointer;
          transition: all 0.15s ease;
          flex-shrink: 0;
        }

        .es-collapse-btn:hover {
          background: var(--bg-surface, #18181b);
          color: var(--text-primary, #fafafa);
        }

        /* ── Toolbar ── */
        .es-toolbar {
          height: 34px;
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 0 10px 0 12px;
          border-bottom: 1px solid var(--border-subtle, #27272a);
          flex-shrink: 0;
        }

        .es-toolbar-left {
          display: flex;
          align-items: center;
          gap: 6px;
        }

        .es-view-toggle {
          width: 24px;
          height: 24px;
          display: flex;
          align-items: center;
          justify-content: center;
          background: transparent;
          border: none;
          color: var(--text-muted, #71717a);
          border-radius: 5px;
          cursor: pointer;
          transition: all 0.15s ease;
        }

        .es-view-toggle:hover {
          background: var(--bg-surface, #18181b);
          color: var(--text-primary, #fafafa);
        }

        .es-toolbar-label {
          font-size: 11px;
          font-weight: 700;
          color: var(--text-muted, #71717a);
          text-transform: uppercase;
          letter-spacing: 0.5px;
        }

        .es-new-btn {
          width: 24px;
          height: 24px;
          display: flex;
          align-items: center;
          justify-content: center;
          background: transparent;
          border: none;
          color: var(--text-muted, #71717a);
          border-radius: 5px;
          cursor: pointer;
          transition: all 0.15s ease;
        }

        .es-new-btn:hover {
          background: var(--bg-surface, #18181b);
          color: var(--text-primary, #fafafa);
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
          background: var(--border-default, #3f3f46);
          border-radius: 2px;
        }
      `}</style>
    </aside>
  );
}
