import { useEffect, useRef, useState } from 'react';

export function AddScanFolderModal({ isOpen, isLoading = false, error = '', onClose, onSubmit }) {
  const [path, setPath] = useState('');
  const inputRef = useRef(null);

  useEffect(() => {
    if (!isOpen) {
      setPath('');
      return;
    }
    const t = setTimeout(() => inputRef.current?.focus(), 10);
    return () => clearTimeout(t);
  }, [isOpen]);

  if (!isOpen) return null;

  const handleSubmit = (e) => {
    e.preventDefault();
    if (!path.trim() || isLoading) return;
    onSubmit?.(path.trim());
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content add-scan-folder-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>Add Project</h2>
          <button className="modal-close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>
        <p className="add-scan-folder-help">Enter an absolute project path to add it to the sidebar.</p>
        <form onSubmit={handleSubmit}>
          <input
            ref={inputRef}
            type="text"
            value={path}
            onChange={(e) => setPath(e.target.value)}
            placeholder="/home/user/projects"
            className="add-scan-folder-input"
            disabled={isLoading}
          />
          {error ? <div className="add-scan-folder-error">{error}</div> : null}
          <div className="modal-actions">
            <button type="button" className="btn-secondary" onClick={onClose} disabled={isLoading}>
              Cancel
            </button>
            <button type="submit" className="btn-primary" disabled={!path.trim() || isLoading}>
              {isLoading ? 'Adding...' : 'Add Project'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
