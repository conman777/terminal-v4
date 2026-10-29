import { useEffect, useId, useMemo, useRef, useState } from 'react';
import './CommandPalette.css';

const LIMIT = 40;

// T3 Code's ⌘K palette: run any workspace command or jump to a thread by typing its name.
export function CommandPalette({ open, onClose, commands = [], threads = [], onSelectThread }) {
  const [query, setQuery] = useState('');
  const [index, setIndex] = useState(0);
  const input = useRef(null);
  const listId = useId();
  useEffect(() => { if (open) { setQuery(''); setIndex(0); input.current?.focus(); } }, [open]);

  const results = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const matches = text => !needle || text.toLowerCase().includes(needle);
    return [
      ...commands.filter(command => matches(command.label)).map(command => ({ key: `c:${command.id}`, label: command.label, hint: command.hint, run: command.run })),
      ...threads.filter(thread => matches(`${thread.title} ${thread.project || ''}`)).map(thread => ({
        key: `t:${thread.id}`, label: thread.title, hint: thread.project, run: () => onSelectThread?.(thread.id),
      })),
    ].slice(0, LIMIT);
  }, [commands, onSelectThread, query, threads]);

  useEffect(() => { setIndex(0); }, [query]);
  if (!open) return null;
  const choose = result => { if (!result) return; onClose?.(); result.run?.(); };
  const keyDown = event => {
    if (event.key === 'Escape') { event.preventDefault(); onClose?.(); }
    else if (event.key === 'ArrowDown') { event.preventDefault(); setIndex(current => Math.min(current + 1, results.length - 1)); }
    else if (event.key === 'ArrowUp') { event.preventDefault(); setIndex(current => Math.max(current - 1, 0)); }
    else if (event.key === 'Enter') { event.preventDefault(); choose(results[index]); }
  };
  return (
    <div className="command-palette-backdrop" onPointerDown={event => { if (event.target === event.currentTarget) onClose?.(); }}>
      <div className="command-palette" role="dialog" aria-modal="true" aria-label="Command palette">
        <input ref={input} role="combobox" aria-expanded="true" aria-controls={listId} aria-label="Search commands and threads"
          aria-activedescendant={results[index] ? `${listId}-${index}` : undefined}
          placeholder="Type a command or thread name…" value={query} onChange={event => setQuery(event.target.value)} onKeyDown={keyDown} />
        <ul id={listId} role="listbox" aria-label="Results">
          {results.map((result, position) => (
            <li key={result.key} id={`${listId}-${position}`} role="option" aria-selected={position === index}
              className={position === index ? 'selected' : ''} onPointerMove={() => setIndex(position)} onClick={() => choose(result)}>
              <span>{result.label}</span>{result.hint && <small>{result.hint}</small>}
            </li>
          ))}
          {results.length === 0 && <li className="command-palette-empty" role="presentation">No matches</li>}
        </ul>
      </div>
    </div>
  );
}
