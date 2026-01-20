import { useState, useMemo } from 'react';

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
  const [searchQuery, setSearchQuery] = useState('');
  const [editingKey, setEditingKey] = useState(null);
  const [editValue, setEditValue] = useState('');
  const [newKey, setNewKey] = useState('');
  const [newValue, setNewValue] = useState('');
  const [showAddForm, setShowAddForm] = useState(false);

  const currentStorage = storage[selectedType] || {};

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
    if (!newKey.trim() || !onUpdateStorage) return;

    try {
      await onUpdateStorage(selectedType, 'set', newKey.trim(), newValue);
      setNewKey('');
      setNewValue('');
      setShowAddForm(false);
    } catch (error) {
      console.error('Failed to add storage item:', error);
    }
  };

  const handleEdit = async (key) => {
    if (!onUpdateStorage) return;

    try {
      await onUpdateStorage(selectedType, 'set', key, editValue);
      setEditingKey(null);
      setEditValue('');
    } catch (error) {
      console.error('Failed to edit storage item:', error);
    }
  };

  const handleDelete = async (key) => {
    if (!onUpdateStorage) return;
    if (!confirm(`Delete "${key}"?`)) return;

    try {
      await onUpdateStorage(selectedType, 'remove', key);
    } catch (error) {
      console.error('Failed to delete storage item:', error);
    }
  };

  const handleClearAll = async () => {
    if (!onUpdateStorage) return;
    if (!confirm(`Clear all ${selectedType} items?`)) return;

    try {
      await onUpdateStorage(selectedType, 'clear');
    } catch (error) {
      console.error('Failed to clear storage:', error);
    }
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
    if (!file || !onUpdateStorage) return;

    // Constants
    const MAX_FILE_SIZE = 1024 * 1024; // 1MB
    const MAX_ENTRIES = 1000;
    const MAX_KEY_LENGTH = 256;
    const MAX_VALUE_SIZE = 100 * 1024; // 100KB

    // Check file size before reading
    if (file.size > MAX_FILE_SIZE) {
      alert(`File too large: ${(file.size / 1024).toFixed(0)}KB (max ${MAX_FILE_SIZE / 1024}KB)`);
      return;
    }

    try {
      const text = await file.text();
      const data = JSON.parse(text);

      if (!data.data || typeof data.data !== 'object') {
        throw new Error('Invalid format: missing data object');
      }

      const entries = Object.entries(data.data);

      // Validate entry count
      if (entries.length > MAX_ENTRIES) {
        throw new Error(`Too many entries: ${entries.length} (max ${MAX_ENTRIES})`);
      }

      // Validate each entry
      for (const [key, value] of entries) {
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
        await onUpdateStorage(selectedType, 'set', key, value);
        imported++;
      }

      alert(`Successfully imported ${imported} entries`);
    } catch (error) {
      console.error('Failed to import storage:', error);
      alert('Failed to import storage: ' + error.message);
    }
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
              onClick={() => setSelectedType(type.value)}
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
            <button onClick={() => setShowAddForm(!showAddForm)} className="btn-icon" title="Add new item">
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
                style={{ display: 'none' }}
              />
            </label>
            <button onClick={handleClearAll} className="btn-icon" title="Clear all">
              🗑️
            </button>
          </div>
        </div>

        {showAddForm && (
          <div className="storage-add-form">
            <input
              type="text"
              value={newKey}
              onChange={(e) => setNewKey(e.target.value)}
              placeholder="Key"
              className="form-input"
            />
            <input
              type="text"
              value={newValue}
              onChange={(e) => setNewValue(e.target.value)}
              placeholder="Value"
              className="form-input"
            />
            <div className="form-actions">
              <button onClick={handleAdd} disabled={!newKey.trim()} className="btn-primary">
                Add
              </button>
              <button onClick={() => setShowAddForm(false)} className="btn-secondary">
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
                            className="action-btn"
                            title="Save"
                          >
                            ✓
                          </button>
                          <button
                            onClick={cancelEdit}
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
                            className="action-btn"
                            title="Edit"
                          >
                            ✏️
                          </button>
                          <button
                            onClick={() => handleDelete(key)}
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
