# Common Issues & Troubleshooting

This guide covers common issues and their solutions for Terminal v4.

## Terminal Issues

### Terminal Not Responding

**Symptoms**: Terminal doesn't accept input or show output.

**Solutions**:
1. Refresh the browser (`Ctrl+F5` for hard refresh)
2. Create a new terminal session
3. Check backend logs:
   - `npm run dev` / foreground `npm start`: watch the terminal where the backend is running
   - systemd service: `journalctl -u terminal-v4 -f`
   - `nohup ... > /tmp/backend.log`: `tail -f /tmp/backend.log`
4. Restart the backend server: `~/terminal-v4/restart.sh`
5. Verify WebSocket connection in browser DevTools → Network tab

**Root Causes**:
- WebSocket connection dropped
- Backend process crashed
- PTY process hung

### ANSI Codes Showing as Text

**Symptoms**: Terminal shows raw ANSI escape codes like `\x1b[31m` instead of colors.

**Solutions**:
1. Hard refresh browser (`Ctrl+F5`)
2. Clear browser cache
3. Clear Vite cache: `rm -rf frontend/node_modules/.vite`
4. Verify xterm.js loaded correctly in browser console
5. Check for JavaScript errors in browser DevTools

**Root Causes**:
- xterm.js failed to load
- Cached corrupt build artifacts
- Browser compatibility issues

### Terminal Output Freezes or Lags

**Symptoms**: Terminal output stops updating or updates very slowly.

**Solutions**:
1. Enable WebGL renderer in terminal settings
2. Reduce terminal font size
3. Clear terminal history
4. Close unused terminal sessions
5. Check system resources (CPU/memory)
6. Disable terminal addons if any

**Root Causes**:
- Too much output too quickly
- Memory pressure
- CPU-intensive rendering
- Large scrollback buffer

### Copy/Paste Not Working

**Symptoms**: Can't copy from or paste into terminal.

**Solutions**:
1. Use `Ctrl+Shift+C` and `Ctrl+Shift+V` instead of `Ctrl+C/V`
2. Grant clipboard permissions in browser
3. Try right-click context menu
4. On mobile, use long-press to select text
5. Check browser console for permission errors

**Root Causes**:
- Browser security restrictions
- Clipboard permissions not granted
- Terminal intercepting Ctrl+C

## Preview Panel Issues

### Preview Shows Blank Page

**Symptoms**: Preview iframe is blank or shows white screen.

**Solutions**:
1. Check browser console for errors (in preview iframe context)
2. Verify the dev server is running: `lsof -i :<port>`
3. Check preview URL is correct - use the port dropdown to select active ports
4. If previewing another LAN machine (e.g. `192.168.x.x`), keep that host in the URL.
   It should not be rewritten to `/preview/:port`.
5. Restart the backend server: `~/terminal-v4/restart.sh`
6. Check CORS settings on dev server
7. Verify port is in allowed list (if `UNRESTRICTED_PREVIEW=false`)

**Root Causes**:
- Dev server not running
- Module resolution errors
- CORS blocking iframe
- Port not accessible

### Preview Shows ERR_CONTENT_DECODING_FAILED

**Symptoms**: Browser console shows `ERR_CONTENT_DECODING_FAILED` error.

**Solutions**:
1. Restart the backend server: `~/terminal-v4/restart.sh`
2. Hard refresh the page (`Ctrl+Shift+R`)
3. Clear browser cache

**Root Causes**:
- Content-encoding header mismatch (proxy sending decompressed data with gzip header)
- This was fixed in the proxy by stripping the `content-encoding` header

### Preview Shows Wrong/Old App

**Symptoms**: Preview displays a different app than expected.

**Solutions**:
1. Use the port dropdown (number badge next to URL) to select the correct port
2. Only actively listening ports appear in the dropdown
3. Clear localStorage if URL persists incorrectly:
   `localStorage.removeItem('terminal_preview_url')`
4. Manually enter the correct URL (e.g., `http://localhost:3001`)

**Root Causes**:
- Preview URL persisted from previous session
- Auto-detection picked up a different server's URL
- Port was cached before it started listening

### Preview Module Scripts Return HTML

**Symptoms**: DevTools shows module scripts return `text/html` instead of JS.

**Solutions**:
1. Keep Vite app `base` as `/` in development
2. Don't set `base: '/preview/{port}/'` in dev mode
3. Verify dev server serves correct MIME types
4. Check if server has custom routing that interferes
5. Try path-based preview instead of subdomain

**Root Causes**:
- Incorrect `base` configuration in Vite
- Server routing SPA fallback too aggressively
- Module path rewriting issues

### Preview Console Logs Not Showing

**Symptoms**: Console logs from preview app don't appear in DevTools.

**Solutions**:
1. Verify injected script loaded (check iframe HTML source)
2. Check if Content Security Policy blocks scripts
3. Refresh preview with hard refresh (`Ctrl+Shift+R`)
4. Check backend preview logs endpoint: `/api/preview/:port/logs`
5. Verify preview port is correct

