import { useEffect, useId, useRef, useState } from 'react';
import { apiFetch } from '../utils/api';
import './WorkspaceGitPanel.css';

async function request(url, options) {
  const response = await apiFetch(url, options);
  const value = await response.json();
  if (!response.ok) throw new Error(value.error || 'Git request failed');
  return value;
}

function GitWorkspace({ workspacePath, onStartTask }) {
  const [mode, setMode] = useState('unstaged');
  const [base, setBase] = useState('HEAD~1');
  const [baseDraft, setBaseDraft] = useState('HEAD~1');
  const [status, setStatus] = useState(null);
  const [trees, setTrees] = useState([]);
  const [checkpoints, setCheckpoints] = useState([]);
  const [checkpointId, setCheckpointId] = useState('');
  const [selectedFile, setSelectedFile] = useState('');
  const [diff, setDiff] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [name, setName] = useState('');
  const [baseRef, setBaseRef] = useState('HEAD');
  const [label, setLabel] = useState('');
  const [restore, setRestore] = useState(null);
  const [notice, setNotice] = useState('');
  const mounted = useRef(false);
  const id = useId();
  const query = new URLSearchParams({ path: workspacePath, mode, base, ...(checkpointId ? { checkpointId } : {}) }).toString();

  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    if (!workspacePath) return;
    const controller = new AbortController();
    setLoading(true); setError(''); setStatus(null); setDiff(null); setSelectedFile('');
    Promise.all([
      request('/api/workspace/git/status?' + query, { signal: controller.signal }),
      request('/api/workspace/git/worktrees?path=' + encodeURIComponent(workspacePath), { signal: controller.signal }),
      request('/api/workspace/git/checkpoints?path=' + encodeURIComponent(workspacePath), { signal: controller.signal }),
    ]).then(([nextStatus, nextTrees, nextCheckpoints]) => {
      if (controller.signal.aborted) return;
      setStatus(nextStatus); setTrees(nextTrees); setCheckpoints(nextCheckpoints);
    }).catch(failure => { if (!controller.signal.aborted) setError(failure.message); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [workspacePath, query, refresh]);

  useEffect(() => {
    setDiff(null);
    if (!selectedFile) return;
    const controller = new AbortController();
    request('/api/workspace/git/diff?' + query + '&file=' + encodeURIComponent(selectedFile), { signal: controller.signal })
      .then(value => { if (!controller.signal.aborted) setDiff(value); })
      .catch(failure => { if (!controller.signal.aborted) setError(failure.message); });
    return () => controller.abort();
  }, [query, selectedFile]);

  async function mutate(action) {
    setBusy(true); setError(''); setNotice('');
    try { await action(); }
    catch (failure) { if (mounted.current) setError(failure.message); }
    finally { if (mounted.current) setBusy(false); }
  }

  return <section className="workspace-git-panel" aria-label="Git review and isolated tasks">
    <div className="workspace-git-toolbar">
      <label htmlFor={id + '-mode'}>Review changes</label>
      <select id={id + '-mode'} value={mode} disabled={busy} onChange={event => { setMode(event.target.value); setCheckpointId(''); }}>
        <option value="unstaged">Unstaged and new files</option><option value="staged">Staged changes</option>
        <option value="base">Branch compared with base</option>{checkpointId && <option value="checkpoint">Since checkpoint</option>}
      </select>
      <button type="button" disabled={busy || loading} onClick={() => setRefresh(value => value + 1)}>Refresh Git</button>
      {status && <small>{status.branch || 'Detached HEAD'}</small>}
    </div>
    {mode === 'base' && <form className="workspace-git-inline" onSubmit={event => { event.preventDefault(); setBase(baseDraft.trim()); }}>
      <label htmlFor={id + '-compare'}>Comparison base</label><input id={id + '-compare'} value={baseDraft} maxLength={200} onChange={event => setBaseDraft(event.target.value)} />
      <button disabled={busy || !baseDraft.trim()}>Compare base</button>
    </form>}
    {error && <p role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}
    {loading && <p role="status">Loading Git workspace…</p>}
    {status && <>
      {status.truncated && <p>File list exceeds the preview limit. Review remaining changes locally.</p>}
      <div className="workspace-git-review">
        <nav aria-label="Changed files">
          {!status.files?.length && <p>No changed files in this view.</p>}
          {status.files?.map(file => <button type="button" key={file.path} title={file.path} aria-pressed={selectedFile === file.path}
            onClick={() => { setError(''); setSelectedFile(file.path); }}>
            <span>{file.status} {file.path}</span><small>{file.binary ? 'Binary' : file.status === '?' ? 'New file' : `+${file.added || 0} −${file.removed || 0}`}</small>
          </button>)}
        </nav>
        <div className="workspace-git-patch">
          {!selectedFile && <p>Select a file to review its changes.</p>}
          {selectedFile && !diff && <p role="status">Loading diff…</p>}
          {diff?.binary && <p>Binary file: text diff unavailable.</p>}
          {diff?.truncated && <p>Diff exceeds the preview limit. Review the full file locally.</p>}
          {diff && !diff.binary && <pre tabIndex={0} aria-label={'Diff for ' + selectedFile}><code>{diff.patch || 'No text changes.'}</code></pre>}
        </div>
      </div>
    </>}
    <h3>Isolated tasks</h3><p>Create a separate checkout and branch for a task, then choose its agent. It starts from committed code. Archiving saves a checkpoint and keeps the checkout, including ignored files, for reactivation.</p>
    <form className="workspace-git-inline" onSubmit={event => {
      event.preventDefault(); mutate(async () => {
        const tree = await request('/api/workspace/git/worktrees', { method: 'POST', body: { path: workspacePath, name: name.trim(), baseRef: baseRef.trim() } });
        if (!mounted.current) return;
        setTrees(current => [...current, tree]); setName(''); setNotice('Isolated task created.');
      });
    }}>
      <label htmlFor={id + '-name'}>Task name</label><input id={id + '-name'} value={name} maxLength={80} disabled={busy} onChange={event => setName(event.target.value)} />
      <label htmlFor={id + '-base'}>Start from</label><input id={id + '-base'} value={baseRef} maxLength={200} disabled={busy} onChange={event => setBaseRef(event.target.value)} />
      <button disabled={busy || !workspacePath || !name.trim() || !baseRef.trim()}>Create isolated task</button>
    </form>
    <ul className="workspace-git-list">{trees.map(tree => <li key={tree.id}><div><strong>{tree.name}</strong><small>{tree.branch}</small><small title={tree.path}>{tree.path}</small></div>
      {tree.archived && <small>Archived · checkout retained</small>}
      {!tree.archived && <button type="button" aria-label={'Start ' + tree.name} disabled={busy || !tree.available || !onStartTask} onClick={() => onStartTask?.(tree.path)}>{tree.available ? 'Start task' : 'Checkout unavailable'}</button>}
      <button type="button" aria-label={(tree.archived ? 'Reactivate ' : 'Archive ') + tree.name} disabled={busy || !tree.available} onClick={() => mutate(async () => {
        const updated = await request('/api/workspace/git/worktrees/' + (tree.archived ? 'reactivate' : 'archive'), {method:'POST',body:{path:workspacePath,worktreeId:tree.id}});
        if (!mounted.current) return;
        setTrees(current => current.map(value => value.id === updated.id ? updated : value));
        setNotice(updated.archived ? 'Task archived. Checkout and ignored files retained.' : 'Task reactivated.');
        setRefresh(value => value + 1);
      })}>{tree.archived ? 'Reactivate' : 'Archive'}</button>
    </li>)}</ul>
    <h3>File checkpoints</h3><p>Save tracked and new non-ignored files. Ignored files, submodule contents, and provider conversation history are excluded. Restore is available in managed isolated tasks.</p>
    <form className="workspace-git-inline" onSubmit={event => {
      event.preventDefault(); mutate(async () => {
        const value = await request('/api/workspace/git/checkpoints', { method: 'POST', body: { path: workspacePath, label: label.trim() } });
        if (!mounted.current) return;
        setCheckpoints(current => [...current, value]); setLabel(''); setNotice('File checkpoint saved.');
      });
    }}><label htmlFor={id + '-label'}>Checkpoint label</label><input id={id + '-label'} value={label} disabled={busy} maxLength={120} onChange={event => setLabel(event.target.value)} />
      <button disabled={busy || !workspacePath || !label.trim()}>Save checkpoint</button></form>
    <ul className="workspace-git-list">{checkpoints.map(checkpoint => <li key={checkpoint.id}><div><strong>{checkpoint.label}</strong><small>{new Date(checkpoint.createdAt * 1000).toLocaleString()}</small></div>
      <button type="button" disabled={busy} onClick={() => { setMode('checkpoint'); setCheckpointId(checkpoint.id); }}>Review changes</button>
      <button type="button" aria-label={'Restore ' + checkpoint.label} disabled={busy || !status?.managed} onClick={() => setRestore(checkpoint)}>Restore</button>
    </li>)}</ul>
    {restore && <div className="workspace-git-confirm" role="group" aria-label="Confirm file restore">
      <p>Restore files to “{restore.label}”? Restoring files does not rewind the agent conversation. Changes since the latest checkpoint must match before files can be restored.</p>
      <button type="button" disabled={busy} onClick={() => mutate(async () => {
        await request('/api/workspace/git/checkpoints/restore', { method: 'POST', body: { path: workspacePath, checkpointId: restore.id } });
        if (!mounted.current) return;
        setRestore(null); setNotice('Files restored. Agent conversation was not changed.'); setRefresh(value => value + 1);
      })}>Restore files</button><button type="button" disabled={busy} onClick={() => setRestore(null)}>Cancel restore</button>
    </div>}
  </section>;
}

export function WorkspaceGitPanel(props) { return <GitWorkspace key={props.workspacePath} {...props} />; }


