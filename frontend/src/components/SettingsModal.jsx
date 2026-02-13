import { useState, useRef, useEffect } from 'react';
import { FolderBrowserModal } from './FolderBrowserModal';
import { getAccessToken } from '../utils/auth';

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
  terminalShellProfile,
  onShellProfileChange,
  terminalFidelityMode,
  onFidelityModeChange,
  terminalNativeLauncher,
  onNativeLauncherChange,
  onOpenNativeTerminal,
  showTabStatusLabels,
  onTabStatusLabelsChange
}) {
  const [workingDir, setWorkingDir] = useState(currentCwd || '');
  const [showDropdown, setShowDropdown] = useState(false);
  const [showFolderBrowser, setShowFolderBrowser] = useState(false);
  const resolvedWebglEnabled = terminalWebglEnabled !== false;
  const resolvedShellProfile = terminalShellProfile || 'system';
  const resolvedFidelityMode = terminalFidelityMode === 'native' ? 'native' : 'balanced';
  const resolvedNativeLauncher = terminalNativeLauncher || 'system';
  const resolvedShowTabStatusLabels = showTabStatusLabels !== false;
  const dropdownRef = useRef(null);

  // Update local state when modal opens
  useEffect(() => {
    if (isOpen) {
      setWorkingDir(currentCwd || '');
    }
  }, [isOpen, currentCwd]);

  // Close dropdown on outside click
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
    if (workingDir && workingDir.trim()) {
      onAddRecentFolder(workingDir.trim());
    }
    onSave(sessionId, workingDir.trim());
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
    // Trigger download by navigating to the endpoint
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
      <div className="modal-content" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px', color: 'var(--accent-primary)' }}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ opacity: 0.7 }}>
              <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
              <circle cx="12" cy="12" r="3" />
            </svg>
            <h2 style={{ margin: 0, fontSize: '15px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.5px' }}>Session Settings</h2>
          </div>
          <button className="modal-close" onClick={onClose} aria-label="Close">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>
        <div className="modal-body">
          <div className="form-group">
            <label>Session: <strong>{sessionTitle || 'New Terminal'}</strong></label>
          </div>
          <div className="form-group">
            <label htmlFor="working-dir">Working Directory</label>
            <div className="input-with-actions">
              <div className="input-with-dropdown" ref={dropdownRef}>
                <input
                  id="working-dir"
                  type="text"
                  value={workingDir}
                  onChange={(e) => setWorkingDir(e.target.value)}
                  placeholder="e.g., C:\Users\YourName\Projects"
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
          <div className="form-group">
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
            <small>Adjust terminal text size (changes apply immediately)</small>
          </div>
          <div className="form-group">
            <label>Terminal Renderer</label>
            <div className="mode-toggle" role="group" aria-label="Terminal renderer">
              <button
                type="button"
                className={`mode-btn ${resolvedWebglEnabled ? 'active' : ''}`}
                onClick={() => onWebglChange?.(true)}
              >
                WebGL
              </button>
              <button
                type="button"
                className={`mode-btn ${!resolvedWebglEnabled ? 'active' : ''}`}
                onClick={() => onWebglChange?.(false)}
              >
                Canvas
              </button>
            </div>
            <small>Use WebGL for GPU acceleration; switch to Canvas if you see glitches.</small>
          </div>
          <div className="form-group">
            <label htmlFor="terminal-shell-profile">Default Shell Profile</label>
            <select
              id="terminal-shell-profile"
              className="terminal-settings-select"
              value={resolvedShellProfile}
              onChange={(e) => onShellProfileChange?.(e.target.value)}
            >
              <option value="system">System Default</option>
              <option value="cmd">Command Prompt (cmd)</option>
              <option value="powershell">Windows PowerShell</option>
              <option value="pwsh">PowerShell 7 (pwsh)</option>
              <option value="bash">Bash</option>
              <option value="zsh">Zsh</option>
              <option value="sh">Sh</option>
              <option value="claude">Claude Code CLI</option>
            </select>
            <small>Used for new terminal sessions unless a session overrides shell selection.</small>
          </div>
          <div className="form-group">
            <label>Terminal Fidelity</label>
            <div className="mode-toggle" role="group" aria-label="Terminal fidelity">
              <button
                type="button"
                className={`mode-btn ${resolvedFidelityMode === 'balanced' ? 'active' : ''}`}
                onClick={() => onFidelityModeChange?.('balanced')}
              >
                Balanced
              </button>
              <button
                type="button"
                className={`mode-btn ${resolvedFidelityMode === 'native' ? 'active' : ''}`}
                onClick={() => onFidelityModeChange?.('native')}
              >
                Native
              </button>
            </div>
            <small>Native reduces buffering/drop protections for a closer OS terminal feel.</small>
          </div>
          <div className="form-group">
            <label htmlFor="terminal-native-launcher">Native Terminal Launcher</label>
            <select
              id="terminal-native-launcher"
              className="terminal-settings-select"
              value={resolvedNativeLauncher}
              onChange={(e) => onNativeLauncherChange?.(e.target.value)}
            >
              <option value="system">System Default</option>
              <option value="wt">Windows Terminal</option>
              <option value="pwsh">PowerShell 7 (pwsh)</option>
              <option value="powershell">Windows PowerShell</option>
              <option value="cmd">Command Prompt (cmd)</option>
              <option value="terminal">Terminal.app (macOS)</option>
              <option value="x-terminal-emulator">x-terminal-emulator (Linux)</option>
            </select>
            <small>Used when opening the current session in your OS-native terminal app.</small>
          </div>
          <div className="form-group">
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
            <small>Show explicit Busy/Done/Idle labels in tab chips.</small>
          </div>

        </div>
        <div className="modal-footer">
          <button className="btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn-secondary"
            onClick={() => onOpenNativeTerminal?.(sessionId)}
            disabled={!sessionId}
            title={sessionId ? 'Open current session in native terminal' : 'Select a session first'}
          >
            Open Native
          </button>
          <button
            className="btn-secondary"
            onClick={handleDownload}
            disabled={!workingDir && !currentCwd}
            title="Download folder as .zip"
          >
            ⬇ Download
          </button>
          <button className="btn-primary" onClick={handleSave}>
            Save & Navigate
          </button>
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
      </div>
    </div>
  );
}

export default SettingsModal;
