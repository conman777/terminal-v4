import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { subscribeEnvironment } from '../utils/remoteEnvironments';
import { FollowupQueuePanel } from './FollowupQueuePanel';
import './WorkspaceToolsButton.css';

function QueueDialog({ sessionId, onClose }) {
  const dialog = useRef(null);
  useEffect(() => { dialog.current?.focus(); }, []);
  function handleKeyDown(event) {
    if (event.key === 'Escape') { event.stopPropagation(); onClose(); }
    if (event.key !== 'Tab') return;
    const fields = dialog.current?.querySelectorAll('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), a[href]');
    if (!fields?.length) return;
    const first = fields[0], last = fields[fields.length - 1];
    if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog.current)) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  }
  return createPortal(<div className="modal-overlay workspace-tools-overlay" onClick={event => { event.stopPropagation(); if (event.target === event.currentTarget) onClose(); }}>
    <section className="workspace-tools-dialog" style={{ maxWidth: 760 }} role="dialog" aria-modal="true" aria-label="Follow-up queue" tabIndex={-1} ref={dialog} onKeyDown={handleKeyDown}>
      <div className="workspace-tools-content"><FollowupQueuePanel sessionId={sessionId} active={true} onClose={onClose} /></div>
    </section>
  </div>, document.body);
}

export function FollowupQueueButton({ sessionId }) {
  const [openSession, setOpenSession] = useState(null);
  const trigger = useRef(null);
  useEffect(() => { setOpenSession(null); }, [sessionId]);
  useEffect(() => subscribeEnvironment(() => setOpenSession(null)), []);
  function close() { setOpenSession(null); trigger.current?.focus(); }
  return <>
    <button type="button" className="workspace-tools-button" style={{ minHeight: 44 }} ref={trigger} aria-label="Open follow-up queue" disabled={!sessionId} onClick={() => setOpenSession(sessionId)}>Queue</button>
    {sessionId && openSession === sessionId && <QueueDialog key={sessionId} sessionId={sessionId} onClose={close} />}
  </>;
}
