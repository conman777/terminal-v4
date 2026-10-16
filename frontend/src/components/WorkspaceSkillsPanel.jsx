import { useEffect, useState } from 'react';
import { apiFetch } from '../utils/api';
import './WorkspaceSkillsPanel.css';

function SkillsContent({ workspacePath, onInsertContext }) {
  const [skills, setSkills] = useState(null);
  const [warnings, setWarnings] = useState([]);
  const [selected, setSelected] = useState([]);
  const [error, setError] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    apiFetch('/api/workspace/skills?path=' + encodeURIComponent(workspacePath), { signal: controller.signal })
      .then(async response => {
        const payload = await response.json();
        if (!response.ok) throw new Error(payload?.error || 'Unable to discover installed skills');
        if (!controller.signal.aborted) { setSkills(payload.skills); setWarnings(payload.warnings); }
      }).catch(loadError => { if (!controller.signal.aborted) setError(loadError.message); });
    return () => controller.abort();
  }, [workspacePath]);
  const context = (skills || []).filter(skill => selected.includes(skill.id)).map(skill =>
    'Installed skill: ' + skill.name + ' (' + skill.provider + ', ' + skill.scope + ')\nSource: ' + skill.path + '\n\n' + skill.instructions).join('\n\n');
  const withinBudget = Array.from(context).length <= 50000;
  return <section className="workspace-installed-skills" aria-label="Installed skill context">
    <h3>Installed skill context</h3>
    <p>Browse skill Markdown from this project and the host's configured agent profiles. Selected instructions are added to your editable prompt.</p>
    <p>Review the text before sending. Linked supporting files and scripts are not loaded.</p>
    {error && <p role="alert">{error}</p>}
    {!skills && !error && <p role="status">Discovering installed skills…</p>}
    {warnings.map((warning, index) => <p className="workspace-skills-warning" key={index}>{warning}</p>)}
    {skills?.length === 0 && <p>No compatible skill files found in the configured roots.</p>}
    {skills?.map(skill => <div className="workspace-installed-skill" key={skill.id}>
      <label className="workspace-profile-check"><input type="checkbox" disabled={!onInsertContext} checked={selected.includes(skill.id)}
        aria-label={'Include ' + skill.name + ' (' + skill.provider + ', ' + skill.scope + ')'}
        onChange={event => setSelected(current => event.target.checked ? [...current, skill.id] : current.filter(id => id !== skill.id))} />
        <span>{skill.name} <small>{skill.provider} · {skill.scope}</small></span>
      </label>
      <details><summary>Preview instructions</summary><p className="workspace-installed-skill-source">{skill.path}</p><pre>{skill.instructions}</pre></details>
    </div>)}
    {!withinBudget && <p role="alert">Select fewer skills to stay within 50000 characters.</p>}
    <button type="button" disabled={!onInsertContext || !context || !withinBudget} onClick={() => onInsertContext(context)}>Add installed skills to prompt</button>
  </section>;
}

export function WorkspaceSkillsPanel(props) {
  if (!props.workspacePath) return <p>Select a workspace to browse installed skill context.</p>;
  return <SkillsContent key={props.workspacePath} {...props} />;
}
