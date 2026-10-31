import { useEffect, useMemo, useRef, useState } from 'react';
import { apiGet } from '../utils/api';
import { DiffView } from './DiffView';
import { VirtualTurnChangesTree } from './VirtualTurnChangesTree';
import './TurnChangesCard.css';

function Delta({ added, removed }) {
  return <span className="turn-changes-delta"><span className="turn-changes-added">+{(added ?? 0).toLocaleString()}</span><span className="turn-changes-removed">−{(removed ?? 0).toLocaleString()}</span></span>;
}

function fileTree(files) {
  const root = { children: [], folders: new Map() };
  const directories = [];
  for (const file of files) {
    const parts = file.path.split('/');
    let current = root;
    for (const [index, name] of parts.slice(0, -1).entries()) {
      const path = parts.slice(0, index + 1).join('/');
      if (!current.folders.has(name)) {
        const folder = { name, path, children: [], folders: new Map(), added: 0, removed: 0 };
        current.folders.set(name, folder);
        current.children.push(folder);
        directories.push(path);
      }
      current = current.folders.get(name);
      current.added += file.added || 0;
      current.removed += file.removed || 0;
    }
    current.children.push({ name: parts.at(-1), file });
  }
  return { children: root.children, directories };
}

// T3 Code's per-turn summary: which files the agent changed, with each file's diff on demand.
export function TurnChangesCard({ changes, workspacePath, onComment }) {
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState('');
  const [diff, setDiff] = useState(null);
  const [error, setError] = useState('');
  const [collapsed, setCollapsed] = useState(() => new Set());
  const request = useRef(null);
  const tree = useMemo(() => fileTree(changes.files), [changes.files]);
  const allCollapsed = tree.directories.every(path => collapsed.has(path));
  const count = changes.files.length;

  useEffect(() => {
    setSelected(''); setDiff(null); setError(''); setCollapsed(new Set());
    return () => { request.current?.abort(); request.current = null; };
  }, [workspacePath, changes.from, changes.to]);

  const showFile = async (path) => {
    request.current?.abort();
    request.current = null;
    if (selected === path) { setSelected(''); return; }
    setSelected(path); setDiff(null); setError('');
    const controller = new AbortController();
    request.current = controller;
    try {
      const query = new URLSearchParams({ path: workspacePath, mode: 'turn', from: changes.from, to: changes.to, file: path });
      const result = await apiGet(`/api/workspace/git/diff?${query}`, { signal: controller.signal });
      if (!controller.signal.aborted) setDiff(result);
    } catch (failure) {
      if (!controller.signal.aborted) setError(failure?.message || 'Diff unavailable');
    }
  };

  const renderDiff = file => <div className="turn-changes-patch">
    {!diff && !error && <p role="status">Loading diff…</p>}
    {error && <p role="alert">{error}</p>}
    {diff?.binary && <p>Binary file: text diff unavailable.</p>}
    {diff && !diff.binary && (diff.patch ? <DiffView patch={diff.patch} file={file} onComment={onComment} /> : <p>No text changes.</p>)}
  </div>;

  const renderNodes = nodes => nodes.map(node => {
    if (!node.file) {
      const expanded = !collapsed.has(node.path);
      return <li key={`dir:${node.path}`}>
        <button type="button" className="turn-changes-file turn-changes-folder" aria-label={`${expanded ? 'Collapse' : 'Expand'} ${node.path}`} aria-expanded={expanded} onClick={() => setCollapsed(previous => {
          const next = new Set(previous);
          if (next.has(node.path)) next.delete(node.path); else next.add(node.path);
          return next;
        })}>
          <span className="turn-changes-path"><span aria-hidden="true">{expanded ? '▾' : '▸'} </span>{node.name}/</span><Delta added={node.added} removed={node.removed} />
        </button>
        {expanded && <ul className="turn-changes-nested">{renderNodes(node.children)}</ul>}
      </li>;
    }
    const file = node.file;
    return <li key={`file:${file.path}`}>
      <button type="button" className="turn-changes-file" aria-label={file.path} aria-expanded={selected === file.path} onClick={() => showFile(file.path)}>
        <span className="turn-changes-path">{node.name}</span>{file.binary ? <span className="turn-changes-delta">binary</span> : <Delta added={file.added} removed={file.removed} />}
      </button>
      {selected === file.path && renderDiff(file.path)}
    </li>;
  });

  return (
    <section className="turn-changes" aria-label="Files changed in this turn">
      <div className="turn-changes-head">
        <span className="turn-changes-title"><span>{count === 1 ? '1 changed file' : `${count} changed files`}</span><Delta added={changes.added} removed={changes.removed} /></span>
        {workspacePath && <button type="button" className="turn-changes-toggle" aria-expanded={open} onClick={() => { if (open) { request.current?.abort(); request.current = null; setSelected(''); } setOpen(value => !value); }}>{open ? 'Hide diff' : 'Open diff'}</button>}
      </div>
      {open && <div className="turn-changes-list">
        {tree.directories.length > 0 && <button type="button" className="turn-changes-toggle turn-changes-collapse" onClick={() => setCollapsed(allCollapsed ? new Set() : new Set(tree.directories))}>{allCollapsed ? 'Expand all folders' : 'Collapse all folders'}</button>}
        {count > 250
          ? <><VirtualTurnChangesTree children={tree.children} collapsed={collapsed} setCollapsed={setCollapsed} selected={selected} showFile={showFile} />
            {selected && <div className="turn-changes-selected"><strong>{selected}</strong>{renderDiff(selected)}</div>}</>
          : <ul className="turn-changes-files">{renderNodes(tree.children)}</ul>}
      </div>}
    </section>
  );
}
