# Quick Start Guide

Get up and running with Terminal v4 in minutes!

## Initial Setup

### 1. Install Dependencies

```bash
# Backend dependencies
cd backend
npm install

# Frontend dependencies
cd ../frontend
npm install
```

### 2. Configure Environment

Create `backend/.env`:

```bash
# Required for production
JWT_SECRET=your-random-secret-here
REFRESH_SECRET=your-random-refresh-secret
ALLOWED_USERNAME=yourusername

# Optional
PORT=3020
ANTHROPIC_API_KEY=your-api-key
GROQ_API_KEY=your-groq-key
TERMINAL_DATA_DIR=/path/to/data
```

### 3. Create User Account

Temporarily enable registration or seed a user directly in the database.

### 4. Start Development Servers

```bash
# Terminal 1: Backend
cd backend
npm run dev

# Terminal 2: Frontend
cd frontend
npm run dev
```

Access at `http://localhost:5173`

## Essential Features in 5 Minutes

### Creating Your First Terminal

1. Click **"New"** button in sidebar (or press `Ctrl+Alt+N`)
2. Select working directory (optional)
3. Start typing commands!

**Tips**:
- Use `Ctrl+Shift+C/V` to copy/paste
- Click tab to switch between terminals
- Right-click tab to rename or close

### Using Claude Code

1. Click **"Claude"** in left panel (or press `Ctrl+Alt+C`)
2. Click **"New Claude Code Session"**
3. Type your question or request
4. Claude streams responses in real-time

**Example prompts**:
```
Help me write a function to parse JSON logs
Review my React component for best practices
Debug why my API endpoint is returning 500
```

### Previewing Your App

1. Start your dev server in a terminal (e.g., `npm run dev`)
2. Terminal v4 automatically detects the URL
3. Click the preview icon or URL in terminal output
4. Preview panel opens with your app

**DevTools**:
- Click **Console** tab to see logs
- Click **Network** tab to monitor requests
- Click **Storage** tab to inspect localStorage
- Use **Hard Refresh** button to clear cache

### Managing Files

1. Click **Files** icon in sidebar (or press `Ctrl+Alt+F`)
2. Navigate folders with breadcrumb
3. Upload files by dragging into window
4. Download, rename, or delete files

**Quick actions**:
- Upload multiple files at once
- Download entire folder as ZIP
- Unzip archives in place
- Pin frequently-used folders

### Saving Commands with Bookmarks

1. Click **Bookmarks** in sidebar (or press `Ctrl+Alt+B`)
2. Click **"Add Bookmark"**
3. Enter command and optional working directory
4. Click saved bookmark to run command

**Example bookmarks**:
```
npm start
git status
docker-compose up
python manage.py runserver
```

## Mobile Setup

### Accessing on Mobile

1. Find your server IP: `hostname -I` (Linux) or `ifconfig` (Mac)
2. On mobile browser, visit `http://<server-ip>:5173`
3. Login with your credentials
4. Enable mobile keybar in settings

### Mobile Tips

- **Swipe left/right** between terminal sessions
- **Long press** tab for context menu
- **Use keybar** for Esc, Tab, Ctrl, arrows
- **Enable voice input** for long commands
- Try **landscape mode** for more space

## Advanced Features

### Split Pane Terminals

1. Click **Split** button on terminal pane
2. Choose horizontal or vertical split
3. Each pane has independent session
4. Drag divider to resize

**Shortcuts**:
- `Ctrl+Alt+V` - split vertically
- `Ctrl+Alt+H` - split horizontally
- `Ctrl+Alt+Enter` - fullscreen current pane

### System Monitoring

1. Click **Stats** icon in header
2. View real-time CPU, RAM, disk I/O
3. See top processes with ports
4. Switch time ranges for historical data

### Voice Input

1. Click **Settings** → **API Settings**
2. Add your Groq API key
3. Click microphone icon in terminal
4. Speak your command
5. Transcription appears in terminal

### Process Management

