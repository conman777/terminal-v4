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
          <h2>Bookmarks</h2>
          <button className="modal-close" onClick={onClose} aria-label="Close">
            ×
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
              >
                + Add
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
                    <span className="bookmark-play">▶</span>
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
                      ✎
                    </button>
                    <button
                      className="bookmark-delete-btn"
                      onClick={() => onDelete(bookmark.id)}
                      title="Delete bookmark"
                      aria-label="Delete bookmark"
                    >
                      ×
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
