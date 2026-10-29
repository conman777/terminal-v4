import { useCallback, useEffect, useRef, useState } from 'react';
import { cancelWorktreeCreation, fetchWorktreeProgress } from '../utils/worktreeProgress';
import './WorktreeSetupCard.css';

const POLL_MS = 800;
const STATUS_TEXT = { pending: 'Pending', running: 'Running', done: 'Done', failed: 'Failed', warning: 'Warning', skipped: 'Skipped', cancelled: 'Cancelled' };
const PLACEHOLDER = [
  { id: 'base', label: 'Checking base', status: 'pending', detail: '' },
  { id: 'checkout', label: 'Creating worktree', status: 'pending', detail: '' },
  { id: 'setup', label: 'Setup script', status: 'pending', detail: '' },
];

export function WorktreeSetupCard({ operationId, poll = true, pollMs = POLL_MS }) {
  const [progress, setProgress] = useState(null);
  const [cancelState, setCancelState] = useState('idle');
  const finished = progress && progress.status !== 'running';

  useEffect(() => {
    if (!operationId || !poll) return undefined;
    const controller = new AbortController();
    let timer = 0;
    const tick = async () => {
      let next = null;
      try { next = await fetchWorktreeProgress(operationId, controller.signal); } catch { /* the next poll retries */ }
      if (controller.signal.aborted) return;
      if (next) setProgress(next);
      if (!next || next.status === 'running') timer = window.setTimeout(tick, pollMs);
    };
    tick();
    return () => { controller.abort(); window.clearTimeout(timer); };
  }, [operationId, poll, pollMs]);

  const cancel = useCallback(async () => {
    setCancelState('requesting');
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        const next = await cancelWorktreeCreation(operationId);
        if (next) { setProgress(next); setCancelState('requested'); return; }
      } catch { /* retry while the request registers */ }
      await new Promise(resolve => window.setTimeout(resolve, 400));
    }
    setCancelState('failed');
  }, [operationId]);

  const stages = progress?.stages?.length ? progress.stages : PLACEHOLDER;
  const running = stages.find(stage => stage.status === 'running');
  const cancelling = cancelState === 'requesting' || progress?.cancelling || cancelState === 'requested' && !finished;
  let summary = 'Starting worktree setup…';
  if (progress?.status === 'ready') summary = 'Worktree is ready.';
  else if (progress?.status === 'cancelled') summary = progress.cleanup || 'Worktree setup was cancelled.';
  else if (progress?.status === 'failed') summary = progress.error || 'Worktree setup failed.';
  else if (cancelling) summary = 'Cancelling and removing the partial checkout…';
  else if (running) summary = `${running.label}…`;

  return (
    <section className="worktree-setup-card" aria-label="Worktree setup progress">
      <header>
        <h2>Setting up worktree</h2>
        {progress && <span className="worktree-setup-elapsed">{Math.floor(progress.elapsedMs / 1000)}s</span>}
      </header>
      <ol className="worktree-setup-stages">
        {stages.map(stage => <li key={stage.id} data-status={stage.status}>
          <span className="worktree-setup-stage-label">{stage.label}</span>
          <span className="worktree-setup-stage-status">{STATUS_TEXT[stage.status]}</span>
          {stage.detail && <small>{stage.detail}</small>}
        </li>)}
      </ol>
      {progress?.tail?.length > 0 && <pre className="worktree-setup-tail" tabIndex={0} aria-label="Latest setup output">{progress.tail.slice(-4).join('\n')}</pre>}
      <p role="status" className="worktree-setup-summary">{summary}</p>
      {cancelState === 'failed' && <p role="alert" className="worktree-setup-error">Could not reach the server to cancel. Try again.</p>}
      {!finished && <button type="button" className="worktree-setup-cancel" disabled={cancelling} onClick={cancel}>{cancelling ? 'Cancelling…' : 'Cancel worktree setup'}</button>}
    </section>
  );
}