1. Click **Processes** in sidebar
2. See running dev servers by port
3. Start/stop project processes
4. View process logs

### Taking Screenshots

1. With preview panel open, click **Screenshot** icon
2. Choose full page or specific element
3. Screenshots saved to gallery
4. Click **Gallery** to view all screenshots

### Notes for Projects

1. Click **Notes** in sidebar (or press `Ctrl+Alt+T`)
2. Add notes about your project
3. Notes support markdown
4. Search notes by content

## Keyboard Shortcuts Cheat Sheet

| Shortcut | Action |
| --- | --- |
| `Ctrl+Alt+N` | New terminal |
| `Ctrl+Alt+C` | Toggle Claude Code |
| `Ctrl+Alt+P` | Toggle preview |
| `Ctrl+Alt+F` | File manager |
| `Ctrl+Alt+B` | Bookmarks |
| `Ctrl+Alt+S` | Settings |
| `Ctrl+Alt+1-9` | Switch to session 1-9 |
| `Ctrl+Shift+C/V` | Copy/paste in terminal |
| `Ctrl+Shift+F` | Search terminal output |

See [KEYBOARD_SHORTCUTS.md](KEYBOARD_SHORTCUTS.md) for complete list.

## Common Tasks

### Deploying to Production

```bash
# Build frontend
cd frontend
npm run build

# Build backend
cd ../backend
npm run build

# Start production server
npm start
```

Server runs on port 3020, serving both API and frontend.

### Setting Up Cloudflare Tunnel

```bash
# Install cloudflared
# Configure tunnel to point to localhost:3020
cloudflared tunnel route dns <tunnel-name> yourdomain.com
```

### Enabling Tmux Persistence

1. Install tmux: `sudo apt install tmux`
2. Set `KillMode=process` in systemd service
3. Restart service: `sudo systemctl restart terminal-v4`

Terminal sessions persist across backend restarts.

### Customizing Theme

1. Click **Settings** → **Style Editor**
2. Adjust colors for terminal, header, sidebar
3. Changes save automatically
4. Reset to defaults if needed

## Troubleshooting Quick Fixes

| Problem | Quick Fix |
| --- | --- |
| Terminal not responding | Refresh browser (`Ctrl+F5`) |
| ANSI codes visible | Clear Vite cache and rebuild |
| Preview blank | Verify dev server running on correct port |
| Can't login | Check `ALLOWED_USERNAME` env var |
| High CPU | Close unused terminal sessions, enable WebGL |
| WebSocket fails | Check firewall, verify backend running |
| Mobile keyboard hidden | Enable mobile keybar in settings |

See [COMMON_ISSUES.md](troubleshooting/COMMON_ISSUES.md) for detailed troubleshooting.

## Next Steps

1. **Read the docs**: Check out [FEATURES.md](FEATURES.md) for complete feature list
2. **Learn shortcuts**: Review [KEYBOARD_SHORTCUTS.md](KEYBOARD_SHORTCUTS.md)
3. **Explore DevTools**: Try the preview panel's debugging tools
4. **Customize**: Adjust settings, themes, and shortcuts to your preference
5. **Integrate Claude Code**: Use AI assistance for your development workflow

## Getting Help

- Check [COMMON_ISSUES.md](troubleshooting/COMMON_ISSUES.md) for solutions
- Review [SYSTEM_ARCHITECTURE.md](architecture/SYSTEM_ARCHITECTURE.md) for technical details
- Check backend logs: `tail -f /tmp/backend.log`
- Open browser DevTools (F12) for client-side errors

## Tips for Power Users

1. **Use bookmarks** for repetitive commands
2. **Split panes** to monitor multiple terminals
3. **Pin folders** you use frequently
4. **Enable WebGL** rendering for better performance
5. **Use keyboard shortcuts** for faster navigation
6. **Try voice input** for long commands
7. **Leverage Claude Code** for coding assistance
8. **Monitor system stats** to catch issues early
9. **Use reader view** for terminal output review
10. **Set up tmux** for session persistence

Happy coding! 🚀
