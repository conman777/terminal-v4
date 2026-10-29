import { useCallback, useEffect, useState } from 'react';
import { apiGet } from '../utils/api';
import './SetupChecklist.css';

const DISMISSED_KEY = 'tv4SetupChecklistDismissed';
function dismissed() { try { return localStorage.getItem(DISMISSED_KEY) === '1'; } catch { return false; } }

// Hermes-style setup check: what this server needs, what is missing, and how to fix it.
export function SetupChecklist({ welcome = false }) {
  const [hidden, setHidden] = useState(() => welcome && dismissed());
  const [report, setReport] = useState(null);
  const [error, setError] = useState('');
  const [checking, setChecking] = useState(false);
  const check = useCallback(async () => {
    setChecking(true); setError('');
    try { setReport(await apiGet('/api/system/doctor')); }
    catch (failure) { setError(failure?.message || 'The setup check could not run.'); }
    finally { setChecking(false); }
  }, []);
  useEffect(() => { if (!hidden) check(); }, [check, hidden]);
  if (hidden || (welcome && (!report || report.ready))) return null;
  const dismiss = () => { try { localStorage.setItem(DISMISSED_KEY, '1'); } catch { /* shows again next time */ } setHidden(true); };
  return (
    <section className={`setup-checklist${welcome ? ' setup-checklist-welcome' : ''}`} aria-label="Setup check">
      <header>
        <div>
          <h3>{welcome ? 'Finish setting up' : 'Setup check'}</h3>
          <p>{report?.ready ? 'Everything Terminal v4 needs is ready.' : 'Install what is missing, then check again.'}</p>
        </div>
        <div className="setup-checklist-actions">
          <button type="button" onClick={check} disabled={checking}>{checking ? 'Checking…' : 'Check again'}</button>
          {welcome && <button type="button" onClick={dismiss}>Dismiss</button>}
        </div>
      </header>
      {error && <p role="alert">{error}</p>}
      {report && <ul>
        {report.checks.map(item => (
          <li key={item.id} className={item.ok ? 'ok' : item.required ? 'missing required' : 'missing'}>
            <span className="setup-checklist-mark" aria-hidden="true">{item.ok ? '✓' : '!'}</span>
            <div>
              <strong>{item.label}</strong>{!item.required && !item.ok && <span className="setup-checklist-optional"> optional</span>}
              <small>{item.detail}</small>
              {!item.ok && <p>{item.fix}</p>}
            </div>
          </li>
        ))}
      </ul>}
    </section>
  );
}
