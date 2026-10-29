import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { createPortal } from 'react-dom';
import { apiFetch } from '../utils/api';
import { NEW_TAB_AI_OPTIONS } from '../utils/aiProviders';
import { savedConnectionBinding, savedConnectionOptions } from '../utils/savedConnectionAgents';
import { loadWorkspaceProfile, resolveWorkspaceDefaults } from '../utils/workspaceProfile';
import { WorkspaceProfileButton } from './WorkspaceProfileButton';
import { AgentModelPicker } from './AgentModelPicker';
import { loadSavedAgentSelection, saveAgentSelection } from '../utils/agentSelection';
import { serviceTierEntry } from '../utils/agentServiceTier';
import './FolderBrowserModal.css';

function resolveInitialAiOptionId(options, preferredId) {
  if (preferredId && options.some((option) => option.id === preferredId)) {
    return preferredId;
  }
  return options[0]?.id || 'cli';
}

function buildAiOptionsSignature(options) {
  return options
    .map((option) => `${option.id}:${option.label}:${option.title ?? ''}:${option.command ?? ''}`)
    .join('|');
}

function resolveLaunchDefaults(profile, options) {
  return resolveWorkspaceDefaults(profile, options) || (savedConnectionBinding(profile?.defaultAgent)
    ? resolveWorkspaceDefaults(profile, [{ id: profile.defaultAgent }]) : null);
}

