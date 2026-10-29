import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { apiFetch } from '../utils/api';
import { buildThreadLineage } from '../utils/threadLineage';
import { getPreferredSessionTopic } from '../utils/sessionTopic';
import './ThreadRelations.css';

const KIND_LABEL = { fork: 'Fork', delegated: 'Delegated', worktree: 'Worktree' };

function threadTitle(session, id) {
  return session ? getPreferredSessionTopic(session.thread?.topic, session.title || 'New session') : id;
}

async function loadJson(url, signal) {
  const response = await apiFetch(url, { signal });
  if (!response.ok) throw new Error('Request failed');
  return response.json();
}

export default function ThreadLineageDialog({ session, sessions, onOpen, onClose }) {
  const [state, setState] = useState({ status: 'loading', links: [], tasks: [] });
  const [attempt, setAttempt] = useState(0);
  const dialogRef = useRef(null);
  const title = threadTitle(session, session.id);

  useEffect(() => {
    const controller = new AbortController();
    setState({ status: 'loading', links: [], tasks: [] });
    Promise.all([loadJson('/api/thread-lineage', controller.signal), loadJson('/api/workspace/tasks', controller.signal)])
      .then(([lineage, tasks]) => {
        if (!controller.signal.aborted) setState({ status: 'ready', links: Array.isArray(lineage?.links) ? lineage.links : [], tasks: Array.isArray(tasks?.tasks) ? tasks.tasks : [] });
      })
      .catch(() => { if (!controller.signal.aborted) setState({ status: 'error', links: [], tasks: [] }); });
    return () => controller.abort();
  }, [attempt]);

  useEffect(() => { dialogRef.current?.focus(); }, []);

  useEffect(() => {
    const dismiss = event => { if (dialogRef.current && !dialogRef.current.contains(event.target)) onClose(); };
    document.addEventListener('pointerdown', dismiss);
    return () => document.removeEventListener('pointerdown', dismiss);
  }, [onClose]);

  const lineage = useMemo(() => buildThreadLineage({ threadId: session.id, sessions, links: state.links, tasks: state.tasks }), [session.id, sessions, state.links, state.tasks]);
  const open = useCallback(id => { onOpen?.(id); onClose(); }, [onOpen, onClose]);

  const sections = [
    ['Forked from', lineage.parent ? [lineage.parent] : []],
    ['Forks', lineage.forks],
    ['Delegated threads', lineage.delegated],
    ['Other worktrees', lineage.worktrees],
  ].filter(([, items]) => items.length > 0);

  return createPortal(
    <div
      ref={dialogRef}
      className="thread-lineage"
      role="dialog"
      aria-label={`Related threads for ${title}`}
      tabIndex={-1}
      onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); onClose(); } }}
    >
      <div className="thread-lineage-head">
        <strong>Related threads</strong>
        <button type="button" className="thread-lineage-close" aria-label="Close related threads" onClick={onClose}>×</button>
      </div>
      {state.status === 'loading' && <p role="status" className="thread-lineage-note">Loading related threads…</p>}
      {state.status === 'error' && <div role="alert" className="thread-lineage-note">
        <span>Could not load related threads.</span>
        <button type="button" onClick={() => setAttempt(value => value + 1)}>Retry</button>
      </div>}
      {state.status === 'ready' && sections.length === 0 && <p className="thread-lineage-note">No related threads yet.</p>}
      {state.status === 'ready' && sections.map(([heading, items]) => (
        <section key={heading} className="thread-lineage-section">
          <h3>{heading}</h3>
          <ul>
            {items.map(item => {
              const label = threadTitle(item.session, item.id);
              return (
                <li key={`${item.kind}:${item.id}`}>
                  <button type="button" disabled={!item.session} aria-label={item.session ? undefined : `${label} (unavailable)`} onClick={() => open(item.id)}>
                    <span className="thread-lineage-title">{label}</span>
                    <span className="thread-lineage-kind">{item.session ? KIND_LABEL[item.kind] : 'Unavailable'}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </div>,
    document.body,
  );
}
