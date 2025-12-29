# Terminal v4 - Web-Based Terminal

A browser-based terminal emulator that provides remote access to your system's command line (cmd/PowerShell/bash) through a web interface. Built with full PTY (pseudo-terminal) support for interactive programs like `claude`, `python`, `vim`, and more.

## Features

- 🖥️ **Full PTY Support** - Run interactive programs (Claude CLI, Python REPL, vim, etc.)
- 🎨 **xterm.js Terminal** - Proper ANSI color rendering and terminal emulation
- 🔄 **Multiple Sessions** - Create and manage multiple terminal sessions simultaneously
- ❌ **Close Terminals** - Terminate any terminal session with × button
- ⚙️ **Configurable Working Directory** - Set default starting directory for new terminals
- 🌐 **Remote Access** - Access your terminal from any browser on your network
- ⚡ **Real-time Streaming** - WebSocket stream for instant terminal output
- 📱 **Responsive UI** - Works on desktop and mobile browsers

## Requirements

- Node.js 22+ (for node-pty compatibility)
- Windows (PowerShell/cmd), macOS, or Linux

## Quick Start

1. **Install dependencies:**
   ```bash
   cd backend && npm install
   cd ../frontend && npm install
   ```

2. **Start the backend:**
   ```bash
   cd backend
   npm run dev
   ```
   Backend runs on `http://localhost:3020`

3. **Start the frontend:**
   ```bash
   cd frontend
   npm run dev
   ```
   Frontend runs on `http://localhost:5173`

4. **Open your browser:**
   - Local: `http://localhost:5173`
   - Network: `http://<your-ip>:5173`

5. **Click "New"** to create a terminal session and start typing commands!

## Project Structure

```
terminal-v4/
├── backend/              # Fastify server with PTY support
│   ├── src/
│   │   ├── index.ts      # Main server entry point
│   │   ├── terminal/     # Terminal manager with PTY
│   │   └── routes/       # API route handlers & schemas
│   ├── test/             # Vitest test suite
│   └── package.json
├── frontend/             # React + Vite frontend
│   ├── src/
│   │   ├── App.jsx       # Main app with session sidebar & settings
│   │   ├── styles.css    # Application styles
│   │   └── components/
│   │       └── TerminalChat.jsx  # xterm.js integration
│   └── package.json
└── docs/
    ├── architecture/     # System architecture docs
    └── development/      # Setup and testing guides
```

## API Endpoints

### Terminal Management
- `POST /api/terminal` - Create new terminal session (accepts `cwd` for working directory)
- `GET /api/terminal` - List all terminal sessions
- `GET /api/terminal/:id/history` - Get terminal output history
- `GET /api/terminal/:id/ws` - WebSocket stream for real-time input/output
- `POST /api/terminal/:id/input` - Send input to terminal
- `DELETE /api/terminal/:id` - Close/terminate terminal session

### Health Check
- `GET /api/health` - Server health status

## Configuration

### Backend Environment Variables

- `PORT` - Backend server port (default: `3020`)
- `HOST` - Server host (default: `0.0.0.0`)
- `LOG_LEVEL` - Logging level (default: `info`)
- `TERMINAL_DATA_DIR` - Override backend data directory (default: `backend/data`)

### Default Shell

The terminal automatically detects your system's default shell:
- **Windows**: `cmd.exe` or `PowerShell`
- **macOS/Linux**: `$SHELL` or `/bin/bash`

## Usage Examples

### Basic Commands
```bash
dir                    # List files (Windows)
ls                     # List files (Unix)
cd path/to/folder     # Change directory
python                # Start Python REPL
node                  # Start Node.js REPL
```

### Interactive Programs
```bash
claude                # Start Claude CLI interactive mode
vim file.txt          # Edit files with vim
python script.py      # Run Python scripts
npm install           # Install packages
git status            # Git operations
```

## Architecture Highlights

- **Backend**: Fastify + TypeScript for high-performance async I/O
- **PTY**: `@homebridge/node-pty-prebuilt-multiarch` for true terminal emulation
- **Frontend**: React + xterm.js for professional terminal UI
- **Communication**: WebSocket for real-time streaming
- **Session Management**: In-memory store with multi-session support

## Security Considerations

⚠️ **Local Development Only** - This app is designed for local/trusted network use:

- No authentication (anyone on network can access)
- No command whitelisting (full shell access)
- No rate limiting
- Sessions stored in memory only

**For production deployment**, you must add:
- User authentication (JWT/session tokens)
- Command filtering/sandboxing
- HTTPS/TLS encryption
- CORS restrictions
- Rate limiting

See `docs/architecture/SYSTEM_ARCHITECTURE.md` for detailed security recommendations.

## Documentation

- 📖 [System Architecture](docs/architecture/SYSTEM_ARCHITECTURE.md) - Complete system design
- 🛠️ [Development Setup](docs/development/SETUP.md) - Local development guide
- 🧪 [Testing Guide](docs/development/TESTING_GUIDE.md) - Running and writing tests
- 📋 [CLAUDE.md](CLAUDE.md) - Universal best practices guide

## Testing

Run the test suite:
```bash
cd backend
npm test              # Run all tests
npm run test:watch   # Watch mode
```

## Troubleshooting

### Terminal not responding
- Refresh browser and create a new terminal session
- Check backend logs for errors
- Ensure PTY dependencies installed correctly

### ANSI codes showing as text
- Hard refresh browser (`Ctrl+F5`)
- Check xterm.js dependencies loaded
- Clear Vite cache: `rm -rf frontend/node_modules/.vite`

### Node.js version issues
- Requires Node.js 22+ for node-pty compatibility
- Use `nvm` to switch Node versions if needed

## Contributing

1. Follow Conventional Commits format for commit messages
2. Run tests before committing: `npm test`
3. Update documentation for significant changes
4. See `CLAUDE.md` for coding standards

## License

MIT

## Acknowledgments

- Built with [xterm.js](https://xtermjs.org/) for terminal emulation
- Uses [node-pty](https://github.com/microsoft/node-pty) for PTY support
- Powered by [Fastify](https://www.fastify.io/) and [React](https://reactjs.org/)
