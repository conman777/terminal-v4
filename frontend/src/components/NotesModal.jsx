import { useState, useMemo, useCallback, useRef, useEffect, memo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { LazySyntaxHighlighter } from './LazySyntaxHighlighter';

// Code block renderer for markdown
const CodeBlock = memo(function CodeBlock({ node, inline, className, children, ...props }) {
  const match = /language-(\w+)/.exec(className || '');
  const language = match ? match[1] : '';

  if (inline) {
    return (
      <code className="note-inline-code" {...props}>
        {children}
      </code>
    );
  }

  return (
    <LazySyntaxHighlighter
      language={language || 'text'}
      customStyle={{
        margin: '12px 0',
        borderRadius: '6px',
        fontSize: '13px',
      }}
      {...props}
    >
      {String(children).replace(/\n$/, '')}
    </LazySyntaxHighlighter>
  );
});

// Markdown renderer
const MarkdownContent = memo(function MarkdownContent({ content }) {
  if (!content) return null;

  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        code: CodeBlock,
        a: ({ node, ...props }) => (
          <a {...props} target="_blank" rel="noopener noreferrer" />
        ),
      }}
    >
      {content}
    </ReactMarkdown>
  );
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

export function NotesModal({ isOpen, onClose, notes, onAdd, onUpdate, onDelete }) {
  const [selectedNoteId, setSelectedNoteId] = useState(null);
  const [editTitle, setEditTitle] = useState('');
  const [editContent, setEditContent] = useState('');
  const [editCategory, setEditCategory] = useState('');
  const [searchTerm, setSearchTerm] = useState('');
  const [isCreating, setIsCreating] = useState(false);
  const [saveStatus, setSaveStatus] = useState('idle'); // 'idle' | 'saving' | 'saved'

  const titleInputRef = useRef(null);
  const contentTextareaRef = useRef(null);
  const saveTimeoutRef = useRef(null);
  const lastSavedRef = useRef({ title: '', content: '', category: '' });

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

  // Sync edit fields when selected note changes
  useEffect(() => {
    if (selectedNote && !isCreating) {
      setEditTitle(selectedNote.title);
      setEditContent(selectedNote.content);
      setEditCategory(selectedNote.category);
      lastSavedRef.current = {
        title: selectedNote.title,
        content: selectedNote.content,
        category: selectedNote.category,
      };
      setSaveStatus('idle');
    }
  }, [selectedNoteId]); // Only trigger on ID change

  // Autosave effect
  useEffect(() => {
    if (!selectedNote || isCreating) return;

    // Check if anything changed from last saved state
    const hasChanges =
      editTitle !== lastSavedRef.current.title ||
      editContent !== lastSavedRef.current.content ||
      editCategory !== lastSavedRef.current.category;

    if (!hasChanges) return;

    // Clear previous timeout
    if (saveTimeoutRef.current) {
      clearTimeout(saveTimeoutRef.current);
    }

    // Debounce save
    saveTimeoutRef.current = setTimeout(async () => {
      setSaveStatus('saving');
      try {
        await onUpdate(selectedNote.id, {
          title: editTitle.trim() || selectedNote.title,
          content: editContent,
          category: editCategory.trim() || selectedNote.category,
        });
        lastSavedRef.current = {
          title: editTitle,
          content: editContent,
          category: editCategory,
        };
        setSaveStatus('saved');
        setTimeout(() => setSaveStatus('idle'), 2000);
      } catch (error) {
        console.error('Failed to save note:', error);
        setSaveStatus('idle');
      }
    }, 1000);

    return () => {
      if (saveTimeoutRef.current) {
        clearTimeout(saveTimeoutRef.current);
      }
    };
  }, [editTitle, editContent, editCategory, selectedNote, isCreating, onUpdate]);

  // Save new note
  const saveNewNote = useCallback(async () => {
    if (isCreating && editTitle.trim()) {
      await onAdd(editTitle.trim(), editContent, editCategory.trim() || 'General');
      setIsCreating(false);
      setEditTitle('');
      setEditContent('');
      setEditCategory('');
    }
  }, [isCreating, editTitle, editContent, editCategory, onAdd]);

  // Create new note
  const createNewNote = useCallback(() => {
    // Clear any pending save
    if (saveTimeoutRef.current) {
      clearTimeout(saveTimeoutRef.current);
    }
    setSelectedNoteId(null);
    setIsCreating(true);
    setEditTitle('');
    setEditContent('');
    setEditCategory('General');
    setSaveStatus('idle');
  }, []);

  // Cancel creating
  const cancelCreating = useCallback(() => {
    setIsCreating(false);
    setEditTitle('');
    setEditContent('');
    setEditCategory('');
  }, []);

  // Delete note
  const handleDelete = useCallback(async () => {
    if (selectedNote && confirm('Delete this note?')) {
      // Clear any pending save
      if (saveTimeoutRef.current) {
        clearTimeout(saveTimeoutRef.current);
      }
      await onDelete(selectedNote.id);
      setSelectedNoteId(null);
    }
  }, [selectedNote, onDelete]);

  // Focus title input when creating
  useEffect(() => {
    if (isCreating && titleInputRef.current) {
      titleInputRef.current.focus();
    }
  }, [isCreating]);

  // Keyboard shortcuts
  useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (e) => {
      if (e.key === 'Escape') {
        if (isCreating) {
          cancelCreating();
        } else {
          onClose();
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
  }, [isOpen, isCreating, cancelCreating, saveNewNote, createNewNote, onClose]);

  // Go back to list (for mobile)
  const goBack = useCallback(() => {
    if (isCreating) {
      cancelCreating();
    }
    setSelectedNoteId(null);
  }, [isCreating, cancelCreating]);

  // Select a note
  const selectNote = useCallback((noteId) => {
    // Clear any pending save
    if (saveTimeoutRef.current) {
      clearTimeout(saveTimeoutRef.current);
    }
    if (isCreating) {
      cancelCreating();
    }
    setSelectedNoteId(noteId);
  }, [isCreating, cancelCreating]);

  // Determine if we have an active selection (for mobile layout)
  const hasSelection = selectedNoteId !== null || isCreating;

  if (!isOpen) return null;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className={`notes-v2${hasSelection ? ' has-selection' : ''}`} onClick={(e) => e.stopPropagation()}>
        {/* Sidebar */}
        <div className="notes-v2-sidebar">
          <div className="notes-v2-sidebar-header">
            <input
              type="text"
              className="notes-v2-search"
              placeholder="Search..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
            />
            <button className="notes-v2-new-btn" onClick={createNewNote} title="New note (⌘N)">
              +
            </button>
          </div>

          <div className="notes-v2-list">
            {filteredNotes.length === 0 ? (
              <div className="notes-v2-empty">
                {searchTerm ? 'No matches' : 'No notes yet'}
              </div>
            ) : (
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
                  placeholder="Untitled"
                  value={editTitle}
                  onChange={(e) => setEditTitle(e.target.value)}
                />
                <div className="notes-v2-editor-actions">
                  <input
                    type="text"
                    className="notes-v2-category-input"
                    placeholder="Category"
                    value={editCategory}
                    onChange={(e) => setEditCategory(e.target.value)}
                  />
                  <button className="notes-v2-save-btn" onClick={saveNewNote}>
                    Save
                  </button>
                  <button className="notes-v2-cancel-btn" onClick={cancelCreating}>
                    Cancel
                  </button>
                </div>
              </div>
              <textarea
                ref={contentTextareaRef}
                className="notes-v2-content-input"
                placeholder="Write something... (Markdown supported)"
                value={editContent}
                onChange={(e) => setEditContent(e.target.value)}
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
                  placeholder="Untitled"
                  value={editTitle}
                  onChange={(e) => setEditTitle(e.target.value)}
                />
                <div className="notes-v2-editor-actions">
                  <input
                    type="text"
                    className="notes-v2-category-input"
                    placeholder="Category"
                    value={editCategory}
                    onChange={(e) => setEditCategory(e.target.value)}
                  />
                  <span className={`notes-v2-save-status ${saveStatus}`}>
                    {saveStatus === 'saving' && 'Saving...'}
                    {saveStatus === 'saved' && 'Saved'}
                  </span>
                  <button className="notes-v2-delete-btn" onClick={handleDelete}>
                    Delete
                  </button>
                </div>
              </div>
              <textarea
                ref={contentTextareaRef}
                className="notes-v2-content-input"
                placeholder="Write something... (Markdown supported)"
                value={editContent}
                onChange={(e) => setEditContent(e.target.value)}
              />
              <div className="notes-v2-editor-hint">
                <span>Auto-saves as you type</span>
              </div>
            </div>
          ) : (
            // Empty state
            <div className="notes-v2-empty-state">
              <div className="notes-v2-empty-icon">📝</div>
              <p>Select a note or create a new one</p>
              <button className="notes-v2-create-btn" onClick={createNewNote}>
                New Note
              </button>
            </div>
          )}
        </div>

        {/* Close button */}
        <button className="notes-v2-close" onClick={onClose} aria-label="Close">
          ×
        </button>
      </div>
    </div>
  );
}
