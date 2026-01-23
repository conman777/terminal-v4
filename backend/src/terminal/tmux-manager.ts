import { execFileSync, spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import type { TerminalProcess, TerminalSpawnOptions } from './terminal-types';

const TMUX_SESSION_PREFIX = 'terminal-app-';
const TMUX_HISTORY_LIMIT = Number(process.env.TMUX_HISTORY_LIMIT || '100000');

function applyHistoryLimit(sessionName: string): void {
  if (!Number.isFinite(TMUX_HISTORY_LIMIT) || TMUX_HISTORY_LIMIT <= 0) {
    return;
  }
  try {
    execFileSync('tmux', ['set-option', '-t', sessionName, 'history-limit', String(TMUX_HISTORY_LIMIT)], {
      stdio: ['ignore', 'pipe', 'ignore']
    });
  } catch {
    // Ignore failures (tmux might not be running or session might be gone)
  }
}

/**
 * Check if tmux is available on the system
 */
export function isTmuxAvailable(): boolean {
  if (process.platform === 'win32') {
    // tmux doesn't run natively on Windows
    return false;
  }

  try {
    execFileSync('which', ['tmux'], { stdio: ['ignore', 'pipe', 'ignore'] });
    return true;
  } catch {
    return false;
  }
}

/**
 * Get the tmux session name for a terminal session ID
 */
export function getTmuxSessionName(sessionId: string): string {
  return `${TMUX_SESSION_PREFIX}${sessionId}`;
}

/**
 * Check if a tmux session exists
 */
export function tmuxSessionExists(sessionId: string): boolean {
  const sessionName = getTmuxSessionName(sessionId);
  try {
    execFileSync('tmux', ['has-session', '-t', sessionName], {
      stdio: ['ignore', 'pipe', 'ignore']
    });
    return true;
  } catch (error) {
    // Exit code 1 means session doesn't exist (normal), other errors are unexpected
    if (error instanceof Error && 'status' in error && (error as any).status !== 1) {
      console.warn(`[tmux] Unexpected error checking session ${sessionId}:`, error);
    }
    return false;
  }
}

/**
 * List all terminal app tmux sessions
 */
export function listTmuxSessions(): string[] {
  try {
    const output = execFileSync('tmux', ['list-sessions', '-F', '#{session_name}'], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe']
    });
    return output
      .split('\n')
      .filter(name => name.startsWith(TMUX_SESSION_PREFIX))
      .map(name => name.replace(TMUX_SESSION_PREFIX, ''));
  } catch (error) {
    // Exit code 1 with "no server running" is normal when no tmux sessions exist
    const stderr = error instanceof Error && 'stderr' in error ? (error as any).stderr : '';
    if (!stderr?.toString().includes('no server running')) {
      console.warn('[tmux] Error listing sessions:', error);
    }
    return [];
  }
}

/**
 * Kill a tmux session
 */
export function killTmuxSession(sessionId: string): boolean {
  const sessionName = getTmuxSessionName(sessionId);
  try {
    execFileSync('tmux', ['kill-session', '-t', sessionName], {
      stdio: ['ignore', 'pipe', 'ignore']
    });
    return true;
  } catch (error) {
    console.warn(`[tmux] Failed to kill session ${sessionId}:`, error);
    return false;
  }
}

/**
 * Create a new tmux session or attach to existing one
 * Returns a TerminalProcess that communicates with the tmux session
 */
