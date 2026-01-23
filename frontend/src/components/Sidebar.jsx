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
  onAddScanFolder = null
}) {
  return (
    <aside className={`sidebar-modern ${isCollapsed ? 'collapsed' : ''}`}>
      <div className="sidebar-header-modern">
        {!isCollapsed && <h1 className="sidebar-title-modern">Explorer</h1>}
        <button
          className="sidebar-toggle-btn"
          onClick={onToggle}
          title={isCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          type="button"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            {isCollapsed ? (
              <>
                <polyline points="9 18 15 12 9 6" />
                <line x1="3" y1="12" x2="3" y2="12" />
              </>
            ) : (
              <>
                <polyline points="15 18 9 12 15 6" />
                <line x1="21" y1="12" x2="21" y2="12" />
              </>
            )}
          </svg>
        </button>
      </div>

      {!isCollapsed && (
        <div className="sidebar-content-modern">
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
        .sidebar-modern {
          width: 260px;
          height: 100%;
          background: var(--bg-primary, #09090b);
          border-right: 1px solid var(--border-default, #3f3f46);
          display: flex;
          flex-direction: column;
          transition: width 0.3s cubic-bezier(0.4, 0, 0.2, 1);
          flex-shrink: 0;
          z-index: 50;
        }

        .sidebar-modern.collapsed {
          width: 48px;
        }

        .sidebar-header-modern {
          height: 48px;
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 0 12px;
          border-bottom: 1px solid var(--border-subtle, #27272a);
          flex-shrink: 0;
        }

        .sidebar-title-modern {
          font-size: 11px;
          font-weight: 700;
          color: var(--text-muted, #71717a);
          text-transform: uppercase;
          letter-spacing: 1px;
          margin: 0;
        }

        .sidebar-toggle-btn {
          width: 28px;
          height: 28px;
          display: flex;
          align-items: center;
          justify-content: center;
          background: transparent;
          border: none;
          color: var(--text-muted, #71717a);
          border-radius: 6px;
          cursor: pointer;
          transition: all 0.2s ease;
        }

        .sidebar-toggle-btn:hover {
          background: var(--bg-surface, #18181b);
          color: var(--text-primary, #fafafa);
        }

        .sidebar-content-modern {
          flex: 1;
          overflow-y: auto;
          scrollbar-width: thin;
          scrollbar-color: var(--border-default) transparent;
        }

        .sidebar-content-modern::-webkit-scrollbar {
          width: 4px;
        }

        .sidebar-content-modern::-webkit-scrollbar-thumb {
          background: var(--border-default, #3f3f46);
          border-radius: 2px;
        }
      `}</style>
    </aside>
  );
}
