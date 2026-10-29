import { useEffect, useRef, useState } from 'react';
import { apiFetch } from '../utils/api';
import { buildNativeHandoff } from '../utils/nativeHandoff';
import './NativeHistoryPanel.css';

export function NativeHistoryPanel({ workspacePath, onInsertPrompt }) {
  const [sources, setSources] = useState([]);
  const [scanned, setScanned] = useState(false);
  const [imports, setImports] = useState([]);
  const [warnings, setWarnings] = useState([]);
  const [error, setError] = useState('');
  const [importsError, setImportsError] = useState('');
  const [busy, setBusy] = useState(false);
  const [prompt, setPrompt] = useState('');
  const [selected, setSelected] = useState(null);
  const generation = useRef(0);
  const params = new URLSearchParams({ path: workspacePath || '' });
  useEffect(() => {
    const version = ++generation.current;
    const controller = new AbortController();
    setSources([]); setScanned(false); setImports([]); setWarnings([]); setError(''); setImportsError(''); setPrompt(''); setSelected(null); setBusy(false);
    if (workspacePath) apiFetch('/api/workspace/native-history/imports?' + new URLSearchParams({ path: workspacePath }), { signal: controller.signal })
      .then(async (response) => { const rows = await response.json(); if (!response.ok || !Array.isArray(rows)) throw new Error(rows?.error || 'Unable to load native imports'); if (generation.current === version) setImports(rows); })
      .catch((failure) => { if (!controller.signal.aborted && generation.current === version) setImportsError(failure.message); });
    return () => { generation.current++; controller.abort(); };
  }, [workspacePath]);
  async function run(url, options, apply, onError = setError) {
    const version = generation.current;
    setBusy(true); setError('');
    try {
      const response = await apiFetch(url, options);
      const result = await response.json();
      if (!response.ok) throw new Error(result?.error || 'Native history request failed');
      if (generation.current === version) apply(result);
    } catch (failure) { if (generation.current === version) onError(failure.message || 'Native history request failed'); }
    finally { if (generation.current === version) setBusy(false); }
  }
  function select(record) { setSelected(record); setPrompt(buildNativeHandoff(record)); }
  return <section className="native-history-panel" aria-label="Native provider conversations">
    <h3>Native conversations</h3>
    <p>Find V4, Claude, Codex, and imported Hermes conversations for this workspace on the server. Scans return up to 50 conversations and skip JSONL files over 8 MB. Import a read-only text snapshot, then review a handoff for another agent.</p>
    <button type="button" disabled={busy || !workspacePath} onClick={() => run('/api/workspace/native-history/sources?' + params, {}, (result) => { setSources(Array.isArray(result.sources) ? result.sources : []); setWarnings(result.warnings || []); setScanned(true); })}>Find native conversations</button>
    {busy && <p role="status">Loading native conversations…</p>}
    {error && <p role="alert">{error}</p>}
    {importsError && <div role="alert"><p>{importsError}</p><button type="button" disabled={busy} onClick={() => run('/api/workspace/native-history/imports?' + params, {}, rows => { if (!Array.isArray(rows)) throw new Error('Unable to load native imports'); setImports(rows); setImportsError(''); }, setImportsError)}>Retry native imports</button></div>}
    {scanned && !busy && sources.length === 0 && <p role="status">No native conversations found for this workspace.</p>}
    {warnings.map((warning) => <p key={warning}>{warning}</p>)}
    {sources.map((row) => <div className="native-history-row" key={row.sourceId}><span><strong>{row.title}</strong><small>{row.provider} · {row.messageCount} messages{row.truncated ? ' · truncated' : ''}</small></span><button type="button" disabled={busy} aria-label={'Import ' + row.title} onClick={() => run('/api/workspace/native-history/import?' + params, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sourceId: row.sourceId }) }, (record) => { select(record); setImports((rows) => [record, ...rows.filter((item) => item.sourceId !== record.sourceId)]); })}>Import</button></div>)}
    {imports.length > 0 && <h4>Imported snapshots</h4>}
    {imports.map((row) => <button className="native-history-import" type="button" key={row.sourceId} disabled={busy} aria-label={'Open imported ' + row.title} onClick={() => run('/api/workspace/native-history/imports/' + encodeURIComponent(row.sourceId) + '?' + params, {}, select)}>{row.title} <small>{row.provider}</small></button>)}
    {selected && <div className="native-history-handoff"><p>Source: {selected.provider}. This transfers visible messages; tools, approvals, and native runtime state stay with the source.</p><label>Review handoff prompt<textarea value={prompt} maxLength={16000} rows={12} onChange={(event) => setPrompt(event.target.value)} /></label><button type="button" disabled={!onInsertPrompt || !prompt.trim()} onClick={() => onInsertPrompt?.(prompt)}>Add handoff to prompt</button></div>}
  </section>;
}
