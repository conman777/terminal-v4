import { useMemo, useState } from 'react';

function isFrontendPort(port, previewPort) {
  if (!port?.listening) return false;
  if (port.port === previewPort) return true;
  if (port.frontendLikely === true || port.previewable === true) return true;
  return port.probeStatus === 'html' || port.probeStatus === 'redirect';
}

function isGenericRuntimeProcess(processName) {
  if (!processName || typeof processName !== 'string') return true;
  const normalized = processName.trim().toLowerCase();
  return (
    normalized === 'node' ||
    normalized === 'npm' ||
    normalized === 'pnpm' ||
    normalized === 'yarn' ||
    normalized === 'bun' ||
    normalized === 'python' ||
    normalized === 'python3' ||
    normalized === 'deno'
  );
}

function getAppKey(portInfo) {
  if (portInfo?.cwd) {
    return `cwd:${String(portInfo.cwd).toLowerCase()}`;
  }
  if (portInfo?.process && !isGenericRuntimeProcess(portInfo.process)) {
    return `proc:${String(portInfo.process).toLowerCase()}`;
  }
  return `port:${portInfo?.port}`;
}

function rankPortForSelection(portInfo, previewPort) {
  let score = 0;
  if (portInfo?.port === previewPort) score -= 1000;
  if (portInfo?.frontendLikely === true || portInfo?.previewable === true) score -= 200;
  if (portInfo?.reachable === true) score -= 120;
  if (portInfo?.previewed) score -= 60;
  if (portInfo?.common) score -= 30;
  if (portInfo?.probeStatus === 'excluded-process') score += 40;
  if (portInfo?.probeStatus === 'timeout') score += 20;
  return score;
}

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

  const selectablePorts = useMemo(() => {
    const frontendPorts = activePorts.filter((port) => isFrontendPort(port, previewPort));
    const bestByApp = new Map();
    for (const portInfo of frontendPorts) {
      const key = getAppKey(portInfo);
      const existing = bestByApp.get(key);
      if (!existing) {
        bestByApp.set(key, portInfo);
        continue;
      }
      const currentRank = rankPortForSelection(portInfo, previewPort);
      const existingRank = rankPortForSelection(existing, previewPort);
      if (currentRank < existingRank || (currentRank === existingRank && portInfo.port < existing.port)) {
        bestByApp.set(key, portInfo);
      }
    }
    return Array.from(bestByApp.values());
  }, [activePorts, previewPort]);

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
    return selectablePorts
      .filter(matches)
      .sort((a, b) => {
        const scoreDelta = rankPortForSelection(a, previewPort) - rankPortForSelection(b, previewPort);
        if (scoreDelta !== 0) return scoreDelta;
        if (a.port === previewPort && b.port !== previewPort) return -1;
        if (b.port === previewPort && a.port !== previewPort) return 1;
        return a.port - b.port;
      });
  }, [selectablePorts, portSearch, previewPort]);

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
          {selectablePorts.length > 0 && (
            <span className="preview-port-badge">{selectablePorts.length}</span>
          )}
        </button>
        {showPortDropdown && (
          <div className="preview-port-dropdown">
            <div className="preview-port-dropdown-header">
              <span>Active Ports</span>
              <span className="preview-port-dropdown-count">{selectablePorts.length}</span>
            </div>
            {selectablePorts.length > 0 && (
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
              <div className="preview-port-dropdown-empty">No frontend ports found</div>
            ) : (
              <div className="preview-port-dropdown-list">
                {visiblePorts.map(({ port, process, cwd, frontendLikely, reachable, probeStatus }) => {
                  const cwdLabel = typeof cwd === 'string' && cwd.length > 0
                    ? cwd.split('/').filter(Boolean).slice(-2).join('/')
                    : '';
                  const hasMeta = Boolean(process || cwdLabel);
                  const statusLabel = frontendLikely || probeStatus === 'html' || probeStatus === 'redirect'
                    ? 'Frontend'
                    : (reachable ? 'Reachable' : (probeStatus === 'excluded-process' ? 'Excluded' : 'Unknown'));
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
                        <span className="preview-port-listening-badge">
                          {port === previewPort ? 'Current' : statusLabel}
                        </span>
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
