import { createUuid } from '../utils/createUuid';
import { useState } from 'react';
import { parseSkillPackage, validateSupportFiles } from '../utils/skillPackages';
import './SkillPackagesEditor.css';

function SupportFilesEditor({ skill, onChange }) {
  const [path, setPath] = useState('');
  const [error, setError] = useState('');
  const files = skill.supportFiles || {};
  function add() {
    setError('');
    try {
      if (Object.hasOwn(files, path)) throw new Error('That file already exists. Edit its contents below.');
      const next = { ...files, [path]: '' };
      validateSupportFiles(next);
      onChange(next);
      setPath('');
    } catch (validationError) { setError(validationError.message); }
  }
  return <div className="skill-package-files">
    <h4>Supporting files</h4>
    <p>V4-owned text references and scripts. Adding a script saves its text; execution still requires agent tool approval.</p>
    {Object.entries(files).map(([name, contents]) => <div className="skill-package-file" key={name}>
      <div><strong>{name}</strong><button type="button" aria-label={'Remove file ' + name} onClick={() => {
        const next = { ...files }; delete next[name]; onChange(next);
      }}>Remove file</button></div>
      <textarea aria-label={'Contents of ' + name} rows={4} value={contents} onChange={event => onChange({ ...files, [name]: event.target.value })} />
      <small>{new TextEncoder().encode(contents).length}/64000 bytes</small>
    </div>)}
    <div className="skill-package-add-file">
      <input aria-label={'New support file path for ' + (skill.name || 'skill')} value={path} placeholder="references/checklist.md" onChange={event => setPath(event.target.value)} />
      <button type="button" disabled={!path || Object.keys(files).length >= 20} onClick={add}>Add support file</button>
    </div>
    {error && <p role="alert" className="workspace-profile-error">{error}</p>}
  </div>;
}

export function SkillPackagesEditor({ skills, onChange, selectedSkillIds, onSelectSkill }) {
  const [importText, setImportText] = useState('');
  const [error, setError] = useState('');
  function update(id, changes) { onChange(skills.map(skill => skill.id === id ? { ...skill, ...changes } : skill)); }
  function importPackage() {
    setError('');
    try {
      const skill = parseSkillPackage(importText);
      if (skills.some(saved => saved.id === skill.id)) throw new Error('That skill ID is already saved. Edit the existing package or import with a new ID.');
      onChange([...skills, skill]);
      setImportText('');
    } catch (importError) { setError(importError.message); }
  }
  return <div className="skill-packages-editor">
    <div className="workspace-profile-section-heading">
      <h3>Reusable skills</h3>
      <button type="button" disabled={skills.length >= 20} onClick={() => onChange([...skills, { id: createUuid(), name: '', instructions: '', supportFiles: {} }])}>Add skill</button>
    </div>
    <details className="skill-package-import"><summary>Import V4 skill package</summary>
      <p>Paste JSON with name, instructions, optional id, and supportFiles mapping relative file paths to text. Review imported contents, then save.</p>
      <textarea aria-label="Skill package JSON" rows={5} value={importText} onChange={event => setImportText(event.target.value)} placeholder={'{"name":"Review","instructions":"Use the checklist.","supportFiles":{"references/checklist.md":"Check errors."}}'} />
      <button type="button" disabled={!importText.trim() || skills.length >= 20} onClick={importPackage}>Import skill package</button>
      {error && <p role="alert" className="workspace-profile-error">{error}</p>}
    </details>
    {skills.length === 0 && <p>Save a repeatable workflow, then choose it when preparing a prompt.</p>}
    {skills.map(skill => <div className="workspace-profile-skill" key={skill.id}>
      <div className="workspace-profile-skill-heading">
        <input aria-label="Skill name" value={skill.name} maxLength={80} required placeholder="Skill name" onChange={event => update(skill.id, { name: event.target.value })} />
        <button type="button" aria-label={'Remove ' + (skill.name || 'skill')} onClick={() => onChange(skills.filter(item => item.id !== skill.id))}>Remove</button>
      </div>
      <textarea aria-label={'Instructions for ' + (skill.name || 'skill')} value={skill.instructions} maxLength={6000} rows={3} required placeholder="Instructions to follow for this workflow" onChange={event => update(skill.id, { instructions: event.target.value })} />
      <label className="workspace-profile-skill-activation">When to use {skill.name || 'skill'}
        <select aria-label={'When to use ' + (skill.name || 'skill')} value={skill.activation || 'alwaysOn'} onChange={event => update(skill.id, { activation: event.target.value })}>
          <option value="alwaysOn">Always include in V4 tasks</option>
          <option value="onDemand">On demand when relevant or requested</option>
        </select>
      </label>
      <small>V4 can read the instructions when relevant or requested; this depends on the model using tools. Adding the skill to a prompt includes its contents explicitly.</small>
      <details className="skill-package-export"><summary>Export package JSON</summary>
        <p>Copy this package to import it into another V4 profile. Review supporting text before sharing.</p>
        <textarea aria-label={'Export JSON for ' + (skill.name || 'skill')} readOnly rows={5} value={JSON.stringify(skill, null, 2)} />
      </details>
      <SupportFilesEditor skill={skill} onChange={supportFiles => update(skill.id, { supportFiles })} />
      {onSelectSkill && <label className="workspace-profile-check"><input type="checkbox" checked={selectedSkillIds?.includes(skill.id) || false} onChange={event => onSelectSkill(skill.id, event.target.checked)} />{'Include ' + (skill.name || 'skill')}</label>}
    </div>)}
  </div>;
}
