import { AgentNotificationSetting } from './AgentNotificationSetting';
import { AppearanceSetting } from './AppearanceSetting';
import { SetupChecklist } from './SetupChecklist';
import { KeyboardShortcutsSetting } from './KeyboardShortcutsSetting';
import { UsageSummary } from './UsageSummary';
import { TelegramSetting } from './TelegramSetting';
import { getActiveEnvironment } from '../utils/remoteEnvironments';
import { useState, useRef, useEffect, useLayoutEffect, useId, useMemo, useSyncExternalStore } from 'react';
import './SettingsModal.css';
import './UtilityDialogs.css';
import { FolderBrowserModal } from './FolderBrowserModal';
import { McpSettingsPanel } from './McpSettingsPanel';
import { AccountKnowledgePanel } from './AccountKnowledgePanel';
import { AgentBrowserSettingsPanel } from './AgentBrowserSettingsPanel';
import { ProviderConnectionsPanel } from './ProviderConnectionsPanel';
import { MountOnFirstOpen } from './MountOnFirstOpen';
import { apiFetch } from '../utils/api';
import { isStructuredSessionId } from '../utils/structuredSessions';
import { getTerminalRendererGuardReason, resolveTerminalWebglEnabled } from '../utils/terminalRendererPolicy';
import { getComposerScrollPreference, setComposerScrollPreference, subscribeComposerScrollPreference } from '../utils/composerScrollPreference';

const dialogSelector = 'dialog, [role="dialog"], [role="alertdialog"]';

