import { useState, useEffect } from 'react';
import { apiFetch } from '../../../utils/api';

function formatExpires(expires) {
  if (!expires || expires === -1) return 'Session';
  const date = new Date(expires * 1000);
  return date.toLocaleString();
}

function CookieRow({ cookie, onEdit, onDelete }) {
  return (
    <tr className="cookie-row">
      <td className="cookie-name">{cookie.name}</td>
      <td className="cookie-value">
        <code>{cookie.value.length > 50 ? cookie.value.slice(0, 50) + '...' : cookie.value}</code>
      </td>
      <td className="cookie-domain">{cookie.domain}</td>
      <td className="cookie-path">{cookie.path}</td>
      <td className="cookie-expires">{formatExpires(cookie.expires)}</td>
      <td className="cookie-flags">
        {cookie.httpOnly && <span className="flag">HTTP</span>}
        {cookie.secure && <span className="flag">Secure</span>}
        {cookie.sameSite && <span className="flag">{cookie.sameSite}</span>}
      </td>
      <td className="cookie-actions">
        <button className="action-btn edit" onClick={() => onEdit(cookie)} title="Edit">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path>
            <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path>
          </svg>
        </button>
        <button className="action-btn delete" onClick={() => onDelete(cookie.name)} title="Delete">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <polyline points="3 6 5 6 21 6"></polyline>
            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
          </svg>
        </button>
      </td>

      <style jsx>{`
        .cookie-row {
          transition: background 0.2s;
        }

        .cookie-row:hover {
          background: var(--bg-hover, #2a2a2a);
        }

        .cookie-name {
          font-weight: 600;
          color: var(--text-primary, #d4d4d4);
        }

        .cookie-value code {
          font-family: 'Monaco', 'Menlo', 'Ubuntu Mono', monospace;
          font-size: 12px;
          background: var(--bg-secondary, #252525);
          padding: 2px 6px;
          border-radius: 3px;
          color: #3b82f6;
        }

        .cookie-domain, .cookie-path, .cookie-expires {
          color: var(--text-secondary, #999);
          font-size: 13px;
        }

        .cookie-flags {
          display: flex;
          gap: 4px;
          flex-wrap: wrap;
        }

        .flag {
          display: inline-block;
          padding: 2px 6px;
          background: var(--bg-secondary, #252525);
          border: 1px solid var(--border-color, #3a3a3a);
          border-radius: 3px;
          font-size: 10px;
          font-weight: 600;
          text-transform: uppercase;
          color: var(--text-secondary, #999);
        }

        .cookie-actions {
          display: flex;
          gap: 4px;
        }

        .action-btn {
          padding: 6px;
          background: none;
          border: 1px solid var(--border-color, #3a3a3a);
          border-radius: 4px;
          cursor: pointer;
          color: var(--text-secondary, #999);
          transition: all 0.2s;
          display: flex;
          align-items: center;
          justify-content: center;
        }

        .action-btn.edit:hover {
          border-color: #3b82f6;
          color: #3b82f6;
          background: rgba(59, 130, 246, 0.1);
        }

        .action-btn.delete:hover {
          border-color: #ef4444;
          color: #ef4444;
          background: rgba(239, 68, 68, 0.1);
        }
      `}</style>
    </tr>
  );
}

