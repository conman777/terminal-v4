import './UtilityDialogs.css';
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
      <div className="modal-content add-scan-folder-modal ui-utility-dialog" role="dialog" aria-modal="true" aria-labelledby="add-project-title" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2 id="add-project-title">Add Project</h2>
          <button className="modal-close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>
        <p id="add-project-help" className="add-scan-folder-help">Enter an absolute project path to add it to the sidebar.</p>
        <form onSubmit={handleSubmit}>
          <label htmlFor="add-project-path">Project path</label>
          <input
            id="add-project-path"
            aria-describedby="add-project-help"
            aria-invalid={Boolean(error)}
            ref={inputRef}
            type="text"
            value={path}
            onChange={(e) => setPath(e.target.value)}
            placeholder="/home/user/projects"
            className="add-scan-folder-input"
            disabled={isLoading}
          />
          {error ? <div role="alert" className="add-scan-folder-error">{error}</div> : null}
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