function getFocusableControls(dialog) {
  return [...dialog.querySelectorAll('button, input, select, textarea, a[href], summary, [tabindex]')]
    .filter(element => {
      if (element.tabIndex < 0 || element.matches(':disabled') || element.closest('[hidden], [inert]')) return false;
      if (element.closest(dialogSelector) !== dialog) return false;
      for (let ancestor = element; ancestor && dialog.contains(ancestor); ancestor = ancestor.parentElement) {
        const style = getComputedStyle(ancestor);
        if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') return false;
      }
      return true;
    });
}

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
  onOpenSystemResources,
  showTabStatusLabels,
  onTabStatusLabelsChange
}) {
  const titleId = useId();
  const [workingDir, setWorkingDir] = useState(currentCwd || '');
  const [showDropdown, setShowDropdown] = useState(false);
  const [showFolderBrowser, setShowFolderBrowser] = useState(false);
  const [activeSection, setActiveSection] = useState('workspace');
  const collapseOnScroll = useSyncExternalStore(subscribeComposerScrollPreference, getComposerScrollPreference, () => true);
  const [composerPreferenceWarning, setComposerPreferenceWarning] = useState(false);
  const [dirtySections, setDirtySections] = useState({});
  const dirtyHandlers = useMemo(() => Object.fromEntries(['mcp', 'browser', 'knowledge', 'connections'].map(section => [section, dirty => {
    setDirtySections(previous => previous[section] === dirty ? previous : { ...previous, [section]: dirty });
  }])), []);
  const unsavedLabels = [['mcp', 'MCP servers'], ['browser', 'Agent browser'], ['knowledge', 'Account knowledge'], ['connections', 'Provider connections']]
    .filter(([section]) => dirtySections[section]).map(([, label]) => label);
  const [saveError, setSaveError] = useState('');
  const [downloadError, setDownloadError] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const [isDownloading, setIsDownloading] = useState(false);
  const sectionSavesOwnSettings = ['mcp', 'browser', 'knowledge', 'connections'].includes(activeSection);
  const resolvedWebglEnabled = resolveTerminalWebglEnabled(terminalWebglEnabled);
  const webglGuardReason = getTerminalRendererGuardReason();
  const webglLocked = Boolean(webglGuardReason);
  const resolvedDesktopAllowTerminalInput = desktopAllowTerminalInput === true;
  const resolvedShowTabStatusLabels = showTabStatusLabels !== false;
  const dialogRef = useRef(null);
  const closeRef = useRef(null);
  const openerRef = useRef(null);
  const dropdownRef = useRef(null);
  const operationGenerationRef = useRef(0);
  const normalizedWorkingDir = workingDir.trim();
  const normalizedCurrentCwd = typeof currentCwd === 'string' ? currentCwd.trim() : '';
  const shouldNavigateOnSave = Boolean(normalizedWorkingDir) && normalizedWorkingDir !== normalizedCurrentCwd;
  useEffect(() => { if (!isOpen) setDirtySections({}); }, [isOpen]);

  useLayoutEffect(() => {
    if (!isOpen) return;
    const dialog = dialogRef.current;
    openerRef.current = document.activeElement;
    let lastFocused = closeRef.current;
    lastFocused.focus({ preventScroll: true });
    const containFocus = event => {
      const targetDialog = event.target.closest(dialogSelector);
      if (dialog.contains(event.target)) {
        if (targetDialog === dialog) lastFocused = event.target;
        return;
      }
      if (targetDialog) return;
      const controls = getFocusableControls(dialog);
      const target = controls.includes(lastFocused) ? lastFocused : controls[0] || dialog;
      target.focus({ preventScroll: true });
    };
    document.addEventListener('focusin', containFocus);
    return () => document.removeEventListener('focusin', containFocus);
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    const opener = openerRef.current;
    const dialog = dialogRef.current;
    return () => {
      const focusedDialog = document.activeElement?.closest(dialogSelector);
      if (opener?.isConnected && (!focusedDialog || focusedDialog === dialog)) opener.focus({ preventScroll: true });
    };
  }, [isOpen]);

  function handleDialogKeyDown(event) {
    if (event.defaultPrevented || event.target.closest(dialogSelector) !== event.currentTarget) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      onClose();
      return;
    }
    if (event.key !== 'Tab') return;
    const controls = getFocusableControls(event.currentTarget);
    const first = controls[0];
    const last = controls[controls.length - 1];
    if (!first || document.activeElement === event.currentTarget) {
      event.preventDefault();
      (event.shiftKey ? last : first)?.focus({ preventScroll: true });
    } else if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus({ preventScroll: true });
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus({ preventScroll: true });
    }
  }

  useEffect(() => {
    operationGenerationRef.current += 1;
    setIsSaving(false);
    setIsDownloading(false);
    if (isOpen) {
      setWorkingDir(currentCwd || '');
      setSaveError('');
      setDownloadError('');
    }
    return () => { operationGenerationRef.current += 1; };
  }, [isOpen, currentCwd, sessionId]);

  useEffect(() => {
    const handleClickOutside = (event) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target)) {
        setShowDropdown(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const handleSave = async () => {
    if (isSaving) return;
    const generation = operationGenerationRef.current;
    setSaveError('');
    if (shouldNavigateOnSave && !sessionId) {
      setSaveError('Select a terminal session before changing its working directory.');
      return;
    }
    if (shouldNavigateOnSave && isStructuredSessionId(sessionId)) {
      setSaveError('This conversation has a fixed workspace. Create a new conversation in the selected folder.');
      return;
    }
    setIsSaving(true);
    try {
      if (shouldNavigateOnSave) {
        await onSave(sessionId, normalizedWorkingDir);
        if (generation !== operationGenerationRef.current) return;
        onAddRecentFolder(normalizedWorkingDir);
      }
      onClose();
    } catch (error) {
      if (generation !== operationGenerationRef.current) return;
      setSaveError(error.message || 'Could not navigate. Your selected directory is still here; try again.');
    } finally {
      if (generation === operationGenerationRef.current) setIsSaving(false);
    }
  };

  const handleDownload = async () => {
    const pathToDownload = normalizedWorkingDir || normalizedCurrentCwd;
    if (!pathToDownload || isDownloading) return;
    const generation = operationGenerationRef.current;
    setDownloadError('');
    setIsDownloading(true);
    try {
      const params = new URLSearchParams({ path: pathToDownload });
      const response = await apiFetch(`/api/fs/download?${params}`);
      if (!response.ok) throw new Error(`Failed to download folder (${response.status})`);
      const blob = await response.blob();
      if (generation !== operationGenerationRef.current) return;
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `${pathToDownload.split(/[\\/]/).filter(Boolean).pop() || 'workspace'}.zip`;
      document.body.appendChild(link);
      try {
        link.click();
      } finally {
        link.remove();
        URL.revokeObjectURL(url);
      }
    } catch (error) {
      if (generation !== operationGenerationRef.current) return;
      setDownloadError(error.message || 'Could not download folder. Try again.');
    } finally {
      if (generation === operationGenerationRef.current) setIsDownloading(false);
    }
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
      <div ref={dialogRef} className="modal-content session-settings-modal ui-utility-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} onKeyDown={handleDialogKeyDown} onClick={(e) => e.stopPropagation()}>
        <div className="modal-header session-settings-header">
          <div className="session-settings-title-wrap">
            <div className="session-settings-title-copy">
              <h2 id={titleId}>Session Settings</h2>
            </div>
          </div>
          <button ref={closeRef} className="modal-close" onClick={onClose} aria-label="Close">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        <div className="modal-body session-settings-body">
          <nav className="session-settings-nav" aria-label="Settings sections">
            {[
              ['workspace', 'Workspace'],
              ['terminal', 'Terminal'],
              ['interface', 'Interface'],
              ['connections', 'Provider connections'],
              ['mcp', 'MCP servers'],
              ['browser', 'Agent browser'],
              ['knowledge', 'Account knowledge'],
              ['voice', 'Voice'],
              ['processes', 'Processes'],
              ['messaging', 'Messaging'],
              ['usage', 'Usage'],
              ['shortcuts', 'Keyboard shortcuts'],
              ['setup', 'Setup check'],
            ].map(([id, label]) => (
              <button
                key={id}
                type="button"
                className={`session-settings-nav-btn${activeSection === id ? ' active' : ''}`}
                aria-current={activeSection === id ? 'page' : undefined}
                onClick={() => setActiveSection(id)}
              >
                {label}
              </button>
            ))}
          </nav>

          <section className="session-settings-section" hidden={activeSection !== 'workspace'}>
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
                      disabled={isSaving}
                      onChange={(e) => setWorkingDir(e.target.value)}
                      placeholder={'e.g., C:\\Users\\YourName\\Projects'}
                      onFocus={() => recentFolders.length > 0 && setShowDropdown(true)}
                    />
                    {recentFolders.length > 0 && (
                      <button
                        type="button"
                        className="dropdown-toggle"
                        disabled={isSaving}
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
                            disabled={isSaving}
                            onClick={() => handleSelectFolder(folder)}
                          >
                            <span className="folder-icon" aria-hidden="true">/</span>
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
                      disabled={isSaving}
                      title="Browse folders"
                    >
                      Browse
                    </button>
                    {currentCwd && currentCwd !== workingDir && (
                      <button
                        type="button"
                        className="btn-secondary btn-small"
                        onClick={() => setWorkingDir(currentCwd)}
                        disabled={isSaving}
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
                        disabled={isSaving}
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
                  disabled={isDownloading || (!normalizedWorkingDir && !normalizedCurrentCwd)}
                  title="Download folder as .zip"
                >
                  {isDownloading ? 'Downloading...' : '↓ Download'}
                </button>
              </div>
              {downloadError && <p role="alert">{downloadError}</p>}
            </div>
          </section>

          <section className="session-settings-section" hidden={activeSection !== 'terminal'}>
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
                      aria-pressed={resolvedWebglEnabled}
                      disabled={webglLocked}
                      onClick={() => onWebglChange?.(true)}
                      title={webglGuardReason || 'Use the GPU-accelerated renderer'}
                    >
                      WebGL
                    </button>
                    <button
                      type="button"
                      className={`mode-btn ${!resolvedWebglEnabled ? 'active' : ''}`}
                      aria-pressed={!resolvedWebglEnabled}
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

          <section className="session-settings-section" hidden={activeSection !== 'messaging'}>
            {activeSection === 'messaging' && <TelegramSetting />}
          </section>

          <section className="session-settings-section" hidden={activeSection !== 'usage'}>
            {activeSection === 'usage' && <UsageSummary />}
          </section>

          <section className="session-settings-section" hidden={activeSection !== 'shortcuts'}>
            {activeSection === 'shortcuts' && <KeyboardShortcutsSetting />}
          </section>

          <section className="session-settings-section" hidden={activeSection !== 'setup'}>
            {activeSection === 'setup' && <SetupChecklist />}
          </section>

          <section className="session-settings-section" hidden={activeSection !== 'interface'}>
            <div className="session-settings-section-heading">
              <span className="session-settings-section-kicker">Desktop UX</span>
              <h3>Choose how the interface behaves</h3>
            </div>
            <div className="session-settings-grid">
              <div className="session-settings-panel session-settings-panel-compact">
                <AgentNotificationSetting />
              </div>
              <div className="session-settings-panel session-settings-panel-compact">
                <AppearanceSetting />
              </div>

              <div className="session-settings-panel session-settings-panel-compact">
                <div className="form-group session-settings-field">
                  <label>Composer while reading</label>
                  <div className="mode-toggle" role="group" aria-label="Compact composer on scroll">
                    <button type="button" className={`mode-btn ${collapseOnScroll ? 'active' : ''}`}
                      aria-label="Compact composer while scrolling" aria-pressed={collapseOnScroll}
                      onClick={() => setComposerPreferenceWarning(!setComposerScrollPreference(true))}>Compact</button>
                    <button type="button" className={`mode-btn ${!collapseOnScroll ? 'active' : ''}`}
                      aria-label="Keep composer expanded" aria-pressed={!collapseOnScroll}
                      onClick={() => setComposerPreferenceWarning(!setComposerScrollPreference(false))}>Expanded</button>
                  </div>
                  <small>Choose whether the desktop composer shrinks while you scroll a conversation. This preference is saved in this browser.</small>
                  {composerPreferenceWarning && <small role="alert">Could not save this preference. It will apply only in this tab until it closes.</small>}
                </div>
              </div>

              <div className="session-settings-panel session-settings-panel-compact">
                <div className="form-group session-settings-field">
                  <label>Tab Status Labels</label>
                  <div className="mode-toggle" role="group" aria-label="Tab status labels">
                    <button
                      type="button"
                      className={`mode-btn ${resolvedShowTabStatusLabels ? 'active' : ''}`}
                      aria-pressed={resolvedShowTabStatusLabels}
                      onClick={() => onTabStatusLabelsChange?.(true)}
                    >
                      Show
                    </button>
                    <button
                      type="button"
                      className={`mode-btn ${!resolvedShowTabStatusLabels ? 'active' : ''}`}
                      aria-pressed={!resolvedShowTabStatusLabels}
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
                      aria-pressed={!resolvedDesktopAllowTerminalInput}
                      onClick={() => onDesktopTerminalInputChange?.(false)}
                    >
                      Ask V4 Only
                    </button>
                    <button
                      type="button"
                      className={`mode-btn ${resolvedDesktopAllowTerminalInput ? 'active' : ''}`}
                      aria-pressed={resolvedDesktopAllowTerminalInput}
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

          <section className="session-settings-section" hidden={activeSection !== 'mcp'}><MountOnFirstOpen isOpen={activeSection === 'mcp'}><McpSettingsPanel isActive={activeSection === 'mcp'} onDirtyChange={dirtyHandlers.mcp} /></MountOnFirstOpen></section>
          <section className="session-settings-section" hidden={activeSection !== 'browser'}><MountOnFirstOpen isOpen={activeSection === 'browser'}><AgentBrowserSettingsPanel onDirtyChange={dirtyHandlers.browser} /></MountOnFirstOpen></section>
          <section className="session-settings-section" hidden={activeSection !== 'knowledge'}><MountOnFirstOpen isOpen={activeSection === 'knowledge'}><AccountKnowledgePanel onDirtyChange={dirtyHandlers.knowledge} /></MountOnFirstOpen></section>
          <section className="session-settings-section" hidden={activeSection !== 'connections'}><MountOnFirstOpen isOpen={activeSection === 'connections'}><ProviderConnectionsPanel onDirtyChange={dirtyHandlers.connections} /></MountOnFirstOpen></section>

          <section className="session-settings-section" hidden={activeSection !== 'voice' && activeSection !== 'processes'}>
            <div className="session-settings-section-heading">
              <span className="session-settings-section-kicker">{activeSection === 'voice' ? 'Voice' : 'Processes'}</span>
              <h3>{activeSection === 'voice' ? 'Voice input' : 'Process tooling'}</h3>
            </div>
            <div className="session-settings-grid">
              <div className="session-settings-panel session-settings-panel-compact" hidden={activeSection !== 'voice'}>
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

              <div className="session-settings-panel session-settings-panel-compact" hidden={activeSection !== 'processes'}>
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
                      disabled={Boolean(getActiveEnvironment()) || !onOpenProcessManager}
                      title={getActiveEnvironment() ? 'Available on the owning server directly' : undefined}
                    >
                      Open Process Manager
                    </button>
                    <button type="button" className="btn-secondary btn-small" onClick={onOpenSystemResources} disabled={!onOpenSystemResources}>
                      Open System Resources
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </section>
        </div>

        <div className="modal-footer session-settings-footer">
          <div className="session-settings-footer-copy">
            {saveError && <p role="alert">{saveError}</p>}
            <span className="session-settings-footer-status">
              {unsavedLabels.length ? `Unsaved changes in ${unsavedLabels.join(', ')}. Save in those sections before closing.` : sectionSavesOwnSettings ? 'Changes are kept between sections. Save before closing settings.' : shouldNavigateOnSave ? isStructuredSessionId(sessionId) ? 'Conversation workspaces are fixed. Create a new conversation to use another folder.' : 'Saving will send a directory change to this terminal.' : 'Display settings apply immediately.'}
            </span>
          </div>
          <div className="session-settings-footer-actions">
            {sectionSavesOwnSettings ? <button className="btn-primary" onClick={onClose}>Close settings</button> : <>
              <button className="btn-secondary" onClick={onClose}>Cancel</button>
              <button className="btn-primary" onClick={handleSave} disabled={isSaving}>{isSaving ? 'Navigating...' : shouldNavigateOnSave ? 'Save & Navigate' : 'Done'}</button>
            </>}
          </div>
        </div>

        <FolderBrowserModal
          isOpen={showFolderBrowser}
          onClose={() => setShowFolderBrowser(false)}
          currentPath={workingDir || currentCwd}
          recentFolders={recentFolders}
          onSelect={(path) => {
            if (isSaving) return;
            setWorkingDir(path);
            setShowFolderBrowser(false);
          }}
        />

      </div>
    </div>
  );
}

export default SettingsModal;
