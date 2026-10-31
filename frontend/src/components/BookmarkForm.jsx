import { useRef, useState } from 'react';

export function BookmarkForm({ bookmark, draft, onDraftChange, onSave, onSaved, onCancel, uncertain = false, onUncertainChange, pending = false, saveUnavailable = '' }) {
  const [name, setName] = useState(draft?.name ?? bookmark?.name ?? '');
  const [command, setCommand] = useState(draft?.command ?? bookmark?.command ?? '');
  const [category, setCategory] = useState(draft?.category ?? bookmark?.category ?? 'General');
  const [isSaving, setIsSaving] = useState(false);
  const [saveError, setSaveError] = useState('');
  const revisionRef = useRef(0);

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!isSaving && !pending && !uncertain && !saveUnavailable && name.trim() && command.trim() && category.trim()) {
      const submittedRevision = revisionRef.current;
      setIsSaving(true);
      setSaveError('');
      try {
        await onSave({ name: name.trim(), command: command.trim(), category: category.trim() });
        if (revisionRef.current === submittedRevision) onSaved?.();
      } catch (error) {
        if (error?.outcomeUncertain) {
          onUncertainChange?.(true);
          setSaveError('The bookmark change may have completed. Check the saved bookmarks before trying again. Your draft is still here.');
        } else setSaveError('Could not save bookmark. Your changes are still here; try again.');
      } finally {
        setIsSaving(false);
      }
    }
  };

  return (
    <form className="bookmark-form" onSubmit={handleSubmit}>
      {saveError && <p role="alert">{saveError}</p>}
      {uncertain && !saveError && <p role="alert">The bookmark change may have completed. Check the saved bookmarks before trying again. Your draft is still here.</p>}
      {uncertain && <button type="button" onClick={() => { onUncertainChange?.(false); setSaveError(''); }}>I checked; enable retry</button>}
      <div className="form-group">
        <label htmlFor="bookmark-name">Name</label>
        <input
          id="bookmark-name"
          type="text"
          value={name}
          disabled={isSaving || pending}
          onChange={(e) => { revisionRef.current += 1; setName(e.target.value); onDraftChange?.({ name: e.target.value, command, category }); }}
          placeholder="e.g., Start development server"
          maxLength={100}
          required
        />
      </div>

      <div className="form-group">
        <label htmlFor="bookmark-command">Command</label>
        <textarea
          id="bookmark-command"
          value={command}
          disabled={isSaving || pending}
          onChange={(e) => { revisionRef.current += 1; setCommand(e.target.value); onDraftChange?.({ name, command: e.target.value, category }); }}
          placeholder="e.g., npm run dev"
          rows={3}
          maxLength={1000}
          required
        />
      </div>

      <div className="form-group">
        <label htmlFor="bookmark-category">Category</label>
        <input
          id="bookmark-category"
          type="text"
          value={category}
          disabled={isSaving || pending}
          onChange={(e) => { revisionRef.current += 1; setCategory(e.target.value); onDraftChange?.({ name, command, category: e.target.value }); }}
          placeholder="e.g., Claude, Git, Docker"
          maxLength={50}
          required
        />
      </div>

      <div className="form-actions">
        <button type="button" className="btn-secondary" onClick={onCancel} disabled={isSaving || pending}>
          Cancel
        </button>
        <button type="submit" className="btn-primary" title={saveUnavailable || undefined} disabled={isSaving || pending || uncertain || Boolean(saveUnavailable)}>
          {isSaving || pending ? 'Saving...' : bookmark ? 'Update' : 'Save'}
        </button>
      </div>
    </form>
  );
}
