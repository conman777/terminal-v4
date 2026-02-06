import { useMemo, useState } from 'react';

function Tooltip({ children, text, shortcut }) {
  const [show, setShow] = useState(false);

  return (
    <div
      className="tooltip-wrapper"
      onMouseEnter={() => setShow(true)}
      onMouseLeave={() => setShow(false)}
    >
      {children}
      {show && (
        <div className="tooltip">
          <span className="tooltip-text">{text}</span>
          {shortcut && <span className="tooltip-shortcut">{shortcut}</span>}
        </div>
      )}
    </div>
  );
}

export function PreviewUrlBar({
  inputUrl,
  onInputUrlChange,
  activePorts,
  previewPort,
  showPortDropdown,
  onTogglePortDropdown,
  portDropdownRef,
  onSelectPort,
  onUrlSubmit,
  onBack,
  onForward,
  onRefresh,
  historyIndex,
  historyStackLength,
  isLoading,
  iframeSrc,
  desktopLayoutMode,
  onSetDesktopLayout,
  useWebContainer,
  showDevTools,
  onToggleDevTools,
  logCount,
  showToolsMenu,
  onToggleToolsMenu,
  toolsMenuRef,
  inspectMode,
  onToggleInspect,
  webContainerSupported,
  onToggleWebContainer,
  onOpenExternal,
  hasCookies,
  onClearCookies,
  mainTerminalMinimized,
  onToggleMainTerminal,
  onClose,
}) {
  const [portSearch, setPortSearch] = useState('');

  const listeningPorts = useMemo(
    () => activePorts.filter((port) => port.listening),
    [activePorts]
  );

  const visiblePorts = useMemo(() => {
    const query = portSearch.trim().toLowerCase();
    const matches = (item) => {
      if (!query) return true;
      const process = (item.process || '').toLowerCase();
      const cwd = (item.cwd || '').toLowerCase();
      return (
        String(item.port).includes(query) ||
        process.includes(query) ||
        cwd.includes(query)
      );
    };
    return listeningPorts
      .filter(matches)
      .sort((a, b) => {
        if (a.port === previewPort && b.port !== previewPort) return -1;
        if (b.port === previewPort && a.port !== previewPort) return 1;
        return a.port - b.port;
      });
  }, [listeningPorts, portSearch, previewPort]);

  return (
    <div className="preview-header">
      {/* Port selector */}
      <div className="preview-port-selector" ref={portDropdownRef}>
        <button
          type="button"
          className={`preview-port-btn ${showPortDropdown ? 'active' : ''}`}
          onClick={onTogglePortDropdown}
          title="Select active port"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="2" y="3" width="20" height="14" rx="2" />
            <path d="M8 21h8" />
            <path d="M12 17v4" />
          </svg>
          {listeningPorts.length > 0 && (
            <span className="preview-port-badge">{listeningPorts.length}</span>
          )}
        </button>
        {showPortDropdown && (
          <div className="preview-port-dropdown">
            <div className="preview-port-dropdown-header">
              <span>Active Ports</span>
              <span className="preview-port-dropdown-count">{listeningPorts.length}</span>
            </div>
            {listeningPorts.length > 0 && (
              <div className="preview-port-dropdown-toolbar">
                <input
                  type="text"
                  className="preview-port-search"
                  placeholder="Find by port, process, folder..."
                  value={portSearch}
                  onChange={(event) => setPortSearch(event.target.value)}
                  aria-label="Filter active ports"
                />
              </div>
            )}
            {visiblePorts.length === 0 ? (
              <div className="preview-port-dropdown-empty">No active ports found</div>
            ) : (
              <div className="preview-port-dropdown-list">
                {visiblePorts.map(({ port, process, cwd }) => {
                  const cwdLabel = typeof cwd === 'string' && cwd.length > 0
                    ? cwd.split('/').filter(Boolean).slice(-2).join('/')
                    : '';
                  const hasMeta = Boolean(process || cwdLabel);
                  return (
                  <button
                    key={port}
                    type="button"
                    className={`preview-port-item ${port === previewPort ? 'current' : ''}${hasMeta ? '' : ' no-meta'}`}
                    onClick={() => onSelectPort(port)}
                  >
                    <div className="preview-port-info">
                      <div className="preview-port-header">
                        <span className="preview-port-pill">
                          <span className="preview-port-status-dot" />
                          :{port}
                        </span>
                        <span className="preview-port-listening-badge">{port === previewPort ? 'Current' : 'Active'}</span>
                      </div>
                      {hasMeta && (
                        <div className="preview-port-details">
                          {process && (
                            <span className="preview-port-meta-chip preview-port-command" title={process}>
                              {process.replace(/^next-server/i, 'next')}
                            </span>
                          )}
                          {cwdLabel && (
                            <span className="preview-port-meta-chip preview-port-cwd" title={cwd}>
                              {cwdLabel}
                            </span>
                          )}
                        </div>
                      )}
                    </div>
                  </button>
                );
                })}
              </div>
            )}
          </div>
        )}
      </div>

      {/* URL bar */}
      <form className="preview-url-form" onSubmit={onUrlSubmit}>
        <input
          type="text"
          className="preview-url-input"
          value={inputUrl}
          onChange={(e) => onInputUrlChange(e.target.value)}
          placeholder="localhost:3000"
          aria-label="Preview URL"
        />
      </form>

      {/* Navigation buttons */}
      <div className="preview-nav-group">
        <Tooltip text="Go back">
          <button
            type="button"
            className="preview-action-btn"
            onClick={onBack}
            disabled={historyIndex <= 0}
            aria-label="Go back"
          >
            {'\u2190'}
          </button>
        </Tooltip>
        <Tooltip text="Go forward">
          <button
            type="button"
            className="preview-action-btn"
            onClick={onForward}
            disabled={historyIndex >= historyStackLength - 1}
            aria-label="Go forward"
          >
            {'\u2192'}
          </button>
        </Tooltip>
        <Tooltip text="Reload" shortcut={'\u2318R'}>
          <button
            type="button"
            className="preview-action-btn"
            onClick={onRefresh}
            disabled={!iframeSrc}
            aria-label="Reload preview"
          >
            {isLoading ? '\u22EF' : '\u21BB'}
          </button>
        </Tooltip>
      </div>

      {/* Layout presets */}
      <div className="preview-layout-presets" aria-label="Preview layout presets">
        <button
          type="button"
          className={`preview-layout-chip ${desktopLayoutMode === 'preview' ? 'active' : ''}`}
          onClick={() => onSetDesktopLayout?.('preview')}
          title="Preview only"
        >
          Preview
        </button>
        <button
          type="button"
          className={`preview-layout-chip ${desktopLayoutMode === 'split' ? 'active' : ''}`}
          onClick={() => onSetDesktopLayout?.('split')}
          title="Preview + terminal"
        >
          Split
        </button>
        <button
          type="button"
          className={`preview-layout-chip ${desktopLayoutMode === 'debug' ? 'active' : ''}`}
          onClick={() => onSetDesktopLayout?.('debug')}
          title="Preview + terminal + DevTools"
        >
          Debug
          {logCount > 0 && <span className="preview-log-badge-sm">{logCount}</span>}
        </button>
      </div>

      {/* Tools overflow menu */}
      <div className="preview-tools-menu-wrap" ref={toolsMenuRef}>
        <button
          type="button"
          className={`preview-action-btn ${showToolsMenu ? 'active' : ''}`}
          onClick={onToggleToolsMenu}
          aria-label="More browser tools"
          title="More browser tools"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="1.5" />
            <circle cx="6" cy="12" r="1.5" />
            <circle cx="18" cy="12" r="1.5" />
          </svg>
        </button>
        {showToolsMenu && (
          <div className="preview-tools-menu">
            <button
              type="button"
              className={`preview-tools-menu-item ${inspectMode ? 'active' : ''}`}
              onClick={() => {
                onToggleInspect();
                onToggleToolsMenu();
              }}
              disabled={!iframeSrc}
            >
              {inspectMode ? 'Exit Inspect' : 'Inspect Element'}
            </button>
            <button
              type="button"
              className={`preview-tools-menu-item ${useWebContainer ? 'active' : ''}`}
              onClick={() => {
                onToggleWebContainer();
                onToggleToolsMenu();
              }}
              disabled={!webContainerSupported?.supported && !useWebContainer}
              title={!webContainerSupported?.supported ? webContainerSupported?.reason : undefined}
            >
              {useWebContainer ? 'Use Proxy Mode' : 'Use WebContainer'}
            </button>
            <button
              type="button"
              className="preview-tools-menu-item"
              onClick={() => {
                onOpenExternal();
                onToggleToolsMenu();
              }}
              disabled={!iframeSrc}
            >
              Open in New Tab
            </button>
            {previewPort && (
              <button
                type="button"
                className={`preview-tools-menu-item ${hasCookies ? 'has-cookies' : ''}`}
                onClick={() => {
                  onClearCookies();
                  onToggleToolsMenu();
                }}
                disabled={!hasCookies}
              >
                {hasCookies ? 'Clear Cookies' : 'No Cookies'}
              </button>
            )}
            {onToggleMainTerminal && (
              <button
                type="button"
                className={`preview-tools-menu-item ${mainTerminalMinimized ? 'active' : ''}`}
                onClick={() => {
                  onToggleMainTerminal();
                  onToggleToolsMenu();
                }}
              >
                {mainTerminalMinimized ? 'Show Main Terminal' : 'Maximize Browser'}
              </button>
            )}
          </div>
        )}
      </div>

      {/* Close */}
      <button
        type="button"
        className="preview-action-btn preview-close-btn"
        onClick={onClose}
        title="Close browser"
        aria-label="Close browser"
      >
        {'\u00D7'}
      </button>
    </div>
  );
}
