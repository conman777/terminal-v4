import { FileTransferPanel } from './FileTransferPanel';
import { CollaborationPanel } from './CollaborationPanel';
import { SessionReplayPanel } from './SessionReplayPanel';
import { WorkspaceRewindPanel } from './WorkspaceRewindPanel';
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { useMobileDetect } from '../hooks/useMobileDetect';
import { useViewportMetrics } from '../hooks/useViewportHeight';
import { createPortal } from 'react-dom';
import { WorkspaceGitPanel } from './WorkspaceGitPanel';
import { SessionHistorySearch } from './SessionHistorySearch';
import { WorkspaceTasksPanel } from './WorkspaceTasksPanel';
import { WorkspaceProposalsPanel } from './WorkspaceProposalsPanel';
import { WorkspaceSkillsPanel } from './WorkspaceSkillsPanel';
import './WorkspaceToolsButton.css';

const tabs = [['git', 'Git & worktrees'], ['history', 'History'], ['rewind', 'Rewind'], ['tasks', 'Tasks & schedules'], ['learning', 'Learning'], ['skills', 'Installed skills'], ['transfers', 'File transfers'], ['collaboration', 'Share workspace'], ['replays', 'Session replay']];
const groups = [
  { label: 'Code & history', ids: ['git', 'history', 'rewind'] },
  { label: 'Plan & improve', ids: ['tasks', 'learning', 'skills'] },
  { label: 'Share & move', ids: ['transfers', 'collaboration', 'replays'] },
];
const descriptions = { git: 'Changes, branches and worktrees', history: 'Find a saved conversation', rewind: 'Restore an earlier checkpoint', tasks: 'Manage tasks and schedules', learning: 'Review project suggestions', skills: 'Browse installed skills', transfers: 'Send and receive files', collaboration: 'Invite someone to your workspace', replays: 'Review a recorded session' };

