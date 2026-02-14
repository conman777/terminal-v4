# Phase 5: Performance & Debugging Features

This document describes the Performance Monitoring and WebSocket Debugging features added in Phase 5, plus the Browser Settings configuration panel.

## Overview

Phase 5 describes three DevTools features for the preview system:

1. **Performance Monitoring** - Track Core Web Vitals, load metrics, and runtime performance
2. **WebSocket Debugging** - Inspect WebSocket connections and messages
3. **Browser Settings** - Configure browser session timeouts, limits, and quality settings

## Current Status (2026-02)

**Implemented**
- Preview logs + proxy logs (Network/Console tabs) in `backend/src/routes/preview-logs-routes.ts`
  and `backend/src/routes/preview-api-routes.ts`.
- Storage/evaluate endpoints for the Storage and Console tabs in
  `backend/src/routes/preview-api-routes.ts`.
- Performance metrics ingestion/query/clear endpoints and live stream.
- WebSocket connection/message query + clear endpoints and proxy capture store.

**Still pending**
- Browser Settings endpoints used by `frontend/src/components/settings/BrowserSettings.jsx`.

## Performance Monitoring

### Architecture

The frontend UI is present, preview pages inject a metrics script, and backend
routes now ingest/query/stream performance metrics.

- **Client-side injection script** (`PERFORMANCE_MONITOR_SCRIPT` in
  `backend/src/routes/preview-subdomain-routes.ts`)
  - Injects PerformanceObserver metrics
  - Sends batches to `/api/preview/:port/performance`
- **Frontend UI** (`frontend/src/components/devtools/PerformanceTab.jsx`)
  - Fetches `/api/preview/:port/performance`
  - Subscribes to `/api/preview/:port/performance/stream`
- **Backend routes**
  - POST `/api/preview/:port/performance`
  - GET/DELETE `/api/preview/:port/performance`
  - WS `/api/preview/:port/performance/stream`

### Metrics Tracked

#### Core Web Vitals

- **LCP (Largest Contentful Paint)**
  - Measures loading performance
  - Good: ≤2500ms
  - Needs improvement: ≤4000ms
  - Poor: >4000ms

- **FID (First Input Delay)**
  - Measures interactivity
  - Good: ≤100ms
  - Needs improvement: ≤300ms
  - Poor: >300ms

- **CLS (Cumulative Layout Shift)**
  - Measures visual stability
  - Good: ≤0.1
  - Needs improvement: ≤0.25
  - Poor: >0.25

#### Load Metrics

- DOM Content Loaded
- Full Page Load
- Time to Interactive (TTI)

#### Runtime Metrics

- **FPS (Frames Per Second)**
  - Real-time graph of last 60 samples
  - Target: 60 FPS
  - Warning: <55 FPS
  - Error: <30 FPS

- **JS Heap Memory**
  - Used vs Total heap size
  - Helps identify memory leaks

- **Long Tasks**
  - Tasks that block main thread >50ms
  - Shows start time and duration

### Usage

1. Open a preview panel with an application running
2. Click the "Performance" tab in DevTools
3. Click "Start Live" to begin real-time monitoring
4. Metrics are collected automatically as you interact with the app
5. Use "Export" to download a JSON report
6. Use "Clear" to reset all metrics

### Performance Impact

The monitoring script is designed to be lightweight:
- Uses passive PerformanceObserver (no performance penalty)
- Batches metrics to reduce network requests
- Sends data every 2 seconds (configurable)
- Only tracks FPS when tab is active
- Automatically stops on page unload

## WebSocket Debugging

### Architecture

The WebSocket Debugger UI is backed by server-side capture + query routes.

- **Frontend UI** (`frontend/src/components/devtools/WebSocketTab.jsx`)
  - Fetches `/api/preview/:port/websockets`
  - Clears with `DELETE /api/preview/:port/websockets`
- **Backend routes**
  - GET `/api/preview/:port/websockets`
  - DELETE `/api/preview/:port/websockets`

### Features

#### Connection Tracking

Each connection shows:
- Connection ID (first 12 chars)
- URL
- Status (connecting, connected, closing, closed, error)
- Timestamp
- Protocols (if negotiated)
- Close code and reason (if closed)
- Error message (if failed)

#### Message Logging

Each message shows:
- Timestamp (HH:MM:SS.mmm)
- Direction (sent → / received ←)
- Format (text/binary)
- Size in bytes
- Data preview (first 100 chars)

#### Filtering

- Filter by connection ID
- Filter by direction (all/sent/received)
- Auto-refresh options (1s, 2s, 5s, manual)

#### Message Detail View

Click any message to see:
- Full message data
- JSON formatting (if valid JSON)
- Copy to clipboard button

### HMR Whitelist

Planned behavior once WebSocket logging is implemented:
- Vite HMR connections are not logged
- Only application WebSockets are tracked