function CookieForm({ cookie, onSave, onCancel }) {
  const [formData, setFormData] = useState(cookie || {
    name: '',
    value: '',
    domain: '',
    path: '/',
    expires: -1,
    httpOnly: false,
    secure: false,
    sameSite: 'Lax'
  });

  const handleSubmit = (e) => {
    e.preventDefault();
    onSave(formData);
  };

  return (
    <div className="cookie-form-overlay" onClick={onCancel}>
      <div className="cookie-form" onClick={(e) => e.stopPropagation()}>
        <div className="cookie-form-header">
          <h4>{cookie ? 'Edit Cookie' : 'Add Cookie'}</h4>
          <button className="close-button" onClick={onCancel}>×</button>
        </div>

        <form onSubmit={handleSubmit}>
          <div className="form-group">
            <label>Name *</label>
            <input
              type="text"
              value={formData.name}
              onChange={(e) => setFormData({ ...formData, name: e.target.value })}
              required
              disabled={!!cookie}
            />
          </div>

          <div className="form-group">
            <label>Value *</label>
            <input
              type="text"
              value={formData.value}
              onChange={(e) => setFormData({ ...formData, value: e.target.value })}
              required
            />
          </div>

          <div className="form-row">
            <div className="form-group">
              <label>Domain *</label>
              <input
                type="text"
                value={formData.domain}
                onChange={(e) => setFormData({ ...formData, domain: e.target.value })}
                required
              />
            </div>

            <div className="form-group">
              <label>Path *</label>
              <input
                type="text"
                value={formData.path}
                onChange={(e) => setFormData({ ...formData, path: e.target.value })}
                required
              />
            </div>
          </div>

          <div className="form-group">
            <label>Expires (Unix timestamp, -1 for session)</label>
            <input
              type="number"
              value={formData.expires}
              onChange={(e) => setFormData({ ...formData, expires: parseInt(e.target.value, 10) })}
            />
          </div>

          <div className="form-group">
            <label>SameSite</label>
            <select
              value={formData.sameSite || 'Lax'}
              onChange={(e) => setFormData({ ...formData, sameSite: e.target.value })}
            >
              <option value="Strict">Strict</option>
              <option value="Lax">Lax</option>
              <option value="None">None</option>
            </select>
          </div>

          <div className="form-checkboxes">
            <label>
              <input
                type="checkbox"
                checked={formData.httpOnly}
                onChange={(e) => setFormData({ ...formData, httpOnly: e.target.checked })}
              />
              HTTP Only
            </label>
            <label>
              <input
                type="checkbox"
                checked={formData.secure}
                onChange={(e) => setFormData({ ...formData, secure: e.target.checked })}
              />
              Secure
            </label>
          </div>

          <div className="form-actions">
            <button type="button" className="btn-secondary" onClick={onCancel}>
              Cancel
            </button>
            <button type="submit" className="btn-primary">
              {cookie ? 'Update' : 'Add'} Cookie
            </button>
          </div>
        </form>

        <style jsx>{`
          .cookie-form-overlay {
            position: fixed;
            top: 0;
            left: 0;
            right: 0;
            bottom: 0;
            background: rgba(0, 0, 0, 0.6);
            display: flex;
            align-items: center;
            justify-content: center;
            z-index: 10001;
          }

          .cookie-form {
            background: var(--bg-primary, #1e1e1e);
            border: 1px solid var(--border-color, #3a3a3a);
            border-radius: 8px;
            box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
            width: 500px;
            max-width: 90vw;
            max-height: 85vh;
            overflow: auto;
          }

          .cookie-form-header {
            display: flex;
            align-items: center;
            justify-content: space-between;
            padding: 16px 20px;
            border-bottom: 1px solid var(--border-color, #3a3a3a);
            position: sticky;
            top: 0;
            background: var(--bg-primary, #1e1e1e);
            z-index: 1;
          }

          .cookie-form-header h4 {
            margin: 0;
            font-size: 16px;
            font-weight: 600;
            color: var(--text-primary, #d4d4d4);
          }

          .close-button {
            background: none;
            border: none;
            color: var(--text-secondary, #999);
            font-size: 28px;
            cursor: pointer;
            padding: 0;
            width: 32px;
            height: 32px;
            display: flex;
            align-items: center;
            justify-content: center;
            border-radius: 4px;
            line-height: 1;
          }

          .close-button:hover {
            background: var(--bg-hover, #2a2a2a);
            color: var(--text-primary, #d4d4d4);
          }

          form {
            padding: 20px;
          }

          .form-group {
            margin-bottom: 16px;
          }

          .form-row {
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 12px;
          }

          .form-group label {
            display: block;
            margin-bottom: 6px;
            font-size: 13px;
            font-weight: 600;
            color: var(--text-secondary, #999);
          }

          .form-group input, .form-group select {
            width: 100%;
            padding: 8px 12px;
            background: var(--bg-secondary, #252525);
            border: 1px solid var(--border-color, #3a3a3a);
            border-radius: 6px;
            color: var(--text-primary, #d4d4d4);
            font-size: 14px;
          }

          .form-group input:focus, .form-group select:focus {
            outline: none;
            border-color: #3b82f6;
            box-shadow: 0 0 0 2px rgba(59, 130, 246, 0.2);
          }

          .form-group input:disabled {
            opacity: 0.5;
            cursor: not-allowed;
          }

          .form-checkboxes {
            display: flex;
            gap: 20px;
            margin-bottom: 20px;
          }

          .form-checkboxes label {
            display: flex;
            align-items: center;
            gap: 8px;
            font-size: 14px;
            color: var(--text-primary, #d4d4d4);
            cursor: pointer;
          }

          .form-checkboxes input[type="checkbox"] {
            width: auto;
            cursor: pointer;
          }

          .form-actions {
            display: flex;
            gap: 8px;
            justify-content: flex-end;
            padding-top: 16px;
            border-top: 1px solid var(--border-color, #3a3a3a);
          }

          .btn-primary, .btn-secondary {
            padding: 8px 16px;
            border: 1px solid;
            border-radius: 6px;
            font-size: 14px;
            font-weight: 500;
            cursor: pointer;
            transition: all 0.2s;
          }

          .btn-primary {
            background: #3b82f6;
            border-color: #3b82f6;
            color: white;
          }

          .btn-primary:hover {
            background: #2563eb;
          }

          .btn-secondary {
            background: transparent;
            border-color: var(--border-color, #3a3a3a);
            color: var(--text-primary, #d4d4d4);
          }

          .btn-secondary:hover {
            background: var(--bg-hover, #2a2a2a);
          }
        `}</style>
      </div>
    </div>
  );
}

