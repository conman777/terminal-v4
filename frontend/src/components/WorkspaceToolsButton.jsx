import { FileTransferPanel } from './FileTransferPanel';
import { CollaborationPanel } from './CollaborationPanel';
import { SessionReplayPanel } from './SessionReplayPanel';
import { WorkspaceRewindPanel } from './WorkspaceRewindPanel';
import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { WorkspaceGitPanel } from './WorkspaceGitPanel';
import { SessionHistorySearch } from './SessionHistorySearch';
import { WorkspaceTasksPanel } from './WorkspaceTasksPanel';
import { WorkspaceProposalsPanel } from './WorkspaceProposalsPanel';
import { WorkspaceSkillsPanel } from './WorkspaceSkillsPanel';
import './WorkspaceToolsButton.css';

const tabs = [['git', 'Git & worktrees'], ['history', 'History'], ['rewind', 'Rewind'], ['tasks', 'Tasks & schedules'], ['learning', 'Learning'], ['transfers', 'File transfers'], ['collaboration', 'Share workspace'], ['replays', 'Session replay'], ['skills', 'Installed skills']];

function WorkspaceToolsDialog({ workspacePath, currentSessionId, latestAssistantText, onStartTask, onSelectSession, onInsertPrompt, onClose }) {
  const [tab, setTab] = useState('git');
  const [navigationError, setNavigationError] = useState('');
  const mounted = useRef(false);
  const dialogRef = useRef(null);
  const titleId = useId();
  useEffect(() => { mounted.current = true; dialogRef.current?.focus(); return () => { mounted.current = false; }; }, []);
  function handleKeyDown(event) {
    if (event.key === 'Escape') { event.stopPropagation(); onClose(); }
    if (event.key !== 'Tab') return;
    const fields = dialogRef.current?.querySelectorAll('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), summary, a[href]');
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
  return createPortal(<div className="modal-overlay workspace-tools-overlay" onClick={event => {
    event.stopPropagation();
    if (event.target === event.currentTarget) onClose();
  }}>
    <section className="workspace-tools-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} ref={dialogRef} onKeyDown={handleKeyDown}>
      <header><div><h2 id={titleId}>Workspace tools</h2><p title={workspacePath}>{workspacePath}</p></div>
        <button type="button" aria-label="Close workspace tools" onClick={onClose}>&times;</button></header>
      <div role="tablist" aria-label="Workspace tools" className="workspace-tools-tabs">
        {tabs.map(([id, label], index) => <button key={id} type="button" role="tab" id={titleId + '-tab-' + id}
          aria-controls={titleId + '-panel'} aria-selected={tab === id} tabIndex={tab === id ? 0 : -1}
          onClick={() => setTab(id)} onKeyDown={event => {
            if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
            event.preventDefault();
            const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
            setTab(tabs[next][0]);
            document.getElementById(titleId + '-tab-' + tabs[next][0])?.focus();
          }}>{label}</button>)}
      </div>
      {navigationError && <p role="alert">{navigationError}</p>}
      <div role="tabpanel" id={titleId + '-panel'} aria-labelledby={titleId + '-tab-' + tab} className="workspace-tools-content">
        {tab === 'git' && <WorkspaceGitPanel workspacePath={workspacePath} onStartTask={onStartTask ? path => navigate(onStartTask, path) : undefined} />}
        {tab === 'history' && <SessionHistorySearch workspacePath={workspacePath} onInsertPrompt={onInsertPrompt ? prompt => navigate(onInsertPrompt, prompt) : undefined} onSelectSession={onSelectSession ? id => navigate(onSelectSession, id) : undefined} />}
        {tab === 'rewind' && <WorkspaceRewindPanel workspacePath={workspacePath} onSelectSession={onSelectSession ? id => navigate(onSelectSession, id) : undefined} />}
        {tab === 'tasks' && <WorkspaceTasksPanel workspacePath={workspacePath} currentSessionId={currentSessionId} latestAssistantText={latestAssistantText} onInsertPrompt={onInsertPrompt ? prompt => navigate(onInsertPrompt, prompt) : undefined} />}
        {tab === 'learning' && <WorkspaceProposalsPanel workspacePath={workspacePath} latestAssistantText={latestAssistantText} onRequestSuggestions={onInsertPrompt ? prompt => navigate(onInsertPrompt, prompt) : undefined} />}
        {tab === 'transfers' && <FileTransferPanel workspacePath={workspacePath} />}
        {tab === 'collaboration' && <CollaborationPanel workspacePath={workspacePath} sessionId={currentSessionId} />}
        {tab === 'replays' && <SessionReplayPanel workspacePath={workspacePath} sessionId={currentSessionId} />}
        {tab === 'skills' && <WorkspaceSkillsPanel workspacePath={workspacePath} onInsertContext={onInsertPrompt ? prompt => navigate(onInsertPrompt, prompt) : undefined} />}
      </div>
    </section>
  </div>, document.body);
}

export function WorkspaceToolsButton(props) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef(null);
  function close() { setOpen(false); triggerRef.current?.focus(); }
  return <>
    <button className="workspace-tools-button" type="button" ref={triggerRef} aria-label="Workspace tools"
      disabled={!props.workspacePath} onClick={() => setOpen(true)}>Tools</button>
    {open && <WorkspaceToolsDialog key={props.workspacePath} {...props} onClose={close} />}
  </>;
}
