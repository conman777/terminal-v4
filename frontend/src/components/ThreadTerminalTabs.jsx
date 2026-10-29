import { useRef } from 'react';
import './ThreadTerminalTabs.css';

export const terminalTabId = id => `thread-terminal-tab-${id}`;
export const terminalPanelId = id => `thread-terminal-panel-${id}`;

export function ThreadTerminalTabs({ terminals, selectedId, onSelect, onAdd, onClose, onSplit, splitLabel = 'Split terminal', disabled = false, className = '', label = 'Thread terminals', withPanels = true }) {
  const list = useRef(null);
  const selectedIndex = Math.max(0, terminals.findIndex(terminal => terminal.id === selectedId));

  function onKeyDown(event) {
    const last = terminals.length - 1;
    const target = { ArrowRight: (selectedIndex + 1) % terminals.length, ArrowLeft: (selectedIndex + last) % terminals.length, Home: 0, End: last }[event.key];
    if (target === undefined || event.altKey || event.ctrlKey || event.metaKey) return;
    event.preventDefault();
    onSelect(terminals[target].id);
    list.current?.querySelector(`#${CSS.escape(terminalTabId(terminals[target].id))}`)?.focus();
  }

  return <div className={`thread-terminal-tabs ${className}`.trim()}>
    <div role="tablist" aria-label={label} ref={list} className="thread-terminal-tablist" onKeyDown={onKeyDown}>
      {terminals.map((terminal, index) => <button key={terminal.id} type="button" role="tab" id={terminalTabId(terminal.id)}
        aria-selected={terminal.id === selectedId} aria-controls={withPanels ? terminalPanelId(terminal.id) : undefined} tabIndex={index === selectedIndex ? 0 : -1}
        onClick={() => onSelect(terminal.id)}>{`Terminal ${index + 1}`}</button>)}
    </div>
    <div className="thread-terminal-actions">
      <button type="button" className="thread-terminal-add" aria-label="New terminal in this thread" disabled={disabled} onClick={onAdd}>+</button>
      {onSplit && <button type="button" aria-label={splitLabel} disabled={disabled} onClick={onSplit}>Split</button>}
      {onClose && <button type="button" aria-label={`Close Terminal ${selectedIndex + 1}`} disabled={disabled} onClick={() => onClose(terminals[selectedIndex].id)}>×</button>}
    </div>
  </div>;
}
