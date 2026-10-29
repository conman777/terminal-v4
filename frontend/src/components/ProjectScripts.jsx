import { useEffect, useState } from 'react';
import { apiFetch } from '../utils/api';

const icon = <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m7 6 6 6-6 6M13 18h6" /></svg>;

// T3 Code's project actions: saved commands for this folder, each run in its own terminal.
export function ProjectScripts({ cwd, onRun }) {
  const [open, setOpen] = useState(false);
  const [scripts, setScripts] = useState(null);
  const [name, setName] = useState('');
  const [command, setCommand] = useState('');
  const [error, setError] = useState('');
  const url = `/api/workspace/scripts?${new URLSearchParams({ path: cwd })}`;

  useEffect(() => {
    if (!open || scripts) return;
    apiFetch(url).then(response => response.json()).then(data => setScripts(Array.isArray(data?.scripts) ? data.scripts : []))
      .catch(() => { setScripts([]); setError('Project scripts could not be loaded.'); });
  }, [open, scripts, url]);

  const save = async next => {
    setError('');
    const response = await apiFetch(url, { method: 'PUT', body: { scripts: next } });
    const data = await response.json().catch(() => null);
    if (!response.ok) { setError(data?.error || 'The script could not be saved.'); return false; }
    setScripts(data.scripts);
    return true;
  };
  const add = async event => {
    event.preventDefault();
    if (await save([...(scripts || []), { name: name.trim(), command: command.trim() }])) { setName(''); setCommand(''); }
  };

  return (
    <div className="project-scripts">
      <button type="button" className="thread-details-row" aria-expanded={open} onClick={() => setOpen(value => !value)}>{icon}<span>Project scripts</span></button>
      {open && <div className="thread-git-form">
        {scripts === null && <p role="status" className="thread-git-note">Loading scripts…</p>}
        {scripts?.length === 0 && <p className="thread-git-note">Save commands you run often, like starting the dev server.</p>}
        {scripts?.map((script, index) => (
          <div key={`${script.name}-${index}`} className="project-script">
            <button type="button" className="project-script-run" aria-label={`Run ${script.name}`} title={script.command} onClick={() => onRun?.(script)}>
              <span>{script.name}</span><small>{script.command}</small>
            </button>
            <button type="button" className="project-script-remove" aria-label={`Remove ${script.name}`} onClick={() => save(scripts.filter((_, position) => position !== index))}>×</button>
          </div>
        ))}
        <form className="project-script-form" onSubmit={add}>
          <input aria-label="Script name" placeholder="Name" value={name} maxLength={60} onChange={event => setName(event.target.value)} />
          <input aria-label="Command" placeholder="Command, e.g. npm run dev" value={command} maxLength={2000} onChange={event => setCommand(event.target.value)} />
          <button type="submit" disabled={!name.trim() || !command.trim()}>Add script</button>
        </form>
        {error && <p role="alert" className="thread-git-note thread-git-error">{error}</p>}
      </div>}
    </div>
  );
}
