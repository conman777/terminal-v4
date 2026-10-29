import './PlanActions.css';

// T3 Code's plan card: once a plan-only turn finishes, implement it here or in a fresh thread.
export function PlanActions({ plan, onImplement, onImplementInNewThread, disabled = false }) {
  if (!onImplement && !onImplementInNewThread) return null;
  return (
    <section className="plan-actions" aria-label="Plan ready">
      <span className="plan-actions-title">Plan ready</span>
      <div className="plan-actions-buttons">
        {onImplementInNewThread && <button type="button" onClick={() => onImplementInNewThread(plan)} disabled={disabled}>Implement in a new thread</button>}
        {onImplement && <button type="button" className="plan-actions-primary" onClick={() => onImplement(plan)} disabled={disabled}>Implement plan</button>}
      </div>
    </section>
  );
}
