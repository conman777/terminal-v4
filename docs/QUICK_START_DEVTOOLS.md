# DevTools Quick Start Guide

Quick reference for using the Preview DevTools features.

## Opening DevTools

1. Open any preview panel (click preview icon or URL)
2. DevTools are integrated into the preview panel
3. Click tabs at the top to switch between tools

## Performance Tab

### Quick Actions

- **Start Live** - Begin real-time monitoring
- **Refresh** - Update metrics from server
- **Export** - Download JSON report
- **Clear** - Reset all metrics

### Reading Metrics

**Core Web Vitals** (colored indicators)
- 🟢 Green = Good
- 🟡 Yellow = Needs Improvement
- 🔴 Red = Poor

**FPS Graph**
- Shows last 60 samples
- Target: 60 FPS
- Updates every second when live

**Long Tasks**
- Red = blocking main thread >50ms
- Shows when and how long

### Common Issues

**No metrics appearing?**
- Confirm the preview app is actively rendering and generating performance data.
- If live mode fails to connect, verify your auth session is valid.
- Reload the preview page
- Check browser console for errors
- Verify page fully loaded

**FPS too low?**
- Check long tasks table
- Monitor memory usage
- Look for layout shifts

## WebSocket Tab

### Quick Actions

- **Refresh** - Update connection/message list
- **Clear** - Reset all logs
- **Auto-refresh** - Set refresh interval (1s/2s/5s)

### Filtering

- Click connection to show only its messages
- Use direction buttons (All/Sent/Received)
- Click message for full details

### Message Colors

- 🔵 Blue = Sent
- 🟢 Green = Received

### Common Issues

**WebSocket not appearing?**
- Confirm the app actually opens non-HMR websocket connections.
- Use Refresh or auto-refresh after initiating websocket traffic.
- Verify it's not HMR (Vite hot reload)
- Check connection URL matches preview
- Look for errors in connection status

**Too many messages?**
- Filter by connection
- Filter by direction
- Use manual refresh mode

## Browser Settings

### Access

- Mobile: Hamburger menu → Browser Settings
- Desktop: Settings → Browser Settings

**Note:** The UI calls `/api/settings/browser` endpoints that are not currently
implemented in the backend. The panel will not persist settings until those
routes are added.

### Common Adjustments

**Faster cleanup** (development)
- Idle timeout: 1-2 minutes
- Cleanup interval: 30 seconds

**Longer sessions** (demos)
- Idle timeout: 30-60 minutes
- Max lifetime: 120-240 minutes

**Smaller storage** (limited resources)
- Screenshot format: JPEG
- JPEG quality: 60-70
- Log retention: 10-30 minutes

### Tips

- Changes affect new sessions immediately
- Existing sessions use old settings
- Use reset to restore defaults

## Keyboard Shortcuts

*Coming in future releases*

## Performance Tips

1. **Only monitor when needed**
   - Disable live monitoring when not debugging
   - Clear metrics after fixing issues

2. **Use filtering**
   - Filter WebSockets by connection
   - Export performance data for later analysis

3. **Adjust settings**
   - Lower timeouts in development
   - Higher timeouts in production
   - Use JPEG for storage efficiency

## Getting Help

- Full documentation: `/docs/PHASE5_PERFORMANCE_DEBUGGING.md`
- Architecture: `/docs/architecture/SYSTEM_ARCHITECTURE.md`
- API reference: `/docs/architecture/API_ARCHITECTURE.md`
