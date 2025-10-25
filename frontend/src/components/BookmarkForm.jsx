import { useState } from 'react';

export function BookmarkForm({ bookmark, onSave, onCancel }) {
  const [name, setName] = useState(bookmark?.name || '');
  const [command, setCommand] = useState(bookmark?.command || '');
  const [category, setCategory] = useState(bookmark?.category || 'General');

  const handleSubmit = (e) => {
    e.preventDefault();
    if (name.trim() && command.trim() && category.trim()) {
      onSave({ name: name.trim(), command: command.trim(), category: category.trim() });
    }
  };

  return (
    <form className="bookmark-form" onSubmit={handleSubmit}>
      <div className="form-group">
        <label htmlFor="bookmark-name">Name</label>
        <input
          id="bookmark-name"
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g., Claude Dangerous"
          maxLength={100}
          required
        />
      </div>

      <div className="form-group">
        <label htmlFor="bookmark-command">Command</label>
        <textarea
          id="bookmark-command"
          value={command}
          onChange={(e) => setCommand(e.target.value)}
          placeholder="e.g., claude --dangerously-skip-permissions"
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
          onChange={(e) => setCategory(e.target.value)}
          placeholder="e.g., Claude, Git, Docker"
          maxLength={50}
          required
        />
      </div>

      <div className="form-actions">
        <button type="button" className="btn-secondary" onClick={onCancel}>
          Cancel
        </button>
        <button type="submit" className="btn-primary">
          {bookmark ? 'Update' : 'Save'}
        </button>
      </div>
    </form>
  );
}
