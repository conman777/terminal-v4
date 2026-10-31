import './UtilityDialogs.css';
import { useToolDialogFocus } from './workspace-tools/useToolDialogFocus';
import './BookmarkModal.css';
import { useState, useMemo, useRef, useEffect } from 'react';
import { BookmarkForm } from './BookmarkForm';

function BookmarkModalContent({ isOpen, onClose, bookmarks, onAdd, onUpdate, onDelete, onExecute, loadStatus = 'ready', loadError = '', onRetryLoad, scopeHeld = false, scopeHoldMessage, scopeHoldCanRetry = true, executionUnavailable = '', saveUnavailable = '' }) {
  const confirmedList = loadStatus === 'ready' && !loadError;
  const dialogRef = useToolDialogFocus(isOpen, onClose);
  const [selectedCategory, setSelectedCategory] = useState('All');
  const [searchTerm, setSearchTerm] = useState('');
  const [editor, setEditor] = useState(null);
  const editorGenerationRef = useRef(0);
  const editorTriggerRef = useRef(null);
  const addButtonRef = useRef(null);
  const retryTriggerRef = useRef(null);
  const activeEditorRef = useRef(editor);
  activeEditorRef.current = editor;
  const draftsRef = useRef(new Map());
  const uncertainDraftsRef = useRef(new Set());
  const pendingDraftsRef = useRef(new Set());
  const [, refreshDraftState] = useState(0);
  const markUncertain = (key, value) => {
    if (value) uncertainDraftsRef.current.add(key);
    else uncertainDraftsRef.current.delete(key);
    refreshDraftState(version => version + 1);
  };
  const editingBookmark = editor?.bookmark;
  const showAddForm = editor !== null && !editingBookmark;
  const [deleteError, setDeleteError] = useState('');
  const [executeError, setExecuteError] = useState('');
  const [isExecuting, setIsExecuting] = useState(false);
  const executionGenerationRef = useRef(0);

  useEffect(() => {
    executionGenerationRef.current += 1;
    setIsExecuting(false);
    setExecuteError('');
    if (!isOpen) setEditor(current => current ? { ...current, generation: ++editorGenerationRef.current, draft: draftsRef.current.get(current.bookmark?.id || 'new') } : null);
    return () => { executionGenerationRef.current += 1; };
  }, [isOpen]);

  useEffect(() => {
    if (isOpen && editor && !scopeHeld) dialogRef.current?.querySelector('#bookmark-name')?.focus({ preventScroll: true });
  }, [isOpen, editor?.generation, scopeHeld, dialogRef]);

  useEffect(() => {
    if (isOpen && scopeHeld) dialogRef.current?.focus({ preventScroll: true });
  }, [isOpen, scopeHeld, dialogRef]);

  useEffect(() => {
    if (!isOpen) { retryTriggerRef.current = null; return; }
    const trigger = retryTriggerRef.current;
    if (!trigger || trigger.isConnected) return;
    retryTriggerRef.current = null;
    if (document.activeElement === document.body) (dialogRef.current?.querySelector('#bookmark-name') || dialogRef.current?.querySelector('.bookmark-modal-search input'))?.focus({ preventScroll: true });
  }, [isOpen, loadStatus, loadError]);

  // Get unique categories
  const categories = useMemo(() => {
    const cats = new Set(bookmarks.map((b) => b.category));
    return ['All', ...Array.from(cats).sort()];
  }, [bookmarks]);

  // Filter bookmarks by category and search
  const filteredBookmarks = useMemo(() => {
    let filtered = bookmarks;

    if (selectedCategory !== 'All') {
      filtered = filtered.filter((b) => b.category === selectedCategory);
    }

    if (searchTerm.trim()) {
      const term = searchTerm.toLowerCase();
      filtered = filtered.filter(
        (b) => b.name.toLowerCase().includes(term) || b.command.toLowerCase().includes(term)
      );
    }

    return filtered;
  }, [bookmarks, selectedCategory, searchTerm]);

  const handleSaveBookmark = async (data) => {
    const key = editingBookmark?.id || 'new';
    const submittedDraft = draftsRef.current.get(key);
    if (pendingDraftsRef.current.has(key)) throw new Error('This bookmark save is already in progress.');
    pendingDraftsRef.current.add(key);
    refreshDraftState(version => version + 1);
    try {
      if (editingBookmark) {
        await onUpdate(editingBookmark.id, data);
      } else {
        await onAdd(data.name, data.command, data.category);
      }
      if (draftsRef.current.get(key) === submittedDraft) draftsRef.current.delete(key);
      uncertainDraftsRef.current.delete(key);
    } finally {
      pendingDraftsRef.current.delete(key);
      refreshDraftState(version => version + 1);
    }
  };

  const handleCancelEdit = () => {
    draftsRef.current.delete(editingBookmark?.id || 'new');
    uncertainDraftsRef.current.delete(editingBookmark?.id || 'new');
    setEditor(null);
    (editorTriggerRef.current?.isConnected ? editorTriggerRef.current : addButtonRef.current)?.focus({ preventScroll: true });
  };

  const handleSavedBookmark = () => {
    if (activeEditorRef.current !== editor) return;
    setEditor(null);
    (editorTriggerRef.current?.isConnected ? editorTriggerRef.current : addButtonRef.current)?.focus({ preventScroll: true });
  };

  const handleDelete = async (id) => {
    setDeleteError('');
    try {
      await onDelete(id);
      draftsRef.current.delete(id);
      setEditor(current => current?.bookmark?.id === id ? null : current);
    } catch {
      setDeleteError('Could not delete bookmark. Try again.');
    }
  };

  const handleExecute = async (command) => {
    if (isExecuting) return;
    const generation = executionGenerationRef.current;
    const editorGeneration = editorGenerationRef.current;
    setExecuteError('');
    setIsExecuting(true);
    try {
      await onExecute(command);
      if (generation !== executionGenerationRef.current || editorGeneration !== editorGenerationRef.current) return;
      onClose();
    } catch (error) {
      if (generation !== executionGenerationRef.current) return;
      setExecuteError(error.message || 'Could not execute bookmark. Try again.');
    } finally {
      if (generation === executionGenerationRef.current) setIsExecuting(false);
    }
  };

  if (!isOpen) return null;

  if (scopeHeld) return (
    <div className="modal-overlay">
      <div className="bookmark-modal bookmark-scope-held ui-utility-dialog" ref={dialogRef} tabIndex={-1} role="dialog" aria-modal="true" aria-label="Bookmarks">
        <div className="bookmark-modal-header"><h2>Bookmarks</h2><button className="modal-close" onClick={onClose} aria-label="Close">×</button></div>
        <div className="bookmark-load-health"><div role="alert"><p>{scopeHoldMessage || 'Bookmark storage ownership is ambiguous. Administrator review is required.'}</p>{scopeHoldCanRetry && <button type="button" onClick={onRetryLoad} disabled={loadStatus === 'loading' || !onRetryLoad}>Retry loading bookmarks</button>}</div></div>
      </div>
    </div>
  );

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="bookmark-modal ui-utility-dialog" ref={dialogRef} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="bookmarks-title" onClick={(e) => e.stopPropagation()}>
        <div className="bookmark-modal-header">
          <div className="bookmark-modal-title">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="m19 21-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v16z" />
            </svg>
            <h2 id="bookmarks-title">Bookmarks</h2>
          </div>
          <button className="modal-close" onClick={onClose} aria-label="Close">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        <div className="bookmark-load-health" aria-live="polite">
          {loadStatus === 'loading' && <p role="status">Loading bookmarks…{bookmarks.length > 0 ? ' Showing the last loaded bookmarks while refreshing.' : ''}</p>}
          {(loadStatus === 'error' || loadError) && <div role="alert"><p>Could not load bookmarks. {loadError}{bookmarks.length > 0 ? ' Showing the last loaded bookmarks.' : ''}</p><button type="button" disabled={loadStatus === 'loading' || !onRetryLoad} onClick={event => { retryTriggerRef.current = event.currentTarget; onRetryLoad?.(); }}>Retry loading bookmarks</button></div>}
          {loadStatus === 'unavailable' && <p role="status">Bookmarks are available on This server. Switch back to load them.</p>}
          {executionUnavailable && loadStatus === 'ready' && <p role="status">{executionUnavailable}</p>}
        </div>
        <div className="bookmark-modal-search">
          <input
            type="text"
            placeholder="Search bookmarks..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            aria-label="Search bookmarks"
          />
        </div>

        <div className="bookmark-modal-body">
          {deleteError && <p role="alert">{deleteError}</p>}
          {executeError && <p role="alert">{executeError}</p>}
          {/* Categories sidebar */}
          <div className="bookmark-categories">
            <div className="bookmark-categories-header">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.93a2 2 0 0 1-1.66-.9l-.82-1.2A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z" />
              </svg>
              <h3>Categories</h3>
            </div>
            <div className="bookmark-category-list">
              {categories.map((cat) => (
                <button
                  key={cat}
                  className={`bookmark-category-item${cat === selectedCategory ? ' active' : ''}`}
                  aria-pressed={cat === selectedCategory}
                  onClick={() => setSelectedCategory(cat)}
                >
                  {cat}
                  <span className="bookmark-count">
                    {confirmedList || bookmarks.length > 0 ? cat === 'All' ? bookmarks.length : bookmarks.filter((b) => b.category === cat).length : '—'}
                  </span>
                </button>
              ))}
            </div>
          </div>

          {/* Bookmarks list */}
          <div className="bookmark-list-pane">
            <div className="bookmark-list-header">
              <h3>
                {selectedCategory === 'All' ? 'All Bookmarks' : selectedCategory}{confirmedList && ` (${filteredBookmarks.length})`}
              </h3>
              <button
                ref={addButtonRef}
                className="bookmark-add-btn"
                disabled={loadStatus === 'unavailable'}
                onClick={event => {
                  editorTriggerRef.current = event.currentTarget;
                  if (showAddForm) return;
                  setEditor({ generation: ++editorGenerationRef.current, bookmark: null, draft: draftsRef.current.get('new') });
                }}
                title="Add bookmark"
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="12" y1="5" x2="12" y2="19" />
                  <line x1="5" y1="12" x2="19" y2="12" />
                </svg>
                <span>Add</span>
              </button>
            </div>

            {showAddForm && (
              <div className="bookmark-form-container" onChange={() => { editorGenerationRef.current += 1; }}>
                <BookmarkForm key={editor.generation} draft={draftsRef.current.get('new') || editor.draft} pending={pendingDraftsRef.current.has('new')} uncertain={uncertainDraftsRef.current.has('new')} saveUnavailable={saveUnavailable} onUncertainChange={value => markUncertain('new', value)} onDraftChange={draft => draftsRef.current.set('new', draft)} onSave={handleSaveBookmark} onSaved={handleSavedBookmark} onCancel={handleCancelEdit} />
              </div>
            )}

            {editingBookmark && (
              <div className="bookmark-form-container" onChange={() => { editorGenerationRef.current += 1; }}>
                <BookmarkForm key={editor.generation} bookmark={editingBookmark} draft={draftsRef.current.get(editingBookmark.id) || editor.draft} pending={pendingDraftsRef.current.has(editingBookmark.id)} uncertain={uncertainDraftsRef.current.has(editingBookmark.id)} saveUnavailable={saveUnavailable} onUncertainChange={value => markUncertain(editingBookmark.id, value)} onDraftChange={draft => draftsRef.current.set(editingBookmark.id, draft)} onSave={handleSaveBookmark} onSaved={handleSavedBookmark} onCancel={handleCancelEdit} />
              </div>
            )}

            <div className="bookmark-list-items">
              {confirmedList && filteredBookmarks.length === 0 && !showAddForm && (
                <div className="bookmark-empty">
                  {searchTerm
                    ? 'No bookmarks match your search'
                    : selectedCategory === 'All'
                      ? 'No bookmarks yet. Click "+ Add" to create one.'
                      : `No bookmarks in ${selectedCategory} category`}
                </div>
              )}

              {filteredBookmarks.map((bookmark) => (
                <div key={bookmark.id} className="bookmark-item">
                  <button
                    className="bookmark-execute-btn"
                    onClick={() => handleExecute(bookmark.command)}
                    disabled={isExecuting || Boolean(executionUnavailable)}
                    title={executionUnavailable || `Execute: ${bookmark.command}`}
                    aria-label={`Execute bookmark: ${bookmark.name}`}
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" stroke="none">
                      <polygon points="6 3 20 12 6 21 6 3" />
                    </svg>
                  </button>

                  <div className="bookmark-content">
                    <div className="bookmark-name">{bookmark.name}</div>
                    <div className="bookmark-command">{bookmark.command}</div>
                    <div className="bookmark-meta">
                      <span className="bookmark-category-badge">{bookmark.category}</span>
                    </div>
                  </div>

                  <div className="bookmark-actions">
                    <button
                      className="bookmark-edit-btn"
                      onClick={event => {
                        editorTriggerRef.current = event.currentTarget;
                        if (editingBookmark?.id === bookmark.id) return;
                        setEditor({ generation: ++editorGenerationRef.current, bookmark, draft: draftsRef.current.get(bookmark.id) });
                      }}
                      title="Edit bookmark"
                      aria-label="Edit bookmark"
                    >
                      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
                      </svg>
                    </button>
                    <button
                      className="bookmark-delete-btn"
                      onClick={() => handleDelete(bookmark.id)}
                      title="Delete bookmark"
                      aria-label="Delete bookmark"
                    >
                      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M3 6h18" />
                        <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" />
                        <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" />
                      </svg>
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export function BookmarkModal(props) {
  return <BookmarkModalContent key={props.scopeKey ?? 'default'} {...props} />;
}
