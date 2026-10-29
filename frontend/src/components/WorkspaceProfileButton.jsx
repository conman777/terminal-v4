import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { NEW_TAB_AI_OPTIONS } from '../utils/aiProviders';
import { buildWorkspaceContext, loadWorkspaceProfile, saveWorkspaceProfile } from '../utils/workspaceProfile';
import { validateKnowledgeProfile } from '../utils/skillPackages';
import { SkillPackagesEditor } from './SkillPackagesEditor';
import { AgentModelPicker } from './AgentModelPicker';
import './WorkspaceProfileButton.css';

function readFileText(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(reader.error || new Error('unreadable'));
    reader.readAsText(file);
  });
}

function WorkspaceProfileEditor({ workspacePath, aiOptions, onInsertContext, onSaved, onClose, triggerRef }) {
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
    const background = [...new Set([document.getElementById('root'), triggerRef.current?.closest('[role="dialog"]')])].filter(Boolean);
    const previous = background.map(element => element.inert);
    background.forEach(element => { element.inert = true; });
    return () => {
      background.forEach((element, index) => { element.inert = previous[index]; });
      triggerRef.current?.focus({ preventScroll: true });
    };
  }, []);

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
      validateKnowledgeProfile(profile);
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

  function exportProfile() {
    const url = URL.createObjectURL(new Blob([JSON.stringify(profile, null, 2)], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `${(workspacePath.split(/[\\/]/).filter(Boolean).pop() || 'workspace')}-knowledge.json`;
    link.click();
    URL.revokeObjectURL(url);
  }

  async function importProfile(event) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    try {
      const imported = JSON.parse(await readFileText(file));
      validateKnowledgeProfile(imported);
      setProfile({ ...profile, ...imported });
      setSaved(false); setError('');
    } catch (failure) {
      setError(`That file is not workspace knowledge: ${failure.message || 'unreadable'}`);
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

  const context = buildWorkspaceContext(profile, selectedSkills, includeMemory);
  const contextWithinBudget = Array.from(context).length <= 50000;
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
              {profile.defaultAgent && profile.defaultAgent !== 'cli' && <AgentModelPicker compact showSpeed={false}
                agentId={profile.defaultAgent} value={profile.selection}
                onChange={selection => setProfile(current => ({
                  ...current, selection: { model: selection.model, reasoning: selection.reasoning || '' },
                }))} />}
            </div>
            <SkillPackagesEditor skills={profile.skills} onChange={skills => { setProfile(current => ({ ...current, skills })); setSaved(false); }}
              selectedSkillIds={selectedSkills} onSelectSkill={onInsertContext ? (id, selected) => setSelectedSkills(current => selected ? [...current, id] : current.filter(value => value !== id)) : undefined} />
            {onInsertContext && <div className="workspace-profile-context">
              <label className="workspace-profile-check">
                <input type="checkbox" checked={includeMemory} onChange={event => setIncludeMemory(event.target.checked)} />
                Include project knowledge
              </label>
              <p>Selected context is added to the editable prompt. Review it before sending.</p>
              {!contextWithinBudget && <p role="alert" className="workspace-profile-error">Select fewer skills to keep the prompt within 50000 characters.</p>}
            </div>}
          </fieldset>
          <footer>
            <span role="status">{saving ? 'Saving…' : dirty ? 'Unsaved changes' : saved ? 'Workspace saved' : 'Saved on this host for your account'}</span>
            {onInsertContext && <button type="button" disabled={!context || !contextWithinBudget || saving}
              onClick={() => { onInsertContext(context); onClose(); }}>Add to prompt</button>}
            <button type="button" disabled={saving} onClick={exportProfile}>Export</button>
            <label className="workspace-profile-import">Import<input type="file" accept="application/json,.json" aria-label="Import knowledge file" disabled={saving} onChange={importProfile} /></label>
            <button type="submit" disabled={saving}>Save workspace</button>
          </footer>
        </form>}
      </section>
    </div>, document.body,
  );
}

export function WorkspaceProfileButton({ workspacePath, aiOptions = NEW_TAB_AI_OPTIONS, onInsertContext, onSaved, iconOnly = false }) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef(null);

  useEffect(() => {
    setOpen(false);
  }, [workspacePath]);

  function close() {
    setOpen(false);
  }

  return <>
    <button type="button" className={`workspace-profile-trigger${iconOnly ? ' workspace-profile-trigger-icon-only' : ''}`} ref={triggerRef} disabled={!workspacePath}
      aria-label="Workspace knowledge" aria-haspopup="dialog" aria-expanded={open} title="Knowledge"
      onClick={() => setOpen(true)}>{iconOnly
        ? <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20V3H6.5A2.5 2.5 0 0 0 4 5.5z" /><path d="M4 19.5A2.5 2.5 0 0 0 6.5 22H20v-5" /></svg>
        : 'Knowledge'}</button>
    {open && <WorkspaceProfileEditor key={workspacePath} workspacePath={workspacePath} aiOptions={aiOptions}
      onInsertContext={onInsertContext} onSaved={onSaved} onClose={close} triggerRef={triggerRef} />}
  </>;
}
