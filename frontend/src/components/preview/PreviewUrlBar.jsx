import { useState } from 'react';

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
  browserSplitEnabled,
  onToggleTerminalSplit,
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
  return (
    <div className="preview-header">
      <div className="preview-title">
        <span className="preview-icon">{'\u2699'}</span>
        <span>Browser</span>
      </div>
      {/* Port selector dropdown */}
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
          {activePorts.filter(p => p.listening).length > 0 && (
            <span className="preview-port-badge">{activePorts.filter(p => p.listening).length}</span>
          )}
        </button>
        {showPortDropdown && (
          <div className="preview-port-dropdown">
            <div className="preview-port-dropdown-header">Active Ports</div>
            {activePorts.filter(p => p.listening).length === 0 ? (
              <div className="preview-port-dropdown-empty">No active ports found</div>
            ) : (
              <div className="preview-port-dropdown-list">
                {activePorts.filter(p => p.listening).map(({ port, process, cwd }) => (
                  <button
                    key={port}
                    type="button"
                    className={`preview-port-item ${port === previewPort ? 'current' : ''}`}
                    onClick={() => onSelectPort(port)}
                  >
                    <div className="preview-port-info">
                      <div className="preview-port-header">
                        <span className="preview-port-badge">
                          <span className="preview-port-status-dot" />
                          {port}
                        </span>
                        <span className="preview-port-listening-badge">Active</span>
                      </div>
                      {(process || cwd) && (
                        <div className="preview-port-details">
                          {process && (
                            <span className="preview-port-command" title={process}>
                              {process}
                            </span>
                          )}
                          {cwd && (
                            <span className="preview-port-cwd" title={cwd}>
                              {cwd.split('/').slice(-2).join('/')}
                            </span>
                          )}
                        </div>
                      )}
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
      <form className="preview-url-form" onSubmit={onUrlSubmit}>
        <input
          type="text"
          className="preview-url-input"
          value={inputUrl}
          onChange={(e) => onInputUrlChange(e.target.value)}
          placeholder="http://localhost:3000 or C:\path\to\index.html"
          aria-label="Preview URL"
        />
      </form>
      <div className="preview-actions">
        {/* Simple back/forward/reload buttons */}
        <Tooltip text="Go back">
          <button
            type="button"
            className="preview-action-btn"
            onClick={onBack}
            disabled={historyIndex <= 0}
            aria-label="Go back"
          >
            ←
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
            →
          </button>
        </Tooltip>
        <Tooltip text="Reload" shortcut="⌘R">
          <button
            type="button"
            className="preview-action-btn"
            onClick={onRefresh}
            disabled={!iframeSrc}
            aria-label="Reload preview"
          >
            {isLoading ? '⋯' : '↻'}
          </button>
        </Tooltip>

        <Tooltip text={browserSplitEnabled ? 'Hide Terminal' : 'Show Terminal'} shortcut="⌘K">
          <button
            type="button"
            className={`preview-action-btn with-label ${browserSplitEnabled ? 'active' : ''}`}
            onClick={onToggleTerminalSplit}
            disabled={!iframeSrc && !useWebContainer}
            aria-label="Toggle terminal split"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <rect x="3" y="3" width="7" height="18" rx="1" />
              <rect x="14" y="3" width="7" height="18" rx="1" />
            </svg>
            <span className="preview-action-label">Split</span>
          </button>
        </Tooltip>
        <Tooltip text={showDevTools ? 'Hide DevTools' : 'Show DevTools'} shortcut="⌘⇧D">
          <button
            type="button"
            className={`preview-action-btn with-label ${showDevTools ? 'active' : ''}`}
            onClick={onToggleDevTools}
            disabled={!iframeSrc}
            aria-label="Toggle DevTools"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="4 17 10 11 4 5" />
              <line x1="12" y1="19" x2="20" y2="19" />
            </svg>
            <span className="preview-action-label">DevTools</span>
            {logCount > 0 && <span className="preview-log-badge-sm">{logCount}</span>}
          </button>
        </Tooltip>
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
    </div>
  );
}