### Usage

1. Open a preview panel with WebSocket connections
2. Click the "WebSocket" tab in DevTools
3. Connections appear automatically as they're created
4. Click a connection to filter messages
5. Click a message to see full details
6. Use "Clear" to reset all logs

## Preview Settings

Browser-automation-specific settings and endpoints were removed from the
backend and frontend. Use the regular preview/devtools routes under
`/api/preview/*` for debugging and diagnostics.

## API Endpoints

### Implemented (Preview DevTools)

```
GET    /api/preview/:port/logs
POST   /api/preview/:port/logs
DELETE /api/preview/:port/logs

GET    /api/preview/:port/proxy-logs
DELETE /api/preview/:port/proxy-logs

GET    /api/preview/active-ports

GET    /api/preview/:port/storage
POST   /api/preview/:port/storage

POST   /api/preview/:port/evaluate
```

### Planned / Unwired

```
POST /api/preview/:port/performance
GET  /api/preview/:port/performance
DELETE /api/preview/:port/performance
WS   /api/preview/:port/performance/stream

GET  /api/preview/:port/websockets
DELETE /api/preview/:port/websockets
```

### WebSocket Debugging

```
GET /api/preview/:port/websockets?connectionId&direction
- Get connections and messages
- Optional filters: connectionId, direction (sent/received)
- Returns: { port, connections, messages, messageCount }

DELETE /api/preview/:port/websockets
- Clear all WebSocket logs for port
```

## Testing

### Performance Monitoring

1. **Load a test page**
   - Navigate to any preview URL
   - Open DevTools → Performance tab

2. **Verify Core Web Vitals**
   - LCP should appear on page load
   - FID should appear on first interaction
   - CLS should update as layout shifts

3. **Verify Live Updates**
   - Click "Start Live"
   - FPS graph should update in real-time
   - Memory should show current heap usage

4. **Test Export**
   - Click "Export"
   - Verify JSON file downloads with all metrics

### WebSocket Debugging

1. **Create WebSocket connection**
   ```javascript
   const ws = new WebSocket('ws://localhost:8080');
   ws.onmessage = (e) => console.log('Received:', e.data);
   ws.send('Hello');
   ```

2. **Verify Connection Tracking**
   - Open DevTools → WebSocket tab
   - Connection should appear with "connected" status
   - URL should show ws://localhost:8080

3. **Verify Message Logging**
   - Send messages from client
   - Messages should appear with "sent →" direction
   - Receive messages from server
   - Messages should appear with "received ←" direction

4. **Test Filtering**
   - Filter by direction (sent/received)
   - Click connection to filter by ID
   - Verify message list updates

5. **Verify HMR Whitelist**
   - HMR WebSockets should NOT appear in list
   - Only application WebSockets should be tracked

## Performance Tips

### For Performance Monitoring

- Only enable live monitoring when actively debugging
- Clear metrics periodically to free memory
- Use export to save historical data
- FPS monitoring has minimal overhead but runs continuously

### For WebSocket Debugging

- Clear logs after debugging to free memory
- Use connection filtering for high-traffic apps
- HMR whitelist reduces noise automatically
- Auto-refresh increases network usage

## Troubleshooting

### Performance Metrics Not Appearing

- Check browser console for script errors
- Verify page is loaded (not cached redirect)
- Check `/api/preview/:port/performance` endpoint directly
- Ensure PerformanceObserver API is supported (Chrome, Firefox, Edge)

### WebSocket Messages Not Logged

- Verify connection is not HMR (check whitelist)
- Check proxy is intercepting WebSocket upgrade
- Verify `/api/preview/:port/websockets` endpoint
- Check connection URL matches preview port

### Performance Impact

If performance monitoring slows down your app:
- Disable live FPS monitoring
- Increase metric flush interval (in script)
- Clear metrics more frequently
- Check for memory leaks in long tasks

## Future Enhancements

Potential improvements for Phase 6+:

- **Performance**
  - Resource timing (script/image load times)
  - Paint timing details
  - User timing marks
  - Network waterfall view

- **WebSocket**
  - Message replay functionality
  - WebSocket connection pooling
  - Binary message hex viewer
  - Message search/filter

- **Settings**
  - Per-project settings overrides
  - Settings presets (development/production)
  - Settings import/export
  - Advanced browser flags

## Related Documentation

- `/docs/architecture/SYSTEM_ARCHITECTURE.md` - Preview proxy architecture
- `/docs/architecture/API_ARCHITECTURE.md` - API surface
- `/backend/src/routes/preview-subdomain-routes.ts` - Performance injection script
- `/backend/src/routes/preview-logs-routes.ts` - Console/log ingestion
- `/backend/src/routes/preview-api-routes.ts` - Proxy logs, storage, eval
