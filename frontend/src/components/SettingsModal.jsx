import { useState, useRef, useEffect } from 'react';
import { FolderBrowserModal } from './FolderBrowserModal';
import { getAccessToken } from '../utils/auth';
import { getTerminalRendererGuardReason, resolveTerminalWebglEnabled } from '../utils/terminalRendererPolicy';

export function SettingsModal({
  isOpen,
  onClose,
  sessionId,
  sessionTitle,
  currentCwd,
  recentFolders,
  onSave,
  onAddRecentFolder,
  terminalFontSize,
  onFontSizeChange,
  terminalWebglEnabled,
  onWebglChange,
  desktopAllowTerminalInput,
  onDesktopTerminalInputChange,
  onOpenApiSettings,
  onOpenProcessManager,
  showTabStatusLabels,
  onTabStatusLabelsChange
}) {
  const [workingDir, setWorkingDir] = useState(currentCwd || '');
  const [showDropdown, setShowDropdown] = useState(false);
  const [showFolderBrowser, setShowFolderBrowser] = useState(false);
  const resolvedWebglEnabled = resolveTerminalWebglEnabled(terminalWebglEnabled);
  const webglGuardReason = getTerminalRendererGuardReason();
  const webglLocked = Boolean(webglGuardReason);
  const resolvedDesktopAllowTerminalInput = desktopAllowTerminalInput === true;
  const resolvedShowTabStatusLabels = showTabStatusLabels !== false;
  const dropdownRef = useRef(null);
  const normalizedWorkingDir = workingDir.trim();
  const normalizedCurrentCwd = typeof currentCwd === 'string' ? currentCwd.trim() : '';
  const shouldNavigateOnSave = Boolean(normalizedWorkingDir) && normalizedWorkingDir !== normalizedCurrentCwd;

  useEffect(() => {
    if (isOpen) {
      setWorkingDir(currentCwd || '');
    }
  }, [isOpen, currentCwd]);

  useEffect(() => {
    const handleClickOutside = (event) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target)) {
        setShowDropdown(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const handleSave = () => {
    if (shouldNavigateOnSave) {
      onAddRecentFolder(normalizedWorkingDir);
      onSave(sessionId, normalizedWorkingDir);
    }
    onClose();
  };

  const handleDownload = () => {
    const pathToDownload = workingDir || currentCwd;
    if (!pathToDownload) return;
    const params = new URLSearchParams({ path: pathToDownload });
    const token = getAccessToken();
    if (token) {
      params.set('token', token);
    }
    window.location.href = `/api/fs/download?${params.toString()}`;
  };

  const handleSelectFolder = (folder) => {
    setWorkingDir(folder);
    setShowDropdown(false);
  };

  const handleClear = () => {
    setWorkingDir('');
  };

  if (!isOpen) return null;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content session-settings-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header session-settings-header">
          <div className="session-settings-title-wrap">
            <div className="session-settings-icon-shell" aria-hidden="true">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
                <circle cx="12" cy="12" r="3" />
              </svg>
            </div>
            <div className="session-settings-title-copy">
              <span className="session-settings-kicker">Workspace controls</span>
              <h2>Session Settings</h2>
              <p>Adjust this session&apos;s workspace path, interaction model, and runtime tooling.</p>
            </div>
          </div>
          <button className="modal-close" onClick={onClose} aria-label="Close">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        <div className="modal-body session-settings-body">
          <section className="session-settings-hero-card">
            <div className="session-settings-hero-main">
              <span className="session-settings-hero-label">Session</span>
              <h3>{sessionTitle || 'New Terminal'}</h3>
              <p>Manage how this session opens, renders, and accepts desktop input.</p>
            </div>
            <div className="session-settings-hero-meta">
              <div className="session-settings-meta-block">
                <span className="session-settings-meta-label">Current path</span>
                <code>{currentCwd || 'Backend default'}</code>
              </div>
              <div className="session-settings-meta-block">
                <span className="session-settings-meta-label">Save behavior</span>
                <span>{shouldNavigateOnSave ? 'Navigate on save' : 'Stay in current workspace'}</span>
              </div>
            </div>
          </section>

          <section className="session-settings-section">
            <div className="session-settings-section-heading">
              <span className="session-settings-section-kicker">Workspace</span>
              <h3>Directory and file access</h3>
            </div>
            <div className="session-settings-panel">
              <div className="form-group session-settings-field">
                <label htmlFor="working-dir">Working Directory</label>
                <div className="input-with-actions">
                  <div className="input-with-dropdown" ref={dropdownRef}>
                    <input
                      id="working-dir"
                      type="text"
                      value={workingDir}
                      onChange={(e) => setWorkingDir(e.target.value)}
                      placeholder={'e.g., C:\\Users\\YourName\\Projects'}
                      onFocus={() => recentFolders.length > 0 && setShowDropdown(true)}
                    />
                    {recentFolders.length > 0 && (
                      <button
                        type="button"
                        className="dropdown-toggle"
                        onClick={() => setShowDropdown(!showDropdown)}
                        aria-label="Show recent folders"
                      >
                        ▼
                      </button>
                    )}
                    {showDropdown && recentFolders.length > 0 && (
                      <div className="folder-dropdown">
                        <div className="folder-dropdown-header">Recent Folders</div>
                        {recentFolders.map((folder, index) => (
                          <button
                            key={index}
                            type="button"
                            className="folder-dropdown-item"
                            onClick={() => handleSelectFolder(folder)}
                          >
                            <span className="folder-icon">📁</span>
                            <span className="folder-path" title={folder}>
                              {folder}
                            </span>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                  <div className="input-actions">
                    <button
                      type="button"
                      className="btn-secondary btn-small"
                      onClick={() => setShowFolderBrowser(true)}
                      title="Browse folders"
                    >
                      Browse
                    </button>
                    {currentCwd && currentCwd !== workingDir && (
                      <button
                        type="button"
                        className="btn-secondary btn-small"
                        onClick={() => setWorkingDir(currentCwd)}
                        title="Use current terminal directory"
                      >
                        Use Current
                      </button>
                    )}
                    {workingDir && (
                      <button
                        type="button"
                        className="btn-secondary btn-small"
                        onClick={handleClear}
                        title="Clear directory"
                      >
                        Clear
                      </button>
                    )}
                  </div>
                </div>
                <small>
                  {currentCwd ? (
                    <>Current: <code>{currentCwd}</code></>
                  ) : (
                    'Leave empty to use backend default'
                  )}
                </small>
              </div>

              <div className="session-settings-inline-utility">
                <div>
                  <span className="session-settings-utility-label">Folder export</span>
                  <p>Download the active workspace folder as a zip archive.</p>
                </div>
                <button
                  className="btn-secondary"
                  onClick={handleDownload}
                  disabled={!workingDir && !currentCwd}
                  title="Download folder as .zip"
                >
                  ↓ Download
                </button>
              </div>
            </div>
          </section>

          <section className="session-settings-section">
            <div className="session-settings-section-heading">
              <span className="session-settings-section-kicker">Runtime</span>
              <h3>Terminal rendering and desktop behavior</h3>
            </div>
            <div className="session-settings-grid">
              <div className="session-settings-panel session-settings-panel-compact">
                <div className="form-group session-settings-field">
                  <label htmlFor="font-size">Terminal Font Size</label>
                  <div className="font-size-selector">
                    <input
                      id="font-size"
                      type="range"
                      min="10"
                      max="24"
                      value={terminalFontSize}
                      onChange={(e) => onFontSizeChange(parseInt(e.target.value, 10))}
                    />
                    <span className="font-size-value">{terminalFontSize}px</span>
                  </div>
                  <small>Adjust terminal text size. Changes apply immediately.</small>
                </div>
              </div>

              <div className="session-settings-panel session-settings-panel-compact">
                <div className="form-group session-settings-field">
                  <label>Terminal Renderer</label>
                  <div className="mode-toggle" role="group" aria-label="Terminal renderer">
                    <button
                      type="button"
                      className={`mode-btn ${resolvedWebglEnabled ? 'active' : ''}`}
                      disabled={webglLocked}
                      onClick={() => onWebglChange?.(true)}
                      title={webglGuardReason || 'Use the GPU-accelerated renderer'}
                    >
                      WebGL
                    </button>
                    <button
                      type="button"
                      className={`mode-btn ${!resolvedWebglEnabled ? 'active' : ''}`}
                      onClick={() => onWebglChange?.(false)}
                      title={webglLocked ? 'Stable renderer for this device' : 'Use the stable canvas renderer'}
                    >
                      Canvas
                    </button>
                  </div>
                  <small>{webglGuardReason || 'Use WebGL for GPU acceleration; switch to Canvas if you see glitches.'}</small>
                </div>
              </div>
            </div>
          </section>

          <section className="session-settings-section">
            <div className="session-settings-section-heading">
              <span className="session-settings-section-kicker">Desktop UX</span>
              <h3>Choose how the interface behaves</h3>
            </div>
            <div className="session-settings-grid">
              <div className="session-settings-panel session-settings-panel-compact">
                <div className="form-group session-settings-field">
                  <label>Tab Status Labels</label>
                  <div className="mode-toggle" role="group" aria-label="Tab status labels">
                    <button
                      type="button"
                      className={`mode-btn ${resolvedShowTabStatusLabels ? 'active' : ''}`}
                      onClick={() => onTabStatusLabelsChange?.(true)}
                    >
                      Show
                    </button>
                    <button
                      type="button"
                      className={`mode-btn ${!resolvedShowTabStatusLabels ? 'active' : ''}`}
                      onClick={() => onTabStatusLabelsChange?.(false)}
                    >
                      Compact
                    </button>
                  </div>
                  <small>Show explicit Busy, Done, and Idle labels in tab chips.</small>
                </div>
              </div>

              <div className="session-settings-panel session-settings-panel-compact">
                <div className="form-group session-settings-field">
                  <label>Desktop Typing</label>
                  <div className="mode-toggle" role="group" aria-label="Desktop typing mode">
                    <button
                      type="button"
                      className={`mode-btn ${!resolvedDesktopAllowTerminalInput ? 'active' : ''}`}
                      onClick={() => onDesktopTerminalInputChange?.(false)}
                    >
                      Ask V4 Only
                    </button>
                    <button
                      type="button"
                      className={`mode-btn ${resolvedDesktopAllowTerminalInput ? 'active' : ''}`}
                      onClick={() => onDesktopTerminalInputChange?.(true)}
                    >
                      Ask V4 + Terminal
                    </button>
                  </div>
                  <small>Keep typing in the Ask V4 composer, or also allow direct terminal typing.</small>
                </div>
              </div>
            </div>
          </section>

          <section className="session-settings-section">
            <div className="session-settings-section-heading">
              <span className="session-settings-section-kicker">Utilities</span>
              <h3>Voice and process tooling</h3>
            </div>
            <div className="session-settings-grid">
              <div className="session-settings-panel session-settings-panel-compact">
                <div className="form-group session-settings-field">
                  <label>Voice Input</label>
                  <div className="settings-inline-actions">
                    <div>
                      <div className="settings-inline-title">Groq cloud transcription</div>
                      <small>Manage the API key used by the Groq cloud microphone button.</small>
                    </div>
                    <button
                      type="button"
                      className="btn-secondary btn-small"
                      onClick={onOpenApiSettings}
                      disabled={!onOpenApiSettings}
                    >
                      Open API Settings
                    </button>
                  </div>
                </div>
              </div>

              <div className="session-settings-panel session-settings-panel-compact">
                <div className="form-group session-settings-field">
                  <label>Process Manager</label>
                  <div className="settings-inline-actions">
                    <div>
                      <div className="settings-inline-title">Manage running project processes</div>
                      <small>Inspect and stop active dev servers from a single panel.</small>
                    </div>
                    <button
                      type="button"
                      className="btn-secondary btn-small"
                      onClick={onOpenProcessManager}
                      disabled={!onOpenProcessManager}
                    >
                      Open Process Manager
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </section>
        </div>

        <div className="modal-footer session-settings-footer">
          <div className="session-settings-footer-copy">
            <span className="session-settings-footer-status">
              {shouldNavigateOnSave ? 'Saving will reopen this session in the new workspace.' : 'Settings are applied immediately where possible.'}
            </span>
          </div>
          <div className="session-settings-footer-actions">
            <button className="btn-secondary" onClick={onClose}>
              Cancel
            </button>
            <button className="btn-primary" onClick={handleSave}>
              {shouldNavigateOnSave ? 'Save & Navigate' : 'Save'}
            </button>
          </div>
        </div>

        <FolderBrowserModal
          isOpen={showFolderBrowser}
          onClose={() => setShowFolderBrowser(false)}
          currentPath={workingDir || currentCwd}
          recentFolders={recentFolders}
          onSelect={(path) => {
            setWorkingDir(path);
            setShowFolderBrowser(false);
          }}
        />
        <style>{`
          .session-settings-modal {
            max-width: 760px;
            background:
              linear-gradient(180deg, color-mix(in srgb, var(--accent-primary) 10%, var(--bg-surface)) 0%, var(--bg-surface) 18%, var(--bg-surface) 100%);
            overflow: hidden;
          }

          .session-settings-header {
            align-items: flex-start;
            padding-bottom: 12px;
          }

          .session-settings-title-wrap {
            display: flex;
            align-items: flex-start;
            gap: 16px;
            min-width: 0;
          }

          .session-settings-icon-shell {
            display: inline-flex;
            align-items: center;
            justify-content: center;
            width: 44px;
            height: 44px;
            border-radius: 14px;
            background: color-mix(in srgb, var(--accent-primary) 18%, transparent);
            color: var(--accent-primary);
            border: 1px solid color-mix(in srgb, var(--accent-primary) 26%, transparent);
            box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.08);
            flex-shrink: 0;
          }

          .session-settings-title-copy {
            min-width: 0;
          }

          .session-settings-title-copy h2 {
            margin: 0;
          }

          .session-settings-kicker,
          .session-settings-section-kicker,
          .session-settings-hero-label,
          .session-settings-meta-label,
          .session-settings-utility-label {
            display: inline-block;
            font-size: 11px;
            font-weight: 700;
            letter-spacing: 0.12em;
            text-transform: uppercase;
            color: var(--text-muted);
          }

          .session-settings-title-copy p {
            margin: 8px 0 0;
            max-width: 52ch;
            font-size: 14px;
            line-height: 1.5;
            color: var(--text-secondary);
          }

          .session-settings-body {
            display: flex;
            flex-direction: column;
            gap: 22px;
          }

          .session-settings-hero-card,
          .session-settings-panel {
            border: 1px solid color-mix(in srgb, var(--border-default) 88%, transparent);
            background: color-mix(in srgb, var(--bg-elevated) 84%, transparent);
            border-radius: 20px;
            box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.03);
          }

          .session-settings-hero-card {
            display: grid;
            grid-template-columns: minmax(0, 1.3fr) minmax(240px, 0.9fr);
            gap: 18px;
            padding: 20px;
          }

          .session-settings-hero-main h3,
          .session-settings-section-heading h3 {
            margin: 8px 0 0;
            font-size: 22px;
            line-height: 1.1;
            letter-spacing: -0.03em;
            color: var(--text-primary);
          }

          .session-settings-hero-main p {
            margin: 10px 0 0;
            color: var(--text-secondary);
            line-height: 1.55;
          }

          .session-settings-hero-meta {
            display: grid;
            gap: 12px;
          }

          .session-settings-meta-block {
            display: grid;
            gap: 8px;
            padding: 14px 16px;
            border-radius: 16px;
            background: color-mix(in srgb, var(--bg-surface) 82%, transparent);
            border: 1px solid color-mix(in srgb, var(--border-subtle) 90%, transparent);
          }

          .session-settings-meta-block code,
          .session-settings-meta-block span:last-child {
            overflow-wrap: anywhere;
            color: var(--text-primary);
          }

          .session-settings-meta-block code {
            font-size: 12px;
            background: color-mix(in srgb, var(--bg-base) 84%, transparent);
            border: 1px solid color-mix(in srgb, var(--border-subtle) 75%, transparent);
            border-radius: 10px;
            padding: 8px 10px;
          }

          .session-settings-section {
            display: flex;
            flex-direction: column;
            gap: 12px;
          }

          .session-settings-section-heading {
            display: flex;
            flex-direction: column;
            gap: 4px;
          }

          .session-settings-grid {
            display: grid;
            grid-template-columns: repeat(2, minmax(0, 1fr));
            gap: 14px;
          }

          .session-settings-panel {
            padding: 18px;
          }

          .session-settings-field {
            gap: 10px;
          }

          .session-settings-inline-utility {
            margin-top: 16px;
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 16px;
            padding-top: 16px;
            border-top: 1px solid color-mix(in srgb, var(--border-subtle) 90%, transparent);
          }

          .session-settings-inline-utility p {
            margin: 6px 0 0;
            color: var(--text-secondary);
            font-size: 13px;
          }

          .settings-inline-actions {
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 12px;
            min-height: 100%;
          }

          .settings-inline-title {
            font-size: 13px;
            font-weight: 600;
            margin-bottom: 4px;
          }

          .session-settings-footer {
            justify-content: space-between;
            align-items: center;
            gap: 16px;
            padding-top: 12px;
          }

          .session-settings-footer-copy {
            min-width: 0;
            flex: 1;
          }

          .session-settings-footer-status {
            display: block;
            color: var(--text-muted);
            font-size: 12px;
            line-height: 1.45;
          }

          .session-settings-footer-actions {
            display: flex;
            align-items: center;
            gap: 10px;
            flex-shrink: 0;
          }

          @media (max-width: 720px) {
            .session-settings-modal {
              max-width: 100%;
            }

            .session-settings-hero-card,
            .session-settings-grid {
              grid-template-columns: 1fr;
            }

            .session-settings-inline-utility,
            .settings-inline-actions,
            .session-settings-footer {
              flex-direction: column;
              align-items: stretch;
            }

            .session-settings-footer-actions {
              width: 100%;
              justify-content: stretch;
            }

            .session-settings-footer-actions > button {
              flex: 1;
            }
          }
        `}</style>
      </div>
    </div>
  );
}

export default SettingsModal;
