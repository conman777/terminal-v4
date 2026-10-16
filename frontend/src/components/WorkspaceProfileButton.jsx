import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { NEW_TAB_AI_OPTIONS } from '../utils/aiProviders';
import { buildWorkspaceContext, loadWorkspaceProfile, saveWorkspaceProfile } from '../utils/workspaceProfile';
import { AgentModelPicker } from './AgentModelPicker';
import './WorkspaceProfileButton.css';

function WorkspaceProfileEditor({ workspacePath, aiOptions, onInsertContext, onSaved, onClose }) {
  const [profile, setProfile] = useState(null);
  const [savedProfile, setSavedProfile] = useState(null);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [selectedSkills, setSelectedSkills] = useState([]);
  const [includeMemory, setIncludeMemory] = useState(true);
  const dialogRef = useRef(null);
  const mountedRef = useRef(false);
  const fieldId = useId();

  useEffect(() => {
    mountedRef.current = true;
    const controller = new AbortController();
    loadWorkspaceProfile(workspacePath, { signal: controller.signal })
      .then(value => {
        if (!controller.signal.aborted) {
          setProfile(value);
          setSavedProfile(value);
        }
      })
      .catch(loadError => {
        if (!controller.signal.aborted) setError(loadError.message);
      });
    dialogRef.current?.focus();
    return () => { mountedRef.current = false; controller.abort(); };
  }, [workspacePath]);

  async function handleSave(event) {
    event.preventDefault();
    event.stopPropagation();
    setSaving(true);
    setError('');
    setSaved(false);
    try {
      const value = await saveWorkspaceProfile(workspacePath, profile);
      if (!mountedRef.current) return;
      setSavedProfile(profile);
      setSaved(true);
      onSaved?.(value);
    } catch (saveError) {
      if (mountedRef.current) setError(saveError.message);
    } finally {
      if (mountedRef.current) {
        setSaving(false);
        dialogRef.current?.focus();
      }
    }
  }

  function handleKeyDown(event) {
    if (event.key === 'Escape') {
      event.stopPropagation();
      if (!saving) onClose();
    }
    if (event.key !== 'Tab') return;
    const fields = dialogRef.current?.querySelectorAll('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled)');
    if (!fields?.length) return;
    const first = fields[0];
    const last = fields[fields.length - 1];
    if (event.shiftKey && (document.activeElement === first || document.activeElement === dialogRef.current)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  function updateSkill(id, changes) {
    setProfile(current => ({
      ...current,
      skills: current.skills.map(skill => skill.id === id ? { ...skill, ...changes } : skill),
    }));
    setSaved(false);
  }

  const context = buildWorkspaceContext(profile, selectedSkills, includeMemory);
  const dirty = profile && JSON.stringify(profile) !== JSON.stringify(savedProfile);

  return createPortal(
    <div className="modal-overlay workspace-profile-overlay" onClick={event => {
      event.stopPropagation();
      if (event.target === event.currentTarget && !saving) onClose();
    }}>
      <section className="workspace-profile-dialog" role="dialog" aria-modal="true" aria-labelledby={fieldId + '-title'}
        tabIndex={-1} ref={dialogRef} onKeyDown={handleKeyDown}>
        <header>
          <div><h2 id={fieldId + '-title'}>Workspace knowledge</h2><p title={workspacePath}>{workspacePath}</p></div>
          <button type="button" onClick={onClose} disabled={saving} aria-label="Close workspace knowledge">×</button>
        </header>
        {error && <p role="alert" className="workspace-profile-error">{error}</p>}
        {!profile && !error && <p role="status">Loading workspace…</p>}
        {profile && <form onSubmit={handleSave}>
          <fieldset disabled={saving}>
            <label htmlFor={fieldId + '-memory'}>Project knowledge</label>
            <p>Keep useful commands, conventions, and decisions for future tasks.</p>
            <textarea id={fieldId + '-memory'} value={profile.memory} maxLength={6000} rows={5}
              onChange={event => { setProfile({ ...profile, memory: event.target.value }); setSaved(false); }} />
            <small>{profile.memory.length}/6000 characters</small>
            <div className="workspace-profile-defaults">
              <label htmlFor={fieldId + '-agent'}>Default agent for new tasks</label>
              <select id={fieldId + '-agent'} value={profile.defaultAgent}
                onChange={event => { setProfile({ ...profile, defaultAgent: event.target.value, selection: null }); setSaved(false); }}>
                <option value="">Use app default</option>
                {aiOptions.map(option => <option key={option.id} value={option.id}>{option.label}</option>)}
              </select>
              {profile.defaultAgent && profile.defaultAgent !== 'cli' && <AgentModelPicker
                agentId={profile.defaultAgent} value={profile.selection}
                onChange={selection => setProfile(current => ({
                  ...current, selection: { model: selection.model, reasoning: selection.reasoning || '' },
                }))} />}
            </div>
            <div className="workspace-profile-section-heading">
              <h3>Reusable skills</h3>
              <button type="button" disabled={profile.skills.length >= 20}
                onClick={() => { setProfile({ ...profile, skills: [...profile.skills, { id: crypto.randomUUID(), name: '', instructions: '' }] }); setSaved(false); }}>
                Add skill
              </button>
            </div>
            {profile.skills.length === 0 && <p>Save a repeatable workflow, then choose it when preparing a prompt.</p>}
            {profile.skills.map(skill => (
              <div className="workspace-profile-skill" key={skill.id}>
                <div className="workspace-profile-skill-heading">
                  <input aria-label="Skill name" value={skill.name} maxLength={80} required placeholder="Skill name"
                    onChange={event => updateSkill(skill.id, { name: event.target.value })} />
                  <button type="button" aria-label={'Remove ' + (skill.name || 'skill')}
                    onClick={() => { setProfile({ ...profile, skills: profile.skills.filter(item => item.id !== skill.id) }); setSaved(false); }}>Remove</button>
                </div>
                <textarea aria-label={'Instructions for ' + (skill.name || 'skill')} value={skill.instructions}
                  maxLength={6000} rows={3} required placeholder="Instructions to follow for this workflow"
                  onChange={event => updateSkill(skill.id, { instructions: event.target.value })} />
                {onInsertContext && <label className="workspace-profile-check">
                  <input type="checkbox" checked={selectedSkills.includes(skill.id)}
                    onChange={event => setSelectedSkills(current => event.target.checked
                      ? [...current, skill.id] : current.filter(id => id !== skill.id))} />
                  {'Include ' + (skill.name || 'skill')}
                </label>}
              </div>
            ))}
            {onInsertContext && <div className="workspace-profile-context">
              <label className="workspace-profile-check">
                <input type="checkbox" checked={includeMemory} onChange={event => setIncludeMemory(event.target.checked)} />
                Include project knowledge
              </label>
              <p>Selected context is added to the editable prompt. Review it before sending.</p>
            </div>}
          </fieldset>
          <footer>
            <span role="status">{saving ? 'Saving…' : dirty ? 'Unsaved changes' : saved ? 'Workspace saved' : 'Saved on this host for your account'}</span>
            {onInsertContext && <button type="button" disabled={!context || saving}
              onClick={() => { onInsertContext(context); onClose(); }}>Add to prompt</button>}
            <button type="submit" disabled={saving}>Save workspace</button>
          </footer>
        </form>}
      </section>
    </div>, document.body,
  );
}

export function WorkspaceProfileButton({ workspacePath, aiOptions = NEW_TAB_AI_OPTIONS, onInsertContext, onSaved }) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef(null);

  useEffect(() => {
    setOpen(false);
  }, [workspacePath]);

  function close() {
    setOpen(false);
    triggerRef.current?.focus();
  }

  return <>
    <button type="button" className="workspace-profile-trigger" ref={triggerRef} disabled={!workspacePath}
      aria-label="Workspace knowledge" aria-haspopup="dialog" aria-expanded={open}
      onClick={() => setOpen(true)}>Knowledge</button>
    {open && <WorkspaceProfileEditor key={workspacePath} workspacePath={workspacePath} aiOptions={aiOptions}
      onInsertContext={onInsertContext} onSaved={onSaved} onClose={close} />}
  </>;
}
