import { useEffect, useRef, useState, useMemo } from 'react';

/**
 * StorageTab - Storage inspection and editing
 * Features:
 * - Tree view: Local Storage, Session Storage, Cookies
 * - Key-value editor: Add/Edit/Delete
 * - Search and filter
 * - Import/Export storage data
 */
export function StorageTab({ storage = {}, onUpdateStorage, previewPort }) {
  const [selectedType, setSelectedType] = useState('localStorage');
  return <StorageEditor key={`${previewPort}:${selectedType}`} storage={storage} onUpdateStorage={onUpdateStorage} selectedType={selectedType} onSelectType={setSelectedType} />;
}

function StorageEditor({ storage, onUpdateStorage, selectedType, onSelectType }) {
  const [searchQuery, setSearchQuery] = useState('');
  const [editingKey, setEditingKey] = useState(null);
  const [editValue, setEditValue] = useState('');
  const [newKey, setNewKey] = useState('');
  const [newValue, setNewValue] = useState('');
  const [showAddForm, setShowAddForm] = useState(false);
  const [isPending, setIsPending] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const active = useRef(true);
  const pending = useRef(false);

  useEffect(() => {
    active.current = true;
    return () => { active.current = false; };
  }, []);

  const currentStorage = storage[selectedType] || {};
  const storageUnavailable = storage.available?.[selectedType] === false;
  const canUpdate = useRef(false);
  canUpdate.current = !storageUnavailable && Boolean(onUpdateStorage);
  const mutationsDisabled = !canUpdate.current || isPending;

  const runUpdate = async (failureMessage, update) => {
    if (!active.current || !canUpdate.current || pending.current) return;
    pending.current = true;
    setIsPending(true);
    setError('');
    setNotice('');
    try {
      await update();
    } catch (error) {
      if (active.current) setError(`${failureMessage}. ${error?.message || 'Try again.'}`);
    } finally {
      pending.current = false;
      if (active.current) setIsPending(false);
    }
  };

  // Filter storage by search
  const filteredEntries = useMemo(() => {
    const entries = Object.entries(currentStorage);
    if (!searchQuery) return entries;

    const query = searchQuery.toLowerCase();
    return entries.filter(([key, value]) => {
      return key.toLowerCase().includes(query) ||
             String(value).toLowerCase().includes(query);
    });
  }, [currentStorage, searchQuery]);

  const handleAdd = async () => {
    if (!newKey.trim()) return;
    await runUpdate('Could not add storage item', async () => {
      await onUpdateStorage(selectedType, 'set', newKey.trim(), newValue);
      if (!active.current) return;
      setNewKey('');
      setNewValue('');
      setShowAddForm(false);
    });
  };

  const handleEdit = async (key) => {
    await runUpdate('Could not save storage item', async () => {
      await onUpdateStorage(selectedType, 'set', key, editValue);
      if (!active.current) return;
      setEditingKey(null);
      setEditValue('');
    });
  };

  const handleDelete = async (key) => {
    if (mutationsDisabled) return;
    if (!confirm(`Delete "${key}"?`)) return;

    await runUpdate('Could not delete storage item', async () => {
      await onUpdateStorage(selectedType, 'remove', key);
    });
  };

  const handleClearAll = async () => {
    if (mutationsDisabled) return;
    if (!confirm(`Clear all ${selectedType} items?`)) return;

    await runUpdate('Could not clear storage', async () => {
      await onUpdateStorage(selectedType, 'clear');
    });
  };

  const handleExport = () => {
    const data = {
      type: selectedType,
      timestamp: new Date().toISOString(),
      data: currentStorage
    };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${selectedType}-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleImport = async (event) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file || mutationsDisabled) return;

    // Constants
    const MAX_FILE_SIZE = 1024 * 1024; // 1MB
    const MAX_ENTRIES = 1000;
    const MAX_KEY_LENGTH = 256;
    const MAX_VALUE_SIZE = 100 * 1024; // 100KB

    // Check file size before reading
    if (file.size > MAX_FILE_SIZE) {
      setError(`File too large: ${(file.size / 1024).toFixed(0)}KB (max ${MAX_FILE_SIZE / 1024}KB)`);
      return;
    }

    await runUpdate('Failed to import storage', async () => {
      const text = await file.text();
      if (!active.current || !canUpdate.current) return;
      const data = JSON.parse(text);

      if (!data?.data || typeof data.data !== 'object' || Array.isArray(data.data)) {
        throw new Error('Invalid format: missing data object');
      }

      const entries = Object.entries(data.data);

      // Validate entry count
      if (entries.length > MAX_ENTRIES) {
        throw new Error(`Too many entries: ${entries.length} (max ${MAX_ENTRIES})`);
      }

      // Validate each entry
      for (const [key, value] of entries) {
        if (typeof value !== 'string') {
          throw new Error(`Value for '${key}' must be a string`);
        }
        if (key.length > MAX_KEY_LENGTH) {
          throw new Error(`Key too long: ${key.substring(0, 50)}... (max ${MAX_KEY_LENGTH} chars)`);
        }
        if (typeof value === 'string' && value.length > MAX_VALUE_SIZE) {
          throw new Error(`Value too large for key '${key}': ${(value.length / 1024).toFixed(2)}KB (max ${MAX_VALUE_SIZE / 1024}KB)`);
        }
      }

      // Import all entries
      let imported = 0;
      for (const [key, value] of entries) {
        if (!active.current || !canUpdate.current) return;
        await onUpdateStorage(selectedType, 'set', key, value);
        imported++;
      }

      if (active.current) setNotice(`Successfully imported ${imported} entries`);
    });
  };

  const startEdit = (key, value) => {
    setEditingKey(key);
    setEditValue(String(value));
  };

  const cancelEdit = () => {
    setEditingKey(null);
    setEditValue('');
  };

  const storageTypes = [
    { value: 'localStorage', label: 'Local Storage', icon: '📦' },
    { value: 'sessionStorage', label: 'Session Storage', icon: '⏱️' },
    { value: 'cookies', label: 'Cookies', icon: '🍪' }
  ];

  return (
    <div className="storage-tab">
      <div className="storage-sidebar">
        <div className="storage-tree">
          <div className="storage-tree-header">Storage</div>
          {storageTypes.map(type => (
            <button
              key={type.value}
              className={`storage-tree-item ${selectedType === type.value ? 'active' : ''}`}
              onClick={() => onSelectType(type.value)}
              aria-pressed={selectedType === type.value}
            >
              <span className="storage-icon">{type.icon}</span>
              <span className="storage-label">{type.label}</span>
              <span className="storage-count">
                ({Object.keys(storage[type.value] || {}).length})
              </span>
            </button>
          ))}
        </div>
      </div>

      <div className="storage-content">
        {storageUnavailable && <p role="status">Browser storage is unavailable in this isolated preview. Open the preview in a separate tab to use browser storage.</p>}
        {error && <p role="alert">{error}</p>}
        {notice && <p role="status">{notice}</p>}
        <div className="storage-toolbar">
          <div className="storage-search">
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search storage..."
              className="search-input"
            />
            {searchQuery && (
              <button
                className="search-clear"
                onClick={() => setSearchQuery('')}
                title="Clear search"
              >
                ×
              </button>
            )}
          </div>
          <div className="storage-actions">
            <button onClick={() => setShowAddForm(!showAddForm)} disabled={mutationsDisabled} className="btn-icon" title="Add new item">
              ➕
            </button>
            <button onClick={handleExport} className="btn-icon" title="Export storage">
              📥
            </button>
            <label className="btn-icon" title="Import storage">
              📤
              <input
                type="file"
                accept=".json"
                onChange={handleImport}
                disabled={mutationsDisabled}
                style={{ display: 'none' }}
              />
            </label>
            <button onClick={handleClearAll} disabled={mutationsDisabled} className="btn-icon" title="Clear all">
              🗑️
            </button>
          </div>
        </div>

        {showAddForm && !storageUnavailable && (
          <div className="storage-add-form">
            <input
              type="text"
              value={newKey}
              onChange={(e) => setNewKey(e.target.value)}
              placeholder="Key"
              disabled={isPending}
              className="form-input"
            />
            <input
              type="text"
              value={newValue}
              onChange={(e) => setNewValue(e.target.value)}
              placeholder="Value"
              disabled={isPending}
              className="form-input"
            />
            <div className="form-actions">
              <button onClick={handleAdd} disabled={mutationsDisabled || !newKey.trim()} className="btn-primary">
                Add
              </button>
              <button onClick={() => setShowAddForm(false)} disabled={isPending} className="btn-secondary">
                Cancel
              </button>
            </div>
          </div>
        )}

        <div className="storage-table-container">
          {filteredEntries.length === 0 ? (
            <div className="storage-empty">
              <p>
                {Object.keys(currentStorage).length === 0
                  ? `No ${selectedType} items`
                  : 'No items match search'}
              </p>
            </div>
          ) : (
            <table className="storage-table">
              <thead>
                <tr>
                  <th className="col-key">Key</th>
                  <th className="col-value">Value</th>
                  <th className="col-actions">Actions</th>
                </tr>
              </thead>
              <tbody>
                {filteredEntries.map(([key, value]) => (
                  <tr key={key} className="storage-row">
                    <td className="col-key">
                      <code>{key}</code>
                    </td>
                    <td className="col-value">
                      {editingKey === key ? (
                        <input
                          type="text"
                          value={editValue}
                          onChange={(e) => setEditValue(e.target.value)}
                          className="edit-input"
                          autoFocus
                          disabled={mutationsDisabled}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') handleEdit(key);
                            if (e.key === 'Escape') cancelEdit();
                          }}
                        />
                      ) : (
                        <div className="value-display" title={String(value)}>
                          {String(value)}
                        </div>
                      )}
                    </td>
                    <td className="col-actions">
                      {editingKey === key ? (
                        <>
                          <button
                            onClick={() => handleEdit(key)}
                            disabled={mutationsDisabled}
                            className="action-btn"
                            title="Save"
                          >
                            ✓
                          </button>
                          <button
                            onClick={cancelEdit}
                            disabled={isPending}
                            className="action-btn"
                            title="Cancel"
                          >
                            ✗
                          </button>
                        </>
                      ) : (
                        <>
                          <button
                            onClick={() => startEdit(key, value)}
                            disabled={mutationsDisabled}
                            className="action-btn"
                            title="Edit"
                          >
                            ✏️
                          </button>
                          <button
                            onClick={() => handleDelete(key)}
                            disabled={mutationsDisabled}
                            className="action-btn"
                            title="Delete"
                          >
                            🗑️
                          </button>
                        </>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}
