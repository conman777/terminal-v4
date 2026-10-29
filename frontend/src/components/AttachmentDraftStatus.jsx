import { useRef, useState } from 'react';
import './AttachmentDraftStatus.css';

export default function AttachmentDraftStatus({ error, conflict, currentItems = [], onRetry, onUseSaved }) {
  const [reviewed, setReviewed] = useState(null);
  const reviewButton = useRef(null);
  const reviewing = Boolean(conflict && reviewed === conflict);

  return <div role="alert" className="remote-readonly-notice attachment-draft-status">
    <p>{error}</p>
    {conflict ? <button ref={reviewButton} type="button" onClick={() => setReviewed(conflict)}>Review saved files</button>
      : <button type="button" onClick={onRetry}>Retry saving files</button>}
    {reviewing && <div role="group" aria-label="Saved file selections" className="attachment-draft-review">
      <p>Using these will replace your current file selections. Your message text will stay the same.</p>
      <p>Sending remains blocked until the conflict is resolved. Current files may only be in this tab; note their paths if you need to attach them again.</p>
      <div className="attachment-draft-review-list">
        <p>Current files:</p>
        {currentItems.length ? <ul>{currentItems.map((item, index) => <li key={`${item.path}:${index}`}><strong>{item.name}</strong> <span>{item.path}</span></li>)}</ul> : <p>No current files.</p>}
        <p>Saved files:</p>
        {conflict.items.length ? <ul>{conflict.items.map((item, index) => <li key={`${item.path}:${index}`}><strong>{item.name}</strong> <span>{item.path}</span></li>)}</ul>
          : <p>The saved selection has no files.</p>}
      </div>
      <div className="attachment-draft-review-actions">
        <button type="button" onClick={() => { const accepted = onUseSaved(reviewed); setReviewed(null); if (!accepted) reviewButton.current?.focus(); }}>Use saved files</button>
        <button type="button" onClick={() => { setReviewed(null); reviewButton.current?.focus(); }}>Close review</button>
      </div>
    </div>}
  </div>;
}