export function FolderBrowserModal({
  isOpen,
  onClose,
  currentPath,
  recentFolders,
  onSelect,
  showAiSelector = false,
  aiOptions = NEW_TAB_AI_OPTIONS,
  defaultAiOptionId = 'cli',
  launchMode
}) {
  const terminalLaunch = launchMode === 'terminal';
  const showAgentSelector = showAiSelector && !terminalLaunch;
  const [connectionOptions, setConnectionOptions] = useState([]);
  const [loadingConnections, setLoadingConnections] = useState(false);
  const [connectionsError, setConnectionsError] = useState('');
  const connectionRequestRef = useRef(null);
  const dialogRef = useRef(null);
  const launchedRef = useRef(false);
  const agentControlRef = useRef(null);
  const baseAiOptions = showAgentSelector && aiOptions.length > 0 ? aiOptions : NEW_TAB_AI_OPTIONS;
  const resolvedAiOptions = useMemo(
    () => [...baseAiOptions, ...connectionOptions.filter(option => !baseAiOptions.some(existing => existing.id === option.id))],
    [baseAiOptions, connectionOptions]
  );
  const resolvedOptionsRef = useRef(resolvedAiOptions);
  resolvedOptionsRef.current = resolvedAiOptions;
  const aiOptionsSignature = useMemo(
    () => buildAiOptionsSignature(baseAiOptions),
    [baseAiOptions]
  );
  const [path, setPath] = useState(currentPath || '');
  const [folders, setFolders] = useState([]);
  const [parent, setParent] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [query, setQuery] = useState('');
  const [selectedAiOptionId, setSelectedAiOptionId] = useState(() => (
    terminalLaunch ? 'cli' : resolveInitialAiOptionId(resolvedAiOptions, defaultAiOptionId)
  ));
  const [agentSelection, setAgentSelection] = useState(() => terminalLaunch ? null : loadSavedAgentSelection(resolveInitialAiOptionId(resolvedAiOptions, defaultAiOptionId)));
  const [tabName, setTabName] = useState('');
  const [agentMenuOpen, setAgentMenuOpen] = useState(false);
  useEffect(() => {
    if (!agentMenuOpen) return undefined;
    agentControlRef.current?.querySelector('.pro-fb-option.selected')?.focus({ preventScroll: true });
    const closeOutside = event => { if (!agentControlRef.current?.contains(event.target)) setAgentMenuOpen(false); };
    document.addEventListener('pointerdown', closeOutside);
    return () => document.removeEventListener('pointerdown', closeOutside);
  }, [agentMenuOpen]);
  const [loadingDefaults, setLoadingDefaults] = useState(false);
  const [loadingRecent, setLoadingRecent] = useState(false);
  const [opening, setOpening] = useState(false);
  const [defaultsError, setDefaultsError] = useState('');
  const manualAgentPathRef = useRef(null);
  const directoryRequestRef = useRef(0);
  const requestedDirectoryRef = useRef(currentPath || '');
  const launchRequestRef = useRef(null);
  const selectedAiOption = resolvedAiOptions.find(option => option.id === selectedAiOptionId) || null;
  const connectionBlocked = savedConnectionBinding(selectedAiOptionId) &&
    (!agentSelection?.model?.trim() || selectedAiOption?.available !== true);

  useEffect(() => {
    if (!isOpen) return undefined;
    const trigger = document.activeElement;
    launchedRef.current = false;
    dialogRef.current?.querySelector('input[aria-label="Search folders"]')?.focus();
    // After a launch, focus belongs to the new terminal or thread rather than the opener.
    return () => { if (!launchedRef.current && trigger?.isConnected) trigger.focus(); };
  }, [isOpen]);

  function handleDialogKeyDown(event) {
    if (event.target.closest('[role="dialog"]') !== event.currentTarget) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      if (agentMenuOpen) setAgentMenuOpen(false);
      else onClose();
    }
    if (event.key !== 'Tab') return;
    const controls = [...event.currentTarget.querySelectorAll('button:not(:disabled), input:not(:disabled), select:not(:disabled), summary, [tabindex="0"]')]
      .filter(element => element.getClientRects().length > 0 && getComputedStyle(element).visibility !== 'hidden');
    const first = controls[0];
    const last = controls[controls.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
  }

  useEffect(() => () => {
    const request = launchRequestRef.current;
    request?.controller.abort();
    if (request && !request.started) {
      launchRequestRef.current = null;
      setLoadingRecent(false);
    }
  }, [isOpen, path]);

  const loadConnections = useCallback(async () => {
    connectionRequestRef.current?.abort();
    const controller = new AbortController();
    connectionRequestRef.current = controller;
    setLoadingConnections(true);
    setConnectionsError('');
    try {
      const response = await apiFetch('/api/agent/catalog', { signal: controller.signal });
      const catalog = await response.json();
      if (controller.signal.aborted) return;
      if (!response.ok || !Array.isArray(catalog?.agents)) throw new Error('Could not load saved connections.');
      setConnectionOptions(savedConnectionOptions(catalog));
    } catch {
      if (!controller.signal.aborted) setConnectionsError('Could not load saved connections.');
    } finally {
      if (connectionRequestRef.current === controller) setLoadingConnections(false);
    }
  }, []);

  useEffect(() => {
    setConnectionOptions([]);
    if (isOpen && showAgentSelector) void loadConnections();
    return () => connectionRequestRef.current?.abort();
  }, [isOpen, showAgentSelector, loadConnections]);

  const loadDirectory = useCallback(async (dirPath) => {
    dialogRef.current?.querySelector('input[aria-label="Search folders"]')?.focus({ preventScroll: true });
    requestedDirectoryRef.current = dirPath;
    const requestId = ++directoryRequestRef.current;
    setLoading(true);
    setQuery('');
    setError(null);
    try {
      const url = dirPath
        ? `/api/fs/list?path=${encodeURIComponent(dirPath)}`
        : '/api/fs/list';
      const res = await apiFetch(url);
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.message || data.error || 'Failed to load directory');
      }
      const data = await res.json();
      if (requestId !== directoryRequestRef.current) return;
      setPath(data.path);
      setFolders(data.folders);
      setParent(data.parent);
    } catch (err) {
      if (requestId === directoryRequestRef.current) setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (requestId === directoryRequestRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (isOpen) {
      manualAgentPathRef.current = null;
      loadDirectory(currentPath);
      setTabName('');
      setAgentMenuOpen(false);
      const nextAiOptionId = terminalLaunch ? 'cli' : resolveInitialAiOptionId(resolvedOptionsRef.current, defaultAiOptionId);
      setSelectedAiOptionId(nextAiOptionId);
      setAgentSelection(terminalLaunch ? null : loadSavedAgentSelection(nextAiOptionId));
    }
  }, [isOpen, currentPath, loadDirectory, defaultAiOptionId, terminalLaunch]);

  useEffect(() => {
    if (!isOpen || !showAgentSelector || !path) return undefined;
    if (manualAgentPathRef.current === path) {
      setLoadingDefaults(false);
      return undefined;
    }
    const controller = new AbortController();
    const initialId = resolveInitialAiOptionId(resolvedAiOptions, defaultAiOptionId);
    setLoadingDefaults(true);
    setDefaultsError('');
    if (manualAgentPathRef.current !== path) {
      setSelectedAiOptionId(initialId);
      setAgentSelection(loadSavedAgentSelection(initialId));
    }
    loadWorkspaceProfile(path, { signal: controller.signal }).then(profile => {
      if (controller.signal.aborted || manualAgentPathRef.current === path) return;
      const defaults = resolveLaunchDefaults(profile, resolvedAiOptions);
      if (defaults) {
        setSelectedAiOptionId(defaults.agentId);
        setAgentSelection(defaults.selection || loadSavedAgentSelection(defaults.agentId));
      }
    }).catch(loadError => {
      if (!controller.signal.aborted) setDefaultsError(loadError.message);
    }).finally(() => {
      if (!controller.signal.aborted) setLoadingDefaults(false);
    });
    return () => controller.abort();
  }, [isOpen, path, showAgentSelector, aiOptionsSignature, defaultAiOptionId]);

  const handleFolderClick = (folderName) => {
    const separator = path.includes('\\') ? '\\' : '/';
    const basePath = path.endsWith('/') || path.endsWith('\\') ? path : `${path}${separator}`;
    const newPath = `${basePath}${folderName}`;
    loadDirectory(newPath);
  };

  const handleGoUp = () => {
    if (parent) {
      loadDirectory(parent);
    }
  };

  const handleSelect = async () => {
    if (!isOpen || loading || error || launchRequestRef.current) return;
    if (showAgentSelector && selectedAiOptionId !== 'cli' && (agentSelection?.available === false || connectionBlocked)) return;
    const request = { controller: new AbortController(), started: true };
    launchRequestRef.current = request;
    setDefaultsError('');
    setOpening(true);
    const args = [
      path,
      terminalLaunch ? 'cli' : showAgentSelector ? selectedAiOptionId : undefined,
      terminalLaunch ? tabName.trim() || undefined : showAgentSelector ? tabName.trim() : undefined,
    ];
    if (showAgentSelector && selectedAiOptionId !== 'cli') args.push(agentSelection);
    try {
      await onSelect(...args);
      if (!request.controller.signal.aborted) { launchedRef.current = true; onClose(); }
    } catch (failure) {
      if (!request.controller.signal.aborted) setDefaultsError(failure.message || 'Unable to start this agent');
    } finally {
      if (launchRequestRef.current === request) {
        launchRequestRef.current = null;
        setOpening(false);
      }
    }
  };

  const handleRecentClick = async (recentPath) => {
    if (!isOpen || launchRequestRef.current) return;
    const controller = new AbortController();
    const request = { controller, started: false };
    launchRequestRef.current = request;
    setLoadingRecent(true);
    setDefaultsError('');
    try {
      const useProjectDefault = showAgentSelector && manualAgentPathRef.current !== path;
      const defaults = useProjectDefault
        ? resolveLaunchDefaults(await loadWorkspaceProfile(recentPath, { signal: controller.signal }), resolvedAiOptions)
        : null;
      if (controller.signal.aborted) return;
      const agentId = defaults?.agentId || selectedAiOptionId;
      let selection = defaults ? defaults.selection || loadSavedAgentSelection(agentId) : agentSelection;
      if (showAgentSelector && agentId !== 'cli') {
        const response = await apiFetch('/api/agent/catalog', { signal: controller.signal });
        const catalog = await response.json();
        if (controller.signal.aborted) return;
        if (!response.ok) throw new Error(catalog?.error || 'Unable to load agent launcher');
        const liveAgent = catalog.agents?.find(agent => agent.id === agentId);
        if (savedConnectionBinding(agentId) && (!savedConnectionOptions(catalog).some(option => option.id === agentId && option.available === true) || !selection?.model?.trim())) {
          throw new Error('Choose an available saved connection and an explicit model ID.');
        }
        if (liveAgent) {
          if (liveAgent.available === false) throw new Error(liveAgent.label + ' runtime is unavailable on this host');
          const model = selection?.model ?? liveAgent.models?.find(model => model.default)?.id ?? liveAgent.models?.[0]?.id ?? '';
          selection = { model, reasoning: selection?.reasoning || '', ...serviceTierEntry(selection?.serviceTier), ...(liveAgent.launchCommand ? { launchCommand: liveAgent.launchCommand } : {}),
            ...(liveAgent.hostShell ? { hostShell: liveAgent.hostShell } : {}), ...(typeof liveAgent.available === 'boolean' ? { available: liveAgent.available } : {}) };
        }
      }
      const args = [recentPath, terminalLaunch ? 'cli' : showAgentSelector ? agentId : undefined, terminalLaunch ? tabName.trim() || undefined : showAgentSelector ? tabName.trim() : undefined];
      if (showAgentSelector && agentId !== 'cli') args.push(selection);
      request.started = true;
      await onSelect(...args);
      if (!controller.signal.aborted) { launchedRef.current = true; onClose(); }
    } catch (loadError) {
      if (!controller.signal.aborted) setDefaultsError(loadError.message);
    } finally {
      if (launchRequestRef.current === request) {
        launchRequestRef.current = null;
        setLoadingRecent(false);
      }
    }
  };

  const handleAgentSelectionChange = (selection) => {
    setAgentSelection(selection);
    if (selectedAiOptionId !== 'cli') saveAgentSelection(selectedAiOptionId, selection);
  };

  if (!isOpen) return null;

  const normalizedQuery = query.trim().toLowerCase();
  const visibleFolders = normalizedQuery
    ? folders.filter((folder) => folder.toLowerCase().includes(normalizedQuery))
    : folders;

  const pathSegments = path.split(/([/\\])/).filter(Boolean);
  const breadcrumbs = [];
  let accumulated = '';
  for (const seg of pathSegments) {
    accumulated += seg;
    if (seg !== '/' && seg !== '\\') {
      breadcrumbs.push({ name: seg, path: accumulated });
    }
  }

  const modal = (
    <div className="modal-overlay" onClick={onClose}>
      <div className="pro-folder-browser" ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="folder-browser-title" onKeyDown={handleDialogKeyDown} onClick={(e) => e.stopPropagation()}>
        <div className="pro-fb-title-row">
          <h2 id="folder-browser-title">{terminalLaunch ? 'New terminal' : showAgentSelector ? 'New thread' : 'Choose project'}</h2>
          <button type="button" onClick={onClose} aria-label="Close folder browser">×</button>
        </div>
        {/* Path bar with integrated back button and breadcrumbs */}
        <div className="pro-fb-header">
          {parent && (
            <button
              type="button"
              className="pro-fb-back-btn"
              onClick={handleGoUp}
              disabled={loading}
              aria-label="Go up"
            >
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                <path d="M10 12L6 8L10 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
            </button>
          )}

          <div className="pro-fb-breadcrumbs">
            {breadcrumbs.map((crumb, i) => (
              <span key={i} className="pro-fb-breadcrumb-segment">
                {i > 0 && <span className="pro-fb-breadcrumb-sep">/</span>}
                <button
                  type="button"
                  className={`pro-fb-breadcrumb-btn${i === breadcrumbs.length - 1 ? ' active' : ''}`}
                  onClick={() => loadDirectory(crumb.path)}
                >
                  {crumb.name}
                </button>
              </span>
            ))}
          </div>
        </div>

        <div className="pro-fb-content">
          {/* Search with icon */}
          <div className="pro-fb-search">
            <svg className="pro-fb-search-icon" width="14" height="14" viewBox="0 0 14 14" fill="none">
              <circle cx="6" cy="6" r="4.5" stroke="currentColor" strokeWidth="1.5"/>
              <path d="M9.5 9.5L12.5 12.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
            </svg>
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search folders..."
              aria-label="Search folders"
            />
            {query && <button className="pro-fb-search-clear" type="button" aria-label="Clear folder search" title="Clear search" onClick={() => setQuery('')}>×</button>}
          </div>

          {/* Folder list */}
          <div className="pro-fb-list">
            {loading && <div role="status" className="pro-fb-loading">Loading...</div>}
            {error && <div className="pro-fb-error"><p role="alert">{error}</p><button type="button" className="btn-secondary" onClick={() => loadDirectory(requestedDirectoryRef.current)}>Retry loading folder</button></div>}
            {!loading && !error && visibleFolders.length === 0 && (
              <div className="pro-fb-empty">
                <svg width="32" height="32" viewBox="0 0 24 24" fill="none" style={{ opacity: 0.4, marginBottom: 8 }}>
                  <path d="M3 7V17C3 18.1046 3.89543 19 5 19H19C20.1046 19 21 18.1046 21 17V9C21 7.89543 20.1046 7 19 7H12L10 5H5C3.89543 5 3 5.89543 3 7Z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round"/>
                </svg>
                {normalizedQuery ? `No folders match “${query.trim()}”.` : 'No subfolders'}
              </div>
            )}
            {!loading && !error && visibleFolders.map((folder) => (
              <button
                type="button"
                key={folder}
                className="pro-fb-item"
                onClick={() => handleFolderClick(folder)}
              >
                <svg className="pro-fb-item-icon" width="18" height="18" viewBox="0 0 24 24" fill="none">
                  <path d="M3 7V17C3 18.1046 3.89543 19 5 19H19C20.1046 19 21 18.1046 21 17V9C21 7.89543 20.1046 7 19 7H12L10 5H5C3.89543 5 3 5.89543 3 7Z" fill="currentColor" fillOpacity="0.2" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round"/>
                </svg>
                <span className="pro-fb-item-name">{folder}</span>
                <svg className="pro-fb-item-arrow" width="14" height="14" viewBox="0 0 14 14" fill="none">
                  <path d="M5 3L9 7L5 11" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                </svg>
              </button>
            ))}
          </div>

          {/* Recent folders */}
          {recentFolders && recentFolders.length > 0 && (
            <div className="pro-fb-recent">
              <div className="pro-fb-recent-label">
                <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                  <circle cx="6" cy="6" r="5" stroke="currentColor" strokeWidth="1.2"/>
                  <path d="M6 3V6L8 7.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
                </svg>
                Recent
              </div>
              <div className="pro-fb-recent-list">
                {recentFolders.slice(0, 5).map((recent, idx) => {
                  const shortName = recent.split(/[/\\]/).pop() || recent;
                  return (
                    <button
                      type="button"
                      key={idx}
                      className="pro-fb-recent-chip"
                      onClick={() => handleRecentClick(recent)}
                      disabled={loadingRecent || opening}
                      title={recent}
                    >
                      {shortName}
                    </button>
                  );
                })}
              </div>
            </div>
          )}
          {showAgentSelector && <section className="pro-fb-launch-settings" aria-label="Thread settings">
            <div className="pro-fb-launch-row">
              <div className="pro-fb-field pro-fb-agent-field">
                <label htmlFor="folder-browser-ai-select">Agent</label>
                <div className="pro-fb-custom-select" ref={agentControlRef} onBlur={event => {
                  if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget)) setAgentMenuOpen(false);
                }} onKeyDown={event => {
                  if (event.key === 'Escape' && agentMenuOpen) {
                    event.preventDefault(); event.stopPropagation(); setAgentMenuOpen(false);
                    agentControlRef.current?.querySelector('button')?.focus({ preventScroll: true });
                  }
                  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
                  event.preventDefault(); event.stopPropagation(); setAgentMenuOpen(true);
                  const options = [...agentControlRef.current.querySelectorAll('.pro-fb-option')];
                  const index = options.indexOf(document.activeElement);
                  const next = event.key === 'Home' ? 0 : event.key === 'End' ? options.length - 1 : index < 0 ? (event.key === 'ArrowUp' ? options.length - 1 : 0) : (index + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length;
                  options[next]?.focus({ preventScroll: true });
                }}>
                  <button type="button" id="folder-browser-ai-select" className="pro-fb-select-trigger"
                    aria-expanded={agentMenuOpen} aria-controls="folder-browser-ai-options"
                    onClick={() => setAgentMenuOpen(open => !open)}>
                    <span>{selectedAiOption?.label || (savedConnectionBinding(selectedAiOptionId) ? 'Saved connection unavailable' : 'Choose agent')}</span>
                    <span aria-hidden="true">⌄</span>
                  </button>
                  <div id="folder-browser-ai-options" className={`pro-fb-options-list${agentMenuOpen ? ' open' : ''}`}>
                    {resolvedAiOptions.map(option => <button type="button" key={option.id}
                      className={`pro-fb-option${option.id === selectedAiOptionId ? ' selected' : ''}`}
                      aria-pressed={option.id === selectedAiOptionId}
                      onClick={() => {
                        manualAgentPathRef.current = path;
                        setSelectedAiOptionId(option.id);
                        setAgentSelection(loadSavedAgentSelection(option.id));
                        setTabName(option.label || '');
                        setAgentMenuOpen(false);
                        agentControlRef.current?.querySelector('button')?.focus({ preventScroll: true });
                      }}>{option.label}</button>)}
                  </div>
                </div>
              </div>
              {selectedAiOptionId !== 'cli' && !loadingDefaults && <div className="pro-fb-model-field">
                <AgentModelPicker compact agentId={selectedAiOptionId} value={agentSelection} onChange={handleAgentSelectionChange} />
              </div>}
            </div>
            {loadingConnections && <small role="status">Loading saved connections…</small>}
            {connectionsError && <div className="pro-fb-launch-notice"><p role="alert">{connectionsError}</p><button type="button" onClick={() => void loadConnections()}>Retry saved connections</button></div>}
            {loadingDefaults && <small role="status">Loading project defaults…</small>}
            <details className="pro-fb-more-options">
              <summary>More options</summary>
              <div className="pro-fb-optional-fields">
                <div className="pro-fb-field">
                  <label htmlFor="folder-browser-tabname-input">Tab name</label>
                  <input id="folder-browser-tabname-input" className="pro-fb-input" type="text" value={tabName}
                    onChange={event => setTabName(event.target.value)} placeholder="Optional" maxLength={60} />
                </div>
                <WorkspaceProfileButton workspacePath={path} aiOptions={resolvedAiOptions} onSaved={profile => {
                  const defaults = resolveLaunchDefaults(profile, resolvedAiOptions);
                  manualAgentPathRef.current = null;
                  const agentId = defaults?.agentId || resolveInitialAiOptionId(resolvedAiOptions, defaultAiOptionId);
                  setSelectedAiOptionId(agentId);
                  setAgentSelection(defaults?.selection || loadSavedAgentSelection(agentId));
                }} />
              </div>
            </details>
          </section>}
          {terminalLaunch && <div className="pro-fb-field">
            <label htmlFor="folder-browser-terminal-name">Terminal name (optional)</label>
            <input id="folder-browser-terminal-name" className="pro-fb-input" value={tabName} disabled={opening || loadingRecent} onChange={event => setTabName(event.target.value)} placeholder="Optional" maxLength={60} />
          </div>}
          {defaultsError && <p role="alert">{defaultsError}</p>}
        </div>

        {/* Footer with path confirmation */}
        <div className="pro-fb-footer">
          <div className="pro-fb-footer-path" title={path}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
              <path d="M3 7V17C3 18.1046 3.89543 19 5 19H19C20.1046 19 21 18.1046 21 17V9C21 7.89543 20.1046 7 19 7H12L10 5H5C3.89543 5 3 5.89543 3 7Z" fill="currentColor" fillOpacity="0.2" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round"/>
            </svg>
            {path.split(/[/\\]/).pop() || path}
          </div>
          <div className="pro-fb-actions">
            <button type="button" className="pro-fb-btn-cancel" onClick={onClose}>Cancel</button>
            <button type="button" className="pro-fb-btn-select" onClick={handleSelect} disabled={loading || Boolean(error) || loadingDefaults || loadingRecent || opening || (showAgentSelector && selectedAiOptionId !== 'cli' && (agentSelection?.available === false || connectionBlocked))}>
              {opening ? 'Starting…' : terminalLaunch ? 'Open terminal' : showAgentSelector ? 'Start thread' : 'Open here'}
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                <path d="M2 7H12M8 3L12 7L8 11" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
            </button>
          </div>
        </div>
      </div>
    </div>
  );

  if (typeof document === 'undefined') {
    return modal;
  }

  return createPortal(modal, document.body);
}
