import React, { useState, useEffect } from 'react';

/**
 * WebSocketTab Component
 *
 * Displays WebSocket connections and messages for debugging
 */
export function WebSocketTab({ port }) {
  const [connections, setConnections] = useState([]);
  const [messages, setMessages] = useState([]);
  const [selectedConnectionId, setSelectedConnectionId] = useState(null);
  const [directionFilter, setDirectionFilter] = useState('all'); // 'all', 'sent', 'received'
  const [selectedMessage, setSelectedMessage] = useState(null);
  const [refreshInterval, setRefreshInterval] = useState(null);
  const [notAvailable, setNotAvailable] = useState(false);

  useEffect(() => {
    fetchData();
  }, [port, selectedConnectionId, directionFilter]);

  useEffect(() => {
    if (refreshInterval && !notAvailable) {
      const id = setInterval(() => {
        fetchData();
      }, refreshInterval);
      return () => clearInterval(id);
    }
  }, [refreshInterval, port, selectedConnectionId, directionFilter, notAvailable]);

  const fetchData = async () => {
    try {
      const params = new URLSearchParams();
      if (selectedConnectionId) params.set('connectionId', selectedConnectionId);
      if (directionFilter !== 'all') params.set('direction', directionFilter);

      const response = await fetch(`/api/preview/${port}/websockets?${params}`);
      if (response.status === 404) {
        setNotAvailable(true);
        return;
      }
      if (response.ok) {
        const data = await response.json();
        setConnections(data.connections);
        setMessages(data.messages);
      }
    } catch (err) {
      setNotAvailable(true);
    }
  };

  const clearLogs = async () => {
    try {
      await fetch(`/api/preview/${port}/websockets`, { method: 'DELETE' });
      setConnections([]);
      setMessages([]);
      setSelectedConnectionId(null);
      setSelectedMessage(null);
    } catch (err) {
      console.error('Error clearing logs:', err);
    }
  };

  const getStatusBadge = (status) => {
    const colors = {
      connecting: 'bg-yellow-100 text-yellow-800',
      connected: 'bg-green-100 text-green-800',
      closing: 'bg-orange-100 text-orange-800',
      closed: 'bg-gray-100 text-gray-800',
      error: 'bg-red-100 text-red-800'
    };
    return (
      <span className={`px-2 py-1 rounded text-xs font-medium ${colors[status] || 'bg-gray-100 text-gray-800'}`}>
        {status}
      </span>
    );
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

  const copyToClipboard = (text) => {
    navigator.clipboard.writeText(text);
  };

  if (notAvailable) {
    return (
      <div className="p-4 h-full flex flex-col overflow-hidden">
        <div className="flex justify-between items-center mb-4">
          <h2 className="text-xl font-semibold">WebSocket Debugger</h2>
        </div>
        <div className="text-center py-12 text-gray-500">
          <p className="text-lg font-medium mb-2">WebSocket debugging not available</p>
          <p>The backend endpoints for WebSocket inspection have not been implemented yet.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="p-4 h-full flex flex-col overflow-hidden">
      {/* Header */}
      <div className="flex justify-between items-center mb-4">
        <h2 className="text-xl font-semibold">WebSocket Debugger</h2>
        <div className="flex gap-2">
          <select
            value={refreshInterval || ''}
            onChange={(e) => setRefreshInterval(e.target.value ? parseInt(e.target.value) : null)}
            className="px-3 py-1 border border-gray-300 rounded text-sm"
          >
            <option value="">Manual Refresh</option>
            <option value="1000">Refresh every 1s</option>
            <option value="2000">Refresh every 2s</option>
            <option value="5000">Refresh every 5s</option>
          </select>
          <button
            onClick={fetchData}
            className="px-3 py-1 bg-blue-600 text-white rounded text-sm font-medium hover:bg-blue-700"
          >
            Refresh
          </button>
          <button
            onClick={clearLogs}
            className="px-3 py-1 bg-red-600 text-white rounded text-sm font-medium hover:bg-red-700"
          >
            Clear
          </button>
        </div>
      </div>

      <div className="flex-1 grid grid-cols-12 gap-4 overflow-hidden">
        {/* Connections List */}
        <div className="col-span-4 flex flex-col overflow-hidden">
          <h3 className="text-lg font-semibold mb-2">
            Connections ({connections.length})
          </h3>
          <div className="flex-1 bg-white rounded-lg border border-gray-200 overflow-auto">
            {connections.length === 0 ? (
              <div className="p-4 text-center text-gray-500">No connections</div>
            ) : (
              <div className="divide-y">
                {connections.map((conn) => (
                  <div
                    key={conn.id}
                    onClick={() => setSelectedConnectionId(conn.id === selectedConnectionId ? null : conn.id)}
                    className={`p-3 cursor-pointer hover:bg-gray-50 ${
                      selectedConnectionId === conn.id ? 'bg-blue-50' : ''
                    }`}
                  >
                    <div className="flex items-center justify-between mb-1">
                      <span className="text-xs font-mono text-gray-500">
                        {conn.id.substring(0, 12)}...
                      </span>
                      {getStatusBadge(conn.status)}
                    </div>
                    <div className="text-sm font-medium truncate" title={conn.url}>
                      {conn.url}
                    </div>
                    <div className="text-xs text-gray-500 mt-1">
                      {formatTime(conn.timestamp)}
                    </div>
                    {conn.protocols && conn.protocols.length > 0 && (
                      <div className="text-xs text-gray-500 mt-1">
                        Protocols: {conn.protocols.join(', ')}
                      </div>
                    )}
                    {conn.error && (
                      <div className="text-xs text-red-600 mt-1">
                        Error: {conn.error}
                      </div>
                    )}
                    {conn.closeCode && (
                      <div className="text-xs text-gray-500 mt-1">
                        Close: {conn.closeCode} {conn.closeReason}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Messages List */}
        <div className="col-span-8 flex flex-col overflow-hidden">
          <div className="flex justify-between items-center mb-2">
            <h3 className="text-lg font-semibold">
              Messages ({messages.length})
            </h3>
            <div className="flex gap-2">
              <button
                onClick={() => setDirectionFilter('all')}
                className={`px-3 py-1 rounded text-sm font-medium ${
                  directionFilter === 'all'
                    ? 'bg-blue-600 text-white'
                    : 'bg-gray-200 text-gray-700 hover:bg-gray-300'
                }`}
              >
                All
              </button>
              <button
                onClick={() => setDirectionFilter('sent')}
                className={`px-3 py-1 rounded text-sm font-medium ${
                  directionFilter === 'sent'
                    ? 'bg-blue-600 text-white'
                    : 'bg-gray-200 text-gray-700 hover:bg-gray-300'
                }`}
              >
                Sent
              </button>
              <button
                onClick={() => setDirectionFilter('received')}
                className={`px-3 py-1 rounded text-sm font-medium ${
                  directionFilter === 'received'
                    ? 'bg-blue-600 text-white'
                    : 'bg-gray-200 text-gray-700 hover:bg-gray-300'
                }`}
              >
                Received
              </button>
            </div>
          </div>

          {selectedMessage ? (
            // Message Detail View
            <div className="flex-1 bg-white rounded-lg border border-gray-200 p-4 overflow-auto">
              <div className="flex justify-between items-center mb-4">
                <h4 className="text-md font-semibold">Message Details</h4>
                <button
                  onClick={() => setSelectedMessage(null)}
                  className="text-gray-500 hover:text-gray-700"
                >
                  Close
                </button>
              </div>
              <div className="space-y-3">
                <div>
                  <div className="text-sm font-medium text-gray-500">Direction</div>
                  <div className={`text-sm font-medium ${
                    selectedMessage.direction === 'sent' ? 'text-blue-600' : 'text-green-600'
                  }`}>
                    {selectedMessage.direction === 'sent' ? '→ Sent' : '← Received'}
                  </div>
                </div>
                <div>
                  <div className="text-sm font-medium text-gray-500">Timestamp</div>
                  <div className="text-sm">{formatTime(selectedMessage.timestamp)}</div>
                </div>
                <div>
                  <div className="text-sm font-medium text-gray-500">Format</div>
                  <div className="text-sm">{selectedMessage.format}</div>
                </div>
                <div>
                  <div className="text-sm font-medium text-gray-500">Size</div>
                  <div className="text-sm">{selectedMessage.size} bytes</div>
                </div>
                <div>
                  <div className="flex justify-between items-center mb-2">
                    <div className="text-sm font-medium text-gray-500">Data</div>
                    <button
                      onClick={() => copyToClipboard(selectedMessage.data)}
                      className="text-xs px-2 py-1 bg-gray-200 hover:bg-gray-300 rounded"
                    >
                      Copy
                    </button>
                  </div>
                  <pre className="text-xs bg-gray-50 p-3 rounded overflow-auto max-h-96">
                    {formatMessageData(selectedMessage.data, selectedMessage.format)}
                  </pre>
                </div>
              </div>
            </div>
          ) : (
            // Messages List View
            <div className="flex-1 bg-white rounded-lg border border-gray-200 overflow-auto">
              {messages.length === 0 ? (
                <div className="p-4 text-center text-gray-500">
                  No messages
                  {selectedConnectionId && ' for selected connection'}
                </div>
              ) : (
                <table className="w-full text-sm">
                  <thead className="bg-gray-50 border-b sticky top-0">
                    <tr>
                      <th className="text-left p-2 w-24">Time</th>
                      <th className="text-left p-2 w-24">Direction</th>
                      <th className="text-left p-2 w-20">Format</th>
                      <th className="text-left p-2 w-20">Size</th>
                      <th className="text-left p-2">Data Preview</th>
                    </tr>
                  </thead>
                  <tbody>
                    {messages.map((msg) => (
                      <tr
                        key={msg.id}
                        onClick={() => setSelectedMessage(msg)}
                        className="border-b hover:bg-gray-50 cursor-pointer"
                      >
                        <td className="p-2 text-xs font-mono">
                          {formatTime(msg.timestamp)}
                        </td>
                        <td className="p-2">
                          <span className={`text-xs font-medium ${
                            msg.direction === 'sent' ? 'text-blue-600' : 'text-green-600'
                          }`}>
                            {msg.direction === 'sent' ? '→ Sent' : '← Received'}
                          </span>
                        </td>
                        <td className="p-2 text-xs">{msg.format}</td>
                        <td className="p-2 text-xs">{msg.size}B</td>
                        <td className="p-2 text-xs font-mono truncate max-w-md">
                          {msg.data.length > 100 ? `${msg.data.substring(0, 100)}...` : msg.data}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
