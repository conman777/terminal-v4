import { useEffect, useId, useRef, useState, useSyncExternalStore } from 'react';
import { getActiveEnvironment, subscribeEnvironment } from '../utils/remoteEnvironments';
import { loadAccountKnowledge, saveAccountKnowledge } from '../utils/workspaceProfile';
import { validateKnowledgeProfile } from '../utils/skillPackages';
import { SkillPackagesEditor } from './SkillPackagesEditor';
import { AccountProposalsPanel } from './WorkspaceProposalsPanel';
import './AccountKnowledgePanel.css';

export function AccountKnowledgePanel({ latestAssistantText, onRequestSuggestions, onDirtyChange }) {
  const environment = useSyncExternalStore(subscribeEnvironment, getActiveEnvironment);
  useEffect(() => { if (environment) onDirtyChange?.(false); }, [environment, onDirtyChange]);
  if (environment) return <section className="account-knowledge-panel" aria-label="Account knowledge settings">
    <h3>Account knowledge</h3>
    <p>Select Home to manage account knowledge and suggestions. Paired connections grant access to workspace tools; account settings stay on their owning server.</p>
  </section>;
  return <HomeAccountKnowledgePanel latestAssistantText={latestAssistantText} onRequestSuggestions={onRequestSuggestions} onDirtyChange={onDirtyChange} />;
}

function HomeAccountKnowledgePanel({ latestAssistantText, onRequestSuggestions, onDirtyChange }) {
  const [profile, setProfile] = useState(null);
  const [savedProfile, setSavedProfile] = useState(null);
  const [changedProfile, setChangedProfile] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const mounted = useRef(false);
  const writing = useRef(false);
  const memoryId = useId();
  const dirty = profile && JSON.stringify(profile) !== JSON.stringify(savedProfile);
  useEffect(() => { onDirtyChange?.(Boolean(dirty)); }, [dirty, onDirtyChange]);

  useEffect(() => {
    mounted.current = true;
    const controller = new AbortController();
    loadAccountKnowledge({ signal: controller.signal }).then(value => {
      if (!controller.signal.aborted) { setProfile(value); setSavedProfile(value); }
    }).catch(loadError => { if (!controller.signal.aborted) setError(loadError.message); });
    return () => { mounted.current = false; controller.abort(); };
  }, []);

  function beginProfileWrite() {
    if (writing.current) return false;
    writing.current = true;
    setBusy(true);
    return true;
  }

  function endProfileWrite() {
    writing.current = false;
    if (mounted.current) setBusy(false);
  }

  async function save(event) {
    event.preventDefault();
    if (!profile || changedProfile || !beginProfileWrite()) return;
    setError(''); setStatus('');
    try {
      validateKnowledgeProfile(profile);
      const value = await saveAccountKnowledge(profile);
      if (!mounted.current) return;
      setProfile(value); setSavedProfile(value); setStatus('Account knowledge saved.');
    } catch (saveError) { if (mounted.current) setError(saveError.message); }
    finally { endProfileWrite(); }
  }

  async function reload() {
    if (!beginProfileWrite()) return;
    setError(''); setStatus('');
    try {
      const value = await loadAccountKnowledge();
      if (!mounted.current) return;
      setProfile(value); setSavedProfile(value); setChangedProfile(null); setStatus('Saved knowledge reloaded.');
    } catch (loadError) { if (mounted.current) setError(loadError.message); }
    finally { endProfileWrite(); }
  }

  function reviewedProfileChanged(value) {
    if (dirty) setChangedProfile(value);
    else { setProfile(value); setSavedProfile(value); }
  }

  return <section className="account-knowledge-panel" aria-label="Account knowledge settings">
    <h3>Account knowledge</h3>
    <p>Preferences and reusable workflows for your V4 account on this host. V4 requests can use these across workspaces. Project-specific knowledge stays in each workspace.</p>
    <p>Automatic learning is staged below for review. Only explicit saves and accepted suggestions change saved knowledge.</p>
    {error && <p role="alert" className="workspace-profile-error">{error}</p>}
    {!profile && error && <button type="button" disabled={busy} onClick={reload}>{busy ? 'Loading account knowledge…' : 'Retry loading account knowledge'}</button>}
    {!profile && !error && <p role="status">Loading account knowledge…</p>}
    {changedProfile && <div className="account-knowledge-conflict" role="status">
      <p>Saved knowledge changed after review. Your unsaved edits were kept; reload the saved version before editing further.</p>
      <button type="button" disabled={busy} onClick={reload}>Reload saved knowledge</button>
    </div>}
    {profile && <form onSubmit={save}>
      <fieldset disabled={busy || !!changedProfile}>
        <label htmlFor={memoryId}>Account knowledge</label>
        <textarea id={memoryId} value={profile.memory} maxLength={6000} rows={5} onChange={event => { setProfile(current => ({ ...current, memory: event.target.value })); setStatus(''); }} />
        <small>{Array.from(profile.memory).length}/6000 characters</small>
        <SkillPackagesEditor skills={profile.skills} onChange={skills => { setProfile(current => ({ ...current, skills })); setStatus(''); }} />
      </fieldset>
      <footer><span role="status">{busy ? 'Saving…' : dirty ? 'Unsaved changes' : status}</span><button type="submit" disabled={busy || !!changedProfile}>Save account knowledge</button></footer>
    </form>}
    {profile && <AccountProposalsPanel savedProfile={savedProfile} latestAssistantText={latestAssistantText} onRequestSuggestions={onRequestSuggestions} onProfileChanged={reviewedProfileChanged} profileWriteBusy={busy} onProfileWriteStart={beginProfileWrite} onProfileWriteEnd={endProfileWrite} />}
  </section>;
}
