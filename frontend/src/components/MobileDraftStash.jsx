import { useRef, useState } from 'react';
import { useDraftStash } from '../hooks/useDraftStash';

export function MobileDraftStash({ composerValue, onComposerChange }) {
  const [open, setOpen] = useState(false);
  const toggle = useRef(null);
  const { items, error, stash, restore } = useDraftStash();
  const hasDraft = Boolean(composerValue.trim());
  return <div className="mobile-draft-stash" onKeyDown={event => {
    if (event.key !== 'Escape' || !open) return;
    event.preventDefault();
    event.stopPropagation();
    setOpen(false);
    toggle.current?.focus();
  }}>
    <button type="button" ref={toggle} className="mobile-stash-toggle" aria-expanded={open} onClick={() => setOpen(value => !value)}>
      {items.length ? `Stash (${items.length})` : 'Stash'}
    </button>
    {open && <div role="group" aria-label="Stashed drafts" className="mobile-stash-list">
      <button type="button" disabled={!hasDraft} onClick={() => { if (stash(composerValue)) onComposerChange('') }}>Stash this draft</button>
      {items.length === 0 && <p role="status">No stashed drafts</p>}
      {items.map(item => <button type="button" key={item.id} aria-label={`Restore draft: ${item.text.slice(0, 60)}`} title={new Date(item.at).toLocaleString()}
        onClick={() => { const text = restore(item.id); if (text) onComposerChange(hasDraft ? `${composerValue.trimEnd()}\n${text}` : text); }}>
        <span>{item.text.slice(0, 60)}</span><small>{new Date(item.at).toLocaleString()}</small>
      </button>)}
    </div>}
    {error && <p role="alert" className="mobile-stash-error">{error}</p>}
  </div>;
}
