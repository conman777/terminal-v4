import { useState, useSyncExternalStore } from 'react';
import { dismissSupervisedInputScopeNotice, getSupervisedInputQueues, subscribeSupervisedInputQueues } from '../utils/supervisedRawInputQueue';
import './RawInputPending.css';

export function RawInputPending({ sessions = [] }) {
  const entries = useSyncExternalStore(subscribeSupervisedInputQueues, getSupervisedInputQueues);
  const [minimized, setMinimized] = useState(false);
  if (!entries.length) return null;
  if (minimized) return <button type="button" className="raw-input-pending-minimized" onClick={() => setMinimized(false)}>Show pending input ({entries.length})</button>;
  return <section className="raw-input-pending" aria-label="Pending terminal input" role="status" aria-live="polite">
    <button type="button" onClick={() => setMinimized(true)}>Minimize input status</button>
    {entries.map(entry => entry.scopeChanged ? <div key="scope-changed"><p>{entry.scopeUncertain ? 'The account or server changed while input was being sent. Check the terminal: it may have been delivered. Any waiting input was discarded.' : 'Waiting terminal input was discarded because the account or server changed.'}</p><button type="button" onClick={dismissSupervisedInputScopeNotice}>Dismiss input notice</button></div> : <div key={entry.sessionId}>
      <p>{sessions.find(session => session.id === entry.sessionId)?.title || entry.sessionId}: {entry.sending ? 'Sending input.' : entry.halted ? 'Input paused.' : 'Preparing input.'} {entry.pending ? `${entry.pending} characters waiting.` : ''}</p>
      {(entry.pending > 0 || entry.sending) && <p>Input being prepared is hidden for privacy and may be lost if this tab closes before it is sent.</p>}
      {entry.error && <p>{entry.error}</p>}
      {entry.halted && entry.pending > 0 && <div>
        <button type="button" onClick={() => entry.queue.resume()}>Send waiting input after review</button>
        <button type="button" onClick={() => entry.queue.discard()}>Discard waiting input</button>
      </div>}
      {entry.halted && !entry.pending && <button type="button" onClick={() => entry.queue.discard()}>Dismiss input notice</button>}
    </div>)}
  </section>;
}
