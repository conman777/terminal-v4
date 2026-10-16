import { useCallback, useEffect, useRef, useState } from 'react';
import { apiFetch } from '../utils/api';
import './SessionHistorySearch.css';
import { NativeHistoryPanel } from './NativeHistoryPanel';

export function SessionHistorySearch({ workspacePath = '', onSelectSession, onInsertPrompt }) {
  const [query, setQuery] = useState('');
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const request = useRef(null);
  const load = useCallback(async (text = '') => {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setRows([]);
    setError('');
    setLoading(true);
    const params = new URLSearchParams();
    if (workspacePath) params.set('path', workspacePath);
    params.set('q', text.trim());
    params.set('limit', '20');
    try {
      const response = await apiFetch('/api/workspace/history?' + params, { signal: controller.signal });
      const result = await response.json();
      if (!response.ok) throw new Error(result?.error || 'Unable to search history');
      if (!Array.isArray(result)) throw new Error('Unable to read history');
      if (!controller.signal.aborted) setRows(result);
    } catch (failure) {
      if (!controller.signal.aborted) setError(failure.message || 'Unable to search history');
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }, [workspacePath]);

  useEffect(() => {
    setQuery('');
    load('');
    return () => request.current?.abort();
  }, [load]);

  return (
    <section className="session-history-search" aria-label="Saved conversation history">
      <header><h3>Conversation history</h3><p>Search saved messages or reopen recent conversations.</p></header>
      <form onSubmit={(event) => { event.preventDefault(); load(query); }}>
        <label>Search saved conversations<input value={query} maxLength={256} onChange={(event) => setQuery(event.target.value)} placeholder="Find a decision, command, or fix…" /></label>
        <button type="submit" disabled={loading}>Search history</button>
      </form>
      {loading && <p role="status">Searching conversations…</p>}
      {error && <div role="alert">{error}<button type="button" onClick={() => load(query)}>Retry history</button></div>}
      {!loading && !error && rows.length === 0 && <p>No matching conversations.</p>}
      <div className="session-history-results">
        {rows.map((row) => (
          <button type="button" className="session-history-result" key={row.sessionId} disabled={!onSelectSession} onClick={() => onSelectSession?.(row.sessionId)}>
            <span className="session-history-result-heading"><strong>{row.title || 'Untitled conversation'}</strong><span>{row.kind === 'structured' ? 'Agent' : 'Terminal'}</span></span>
            <span>{row.snippet || 'No saved messages yet.'}</span>
            <time dateTime={row.updatedAt}>{new Date(row.updatedAt).toLocaleString()}</time>
          </button>
        ))}
      </div>
      <NativeHistoryPanel workspacePath={workspacePath} onInsertPrompt={onInsertPrompt} />
    </section>
  );
}

