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
    <aside className={`sidebar ${isCollapsed ? 'collapsed' : ''}`}>
      <div className="sidebar-header">
        {!isCollapsed && <h1 className="sidebar-title">Explorer</h1>}
        <button
          className="sidebar-collapse-btn"
          onClick={onToggle}
          title={isCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          type="button"
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
            {isCollapsed ? (
              <path d="M6.22 3.22a.75.75 0 0 1 1.06 0l4.25 4.25a.75.75 0 0 1 0 1.06l-4.25 4.25a.751.751 0 0 1-1.042-.018.751.751 0 0 1-.018-1.042L9.94 8 6.22 4.28a.75.75 0 0 1 0-1.06Z" />
            ) : (
              <path d="M9.78 12.78a.75.75 0 0 1-1.06 0L4.47 8.53a.75.75 0 0 1 0-1.06l4.25-4.25a.751.751 0 0 1 1.042.018.751.751 0 0 1 .018 1.042L6.06 8l3.72 3.72a.75.75 0 0 1 0 1.06Z" />
            )}
          </svg>
        </button>
      </div>

      {!isCollapsed && (
        <div className="sidebar-content">
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
        </div>
      )}
    </aside>
  );
}
