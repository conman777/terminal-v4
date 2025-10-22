const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { randomUUID } = require('crypto');

const DEFAULT_COLS = 140;
const DEFAULT_ROWS = 40;

function resolveShell() {
  if (process.platform === 'win32') {
    return process.env.ComSpec || 'powershell.exe';
  }
  return process.env.SHELL || '/bin/bash';
}

class TerminalManager {
  constructor() {
    this.sessions = new Map();
  }

  createSession(options = {}) {
    const id = options.id || randomUUID();
    const shell = resolveShell();
    const cols = options.cols || DEFAULT_COLS;
    const rows = options.rows || DEFAULT_ROWS;

    // For Windows PowerShell/CMD, use different args
    let shellArgs = [];
    let shellProcess;

    // Use appropriate spawn arguments for different shells
    if (process.platform === 'win32') {
      // Windows: use powershell with NoExit to keep the process running
      shellArgs = ['-NoExit', '-Command', ''];
      shellProcess = spawn(shell, shellArgs, {
        cwd: options.cwd || process.cwd(),
        env: { ...process.env, ...options.env },
        stdio: ['pipe', 'pipe', 'pipe']
      });
    } else {
      // Unix: use bash/sh
      shellProcess = spawn(shell, ['-i'], {
        cwd: options.cwd || process.cwd(),
        env: { ...process.env, ...options.env },
        stdio: ['pipe', 'pipe', 'pipe']
      });
    }

    const session = {
      id,
      shell,
      createdAt: new Date().toISOString(),
      process: shellProcess,
      buffer: [],
      subscribers: new Set()
    };

    shellProcess.stdout.on('data', (chunk) => {
      const text = chunk.toString();
      console.log(`[Terminal ${id}] stdout:`, text);
      session.buffer.push({ type: 'terminal', text, ts: Date.now() });
      for (const subscriber of session.subscribers) {
        subscriber(text);
      }
    });

    shellProcess.stderr.on('data', (chunk) => {
      const text = chunk.toString();
      console.log(`[Terminal ${id}] stderr:`, text);
      session.buffer.push({ type: 'terminal', text, ts: Date.now() });
      for (const subscriber of session.subscribers) {
        subscriber(text);
      }
    });

    shellProcess.on('error', (err) => {
      console.error(`[Terminal ${id}] Process error:`, err);
      const errorText = `\n[Process Error] ${err.message}\n`;
      session.buffer.push({ type: 'terminal', text: errorText, ts: Date.now() });
      for (const subscriber of session.subscribers) {
        subscriber(errorText);
      }
    });

    shellProcess.on('exit', (code) => {
      console.log(`[Terminal ${id}] Process exited with code ${code}`);
      for (const subscriber of session.subscribers) {
        subscriber(null); // signal end of stream
      }
      this.sessions.delete(id);
    });

    console.log(`[Terminal ${id}] Created shell: ${shell} with args:`, shellArgs);
    this.sessions.set(id, session);
    return session;
  }

  getSession(id) {
    return this.sessions.get(id);
  }

  listSessions() {
    return Array.from(this.sessions.values()).map(({ id, shell, createdAt, buffer }) => ({
      id,
      shell,
      createdAt,
      history: buffer
    }));
  }

  subscribe(id, handler) {
    const session = this.sessions.get(id);
    if (!session) {
      throw new Error(`Session ${id} not found`);
    }
    session.subscribers.add(handler);
    return () => session.subscribers.delete(handler);
  }

  write(id, data) {
    const session = this.sessions.get(id);
    if (!session) {
      throw new Error(`Session ${id} not found`);
    }
    session.process.stdin.write(data);
  }
}

module.exports = { TerminalManager };
