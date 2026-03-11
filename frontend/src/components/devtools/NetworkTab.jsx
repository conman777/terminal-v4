import { useState, useMemo } from 'react';
import { FilterBar } from './shared/FilterBar';
import { JsonTreeView } from './shared/JsonTreeView';

/**
 * NetworkTab - Network monitoring with request/response details
 * Features:
 * - Request table with method, URL, status, type, size, time
 * - Color-coded status (2xx green, 3xx blue, 4xx/5xx red)
 * - Expandable details: Headers, Request/Response Body, Timing
 * - Filters: All, XHR/Fetch, JS, CSS, Images, Other
 * - Export to HAR, Copy as cURL/fetch/Axios
 */
export function NetworkTab({ requests = [], onClear }) {
  const [filter, setFilter] = useState('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedRequest, setSelectedRequest] = useState(null);
  const [detailTab, setDetailTab] = useState('headers');

  // Filter requests by type
  const filteredRequests = useMemo(() => {
    let filtered = requests;

    // Apply type filter
    if (filter !== 'all') {
      filtered = filtered.filter(req => {
        const contentType = req.contentType || '';
        const url = req.url || '';

        if (filter === 'fetch') {
          return req.method !== 'GET' || contentType.includes('json');
        }
        if (filter === 'js') {
          return contentType.includes('javascript') || url.endsWith('.js') || url.endsWith('.mjs');
        }
        if (filter === 'css') {
          return contentType.includes('css') || url.endsWith('.css');
        }
        if (filter === 'img') {
          return contentType.includes('image') || /\.(png|jpg|jpeg|gif|svg|webp|ico)(\?|$)/.test(url);
        }
        if (filter === 'other') {
          const isCommon = contentType.includes('javascript') ||
                          contentType.includes('css') ||
                          contentType.includes('image') ||
                          contentType.includes('json');
          return !isCommon;
        }
        return true;
      });
    }

    // Apply search filter
    if (searchQuery) {
      const query = searchQuery.toLowerCase();
      filtered = filtered.filter(req => {
        const url = (req.url || '').toLowerCase();
        const method = (req.method || '').toLowerCase();
        const status = String(req.status || '');
        return url.includes(query) || method.includes(query) || status.includes(query);
      });
    }

    return filtered;
  }, [requests, filter, searchQuery]);

  // Count requests by type
  const counts = useMemo(() => {
    const result = { all: requests.length, fetch: 0, js: 0, css: 0, img: 0, other: 0 };
    requests.forEach(req => {
      const contentType = req.contentType || '';
      const url = req.url || '';

      if (req.method !== 'GET' || contentType.includes('json')) {
        result.fetch++;
      } else if (contentType.includes('javascript') || url.endsWith('.js') || url.endsWith('.mjs')) {
        result.js++;
      } else if (contentType.includes('css') || url.endsWith('.css')) {
        result.css++;
      } else if (contentType.includes('image') || /\.(png|jpg|jpeg|gif|svg|webp|ico)(\?|$)/.test(url)) {
        result.img++;
      } else {
        result.other++;
      }
    });
    return result;
  }, [requests]);

  const filters = [
    { value: 'all', label: 'All', count: counts.all },
    { value: 'fetch', label: 'Fetch/XHR', count: counts.fetch },
    { value: 'js', label: 'JS', count: counts.js },
    { value: 'css', label: 'CSS', count: counts.css },
    { value: 'img', label: 'Images', count: counts.img },
    { value: 'other', label: 'Other', count: counts.other }
  ];

  const handleExportHAR = () => {
    const har = {
      log: {
        version: '1.2',
        creator: { name: 'V4 DevTools', version: '1.0' },
        entries: requests.map(req => ({
          startedDateTime: new Date(req.timestamp).toISOString(),
          time: req.duration || 0,
          request: {
            method: req.method,
            url: req.url,
            httpVersion: 'HTTP/1.1',
            headers: Object.entries(req.requestHeaders || {}).map(([name, value]) => ({ name, value })),
            queryString: [],
            postData: req.requestBody ? { mimeType: 'text/plain', text: req.requestBody } : undefined
          },
          response: {
            status: req.status || 0,
            statusText: req.statusText || '',
            httpVersion: 'HTTP/1.1',
            headers: Object.entries(req.responseHeaders || {}).map(([name, value]) => ({ name, value })),
            content: {
              size: req.responseSize || 0,
              mimeType: req.contentType || '',
              text: req.responseBody || ''
            }
          },
          timings: {
            send: 0,
            wait: req.duration || 0,
            receive: 0
          }
        }))
      }
    };
    const blob = new Blob([JSON.stringify(har, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `network-${Date.now()}.har`;
    a.click();
    URL.revokeObjectURL(url);
  };

  // Escape single quotes for shell commands (bash/curl)
  // Replaces ' with '\'' which closes the quote, adds escaped quote, reopens quote
  const escapeSingleQuotes = (str) => {
    if (!str) return '';
    return str.replace(/'/g, "'\\''");
  };

  const handleCopyAsCurl = (req) => {
    const escapedUrl = escapeSingleQuotes(req.url);
    let curl = `curl '${escapedUrl}' \\\n  -X ${req.method}`;
    if (req.requestHeaders) {
      Object.entries(req.requestHeaders).forEach(([key, value]) => {
        const escapedKey = escapeSingleQuotes(key);
        const escapedValue = escapeSingleQuotes(value);
        curl += ` \\\n  -H '${escapedKey}: ${escapedValue}'`;
      });
    }
    if (req.requestBody) {
      const escapedBody = escapeSingleQuotes(req.requestBody);
      curl += ` \\\n  --data '${escapedBody}'`;
    }
    navigator.clipboard.writeText(curl);
  };

  const handleCopyAsFetch = (req) => {
    // JSON.stringify handles escaping for us, but validate URL
    const options = { method: req.method };
    if (req.requestHeaders) {
      options.headers = req.requestHeaders;
    }
    if (req.requestBody) {
      options.body = req.requestBody;
    }
    // Use JSON.stringify for safe escaping in JavaScript code
    const code = `fetch(${JSON.stringify(req.url)}, ${JSON.stringify(options, null, 2)})`;
    navigator.clipboard.writeText(code);
  };

  const handleCopyAsAxios = (req) => {
    // JSON.stringify handles escaping for us
    const config = { method: req.method.toLowerCase(), url: req.url };
    if (req.requestHeaders) {
      config.headers = req.requestHeaders;
    }
    if (req.requestBody) {
      config.data = req.requestBody;
    }
    const code = `axios(${JSON.stringify(config, null, 2)})`;
    navigator.clipboard.writeText(code);
  };

  const getStatusClass = (status) => {
    if (!status) return 'status-unknown';
    if (status >= 200 && status < 300) return 'status-success';
    if (status >= 300 && status < 400) return 'status-redirect';
    if (status >= 400) return 'status-error';
    return 'status-unknown';
  };

  const formatSize = (bytes) => {
    if (!bytes) return '-';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  const formatDuration = (ms) => {
    if (!ms) return '-';
    if (ms < 1000) return `${Math.round(ms)} ms`;
    return `${(ms / 1000).toFixed(2)} s`;
  };

  return (
    <div className="network-tab">
      <div className="network-toolbar">
        <FilterBar
          filters={filters}
          activeFilter={filter}
          onFilterChange={setFilter}
          searchValue={searchQuery}
          onSearchChange={setSearchQuery}
          placeholder="Filter requests..."
        />
        <div className="network-actions">
          <button onClick={handleExportHAR} className="btn-icon" title="Export HAR">
            📥 HAR
          </button>
          <button onClick={onClear} className="btn-icon" title="Clear network log">
            🗑️
          </button>
        </div>
      </div>

      <div className="network-content">
        <div className="network-table-container">
          <table className="network-table">
            <thead>
              <tr>
                <th className="col-method">Method</th>
                <th className="col-url">URL</th>
                <th className="col-status">Status</th>
                <th className="col-type">Type</th>
                <th className="col-size">Size</th>
                <th className="col-time">Time</th>
              </tr>
            </thead>
            <tbody>
              {filteredRequests.length === 0 ? (
                <tr>
                  <td colSpan="6" className="empty-state">
                    {requests.length === 0 ? 'No requests recorded' : 'No requests match filters'}
                  </td>
                </tr>
              ) : (
                filteredRequests.map((req, index) => (
                  <tr
                    key={index}
                    className={`network-row ${selectedRequest === req ? 'selected' : ''} ${req.error ? 'has-error' : ''}`}
                    onClick={() => setSelectedRequest(req)}
                  >
                    <td className="col-method">{req.method}</td>
                    <td className="col-url" title={req.url}>{req.url}</td>
                    <td className={`col-status ${getStatusClass(req.status)}`}>
                      {req.error ? 'Failed' : req.status || '-'}
                    </td>
                    <td className="col-type">{req.contentType?.split(';')[0] || '-'}</td>
                    <td className="col-size">{formatSize(req.responseSize)}</td>
                    <td className="col-time">{formatDuration(req.duration)}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        {selectedRequest && (
          <div className="network-details">
            <div className="network-details-header">
              <div className="network-details-title">
                <span className="method-badge">{selectedRequest.method}</span>
                <span className="url-text">{selectedRequest.url}</span>
              </div>
              <div className="network-details-actions">
                <button onClick={() => handleCopyAsCurl(selectedRequest)} title="Copy as cURL">
                  cURL
                </button>
                <button onClick={() => handleCopyAsFetch(selectedRequest)} title="Copy as fetch">
                  fetch
                </button>
                <button onClick={() => handleCopyAsAxios(selectedRequest)} title="Copy as Axios">
                  Axios
                </button>
                <button onClick={() => setSelectedRequest(null)} title="Close">
                  ×
                </button>
              </div>
            </div>

            <div className="network-details-tabs">
              <button
                className={detailTab === 'headers' ? 'active' : ''}
                onClick={() => setDetailTab('headers')}
              >
                Headers
              </button>
              <button
                className={detailTab === 'request' ? 'active' : ''}
                onClick={() => setDetailTab('request')}
              >
                Request
              </button>
              <button
                className={detailTab === 'response' ? 'active' : ''}
                onClick={() => setDetailTab('response')}
              >
                Response
              </button>
              <button
                className={detailTab === 'timing' ? 'active' : ''}
                onClick={() => setDetailTab('timing')}
              >
                Timing
              </button>
            </div>

            <div className="network-details-content">
              {detailTab === 'headers' && (
                <div className="headers-view">
                  <div className="header-section">
                    <h4>Request Headers</h4>
                    {selectedRequest.requestHeaders && Object.keys(selectedRequest.requestHeaders).length > 0 ? (
                      <table className="headers-table">
                        <tbody>
                          {Object.entries(selectedRequest.requestHeaders).map(([key, value]) => (
                            <tr key={key}>
                              <td className="header-name">{key}</td>
                              <td className="header-value">{value}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    ) : (
                      <p className="empty-message">No request headers</p>
                    )}
                  </div>
                  <div className="header-section">
                    <h4>Response Headers</h4>
                    {selectedRequest.responseHeaders && Object.keys(selectedRequest.responseHeaders).length > 0 ? (
                      <table className="headers-table">
                        <tbody>
                          {Object.entries(selectedRequest.responseHeaders).map(([key, value]) => (
                            <tr key={key}>
                              <td className="header-name">{key}</td>
                              <td className="header-value">{value}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    ) : (
                      <p className="empty-message">No response headers</p>
                    )}
                  </div>
                </div>
              )}

              {detailTab === 'request' && (
                <div className="body-view">
                  {selectedRequest.requestBody ? (
                    <pre className="body-content">{selectedRequest.requestBody}</pre>
                  ) : (
                    <p className="empty-message">No request body</p>
                  )}
                </div>
              )}

              {detailTab === 'response' && (
                <div className="body-view">
                  {selectedRequest.error ? (
                    <div className="error-view">
                      <p className="error-message">{selectedRequest.error}</p>
                    </div>
                  ) : selectedRequest.responseBody ? (
                    <pre className="body-content">{selectedRequest.responseBody}</pre>
                  ) : (
                    <p className="empty-message">No response body</p>
                  )}
                </div>
              )}

              {detailTab === 'timing' && (
                <div className="timing-view">
                  <table className="timing-table">
                    <tbody>
                      <tr>
                        <td className="timing-label">Started:</td>
                        <td className="timing-value">
                          {new Date(selectedRequest.timestamp).toLocaleTimeString()}
                        </td>
                      </tr>
                      <tr>
                        <td className="timing-label">Duration:</td>
                        <td className="timing-value">{formatDuration(selectedRequest.duration)}</td>
                      </tr>
                      <tr>
                        <td className="timing-label">Request Size:</td>
                        <td className="timing-value">{formatSize(selectedRequest.requestSize)}</td>
                      </tr>
                      <tr>
                        <td className="timing-label">Response Size:</td>
                        <td className="timing-value">{formatSize(selectedRequest.responseSize)}</td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
