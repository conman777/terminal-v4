import { apiFetch } from '../../utils/api';
import React, { useState, useEffect, useRef } from 'react';
import './WebSocketTab.css';

/**
 * WebSocketTab Component
 *
 * Displays WebSocket connections and messages for debugging
 */
export function WebSocketTab({ port }) {
  const [connections, setConnections] = useState([]);
  const [messages, setMessages] = useState([]);
  const requestRevision = useRef(0);
  const [refreshRevision, setRefreshRevision] = useState(0);
  const [error, setError] = useState(null);
  const [isClearing, setIsClearing] = useState(false);
  const clearOwner = useRef(null);
  const [selectedConnectionId, setSelectedConnectionId] = useState(null);
  const [directionFilter, setDirectionFilter] = useState('all'); // 'all', 'sent', 'received'
  const [selectedMessage, setSelectedMessage] = useState(null);
  const [refreshInterval, setRefreshInterval] = useState(null);
  const [notAvailable, setNotAvailable] = useState(false);
  const messageButtons = useRef(new Map());
  const returnFocusId = useRef(null);

  useEffect(() => {
    if (!selectedMessage && returnFocusId.current) {
      messageButtons.current.get(returnFocusId.current)?.focus();
      returnFocusId.current = null;
    }
  }, [selectedMessage]);

  useEffect(() => {
    setConnections([]);
    setMessages([]);
    setSelectedConnectionId(null);
    setSelectedMessage(null);
    setNotAvailable(false);
    setError(null);
    setIsClearing(false);
    clearOwner.current = null;
    return () => { clearOwner.current = null; };
  }, [port]);

  useEffect(() => {
    if (!port || clearOwner.current) return;
    const controller = new AbortController();
    const revision = ++requestRevision.current;
    const current = () => !controller.signal.aborted && requestRevision.current === revision;
    const load = async () => {
      try {
        const params = new URLSearchParams();
        if (selectedConnectionId) params.set('connectionId', selectedConnectionId);
        if (directionFilter !== 'all') params.set('direction', directionFilter);
        const response = await apiFetch(`/api/preview/${port}/websockets?${params}`, { signal: controller.signal });
        if (!current()) return;
        if (response.status === 404) { setNotAvailable(true); return; }
        if (!response.ok) throw new Error('WebSocket request failed');
        const data = await response.json();
        if (!current()) return;
        if (!Array.isArray(data.connections) || !Array.isArray(data.messages)) throw new Error('Invalid WebSocket response');
        setConnections(data.connections);
        setMessages(data.messages);
        setNotAvailable(false);
        setError(null);
      } catch {
        if (current()) setError('Could not load WebSocket telemetry. Try refreshing.');
      }
    };
    void load();
    return () => controller.abort();
  }, [port, selectedConnectionId, directionFilter, refreshRevision]);

  useEffect(() => {
    if (!refreshInterval || notAvailable || isClearing || !port) return;
    const id = setInterval(() => setRefreshRevision(value => value + 1), refreshInterval);
    return () => clearInterval(id);
  }, [refreshInterval, notAvailable, isClearing, port]);

  const fetchData = () => setRefreshRevision(value => value + 1);

  const clearLogs = async () => {
    if (!port || clearOwner.current) return;
    const owner = {};
    clearOwner.current = owner;
    requestRevision.current += 1;
    setIsClearing(true);
    setError(null);
    try {
      const response = await apiFetch(`/api/preview/${port}/websockets`, { method: 'DELETE' });
      if (clearOwner.current !== owner) return;
      if (!response.ok) throw new Error('Clear request failed');
      setConnections([]);
      setMessages([]);
      setSelectedConnectionId(null);
      setSelectedMessage(null);
    } catch {
      if (clearOwner.current === owner) setError('Could not clear WebSocket telemetry. The server may not support clearing.');
    } finally {
      if (clearOwner.current === owner) {
        clearOwner.current = null;
        setIsClearing(false);
      }
    }
  };

  const formatTime = (timestamp) => {
    return new Date(timestamp).toLocaleTimeString('en-US', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      fractionalSecondDigits: 3
    });
  };

  const formatMessageData = (data, format) => {
    if (format === 'binary') {
      return data;
    }

    try {
      const parsed = JSON.parse(data);
      return JSON.stringify(parsed, null, 2);
    } catch {
      return data;
    }
  };

  const copyToClipboard = async (text) => {
    try {
      await navigator.clipboard.writeText(text);
      setError(null);
    } catch {
      setError('Could not copy message. Clipboard access is unavailable; try again with clipboard permission.');
    }
  };

  if (notAvailable) {
    return (
      <div className="websocket-tab">
        <h2>WebSocket Debugger</h2>
        <div className="websocket-tab__empty">
          <p>WebSocket debugging not available</p>
          <p>This preview server does not provide WebSocket inspection.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="websocket-tab">
      <div className="websocket-tab__toolbar">
        <h2>WebSocket Debugger</h2>
        <div className="websocket-tab__actions">
          <select
            aria-label="WebSocket refresh interval"
            value={refreshInterval || ''}
            onChange={(e) => setRefreshInterval(e.target.value ? parseInt(e.target.value) : null)}
          >
            <option value="">Manual Refresh</option>
            <option value="1000">Refresh every 1s</option>
            <option value="2000">Refresh every 2s</option>
            <option value="5000">Refresh every 5s</option>
          </select>
          <button type="button" onClick={fetchData} disabled={!port || isClearing}>Refresh</button>
          <button type="button" onClick={clearLogs} disabled={!port || isClearing} className="websocket-tab__error">Clear</button>
        </div>
      </div>

      {error && <p role="alert" className="websocket-tab__error">{error}</p>}
      <div className="websocket-tab__layout">
        <section className="websocket-tab__pane" aria-label="Connections">
          <h3>Connections ({connections.length})</h3>
          <div className="websocket-tab__scroll" role="region" aria-label="WebSocket connections" tabIndex={0}>
            {connections.length === 0 ? (
              <div className="websocket-tab__empty">No connections</div>
            ) : connections.map((conn) => (
              <button
                type="button"
                key={conn.id}
                aria-label={`Connection ${conn.id}: ${conn.url} (${conn.status})`}
                aria-pressed={selectedConnectionId === conn.id}
                disabled={isClearing}
                onClick={() => setSelectedConnectionId(conn.id === selectedConnectionId ? null : conn.id)}
                className="websocket-tab__connection"
              >
                <span className="websocket-tab__row-heading">
                  <span className="websocket-tab__mono">{conn.id.substring(0, 12)}...</span>
                  <span className="websocket-tab__status" data-status={conn.status}>{conn.status}</span>
                </span>
                <span className="websocket-tab__url" title={conn.url}>{conn.url}</span>
                <span className="websocket-tab__muted">{formatTime(conn.timestamp)}</span>
                {conn.protocols && conn.protocols.length > 0 && (
                  <span className="websocket-tab__muted">Protocols: {conn.protocols.join(', ')}</span>
                )}
                {conn.error && <span className="websocket-tab__error">Error: {conn.error}</span>}
                {conn.closeCode && <span className="websocket-tab__muted">Close: {conn.closeCode} {conn.closeReason}</span>}
              </button>
            ))}
          </div>
        </section>

        <section className="websocket-tab__pane" aria-label="Messages">
          <div className="websocket-tab__toolbar">
            <h3>Messages ({messages.length})</h3>
            <div className="websocket-tab__actions" role="group" aria-label="Message direction">
              {['all', 'sent', 'received'].map(direction => (
                <button
                  type="button"
                  key={direction}
                  onClick={() => setDirectionFilter(direction)}
                  aria-pressed={directionFilter === direction}
                  disabled={isClearing}
                >
                  {direction[0].toUpperCase() + direction.slice(1)}
                </button>
              ))}
            </div>
          </div>

          {selectedMessage ? (
            <div className="websocket-tab__scroll websocket-tab__details" role="region" aria-label="Message details" tabIndex={0}>
              <div className="websocket-tab__toolbar">
                <h4>Message Details</h4>
                <button type="button" autoFocus onClick={() => setSelectedMessage(null)}>Close</button>
              </div>
              <dl>
                <dt>Direction</dt>
                <dd className="websocket-tab__direction" data-direction={selectedMessage.direction}>
                  {selectedMessage.direction === 'sent' ? '→ Sent' : '← Received'}
                </dd>
                <dt>Timestamp</dt>
                <dd>{formatTime(selectedMessage.timestamp)}</dd>
                <dt>Format</dt>
                <dd>{selectedMessage.format}</dd>
                <dt>Size</dt>
                <dd>{selectedMessage.size} bytes</dd>
              </dl>
              <div className="websocket-tab__toolbar">
                <span className="websocket-tab__muted">Data</span>
                <button type="button" onClick={() => copyToClipboard(selectedMessage.data)}>Copy</button>
              </div>
              <pre>{formatMessageData(selectedMessage.data, selectedMessage.format)}</pre>
            </div>
          ) : (
            <div className="websocket-tab__scroll" role="region" aria-label="WebSocket messages" tabIndex={0}>
              {messages.length === 0 ? (
                <div className="websocket-tab__empty">
                  No messages{selectedConnectionId && ' for selected connection'}
                </div>
              ) : (
                <table className="websocket-tab__table" aria-label="WebSocket messages">
                  <thead>
                    <tr>
                      <th scope="col">Time</th>
                      <th scope="col">Direction</th>
                      <th scope="col">Format</th>
                      <th scope="col">Size</th>
                      <th scope="col">Data Preview</th>
                    </tr>
                  </thead>
                  <tbody>
                    {messages.map((msg) => (
                      <tr
                        key={msg.id}
                        onClick={() => { returnFocusId.current = msg.id; setSelectedMessage(msg); }}
                      >
                        <td className="websocket-tab__mono">{formatTime(msg.timestamp)}</td>
                        <td className="websocket-tab__direction" data-direction={msg.direction}>
                          {msg.direction === 'sent' ? '→ Sent' : '← Received'}
                        </td>
                        <td>{msg.format}</td>
                        <td>{msg.size}B</td>
                        <td>
                          <button
                            type="button"
                            className="websocket-tab__message"
                            ref={node => {
                              if (node) messageButtons.current.set(msg.id, node);
                              else messageButtons.current.delete(msg.id);
                            }}
                            aria-label={`Inspect message ${msg.id}: ${msg.data.length > 100 ? `${msg.data.substring(0, 100)}...` : msg.data}`}
                          >
                            {msg.data.length > 100 ? `${msg.data.substring(0, 100)}...` : msg.data}
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
