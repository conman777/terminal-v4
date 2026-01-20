import { useState, useCallback } from 'react';
import { DevToolsPanel } from './DevToolsPanel';
import '../../devtools.css';

/**
 * DevToolsExample - Standalone example showing how to integrate DevTools
 *
 * Usage:
 * import { DevToolsExample } from './components/devtools/DevToolsExample';
 * <DevToolsExample />
 */
export function DevToolsExample() {
  // Mock data for demonstration
  const [networkRequests] = useState([
    {
      method: 'GET',
      url: 'https://api.example.com/users',
      status: 200,
      statusText: 'OK',
      contentType: 'application/json',
      responseSize: 1024,
      requestSize: 256,
      duration: 45,
      timestamp: Date.now() - 5000,
      requestHeaders: {
        'Accept': 'application/json',
        'Authorization': 'Bearer token123'
      },
      responseHeaders: {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-cache'
      },
      requestBody: null,
      responseBody: JSON.stringify({ users: [{ id: 1, name: 'John' }] }, null, 2)
    },
    {
      method: 'POST',
      url: 'https://api.example.com/users',
      status: 201,
      statusText: 'Created',
      contentType: 'application/json',
      responseSize: 512,
      requestSize: 128,
      duration: 120,
      timestamp: Date.now() - 3000,
      requestHeaders: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer token123'
      },
      responseHeaders: {
        'Content-Type': 'application/json',
        'Location': '/users/2'
      },
      requestBody: JSON.stringify({ name: 'Jane', email: 'jane@example.com' }, null, 2),
      responseBody: JSON.stringify({ id: 2, name: 'Jane', email: 'jane@example.com' }, null, 2)
    },
    {
      method: 'GET',
      url: 'https://cdn.example.com/style.css',
      status: 200,
      statusText: 'OK',
      contentType: 'text/css',
      responseSize: 2048,
      duration: 30,
      timestamp: Date.now() - 2000,
      requestHeaders: { 'Accept': 'text/css' },
      responseHeaders: { 'Content-Type': 'text/css', 'Cache-Control': 'max-age=3600' },
      responseBody: 'body { margin: 0; padding: 0; }'
    },
    {
      method: 'GET',
      url: 'https://cdn.example.com/missing.js',
      status: 404,
      statusText: 'Not Found',
      contentType: 'text/html',
      responseSize: 256,
      duration: 20,
      timestamp: Date.now() - 1000,
      requestHeaders: { 'Accept': '*/*' },
      responseHeaders: { 'Content-Type': 'text/html' },
      responseBody: '<html><body>404 Not Found</body></html>'
    }
  ]);

  const [consoleLogs] = useState([
    {
      id: 1,
      level: 'log',
      message: 'Application started',
      timestamp: Date.now() - 10000
    },
    {
      id: 2,
      level: 'info',
      message: 'Fetching user data...',
      timestamp: Date.now() - 8000
    },
    {
      id: 3,
      level: 'log',
      message: JSON.stringify({ users: [{ id: 1, name: 'John' }] }),
      timestamp: Date.now() - 7000
    },
    {
      id: 4,
      level: 'warn',
      message: 'API rate limit: 95/100 requests used',
      timestamp: Date.now() - 5000
    },
    {
      id: 5,
      level: 'error',
      message: 'Failed to load resource: net::ERR_FAILED',
      stack: 'Error: Failed to load resource\n    at fetch (app.js:123:45)\n    at loadData (app.js:89:12)',
      timestamp: Date.now() - 2000
    },
    {
      id: 6,
      level: 'debug',
      message: 'Cache invalidated for key: user-data',
      timestamp: Date.now() - 1000
    }
  ]);

  const [storage] = useState({
    localStorage: {
      'user_id': '12345',
      'session_token': 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...',
      'theme': 'dark',
      'language': 'en',
      'last_visit': new Date().toISOString()
    },
    sessionStorage: {
      'cart_items': JSON.stringify([{ id: 1, qty: 2 }, { id: 2, qty: 1 }]),
      'checkout_step': '2',
      'temp_data': 'temporary value'
    },
    cookies: {
      'session_id': 'abc123',
      'analytics_id': 'GA1.2.123456789.1234567890'
    }
  });

  const handleClearNetwork = useCallback(() => {
    alert('Clear network logs');
  }, []);

  const handleClearConsole = useCallback(() => {
    alert('Clear console logs');
  }, []);

  const handleUpdateStorage = useCallback(async (type, operation, key, value) => {
    console.log('Storage update:', { type, operation, key, value });
    alert(`Storage operation: ${operation} ${key} in ${type}`);
  }, []);

  const handleEvaluate = useCallback(async (expression) => {
    console.log('Evaluating:', expression);
    try {
      const result = eval(expression);
      alert(`Result: ${JSON.stringify(result)}`);
      return result;
    } catch (error) {
      alert(`Error: ${error.message}`);
      throw error;
    }
  }, []);

  return (
    <div style={{ height: '600px', border: '1px solid #ccc' }}>
      <div style={{ padding: '10px', background: '#f0f0f0', borderBottom: '1px solid #ccc' }}>
        <h3>DevTools Example</h3>
        <p>This is a standalone example showing the DevTools panel with mock data.</p>
      </div>
      <div style={{ height: 'calc(100% - 80px)' }}>
        <DevToolsPanel
          networkRequests={networkRequests}
          consoleLogs={consoleLogs}
          storage={storage}
          previewPort={3000}
          onClearNetwork={handleClearNetwork}
          onClearConsole={handleClearConsole}
          onUpdateStorage={handleUpdateStorage}
          onEvaluate={handleEvaluate}
        />
      </div>
    </div>
  );
}