export function CookieManager({ onClose }) {
  const [cookies, setCookies] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [searchTerm, setSearchTerm] = useState('');
  const [domainFilter, setDomainFilter] = useState('');
  const [showForm, setShowForm] = useState(false);
  const [editingCookie, setEditingCookie] = useState(null);

  useEffect(() => {
    loadCookies();
  }, []);

  const loadCookies = async () => {
    setLoading(true);
    try {
      const response = await apiFetch('/api/browser/cookies');
      setCookies(response.cookies || []);
      setError(null);
    } catch (err) {
      setError(err.message || 'Failed to load cookies');
    } finally {
      setLoading(false);
    }
  };

  const handleAddCookie = async (cookieData) => {
    try {
      await apiFetch('/api/browser/cookies', {
        method: 'POST',
        body: JSON.stringify({ cookie: cookieData })
      });
      await loadCookies();
      setShowForm(false);
    } catch (err) {
      setError(err.message || 'Failed to add cookie');
    }
  };

  const handleEditCookie = (cookie) => {
    setEditingCookie(cookie);
    setShowForm(true);
  };

  const handleUpdateCookie = async (cookieData) => {
    try {
      // Delete old cookie and add new one (Playwright doesn't support in-place update)
      await apiFetch(`/api/browser/cookies/${editingCookie.name}`, {
        method: 'DELETE'
      });
      await apiFetch('/api/browser/cookies', {
        method: 'POST',
        body: JSON.stringify({ cookie: cookieData })
      });
      await loadCookies();
      setShowForm(false);
      setEditingCookie(null);
    } catch (err) {
      setError(err.message || 'Failed to update cookie');
    }
  };

  const handleDeleteCookie = async (name) => {
    if (!confirm(`Delete cookie "${name}"?`)) return;

    try {
      await apiFetch(`/api/browser/cookies/${name}`, {
        method: 'DELETE'
      });
      await loadCookies();
    } catch (err) {
      setError(err.message || 'Failed to delete cookie');
    }
  };

  const handleClearAll = async () => {
    if (!confirm('Clear all cookies? This cannot be undone.')) return;

    try {
      await apiFetch('/api/browser/cookies', {
        method: 'DELETE',
        body: JSON.stringify({})
      });
      await loadCookies();
    } catch (err) {
      setError(err.message || 'Failed to clear cookies');
    }
  };

  const handleExport = async () => {
    try {
      const response = await fetch('/api/browser/cookies/export', {
        headers: {
          'Authorization': `Bearer ${localStorage.getItem('token')}`
        }
      });
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `cookies-${Date.now()}.json`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(err.message || 'Failed to export cookies');
    }
  };

  const handleImport = async () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'application/json';
    input.onchange = async (e) => {
      const file = e.target.files[0];
      if (!file) return;

      try {
        const text = await file.text();
        await apiFetch('/api/browser/cookies/import', {
          method: 'POST',
          body: JSON.stringify({ json: text })
        });
        await loadCookies();
      } catch (err) {
        setError(err.message || 'Failed to import cookies');
      }
    };
    input.click();
  };

  const filteredCookies = cookies.filter(cookie => {
    const matchesSearch = !searchTerm ||
      cookie.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
      cookie.value.toLowerCase().includes(searchTerm.toLowerCase());
    const matchesDomain = !domainFilter ||
      cookie.domain.toLowerCase().includes(domainFilter.toLowerCase());
    return matchesSearch && matchesDomain;
  });

  const domains = [...new Set(cookies.map(c => c.domain))];

  return (
    <>
      <div className="cookie-manager-overlay" onClick={(e) => e.target.className === 'cookie-manager-overlay' && onClose()}>
        <div className="cookie-manager">
          <div className="cookie-manager-header">
            <h3>Cookie Manager</h3>
            <button className="close-button" onClick={onClose}>×</button>
          </div>

          {error && (
            <div className="cookie-manager-error">
              {error}
              <button onClick={() => setError(null)}>×</button>
            </div>
          )}

          <div className="cookie-manager-toolbar">
            <div className="toolbar-filters">
              <input
                type="text"
                placeholder="Search cookies..."
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                className="filter-input"
              />
              <select
                value={domainFilter}
                onChange={(e) => setDomainFilter(e.target.value)}
                className="filter-select"
              >
                <option value="">All Domains</option>
                {domains.map(domain => (
                  <option key={domain} value={domain}>{domain}</option>
                ))}
              </select>
            </div>

            <div className="toolbar-actions">
              <button className="btn-outline-sm" onClick={() => { setEditingCookie(null); setShowForm(true); }}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <line x1="12" y1="5" x2="12" y2="19"></line>
                  <line x1="5" y1="12" x2="19" y2="12"></line>
                </svg>
                Add
              </button>
              <button className="btn-outline-sm" onClick={handleExport}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
                  <polyline points="17 8 12 3 7 8"></polyline>
                  <line x1="12" y1="3" x2="12" y2="15"></line>
                </svg>
                Export
              </button>
              <button className="btn-outline-sm" onClick={handleImport}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
                  <polyline points="7 10 12 15 17 10"></polyline>
                  <line x1="12" y1="15" x2="12" y2="3"></line>
                </svg>
                Import
              </button>
              <button className="btn-danger-sm" onClick={handleClearAll}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <polyline points="3 6 5 6 21 6"></polyline>
                  <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
                </svg>
                Clear All
              </button>
            </div>
          </div>

          <div className="cookie-table-container">
            {loading ? (
              <div className="cookie-loading">Loading cookies...</div>
            ) : filteredCookies.length === 0 ? (
              <div className="cookie-empty">
                {cookies.length === 0 ? 'No cookies found' : 'No matching cookies'}
              </div>
            ) : (
              <table className="cookie-table">
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Value</th>
                    <th>Domain</th>
                    <th>Path</th>
                    <th>Expires</th>
                    <th>Flags</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredCookies.map(cookie => (
                    <CookieRow
                      key={`${cookie.domain}-${cookie.path}-${cookie.name}`}
                      cookie={cookie}
                      onEdit={handleEditCookie}
                      onDelete={handleDeleteCookie}
                    />
                  ))}
                </tbody>
              </table>
            )}
          </div>

          <div className="cookie-manager-footer">
            <span>{filteredCookies.length} cookie(s)</span>
          </div>
        </div>
      </div>

      {showForm && (
        <CookieForm
          cookie={editingCookie}
          onSave={editingCookie ? handleUpdateCookie : handleAddCookie}
          onCancel={() => {
            setShowForm(false);
            setEditingCookie(null);
          }}
        />
      )}

      <style jsx>{`
        .cookie-manager-overlay {
          position: fixed;
          top: 0;
          left: 0;
          right: 0;
          bottom: 0;
          background: rgba(0, 0, 0, 0.5);
          backdrop-filter: blur(4px);
          display: flex;
          align-items: center;
          justify-content: center;
          z-index: 10000;
        }

        .cookie-manager {
          background: var(--bg-primary, #1e1e1e);
          border: 1px solid var(--border-color, #3a3a3a);
          border-radius: 8px;
          box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
          width: 1100px;
          max-width: 95vw;
          max-height: 90vh;
          display: flex;
          flex-direction: column;
          overflow: hidden;
        }

        .cookie-manager-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 16px 20px;
          border-bottom: 1px solid var(--border-color, #3a3a3a);
        }

        .cookie-manager-header h3 {
          margin: 0;
          font-size: 18px;
          font-weight: 600;
          color: var(--text-primary, #d4d4d4);
        }

        .close-button {
          background: none;
          border: none;
          color: var(--text-secondary, #999);
          font-size: 28px;
          cursor: pointer;
          padding: 0;
          width: 32px;
          height: 32px;
          display: flex;
          align-items: center;
          justify-content: center;
          border-radius: 4px;
          line-height: 1;
        }

        .close-button:hover {
          background: var(--bg-hover, #2a2a2a);
          color: var(--text-primary, #d4d4d4);
        }

        .cookie-manager-error {
          display: flex;
          justify-content: space-between;
          align-items: center;
          padding: 12px 20px;
          background: rgba(239, 68, 68, 0.1);
          border-bottom: 1px solid rgba(239, 68, 68, 0.3);
          color: #ef4444;
          font-size: 13px;
        }

        .cookie-manager-error button {
          background: none;
          border: none;
          color: #ef4444;
          font-size: 20px;
          cursor: pointer;
          padding: 0 8px;
        }

        .cookie-manager-toolbar {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 12px;
          padding: 16px 20px;
          border-bottom: 1px solid var(--border-color, #3a3a3a);
          background: var(--bg-secondary, #252525);
        }

        .toolbar-filters {
          display: flex;
          gap: 8px;
          flex: 1;
        }

        .filter-input, .filter-select {
          padding: 8px 12px;
          background: var(--bg-primary, #1e1e1e);
          border: 1px solid var(--border-color, #3a3a3a);
          border-radius: 6px;
          color: var(--text-primary, #d4d4d4);
          font-size: 14px;
        }

        .filter-input {
          flex: 1;
          min-width: 200px;
        }

        .filter-select {
          min-width: 150px;
        }

        .toolbar-actions {
          display: flex;
          gap: 8px;
        }

        .btn-outline-sm, .btn-danger-sm {
          display: flex;
          align-items: center;
          gap: 6px;
          padding: 6px 12px;
          font-size: 13px;
          border: 1px solid;
          border-radius: 4px;
          cursor: pointer;
          font-weight: 500;
          transition: all 0.2s;
        }

        .btn-outline-sm {
          background: transparent;
          border-color: var(--border-color, #3a3a3a);
          color: var(--text-primary, #d4d4d4);
        }

        .btn-outline-sm:hover {
          background: var(--bg-hover, #2a2a2a);
          border-color: #3b82f6;
        }

        .btn-danger-sm {
          background: transparent;
          border-color: #ef4444;
          color: #ef4444;
        }

        .btn-danger-sm:hover {
          background: rgba(239, 68, 68, 0.1);
        }

        .cookie-table-container {
          flex: 1;
          overflow: auto;
        }

        .cookie-loading, .cookie-empty {
          padding: 60px 40px;
          text-align: center;
          color: var(--text-secondary, #999);
        }

        .cookie-table {
          width: 100%;
          border-collapse: collapse;
        }

        .cookie-table thead {
          position: sticky;
          top: 0;
          background: var(--bg-secondary, #252525);
          z-index: 1;
        }

        .cookie-table th {
          padding: 12px 16px;
          text-align: left;
          font-size: 12px;
          font-weight: 600;
          text-transform: uppercase;
          letter-spacing: 0.05em;
          color: var(--text-secondary, #999);
          border-bottom: 1px solid var(--border-color, #3a3a3a);
        }

        .cookie-table td {
          padding: 12px 16px;
          border-bottom: 1px solid var(--border-color, #3a3a3a);
          font-size: 13px;
        }

        .cookie-manager-footer {
          padding: 12px 20px;
          border-top: 1px solid var(--border-color, #3a3a3a);
          font-size: 13px;
          color: var(--text-secondary, #999);
        }
      `}</style>
    </>
  );
}
