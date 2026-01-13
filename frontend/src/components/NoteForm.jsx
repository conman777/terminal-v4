import { useState } from 'react';

export function NoteForm({ note, onSave, onCancel }) {
  const [title, setTitle] = useState(note?.title || '');
  const [content, setContent] = useState(note?.content || '');
  const [category, setCategory] = useState(note?.category || 'General');

  const handleSubmit = (e) => {
    e.preventDefault();
    if (title.trim() && category.trim()) {
      onSave({ title: title.trim(), content: content, category: category.trim() });
    }
  };

  return (
    <form className="note-form" onSubmit={handleSubmit}>
      <div className="form-group">
        <label htmlFor="note-title">Title</label>
        <input
          id="note-title"
          type="text"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Note title"
          maxLength={200}
          required
        />
      </div>

      <div className="form-group">
        <label htmlFor="note-category">Category</label>
        <input
          id="note-category"
          type="text"
          value={category}
          onChange={(e) => setCategory(e.target.value)}
          placeholder="e.g., Work, Personal, Code"
          maxLength={50}
          required
        />
      </div>

      <div className="form-group note-content-group">
        <label htmlFor="note-content">Content (Markdown supported)</label>
        <textarea
          id="note-content"
          value={content}
          onChange={(e) => setContent(e.target.value)}
          placeholder="Write your note here... Markdown is supported."
          rows={12}
          maxLength={50000}
        />
      </div>

      <div className="form-actions">
        <button type="button" className="btn-secondary" onClick={onCancel}>
          Cancel
        </button>
        <button type="submit" className="btn-primary">
          {note ? 'Update' : 'Save'}
        </button>
      </div>
    </form>
  );
}
