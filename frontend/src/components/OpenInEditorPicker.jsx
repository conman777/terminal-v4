import { useEffect, useMemo, useState } from 'react';
import { apiGet, apiPost } from '../utils/api';
import { getUser } from '../utils/auth';
import './ThreadCardExtras.css';

const icon = <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m8 7-5 5 5 5M16 7l5 5-5 5" /></svg>;

let installedEditors = null;
export function resetInstalledEditorsCache() { installedEditors = null; }
function loadInstalledEditors() {
  installedEditors ||= Promise.resolve().then(() => apiGet('/api/system/editors')).then(data => (Array.isArray(data?.editors) ? data.editors : []), () => []);
  return installedEditors;
}

export function preferredEditorKey() {
  let id = 'anonymous';
  try { id = getUser()?.id || id; } catch { /* storage unavailable */ }
  return `terminal-v4:preferred-editor:${id}`;
}
function readPreferred() { try { return localStorage.getItem(preferredEditorKey()); } catch { return null; } }
function writePreferred(id) { try { localStorage.setItem(preferredEditorKey(), id); } catch { /* remembered for this tab only */ } }

export function isOpenEditorShortcut(event) {
  return event.altKey && event.shiftKey && !event.ctrlKey && !event.metaKey && event.code === 'KeyO';
}

export function OpenInEditorPicker({ cwd }) {
  const [editors, setEditors] = useState([]);
  const [preferred, setPreferred] = useState(readPreferred);
  const [error, setError] = useState('');
  useEffect(() => {
    let cancelled = false;
    loadInstalledEditors().then(list => { if (!cancelled) setEditors(list); });
    return () => { cancelled = true; };
  }, []);
  const editor = useMemo(() => editors.find(item => item.id === preferred) || editors[0], [editors, preferred]);

  const open = async () => {
    if (!editor || !cwd) return;
    setError('');
    try {
      await apiPost('/api/system/open-in-editor', { editor: editor.id, path: cwd });
    } catch (failure) {
      setError(failure?.message || `Could not open ${editor.label}`);
    }
  };

  useEffect(() => {
    if (!editor || !cwd) return undefined;
    const onKey = event => { if (isOpenEditorShortcut(event)) { event.preventDefault(); open(); } };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  if (!editor || !cwd) return null;
  return (
    <div className="thread-editor">
      <div className="thread-editor-row">
        <button type="button" className="thread-details-row" title="Alt+Shift+O" aria-keyshortcuts="Alt+Shift+O" onClick={open}>{icon}<span>{`Open in ${editor.label}`}</span></button>
        {editors.length > 1 && <select aria-label="Choose editor" value={editor.id} onChange={event => { writePreferred(event.target.value); setPreferred(event.target.value); }}>
          {editors.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}
        </select>}
      </div>
      {error && <p role="alert" className="thread-git-note thread-git-error">{error}</p>}
    </div>
  );
}