export function spawnTmuxSession(options: TerminalSpawnOptions & { sessionId: string }): TerminalProcess {
  const emitter = new EventEmitter() as TerminalProcess;
  const sessionName = getTmuxSessionName(options.sessionId);
  const sessionExists = tmuxSessionExists(options.sessionId);

  let ptyProcess: ReturnType<typeof spawn>;

  if (sessionExists) {
    // Attach to existing tmux session
    console.log(`[tmux] Reattaching to existing session: ${sessionName}`);
    applyHistoryLimit(sessionName);
    ptyProcess = spawn('tmux', [
      'attach-session',
      '-t', sessionName
    ], {
      cwd: options.cwd || process.cwd(),
      env: { ...process.env, ...options.env, TERM: 'xterm-256color' } as NodeJS.ProcessEnv,
      stdio: ['pipe', 'pipe', 'pipe']
    });
  } else {
    // Create new tmux session with the shell
    console.log(`[tmux] Creating new session: ${sessionName} with shell: ${options.shell}`);

    // First create the detached session
    try {
      execFileSync('tmux', [
        'new-session',
        '-d',
        '-s',
        sessionName,
        '-x',
        String(options.cols),
        '-y',
        String(options.rows),
        options.shell
      ], {
        cwd: options.cwd || process.cwd(),
        env: { ...process.env, ...options.env, TERM: 'xterm-256color' } as NodeJS.ProcessEnv,
        stdio: 'pipe'
      });
    } catch (error) {
      console.error(`[tmux] Failed to create session:`, error);
      throw error;
    }

    applyHistoryLimit(sessionName);

    // Then attach to it
    ptyProcess = spawn('tmux', [
      'attach-session',
      '-t', sessionName
    ], {
      cwd: options.cwd || process.cwd(),
      env: { ...process.env, ...options.env, TERM: 'xterm-256color' } as NodeJS.ProcessEnv,
      stdio: ['pipe', 'pipe', 'pipe']
    });
  }

  // Handle stdout
  ptyProcess.stdout?.on('data', (data: Buffer) => {
    emitter.emit('data', data.toString());
  });

  // Handle stderr (merge with stdout for terminal)
  ptyProcess.stderr?.on('data', (data: Buffer) => {
    emitter.emit('data', data.toString());
  });

  // Handle exit
  ptyProcess.on('exit', (code, signal) => {
    emitter.emit('exit', code, signal);
  });

  ptyProcess.on('error', (error) => {
    console.error(`[tmux] Process error:`, error);
    emitter.emit('exit', 1, null);
  });

  // Write method
  emitter.write = (data: string) => {
    if (ptyProcess.stdin?.writable) {
      ptyProcess.stdin.write(data);
    }
  };

  // Resize method - use tmux resize
  emitter.resize = (cols: number, rows: number) => {
    try {
      execFileSync('tmux', ['resize-window', '-t', sessionName, '-x', String(cols), '-y', String(rows)], {
        stdio: ['ignore', 'pipe', 'ignore']
      });
    } catch {
      // Ignore resize errors
    }
  };

  // Kill method - just detach, don't kill the tmux session
  emitter.kill = (signal?: NodeJS.Signals | number) => {
    // Detach from tmux (the session continues running)
    if (ptyProcess.stdin?.writable) {
      // Send tmux detach command
      ptyProcess.stdin.write('\x02d'); // Ctrl+B, d (tmux prefix + detach)
    }
    // Also kill the attach process
    ptyProcess.kill(signal as NodeJS.Signals);
  };

  return emitter;
}

/**
 * Spawn a PTY-based tmux session using node-pty for better terminal emulation
 */
export function spawnTmuxWithPty(
  ptySpawn: (shell: string, args: string[], options: any) => any,
  options: TerminalSpawnOptions & { sessionId: string }
): TerminalProcess {
  const emitter = new EventEmitter() as TerminalProcess;
  const sessionName = getTmuxSessionName(options.sessionId);
  const sessionExists = tmuxSessionExists(options.sessionId);

  if (!sessionExists) {
    // Create new detached tmux session with the specified shell
    console.log(`[tmux] Creating new session: ${sessionName} with shell: ${options.shell}`);
    try {
      execFileSync('tmux', [
        'new-session',
        '-d',
        '-s',
        sessionName,
        '-x',
        String(options.cols),
        '-y',
        String(options.rows),
        options.shell
      ], {
        cwd: options.cwd || process.cwd(),
        env: { ...process.env, ...options.env, TERM: 'xterm-256color' } as NodeJS.ProcessEnv,
        stdio: 'pipe'
      });
    } catch (error) {
      console.error(`[tmux] Failed to create session:`, error);
      throw error;
    }
  } else {
    console.log(`[tmux] Reattaching to existing session: ${sessionName}`);
  }

  applyHistoryLimit(sessionName);

  // Use node-pty to attach to the tmux session
  const ptyProcess = ptySpawn('tmux', ['attach-session', '-t', sessionName], {
    name: 'xterm-256color',
    cols: options.cols,
    rows: options.rows,
    cwd: options.cwd || process.cwd(),
    env: { ...process.env, ...options.env } as Record<string, string>
  });

  ptyProcess.onData((data: string) => {
    emitter.emit('data', data);
  });

  ptyProcess.onExit(({ exitCode, signal }: { exitCode: number; signal?: number }) => {
    // When tmux attach exits, it could be a detach - session may still be running
    emitter.emit('exit', exitCode, signal ?? null);
  });

  emitter.write = (data: string) => {
    ptyProcess.write(data);
  };

  emitter.resize = (cols: number, rows: number) => {
    ptyProcess.resize(cols, rows);
    // Also resize the tmux window
    try {
      execFileSync('tmux', ['resize-window', '-t', sessionName, '-x', String(cols), '-y', String(rows)], {
        stdio: ['ignore', 'pipe', 'ignore']
      });
    } catch {
      // Ignore
    }
  };

  emitter.kill = (signal?: NodeJS.Signals | number) => {
    // When killing, we detach from tmux but don't kill the session
    // The session continues running in the background
    ptyProcess.kill(signal as string);
  };

  return emitter;
}

/**
 * Force kill a tmux session (for when user explicitly closes terminal)
 */
export function destroyTmuxSession(sessionId: string): void {
  killTmuxSession(sessionId);
}

/**
 * Get the working directory of a tmux session
 */
export function getTmuxSessionCwd(sessionId: string): string | null {
  const sessionName = getTmuxSessionName(sessionId);
  try {
    const output = execFileSync('tmux', ['display-message', '-t', sessionName, '-p', '#{pane_current_path}'], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe']
    });
    return output.trim() || null;
  } catch {
    return null;
  }
}
