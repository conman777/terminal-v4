import { useState } from 'react';
import { apiGet } from '../utils/api';
import { DiffView } from './DiffView';
import './TurnChangesCard.css';

function Delta({ added, removed }) {
  return <span className="turn-changes-delta"><span className="turn-changes-added">+{(added ?? 0).toLocaleString()}</span><span className="turn-changes-removed">−{(removed ?? 0).toLocaleString()}</span></span>;
}

// T3 Code's per-turn summary: which files the agent changed, with each file's diff on demand.
export function TurnChangesCard({ changes, workspacePath, onComment }) {
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState('');
  const [diff, setDiff] = useState(null);
  const [error, setError] = useState('');
  const count = changes.files.length;

  const showFile = async (path) => {
    if (selected === path) { setSelected(''); return; }
    setSelected(path); setDiff(null); setError('');
    try {
      const query = new URLSearchParams({ path: workspacePath, mode: 'turn', from: changes.from, to: changes.to, file: path });
      setDiff(await apiGet(`/api/workspace/git/diff?${query}`));
    } catch (failure) {
      setError(failure?.message || 'Diff unavailable');
    }
  };

  return (
    <section className="turn-changes" aria-label="Files changed in this turn">
      <div className="turn-changes-head">
        <span className="turn-changes-title"><span>{count === 1 ? '1 changed file' : `${count} changed files`}</span><Delta added={changes.added} removed={changes.removed} /></span>
        {workspacePath && <button type="button" className="turn-changes-toggle" aria-expanded={open} onClick={() => setOpen(value => !value)}>{open ? 'Hide diff' : 'Open diff'}</button>}
      </div>
      {open && <ul className="turn-changes-files">
        {changes.files.map(file => <li key={file.path}>
          <button type="button" className="turn-changes-file" aria-expanded={selected === file.path} onClick={() => showFile(file.path)}>
            <span className="turn-changes-path">{file.path}</span>{file.binary ? <span className="turn-changes-delta">binary</span> : <Delta added={file.added} removed={file.removed} />}
          </button>
          {selected === file.path && <div className="turn-changes-patch">
            {!diff && !error && <p role="status">Loading diff…</p>}
            {error && <p role="alert">{error}</p>}
            {diff?.binary && <p>Binary file: text diff unavailable.</p>}
            {diff && !diff.binary && (diff.patch ? <DiffView patch={diff.patch} file={file.path} onComment={onComment} /> : <p>No text changes.</p>)}
          </div>}
        </li>)}
      </ul>}
    </section>
  );
}
