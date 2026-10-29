import './UtilityDialogs.css';
import { useToolDialogFocus } from './workspace-tools/useToolDialogFocus';
import './NotesModal.css';
import { useState, useMemo, useCallback, useRef, useEffect, memo } from 'react';
import { LightweightMarkdown } from './LightweightMarkdown';

// Markdown renderer
const MarkdownContent = memo(function MarkdownContent({ content }) {
  if (!content) return null;
  return <LightweightMarkdown content={content} codeClassName="note-code-block" />;
});

// Format relative time
function formatRelativeTime(dateString) {
  const date = new Date(dateString);
  const now = new Date();
  const diffMs = now - date;
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 1) return 'Just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;

  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function NotesModalContent({ isOpen, onClose, notes, onAdd, onUpdate, onDelete, loadStatus = 'ready', loadError = '', onRetryLoad }) {
  const confirmedList = loadStatus === 'ready' && !loadError;
  const dialogRef = useToolDialogFocus(isOpen);
  const [selectedNoteId, setSelectedNoteId] = useState(null);
  const [editTitle, setEditTitle] = useState('');
  const [editContent, setEditContent] = useState('');
  const [editCategory, setEditCategory] = useState('');
  const [searchTerm, setSearchTerm] = useState('');
  const [isCreating, setIsCreating] = useState(false);
  const [saveStatus, setSaveStatus] = useState('idle');
  const [saveError, setSaveError] = useState('');
  const [isDeleting, setIsDeleting] = useState(false);

  const titleInputRef = useRef(null);
  const searchInputRef = useRef(null);
  const retryTriggerRef = useRef(null);
  const contentTextareaRef = useRef(null);
  const saveTimeoutRef = useRef(null);
  const lastSavedRef = useRef({ title: '', content: '', category: '' });
  const draftRef = useRef(null);
  const newDraftRef = useRef(null);
  const saveInFlightRef = useRef(null);
  const transitionRef = useRef(false);
  const isCreatingRef = useRef(false);
  const onUpdateRef = useRef(onUpdate);
  onUpdateRef.current = onUpdate;

  useEffect(() => {
    if (!isOpen) { retryTriggerRef.current = null; return; }
    const trigger = retryTriggerRef.current;
    if (!trigger || trigger.isConnected) return;
    retryTriggerRef.current = null;
    if (document.activeElement === document.body) (titleInputRef.current || searchInputRef.current)?.focus({ preventScroll: true });
  }, [isOpen, loadStatus, loadError]);

  const updateDraft = useCallback((field, value) => {
    if (isDeleting) return;
    draftRef.current = { ...draftRef.current, [field]: value };
    if (isCreatingRef.current) newDraftRef.current = draftRef.current;
    if (field === 'title') setEditTitle(value);
    if (field === 'content') setEditContent(value);
    if (field === 'category') setEditCategory(value);
    setSaveStatus('idle');
    setSaveError('');
  }, [isDeleting]);

  const flushPendingNote = useCallback(async () => {
    clearTimeout(saveTimeoutRef.current);
    try {
      while (!isCreatingRef.current && draftRef.current?.id) {
        if (saveInFlightRef.current) {
          await saveInFlightRef.current;
          continue;
        }
        const draft = draftRef.current;
        const saved = lastSavedRef.current;
        if (draft.title === saved.title && draft.content === saved.content && draft.category === saved.category) return true;
        setSaveStatus('saving');
        setSaveError('');
        const pending = Promise.resolve().then(() => onUpdateRef.current(draft.id, {
          title: draft.title.trim() || draft.originalTitle,
          content: draft.content,
          category: draft.category.trim() || draft.originalCategory,
        })).then(() => {
          lastSavedRef.current = draft;
          setSaveStatus('saved');
        });
        saveInFlightRef.current = pending;
        try {
          await pending;
        } finally {
          if (saveInFlightRef.current === pending) saveInFlightRef.current = null;
        }
      }
      return true;
    } catch (error) {
      console.error('Failed to save note:', error);
      setSaveStatus('error');
      setSaveError('Could not save note. Your changes are still here; try again.');
      return false;
    }
  }, []);

  const navigate = useCallback(async (action) => {
    if (transitionRef.current) return;
    transitionRef.current = true;
    try {
      if (await flushPendingNote()) action();
    } finally {
      transitionRef.current = false;
    }
  }, [flushPendingNote]);

  // Get selected note
  const selectedNote = useMemo(() => {
    return notes.find(n => n.id === selectedNoteId);
  }, [notes, selectedNoteId]);

  // Filter and sort notes
  const filteredNotes = useMemo(() => {
    let filtered = notes;

    if (searchTerm.trim()) {
      const term = searchTerm.toLowerCase();
      filtered = filtered.filter(
        n => n.title.toLowerCase().includes(term) ||
             n.content.toLowerCase().includes(term)
      );
    }

    return [...filtered].sort((a, b) => {
      const dateA = new Date(a.updatedAt || a.createdAt);
      const dateB = new Date(b.updatedAt || b.createdAt);
      return dateB - dateA;
    });
  }, [notes, searchTerm]);

  useEffect(() => {
    if (!selectedNoteId || isCreating) return;
    saveTimeoutRef.current = setTimeout(flushPendingNote, 1000);
    return () => clearTimeout(saveTimeoutRef.current);
  }, [editTitle, editContent, editCategory, selectedNoteId, isCreating, flushPendingNote]);

  useEffect(() => () => {
    clearTimeout(saveTimeoutRef.current);
    void flushPendingNote();
  }, [flushPendingNote]);

  useEffect(() => {
    if (!isOpen) void flushPendingNote();
  }, [isOpen, flushPendingNote]);

  const cancelCreating = useCallback((discard = true) => {
    if (discard !== false) newDraftRef.current = null;
    isCreatingRef.current = false;
    setIsCreating(false);
    draftRef.current = null;
    setEditTitle('');
    setEditContent('');
    setEditCategory('');
    setSaveStatus('idle');
    setSaveError('');
  }, []);

  const saveNewNote = useCallback(async () => {
    if (!isCreatingRef.current || !editTitle.trim() || transitionRef.current) return;
    transitionRef.current = true;
    setSaveStatus('saving');
    setSaveError('');
    try {
      await onAdd(editTitle.trim(), editContent, editCategory.trim() || 'General');
      cancelCreating();
    } catch (error) {
      console.error('Failed to create note:', error);
      setSaveStatus('error');
      setSaveError('Could not save note. Your changes are still here; try again.');
    } finally {
      transitionRef.current = false;
    }
  }, [editTitle, editContent, editCategory, onAdd, cancelCreating]);

  const createNewNote = useCallback(() => {
    if (loadStatus === 'unavailable') return;
    return navigate(() => {
    if (isCreatingRef.current) return;
    setSelectedNoteId(null);
    isCreatingRef.current = true;
    setIsCreating(true);
    const draft = newDraftRef.current || { title: '', content: '', category: 'General' };
    draftRef.current = draft;
    setEditTitle(draft.title);
    setEditContent(draft.content);
    setEditCategory(draft.category);
    setSaveStatus('idle');
    setSaveError('');
    });
  }, [navigate, loadStatus]);

  const handleClose = useCallback(() => navigate(onClose), [navigate, onClose]);

  const handleDelete = useCallback(async () => {
    if (!selectedNote || transitionRef.current || !confirm('Delete this note?')) return;
    transitionRef.current = true;
    setIsDeleting(true);
    clearTimeout(saveTimeoutRef.current);
    try {
      await flushPendingNote();
      await onDelete(selectedNote.id);
      draftRef.current = null;
      setSelectedNoteId(null);
      setSaveError('');
    } catch (error) {
      console.error('Failed to delete note:', error);
      setSaveError('Could not delete note. Your note is still here; try again.');
    } finally {
      setIsDeleting(false);
      transitionRef.current = false;
    }
  }, [selectedNote, onDelete, flushPendingNote]);

  useEffect(() => {
    if (!isOpen) return;
    if (isCreating || selectedNoteId) titleInputRef.current?.focus({ preventScroll: true });
    else searchInputRef.current?.focus({ preventScroll: true });
  }, [isOpen, isCreating, selectedNoteId]);

  // Keyboard shortcuts
  useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (e) => {
      if (e.isComposing || e.keyCode === 229) return;
      if (e.key === 'Escape') {
        if (isCreating) {
          if (saveStatus !== 'saving') cancelCreating();
        } else {
          handleClose();
        }
      }
      if ((e.metaKey || e.ctrlKey) && e.key === 's' && isCreating) {
        e.preventDefault();
        saveNewNote();
      }
      if ((e.metaKey || e.ctrlKey) && e.key === 'n') {
        e.preventDefault();
        createNewNote();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, isCreating, saveStatus, cancelCreating, saveNewNote, createNewNote, handleClose]);

  const goBack = useCallback(() => navigate(() => {
    if (isCreatingRef.current) cancelCreating(false);
    draftRef.current = null;
    setSelectedNoteId(null);
  }), [navigate, cancelCreating]);

  const selectNote = useCallback((noteId) => navigate(() => {
    if (draftRef.current?.id === noteId) return;
    if (isCreatingRef.current) cancelCreating(false);
    const note = notes.find(note => note.id === noteId);
    if (!note) return;
    const draft = { ...note, originalTitle: note.title, originalCategory: note.category };
    draftRef.current = draft;
    lastSavedRef.current = draft;
    setEditTitle(note.title);
    setEditContent(note.content);
    setEditCategory(note.category);
    setSaveStatus('idle');
    setSaveError('');
    setSelectedNoteId(noteId);
  }), [notes, navigate, cancelCreating]);

  // Determine if we have an active selection (for mobile layout)
  const hasSelection = selectedNoteId !== null || isCreating;

  if (!isOpen) return null;

  return (
    <div className="modal-overlay" onClick={handleClose}>
      <div className={`notes-v2 ui-utility-dialog${hasSelection ? ' has-selection' : ''}`} ref={dialogRef} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="notes-dialog-title" onClick={(e) => e.stopPropagation()}>
        <div className="notes-v2-header">
          <h2 id="notes-dialog-title">Notes</h2>
          <button className="notes-v2-close" onClick={handleClose} aria-label="Close">×</button>
        </div>
        <div className="notes-load-health" aria-live="polite">
          {loadStatus === 'loading' && <p role="status">Loading notes…{notes.length > 0 ? ' Showing the last loaded notes while refreshing.' : ''}</p>}
          {(loadStatus === 'error' || loadError) && <div role="alert"><p>Could not load notes. {loadError}{notes.length > 0 ? ' Showing the last loaded notes.' : ''}</p><button type="button" disabled={loadStatus === 'loading' || !onRetryLoad} onClick={event => { retryTriggerRef.current = event.currentTarget; onRetryLoad?.(); }}>Retry loading notes</button></div>}
          {loadStatus === 'unavailable' && <p role="status">Notes are available on This server. Switch back to load them.</p>}
        </div>
        <div className="notes-v2-layout">
          {/* Sidebar */}
          <div className="notes-v2-sidebar">
            <div className="notes-v2-sidebar-header">
              <input
                type="text"
                ref={searchInputRef}
                className="notes-v2-search"
                aria-label="Search notes"
                placeholder="Search..."
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
              />
              <button className="notes-v2-new-btn" disabled={loadStatus === 'unavailable'} onClick={createNewNote} title="New note (⌘N)" aria-label="New note">
                +
              </button>
            </div>

            <div className="notes-v2-list">
              {filteredNotes.length === 0 ? (confirmedList && (
                <div className="notes-v2-empty">
                  {searchTerm ? 'No matches' : 'No notes yet'}
                </div>
              )) : (
                filteredNotes.map((note) => (
                  <button
                    key={note.id}
                    className={`notes-v2-item${selectedNoteId === note.id ? ' active' : ''}`}
                    onClick={() => selectNote(note.id)}
                  >
                    <div className="notes-v2-item-title">{note.title}</div>
                    <div className="notes-v2-item-meta">
                      <span className="notes-v2-item-time">{formatRelativeTime(note.updatedAt || note.createdAt)}</span>
                      <span className="notes-v2-item-category">{note.category}</span>
                    </div>
                  </button>
                ))
              )}
            </div>
          </div>

          {/* Main content */}
          <div className="notes-v2-main">
            {saveError && (
              <div role="alert">
                {saveError}
                {!isCreating && <button onClick={flushPendingNote}>Retry</button>}
              </div>
            )}
            {/* Back button for mobile */}
            {hasSelection && (
              <button className="notes-v2-back-btn" onClick={goBack}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M19 12H5M12 19l-7-7 7-7" />
                </svg>
                Back
              </button>
            )}

            {isCreating ? (
              // Creating new note - explicit save required
              <div className="notes-v2-editor">
                <div className="notes-v2-editor-header">
                  <input
                    ref={titleInputRef}
                    type="text"
                    className="notes-v2-title-input"
                    aria-label="Note title"
                    placeholder="Untitled"
                    value={editTitle}
                    onChange={(e) => updateDraft('title', e.target.value)}
                    disabled={saveStatus === 'saving'}
                  />
                  <div className="notes-v2-editor-actions">
                    <input
                      type="text"
                      className="notes-v2-category-input"
                      aria-label="Note category"
                      placeholder="Category"
                      value={editCategory}
                      onChange={(e) => updateDraft('category', e.target.value)}
                      disabled={saveStatus === 'saving'}
                    />
                    <button className="notes-v2-save-btn" onClick={saveNewNote} disabled={saveStatus === 'saving'}>
                      Save
                    </button>
                    <button className="notes-v2-cancel-btn" onClick={cancelCreating} disabled={saveStatus === 'saving'}>
                      Cancel
                    </button>
                  </div>
                </div>
                <textarea
                  ref={contentTextareaRef}
                  className="notes-v2-content-input"
                  aria-label="Note content"
                  placeholder="Write something... (Markdown supported)"
                  value={editContent}
                  onChange={(e) => updateDraft('content', e.target.value)}
                  disabled={saveStatus === 'saving'}
                />
                <div className="notes-v2-editor-hint">
                  <span>⌘S to save</span>
                  <span>ESC to cancel</span>
                </div>
              </div>
            ) : selectedNote ? (
              // Editing existing note - autosave enabled
              <div className="notes-v2-editor">
                <div className="notes-v2-editor-header">
                  <input
                    ref={titleInputRef}
                    type="text"
                    className="notes-v2-title-input"
                    aria-label="Note title"
                    placeholder="Untitled"
                    value={editTitle}
                    onChange={(e) => updateDraft('title', e.target.value)}
                    disabled={isDeleting}
                  />
                  <div className="notes-v2-editor-actions">
                    <input
                      type="text"
                      className="notes-v2-category-input"
                      aria-label="Note category"
                      placeholder="Category"
                      value={editCategory}
                      onChange={(e) => updateDraft('category', e.target.value)}
                      disabled={isDeleting}
                    />
                    <span role="status" className={`notes-v2-save-status ${saveStatus}`}>
                      {saveStatus === 'saving' && 'Saving...'}
                      {saveStatus === 'saved' && 'Saved'}
                    </span>
                    <button className="notes-v2-delete-btn" onClick={handleDelete} disabled={isDeleting}>
                      Delete
                    </button>
                  </div>
                </div>
                <textarea
                  ref={contentTextareaRef}
                  className="notes-v2-content-input"
                  aria-label="Note content"
                  placeholder="Write something... (Markdown supported)"
                  value={editContent}
                  onChange={(e) => updateDraft('content', e.target.value)}
                  disabled={isDeleting}
                />
                <div className="notes-v2-editor-hint">
                  <span>Auto-saves as you type</span>
                </div>
              </div>
            ) : (
              // Empty state
              <div className="notes-v2-empty-state">
                <p>{confirmedList ? 'Select a note or create a new one' : loadStatus === 'unavailable' ? 'Switch back to This server to use saved notes.' : 'Retry loading your saved notes, or create a new draft.'}</p>
                <button className="notes-v2-create-btn" disabled={loadStatus === 'unavailable'} onClick={createNewNote}>
                  New Note
                </button>
              </div>
            )}
          </div>

        </div>
      </div>
    </div>
  );
}

export function NotesModal(props) {
  return <NotesModalContent key={props.scopeKey ?? 'default'} {...props} />;
}