function WorkspaceToolsDialog({ workspacePath, currentSessionId, latestAssistantText, initialTool, onStartTask, onSelectSession, onInsertPrompt, onClose }) {
  const hasInitialTool = tabs.some(([id]) => id === initialTool);
  const startingTool = hasInitialTool ? initialTool : 'git';
  const [tab, setTab] = useState(startingTool);
  const [navigationError, setNavigationError] = useState('');
  const [showTool, setShowTool] = useState(hasInitialTool);
  const isMobile = useMobileDetect();
  const [visited, setVisited] = useState(() => isMobile && !hasInitialTool ? [] : [startingTool]);
  const viewport = useViewportMetrics();
  const mounted = useRef(false);
  const dialogRef = useRef(null);
  const titleId = useId();
  const backRef = useRef(null);
  useEffect(() => {
    mounted.current = true;
    const root = document.getElementById('root');
    const previousInert = root?.inert;
    if (root) root.inert = true;
    if (isMobile && showTool) backRef.current?.focus({ preventScroll: true });
    else if (isMobile) document.getElementById(titleId + '-tab-' + tab)?.focus({ preventScroll: true });
    else dialogRef.current?.focus();
    return () => { mounted.current = false; if (root) root.inert = previousInert; };
  }, []);
  useLayoutEffect(() => {
    if (!isMobile) return;
    if (showTool) backRef.current?.focus({ preventScroll: true });
    else document.getElementById(titleId + '-tab-' + tab)?.focus({ preventScroll: true });
  }, [showTool, isMobile, tab, titleId]);
  useEffect(() => {
    if (!isMobile) setVisited(current => current.includes(tab) ? current : [...current, tab]);
  }, [isMobile, tab]);
  function selectTool(id) {
    setTab(id);
    setVisited(current => current.includes(id) ? current : [...current, id]);
    setShowTool(true);
    setNavigationError('');
  }
  function handleKeyDown(event) {
    if (event.isComposing || event.keyCode === 229) return;
    if (event.target.closest('[role="dialog"]') !== event.currentTarget) return;
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); if (isMobile && showTool) setShowTool(false); else onClose(); }
    if (event.key !== 'Tab') return;
    const fields = [...dialogRef.current.querySelectorAll('*')].filter(element => {
      const focusable = element.matches('button, input, textarea, select, summary, a[href], [tabindex]');
      const collapsed = element.closest('details:not([open])');
      return focusable && element.tabIndex >= 0 && !element.matches(':disabled, input[type="hidden"]')
        && !element.closest('[hidden]') && (!collapsed || collapsed.querySelector(':scope > summary') === element);
    });
    if (!fields?.length) return;
    const first = fields[0];
    const last = fields[fields.length - 1];
    if (event.shiftKey && (document.activeElement === first || document.activeElement === dialogRef.current)) {
      event.preventDefault(); last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault(); first.focus();
    }
  }
  function navigate(callback, value) {
    setNavigationError('');
    try {
      const result = callback?.(value);
      if (result?.then) {
        result.then(() => { if (mounted.current) onClose(); }).catch(error => {
          if (mounted.current) setNavigationError(error?.message || 'Unable to open workspace');
        });
      } else onClose();
    } catch (error) {
      setNavigationError(error?.message || 'Unable to open workspace');
    }
  }
  return createPortal(<div className="modal-overlay workspace-tools-overlay" style={{ top: viewport.offsetTop, left: viewport.offsetLeft, width: viewport.width, height: viewport.height, right: 'auto', bottom: 'auto' }} onClick={event => {
    event.stopPropagation();
    if (event.target === event.currentTarget) onClose();
  }}>
    <section className="workspace-tools-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} ref={dialogRef} onKeyDown={handleKeyDown}>
      <header><div>{isMobile && showTool && <button ref={backRef} type="button" className="workspace-tools-back" onClick={() => setShowTool(false)}><span aria-hidden="true">‹</span> All tools</button>}<h2 id={titleId}>{isMobile && showTool ? tabs.find(([id]) => id === tab)?.[1] : 'Workspace tools'}</h2><p title={workspacePath}>{workspacePath}</p></div>
        <button type="button" aria-label="Close workspace tools" onClick={onClose}>&times;</button></header>
      <div className="workspace-tools-body">
      <nav role="tablist" aria-label="Workspace tools" aria-orientation="vertical" className="workspace-tools-tabs" hidden={isMobile && showTool}>
        {groups.map(group => <div className="workspace-tools-group" key={group.label}><h3>{group.label}</h3>{group.ids.map(id => {
          const index = tabs.findIndex(([tabId]) => tabId === id);
          const label = tabs[index][1];
          return <button key={id} type="button" role="tab" id={titleId + '-tab-' + id} aria-label={label}
          aria-controls={titleId + '-panel-' + id} aria-selected={tab === id} tabIndex={tab === id ? 0 : -1}
          onClick={event => { event.currentTarget.focus({ preventScroll: true }); selectTool(id); }} onKeyDown={event => {
            if (!['ArrowLeft', 'ArrowRight', 'ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
            event.preventDefault();
            const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (index + (['ArrowRight', 'ArrowDown'].includes(event.key) ? 1 : -1) + tabs.length) % tabs.length;
            setTab(tabs[next][0]);
            document.getElementById(titleId + '-tab-' + tabs[next][0])?.focus();
          }}><span><span>{label}</span><small>{descriptions[id]}</small></span><span className="workspace-tools-chevron" aria-hidden="true">›</span></button>;
        })}</div>)}
      </nav>
      <div className="workspace-tools-content" hidden={isMobile && !showTool}>
        {navigationError && <p role="alert">{navigationError}</p>}
        {tabs.map(([id]) => <div key={id} role="tabpanel" id={titleId + '-panel-' + id} aria-labelledby={titleId + '-tab-' + id} tabIndex={0} hidden={tab !== id}>
          {visited.includes(id) && <>
            {id === 'git' && <WorkspaceGitPanel workspacePath={workspacePath} onStartTask={onStartTask ? path => navigate(onStartTask, path) : undefined} />}
            {id === 'history' && <SessionHistorySearch workspacePath={workspacePath} onInsertPrompt={onInsertPrompt ? prompt => navigate(onInsertPrompt, prompt) : undefined} onSelectSession={onSelectSession ? id => navigate(onSelectSession, id) : undefined} />}
            {id === 'rewind' && <WorkspaceRewindPanel workspacePath={workspacePath} onSelectSession={onSelectSession ? id => navigate(onSelectSession, id) : undefined} />}
            {id === 'tasks' && <WorkspaceTasksPanel workspacePath={workspacePath} currentSessionId={currentSessionId} latestAssistantText={latestAssistantText} onInsertPrompt={onInsertPrompt ? prompt => navigate(onInsertPrompt, prompt) : undefined} />}
            {id === 'learning' && <WorkspaceProposalsPanel workspacePath={workspacePath} latestAssistantText={latestAssistantText} onRequestSuggestions={onInsertPrompt ? prompt => navigate(onInsertPrompt, prompt) : undefined} />}
            {id === 'transfers' && <FileTransferPanel workspacePath={workspacePath} />}
            {id === 'collaboration' && <CollaborationPanel workspacePath={workspacePath} sessionId={currentSessionId} onInsertPrompt={onInsertPrompt ? prompt => navigate(onInsertPrompt, prompt) : undefined} />}
            {id === 'replays' && <SessionReplayPanel workspacePath={workspacePath} sessionId={currentSessionId} />}
            {id === 'skills' && <WorkspaceSkillsPanel workspacePath={workspacePath} onInsertContext={onInsertPrompt ? prompt => navigate(onInsertPrompt, prompt) : undefined} />}
          </>}
        </div>)}
      </div>
      </div>
    </section>
  </div>, document.body);
}

export function WorkspaceToolsButton(props) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef(null);
  const wasOpen = useRef(false);
  const accessibleLabel = props.ariaLabel || props.label || 'Workspace tools';
  useEffect(() => { if (!open && wasOpen.current) triggerRef.current?.focus({ preventScroll: true }); wasOpen.current = open; }, [open]);
  function close() { setOpen(false); }
  return <>
    <button className={`workspace-tools-button${props.iconOnly ? ' workspace-tools-button-icon-only' : ''}`} type="button" ref={triggerRef} aria-label={accessibleLabel}
      aria-haspopup="dialog" aria-expanded={open} title={accessibleLabel}
      disabled={!props.workspacePath} onClick={() => setOpen(true)}>
      {props.icon || (props.iconOnly && <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
        {props.initialTool === 'git' ? <><circle cx="6" cy="5" r="2" /><circle cx="18" cy="5" r="2" /><circle cx="6" cy="19" r="2" /><path d="M6 7v10M18 7a8 8 0 0 1-8 8H6" /></> : <path d="M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z" />}
      </svg>)}
      {!props.iconOnly && (props.label || 'Tools')}
    </button>
    {open && <WorkspaceToolsDialog key={props.workspacePath} {...props} latestAssistantText={props.readLatestAssistantText?.() ?? props.latestAssistantText} onClose={close} />}
  </>;
}
