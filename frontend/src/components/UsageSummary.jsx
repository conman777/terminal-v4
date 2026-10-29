import './KeyboardShortcutsSetting.css';
import { useEffect, useState } from 'react';
import { apiGet } from '../utils/api';

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const tokens = value => Number(value || 0).toLocaleString('en-US');

function total(rows) {
  const count = rows.reduce((sum, row) => sum + (row.inputTokens || 0) + (row.outputTokens || 0), 0);
  const priced = rows.filter(row => Number.isFinite(row.costUsd));
  const cost = priced.reduce((sum, row) => sum + row.costUsd, 0);
  return `${tokens(count)} tokens${priced.length ? ` · $${cost.toFixed(2)}` : ''}`;
}

// Token use and cost per thread, as reported by each agent (Codex does not report cost).
export function UsageSummary({ now = Date.now() }) {
  const [threads, setThreads] = useState(null);
  const [error, setError] = useState('');
  useEffect(() => {
    apiGet('/api/structured/usage').then(data => setThreads(Array.isArray(data?.threads) ? data.threads : []))
      .catch(failure => setError(failure?.message || 'Usage could not be loaded.'));
  }, []);
  if (error) return <p role="alert">{error}</p>;
  if (!threads) return <p role="status">Loading usage…</p>;
  const recent = threads.filter(row => now - Date.parse(row.updatedAt) <= WEEK_MS);
  const sorted = [...threads].sort((a, b) => ((b.inputTokens + b.outputTokens) - (a.inputTokens + a.outputTokens)));
  return (
    <div className="form-group session-settings-field usage-summary">
      <label>Usage</label>
      <div className="usage-summary-totals">
        <div><small>Last 7 days</small><strong>{total(recent)}</strong></div>
        <div><small>All time</small><strong>{total(threads)}</strong></div>
      </div>
      {threads.length === 0 ? <small>No usage reported yet. Claude Code and Codex report it after each reply.</small> : <table className="keyboard-shortcuts-table">
        <thead><tr><th scope="col">Thread</th><th scope="col">Tokens</th><th scope="col">Cost</th></tr></thead>
        <tbody>{sorted.map(row => <tr key={row.id}>
          <th scope="row">{row.title || 'Untitled'} <small>{row.provider}</small></th>
          <td>{tokens(row.inputTokens + row.outputTokens)}</td>
          <td>{Number.isFinite(row.costUsd) ? `$${row.costUsd.toFixed(2)}` : '—'}</td>
        </tr>)}</tbody>
      </table>}
      <small>Costs are the estimates Claude Code reports; Codex usage is billed through your OpenAI plan.</small>
    </div>
  );
}
