import { useState, useMemo } from 'react';
import { BookmarkForm } from './BookmarkForm';

export function BookmarkModal({ isOpen, onClose, bookmarks, onAdd, onUpdate, onDelete, onExecute }) {
  const [selectedCategory, setSelectedCategory] = useState('All');
  const [searchTerm, setSearchTerm] = useState('');
  const [editingBookmark, setEditingBookmark] = useState(null);
  const [showAddForm, setShowAddForm] = useState(false);

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
    if (editingBookmark) {
      await onUpdate(editingBookmark.id, data);
      setEditingBookmark(null);
    } else {
      await onAdd(data.name, data.command, data.category);
      setShowAddForm(false);
    }
  };

  const handleCancelEdit = () => {
    setEditingBookmark(null);
    setShowAddForm(false);
  };

  if (!isOpen) return null;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="bookmark-modal" onClick={(e) => e.stopPropagation()}>
        <div className="bookmark-modal-header">
          <div className="bookmark-modal-title">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="m19 21-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v16z" />
            </svg>
            <h2>Bookmarks</h2>
          </div>
          <button className="modal-close" onClick={onClose} aria-label="Close">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
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
                  onClick={() => setSelectedCategory(cat)}
                >
                  {cat}
                  <span className="bookmark-count">
                    {cat === 'All' ? bookmarks.length : bookmarks.filter((b) => b.category === cat).length}
                  </span>
                </button>
              ))}
            </div>
          </div>

          {/* Bookmarks list */}
          <div className="bookmark-list-pane">
            <div className="bookmark-list-header">
              <h3>
                {selectedCategory === 'All'
                  ? `All Bookmarks (${filteredBookmarks.length})`
                  : `${selectedCategory} (${filteredBookmarks.length})`}
              </h3>
              <button
                className="bookmark-add-btn"
                onClick={() => {
                  setShowAddForm(true);
                  setEditingBookmark(null);
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
              <div className="bookmark-form-container">
                <BookmarkForm onSave={handleSaveBookmark} onCancel={handleCancelEdit} />
              </div>
            )}

            {editingBookmark && (
              <div className="bookmark-form-container">
                <BookmarkForm bookmark={editingBookmark} onSave={handleSaveBookmark} onCancel={handleCancelEdit} />
              </div>
            )}

            <div className="bookmark-list-items">
              {filteredBookmarks.length === 0 && !showAddForm && (
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
                    onClick={() => {
                      onExecute(bookmark.command);
                      onClose();
                    }}
                    title={`Execute: ${bookmark.command}`}
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
                      onClick={() => {
                        setEditingBookmark(bookmark);
                        setShowAddForm(false);
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
                      onClick={() => onDelete(bookmark.id)}
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