**Root Causes**:
- Injection script blocked by CSP
- Preview port mismatch
- Script injection failed

### Preview Cookies Not Persisting

**Symptoms**: Login sessions don't persist across preview reloads.

**Solutions**:
1. Check cookie jar status: `/api/preview/:port/cookies`
2. Clear cookie jar and try again: `DELETE /api/preview/:port/cookies`
3. Verify cookies are being set (check DevTools → Application → Cookies)
4. Check if cookies have `SameSite=None` and `Secure` for cross-origin

**Root Causes**:
- Cookie storage not working
- SameSite restrictions
- Cookies not sent in iframe context

## Claude Code Issues

### Claude Code Not Starting

**Symptoms**: Claude Code session doesn't start or immediately fails.

**Solutions**:
1. Verify Claude CLI installed: `which claude`
2. Check `CLAUDE_BIN` environment variable
3. Set `ANTHROPIC_API_KEY` environment variable
4. Check backend logs for Claude CLI errors
5. Test Claude CLI manually: `claude --version`

**Root Causes**:
- Claude CLI not installed
- Missing API key
- PATH issues
- Claude CLI version incompatible

### Claude Code Responses Not Streaming

**Symptoms**: Claude responses appear all at once instead of streaming.

**Solutions**:
1. Refresh the page
2. Close and restart Claude Code session
3. Check SSE connection in browser DevTools → Network
4. Verify backend SSE endpoint working: `/api/claude-code/:id/stream`
5. Check for proxy/CDN issues blocking SSE

**Root Causes**:
- SSE connection failed
- Browser buffering responses
- Proxy/CDN blocking streaming

### Claude Code Session Hung

**Symptoms**: Claude Code session appears stuck, not responding to input.

**Solutions**:
1. Stop the session via UI
2. Delete the session and start a new one
3. Check if Claude CLI process hung: `ps aux | grep claude`
4. Kill hung Claude process: `kill <pid>`
5. Restart backend server

**Root Causes**:
- Claude CLI process deadlocked
- PTY communication failure
- Resource exhaustion

## Authentication Issues

### Can't Log In

**Symptoms**: Login fails with error or redirects back to login page.

**Solutions**:
1. Verify username and password are correct
2. Check if `ALLOWED_USERNAME` restricts access
3. Verify user exists in database: `sqlite3 backend/data/terminal.db "SELECT * FROM users;"`
4. Check backend logs for auth errors
5. Clear browser localStorage and cookies
6. Verify JWT secrets are set in production

**Root Causes**:
- Wrong credentials
- User not created
- JWT configuration issues
- Database connection failure

### Session Expires Immediately

**Symptoms**: Logged out right after logging in.

**Solutions**:
1. Check system clock is correct (JWT uses timestamps)
2. Verify `JWT_SECRET` and `REFRESH_SECRET` are consistent across restarts
3. Check refresh token expiration settings
4. Clear browser localStorage
5. Check backend logs for token validation errors

**Root Causes**:
- Clock skew
- Secrets changed between restarts
- Token expiration misconfigured

## File Manager Issues

### Can't Upload Files

**Symptoms**: File upload fails or hangs.

**Solutions**:
1. Check file size is under 100MB limit
2. Verify backend has disk space: `df -h`
3. Check file permissions on target directory
4. Try smaller files first to isolate issue
5. Check backend logs for upload errors

**Root Causes**:
- File too large
- Disk full
- Permission denied
- Network timeout

### Can't Download Files

**Symptoms**: File download fails or returns 404.

**Solutions**:
1. Verify file exists at specified path
2. Check file permissions (backend must be able to read)
3. For directory downloads, verify zip creation works: `zip --version`
4. Check backend logs for errors
5. Try different browser if download repeatedly fails

**Root Causes**:
- File doesn't exist
- Permission denied
- Zip command failed
- Path traversal blocked

## Mobile Issues

### Keyboard Won't Show

**Symptoms**: Tapping terminal doesn't show mobile keyboard.

**Solutions**:
1. Enable mobile keybar in settings
2. Tap directly on terminal input area
3. Use "Show Keyboard" button if available
4. Try landscape orientation
5. Check iOS/Android keyboard settings

**Root Causes**:
- Focus not captured correctly
- Browser keyboard behavior
- Input element not visible

### Mobile Keybar Missing Keys

**Symptoms**: Some keys unavailable in mobile keybar.

**Solutions**:
1. Use Fn dropdown for function keys (F1-F12)
2. Use Ctrl/Alt/Shift sticky modifiers
3. Tap and hold for alternative keys
4. Use voice input for complex commands
5. Connect external keyboard if available

**Root Causes**:
- Space constraints on mobile screen
- Key combinations require modifiers

### Mobile UI Overlapping

**Symptoms**: UI elements overlap or are cut off on mobile.

**Solutions**:
1. Rotate to landscape orientation
2. Zoom out in browser
3. Refresh page to reset layout
4. Try different mobile browser
5. Report specific device/browser combination

**Root Causes**:
- Viewport calculation issues
- Browser chrome interference
- Device-specific quirks

