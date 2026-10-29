import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { subscribeEnvironment } from '../utils/remoteEnvironments';
import { ConversationContextPanel } from './ConversationContextPanel';
import './ConversationContextPanel.css';

function ContextDialog({ onClose, triggerRef, ...props }) {
  const dialog = useRef(null);
  useEffect(() => {
    const background = [...new Set([document.getElementById('root'), triggerRef.current?.closest('[role="dialog"]')])].filter(Boolean);
    const previous = background.map(element => element.inert);
    background.forEach(element => { element.inert = true; });
    dialog.current?.focus();
    return () => {
      background.forEach((element, index) => { element.inert = previous[index]; });
      triggerRef.current?.focus({ preventScroll: true });
    };
  }, []);
  function keyDown(event) {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose(); return; }
    if (event.key !== 'Tab') return;
    const fields = dialog.current?.querySelectorAll('button:not(:disabled), textarea:not(:disabled), input:not(:disabled), select:not(:disabled), a[href], summary');
    if (!fields?.length) { event.preventDefault(); return; }
    const first = fields[0], last = fields[fields.length - 1];
    if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog.current)) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  }
  return createPortal(<div className="conversation-context-overlay" onClick={event => { event.stopPropagation(); if (event.target === event.currentTarget) onClose(); }}>
    <section className="conversation-context-dialog" ref={dialog} role="dialog" aria-modal="true" aria-label="Conversation context" tabIndex={-1} onKeyDown={keyDown}>
      <ConversationContextPanel {...props} active={true} onClose={onClose} />
    </section>
  </div>, document.body);
}

export function ConversationContextButton({ sessionId, active = true, ...props }) {
  const [openSession, setOpenSession] = useState(null), trigger = useRef(null);
  useEffect(() => { setOpenSession(null); }, [sessionId, active]);
  useEffect(() => subscribeEnvironment(() => setOpenSession(null)), []);
  function close() { setOpenSession(null); }
  return <><button type="button" className="workspace-tools-button conversation-context-trigger" ref={trigger} aria-label="Open conversation context" aria-haspopup="dialog" aria-expanded={Boolean(sessionId && active && openSession === sessionId)} disabled={!sessionId || !active} onClick={() => setOpenSession(sessionId)}>Context</button>
    {active && sessionId && openSession === sessionId && <ContextDialog {...props} key={sessionId} sessionId={sessionId} triggerRef={trigger} onClose={close} />}</>;
}
