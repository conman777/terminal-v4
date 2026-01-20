# Phase 5: Performance & Debugging Features

This document describes the Performance Monitoring and WebSocket Debugging features added in Phase 5, plus the Browser Settings configuration panel.

## Overview

Phase 5 adds three major features to the preview system:

1. **Performance Monitoring** - Track Core Web Vitals, load metrics, and runtime performance
2. **WebSocket Debugging** - Inspect WebSocket connections and messages
3. **Browser Settings** - Configure session timeouts, limits, and quality settings

## Performance Monitoring

### Architecture

The performance monitoring system consists of:

- **Client-side injection script** (`PERFORMANCE_MONITOR_SCRIPT` in `preview-subdomain-routes.ts`)
  - Automatically injected into all HTML pages
  - Uses PerformanceObserver API to track metrics
  - Batches and sends metrics to backend every 2 seconds
  - Lightweight design to avoid impacting page performance

- **Backend storage** (`performance-service.ts`)
  - In-memory storage of metrics per port
  - Automatic cleanup of old metrics
  - WebSocket streaming for live updates

- **Frontend UI** (`PerformanceTab.jsx`)
  - Displays metrics with pass/fail indicators
  - Real-time FPS graph
  - Export functionality for reports

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

The WebSocket debugging system intercepts WebSocket connections through the preview proxy:

- **Server-side interceptor** (`websocket-interceptor.ts`)
  - Logs connection events (open, close, error)
  - Captures all sent and received messages
  - Stores message format (text/binary) and size
  - Automatically filters HMR WebSockets to reduce noise

- **Frontend UI** (`WebSocketTab.jsx`)
  - Connection list with status badges
  - Message log with filtering (sent/received)
  - JSON formatting for structured data
  - Message detail view with copy functionality

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

Hot Module Replacement (HMR) WebSockets are automatically whitelisted to reduce noise:
- Vite HMR connections are not logged
- Only application WebSockets are tracked
- Configurable in `websocket-interceptor.ts`

### Usage

1. Open a preview panel with WebSocket connections
2. Click the "WebSocket" tab in DevTools
3. Connections appear automatically as they're created
4. Click a connection to filter messages
5. Click a message to see full details
6. Use "Clear" to reset all logs

## Browser Settings

### Architecture

The browser settings system provides centralized configuration for browser session management:

- **Backend service** (`browser-settings-service.ts`)
  - Stores settings in JSON file
  - Validates all updates
  - Provides defaults
  - Used by browser-session-service

- **API endpoints** (`browser-settings-routes.ts`)
  - GET `/api/settings/browser` - Get current settings
  - PUT `/api/settings/browser` - Update settings
  - POST `/api/settings/browser/reset` - Reset to defaults

- **Frontend UI** (`BrowserSettings.jsx`)
  - Form with sliders and inputs
  - Real-time validation
  - Shows current vs default values
  - Immediate effect on save

### Settings

#### Session Timeouts

- **Idle Timeout** (1-60 minutes, default: 5 min)
  - How long before idle sessions are cleaned up
  - Affects all browser sessions

- **Max Lifetime** (10-240 minutes, default: 30 min)
  - Maximum session duration regardless of activity
  - Prevents resource exhaustion

#### Session Limits

- **Max Concurrent Sessions** (1-20, default: 10)
  - Maximum number of active browser sessions
  - Prevents resource exhaustion

#### Cleanup Settings

- **Cleanup Interval** (30-600 seconds, default: 60s)
  - How often to check for expired sessions
  - Lower = more responsive cleanup, higher = less overhead

- **Log Retention** (10-1440 minutes, default: 60 min)
  - How long to keep browser session logs
  - Affects network logs, console logs, etc.

#### Screenshot Settings

- **Format** (PNG/JPEG, default: PNG)
  - PNG: Lossless, larger files
  - JPEG: Lossy, smaller files

- **JPEG Quality** (1-100, default: 80)
  - Only applies to JPEG format
  - Higher = better quality, larger files

### Usage

1. Open the mobile drawer (hamburger menu) or settings panel
2. Click "Browser Settings"
3. Adjust sliders or inputs as needed
4. Click "Save Settings" to apply
5. Click "Reset to Defaults" to restore defaults
6. Changes take effect immediately for new sessions

### Access Points

- **Mobile**: Drawer menu → Browser Settings
- **Desktop**: Settings menu → Browser Settings (if integrated)

## API Endpoints

### Performance Monitoring

```
POST /api/preview/:port/performance
Body: { metrics: PerformanceMetric[] }
- Track metrics from client

GET /api/preview/:port/performance?since=timestamp
- Get all metrics since timestamp
- Returns: { port, metrics, latestTimestamp }

DELETE /api/preview/:port/performance
- Clear all metrics for port

WebSocket /api/preview/:port/performance/stream
- Stream real-time metric updates
- Sends updates every 1 second
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

### Browser Settings

```
GET /api/settings/browser
- Get current settings and defaults
- Returns: { settings, defaults }

PUT /api/settings/browser
Body: Partial<BrowserSettings>
- Update settings
- Returns: { success, settings }

POST /api/settings/browser/reset
- Reset to defaults
- Returns: { success, settings }
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

### Browser Settings

1. **Test All Controls**
   - Adjust idle timeout slider
   - Adjust max lifetime slider
   - Change max sessions input
   - Change cleanup interval
   - Change log retention
   - Change screenshot format
   - Adjust JPEG quality (when format=JPEG)

2. **Verify Validation**
   - Try values outside range (should be clamped)
   - Verify current vs default display updates

3. **Test Persistence**
   - Change settings and save
   - Refresh page
   - Verify settings persisted

4. **Test Reset**
   - Change multiple settings
   - Click "Reset to Defaults"
   - Verify all settings return to defaults

5. **Verify Effects**
   - Change idle timeout to 1 minute
   - Create browser session
   - Wait 1 minute idle
   - Verify session is cleaned up

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

### For Browser Sessions

- Lower idle timeout to free resources faster
- Lower cleanup interval for more responsive cleanup
- Use JPEG screenshots for smaller storage
- Reduce log retention for lower memory usage

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

### Settings Not Saving

- Check browser console for API errors
- Verify `/api/settings/browser` endpoint is accessible
- Check file permissions on settings file
- Ensure valid ranges (settings are validated)

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

- `/docs/BROWSER_SESSIONS.md` - Browser session management
- `/docs/PREVIEW_SYSTEM.md` - Preview proxy architecture
- `/backend/src/browser/performance-service.ts` - Performance storage
- `/backend/src/preview/websocket-interceptor.ts` - WebSocket interception
- `/backend/src/settings/browser-settings-service.ts` - Settings management