## Performance Issues

### High CPU Usage

**Symptoms**: Browser or backend using excessive CPU.

**Solutions**:
1. Close unused terminal sessions
2. Enable WebGL renderer for terminals
3. Reduce terminal font size
4. Clear terminal history
5. Check for runaway processes in terminals
6. Monitor system stats in UI

**Root Causes**:
- Too many active terminals
- Heavy terminal rendering
- Runaway background processes
- Memory leaks

### High Memory Usage

**Symptoms**: Browser or backend consuming excessive RAM.

**Solutions**:
1. Close unused sessions
2. Clear terminal history buffers
3. Restart backend server periodically
4. Reduce number of concurrent Claude Code sessions
5. Check for memory leaks in browser DevTools

**Root Causes**:
- Large terminal buffers
- Memory leaks
- Too many sessions
- Large file operations

### Slow Terminal Output

**Symptoms**: Terminal output renders slowly or stutters.

**Solutions**:
1. Enable WebGL rendering
2. Reduce output verbosity (e.g., `--quiet` flags)
3. Pipe large output to files instead of terminal
4. Use pagination for long output: `less`, `more`
5. Reduce terminal scrollback buffer size

**Root Causes**:
- Too much output too fast
- CPU-intensive rendering
- Large scrollback buffer

## Network Issues

### WebSocket Connection Fails

**Symptoms**: Terminal can't connect to backend WebSocket.

**Solutions**:
1. Check backend is running: `curl http://localhost:3020/api/health`
2. Verify firewall allows WebSocket connections
3. Check Cloudflare/proxy WebSocket settings
4. Try direct IP instead of hostname
5. Check backend logs for connection errors

**Root Causes**:
- Backend not running
- Firewall blocking WebSocket
- Proxy misconfiguration
- CORS issues

### High Latency

**Symptoms**: Terminal input/output has noticeable delay.

**Solutions**:
1. Use WebSocket latency test: `/api/latency/ws`
2. Check network connection quality
3. Try different network (WiFi vs cellular)
4. Check system resource usage
5. Verify backend server isn't overloaded

**Root Causes**:
- Network congestion
- High backend load
- Geographic distance
- Resource constraints

## Build & Deployment Issues

### Build Fails

**Symptoms**: `npm run build` fails with errors.

**Solutions**:
1. Delete `node_modules` and reinstall: `rm -rf node_modules && npm install`
2. Clear build caches: `rm -rf frontend/dist backend/dist`
3. Check Node.js version: `node --version` (need 18+)
4. Verify no TypeScript errors: `npm run build` in backend
5. Check for disk space: `df -h`

**Root Causes**:
- Dependency issues
- TypeScript errors
- Disk space
- Node version mismatch

### Production Server Won't Start

**Symptoms**: Backend fails to start in production.

**Solutions**:
1. Check environment variables are set (JWT secrets, etc.)
2. Verify data directory permissions: `ls -la backend/data`
3. Check port 3020 isn't already in use: `lsof -i :3020`
4. Review backend logs (foreground console, `journalctl -u terminal-v4 -f`, or `/tmp/backend.log` if started with `nohup ... > /tmp/backend.log`)
5. Verify frontend is built: `ls frontend/dist`

**Root Causes**:
- Missing environment variables
- Port conflict
- Permission issues
- Missing build artifacts

### Tmux Sessions Not Persisting

**Symptoms**: Terminal sessions lost after server restart.

**Solutions**:
1. Verify tmux is installed: `which tmux`
2. Check systemd service uses `KillMode=process`
3. Verify `TERMINAL_DATA_DIR` is set consistently
4. Check tmux server is running: `tmux ls`
5. Review tmux configuration

**Root Causes**:
- Systemd killing child processes
- Tmux not installed
- Data directory changed
- Tmux server stopped

## Browser Compatibility

### Recommended Browsers
- Chrome/Chromium 90+ (best performance)
- Firefox 88+
- Safari 14+ (limited WebSocket support)
- Edge 90+

### Known Issues
- Safari: Some WebSocket reconnection issues
- Firefox: WebGL rendering may have artifacts
- Mobile browsers: Keyboard handling varies by platform

## Getting Help

If you can't resolve an issue:

1. Check backend logs (foreground console, `journalctl -u terminal-v4 -f`, or `/tmp/backend.log` if started with `nohup ... > /tmp/backend.log`)
2. Check browser console for errors (F12)
3. Check system resources: `/api/system/stats`
4. Gather reproduction steps
5. Note your environment:
   - OS and version
   - Node.js version
   - Browser and version
   - Terminal v4 version (git commit hash)
6. Report issue with details

## Debugging Tips

1. **Enable Debug Logging**: Set `LOG_LEVEL=debug` in backend
2. **Browser DevTools**: Use Network tab to monitor API calls
3. **WebSocket Inspector**: Check WebSocket frames in DevTools
4. **Terminal Buffer**: Use reader view to inspect terminal output
5. **Process List**: Check `/api/system/stats` for resource-heavy processes
