import { execSync, spawn, ChildProcess } from 'child_process';
import { existsSync, readlinkSync, readFileSync } from 'fs';
import { join, basename } from 'path';
import {
  registerProcess,
  addProcessLog,
  associatePort,
  markProcessExited
} from '../preview/process-log-store.js';

export interface PortInfo {
  port: number;
  pid: number;
  command: string;
}

export interface ProcessInfo {
  pid: number;
  port: number;
  command: string;
}

export interface RepoStatus {
  path: string;
  name: string;
  projectType: 'node' | 'python' | 'unknown';
  running: boolean;
  processes: ProcessInfo[];
}

/**
 * Get all TCP ports currently listening, with their PIDs and commands
 */
export function getListeningPorts(): PortInfo[] {
  try {
    // Use ss to get listening TCP ports with process info
    // -t = TCP, -l = listening, -n = numeric, -p = show process
    const output = execSync('ss -tlnp 2>/dev/null', { encoding: 'utf-8' });
    const lines = output.trim().split('\n').slice(1); // Skip header

    const ports: PortInfo[] = [];

    for (const line of lines) {
      // Parse ss output: State Recv-Q Send-Q Local Address:Port Peer Address:Port Process
      // Example: LISTEN 0 511 *:3020 *:* users:(("node",pid=12345,fd=19))
      const parts = line.split(/\s+/);
      if (parts.length < 5) continue;

      // Extract port from local address (format: *:PORT or 0.0.0.0:PORT or [::]:PORT)
      const localAddr = parts[3];
      const portMatch = localAddr.match(/:(\d+)$/);
      if (!portMatch) continue;
      const port = parseInt(portMatch[1], 10);

      // Extract PID from process info
      const processInfo = parts.slice(5).join(' ');
      const pidMatch = processInfo.match(/pid=(\d+)/);
      if (!pidMatch) continue;
      const pid = parseInt(pidMatch[1], 10);

      // Validate PID is a positive integer
      if (isNaN(pid) || pid <= 0) continue;

      // Get command name from /proc/{pid}/comm
      let command = 'unknown';
      try {
        command = readFileSync(`/proc/${pid}/comm`, 'utf-8').trim();
      } catch {
        // Process may have exited - safe to ignore
      }

      ports.push({ port, pid, command });
    }

    return ports;
  } catch {
    return [];
  }
}

/**
 * Get the working directory of a process
 */
function getProcessCwd(pid: number): string | null {
  try {
    return readlinkSync(`/proc/${pid}/cwd`);
  } catch {
    return null;
  }
}

/**
 * Detect project type from directory contents
 */
function detectProjectType(repoPath: string): 'node' | 'python' | 'unknown' {
  if (existsSync(join(repoPath, 'package.json'))) {
    return 'node';
  }
  if (
    existsSync(join(repoPath, 'requirements.txt')) ||
    existsSync(join(repoPath, 'setup.py')) ||
    existsSync(join(repoPath, 'pyproject.toml'))
  ) {
    return 'python';
  }
  return 'unknown';
}

/**
 * Check if a path is within a repo directory
 */
function isPathInRepo(processPath: string, repoPath: string): boolean {
  const normalizedProcess = processPath.replace(/\/$/, '');
  const normalizedRepo = repoPath.replace(/\/$/, '');
  return normalizedProcess === normalizedRepo || normalizedProcess.startsWith(normalizedRepo + '/');
}

/**
 * Get status of all repos with their running processes
 */
export function getRepoProcesses(repoPaths: string[]): RepoStatus[] {
  const listeningPorts = getListeningPorts();

  // Build a map of PID -> port info
  const pidToPort = new Map<number, PortInfo>();
  for (const portInfo of listeningPorts) {
    pidToPort.set(portInfo.pid, portInfo);
  }

  // Get unique PIDs and their working directories
  const pidCwds = new Map<number, string>();
  for (const portInfo of listeningPorts) {
    const cwd = getProcessCwd(portInfo.pid);
    if (cwd) {
      pidCwds.set(portInfo.pid, cwd);
    }
  }

  const results: RepoStatus[] = [];

  for (const repoPath of repoPaths) {
    const projectType = detectProjectType(repoPath);
    const processes: ProcessInfo[] = [];

    // Find processes running from this repo
    for (const [pid, cwd] of pidCwds) {
      if (isPathInRepo(cwd, repoPath)) {
        const portInfo = pidToPort.get(pid);
        if (portInfo) {
          processes.push({
            pid: portInfo.pid,
            port: portInfo.port,
            command: portInfo.command,
          });
        }
      }
    }

    results.push({
      path: repoPath,
      name: basename(repoPath),
      projectType,
      running: processes.length > 0,
      processes,
    });
  }

  return results;
}

/**
 * Get the appropriate start command for a repo
 */
function getStartCommand(repoPath: string, projectType: 'node' | 'python' | 'unknown'): { cmd: string; args: string[] } | null {
  if (projectType === 'node') {
    // Check package.json for start script
    try {
      const pkgPath = join(repoPath, 'package.json');
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
      if (pkg.scripts?.start) {
        return { cmd: 'npm', args: ['start'] };
      }
      if (pkg.scripts?.dev) {
        return { cmd: 'npm', args: ['run', 'dev'] };
      }
    } catch {
      // No package.json or invalid
    }
    return { cmd: 'npm', args: ['start'] };
  }

  if (projectType === 'python') {
    // Check for common Python entry points
    if (existsSync(join(repoPath, 'manage.py'))) {
      return { cmd: 'python', args: ['manage.py', 'runserver'] };
    }
    if (existsSync(join(repoPath, 'app.py'))) {
      return { cmd: 'python', args: ['app.py'] };
    }
    if (existsSync(join(repoPath, 'main.py'))) {
      return { cmd: 'python', args: ['main.py'] };
    }
    return null;
  }

  return null;
}

// Track spawned processes for log capture
const spawnedProcesses = new Map<number, ChildProcess>();

// Patterns to detect port from process output
const PORT_PATTERNS = [
  /(?:listening|running|started|server|http).*?(?:on|at|port|:)\s*(\d{4,5})/i,
  /localhost:(\d{4,5})/i,
  /127\.0\.0\.1:(\d{4,5})/i,
  /0\.0\.0\.0:(\d{4,5})/i,
  /port\s*[=:]\s*(\d{4,5})/i,
];

/**
 * Start a repo's application in the background with log capture
 */
export async function startRepo(repoPath: string): Promise<{ success: boolean; pid?: number; error?: string }> {
  const projectType = detectProjectType(repoPath);
  const startCmd = getStartCommand(repoPath, projectType);

  if (!startCmd) {
    return { success: false, error: `Cannot determine start command for ${projectType} project` };
  }

  try {
    // Spawn process with stdout/stderr piped for log capture
    const child = spawn(startCmd.cmd, startCmd.args, {
      cwd: repoPath,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, NODE_ENV: 'development' },
    });

    if (!child.pid) {
      return { success: false, error: 'Failed to get process PID' };
    }

    const pid = child.pid;
    const commandStr = `${startCmd.cmd} ${startCmd.args.join(' ')}`;

    // Register process for log capture
    registerProcess(pid, commandStr, repoPath);
    spawnedProcesses.set(pid, child);

    // Capture stdout
    child.stdout?.on('data', (data: Buffer) => {
      const text = data.toString();
      addProcessLog(pid, 'stdout', text);

      // Try to detect port from output
      for (const pattern of PORT_PATTERNS) {
        const match = text.match(pattern);
        if (match) {
          const port = parseInt(match[1], 10);
          if (port >= 3000 && port <= 65535) {
            associatePort(pid, port);
            break;
          }
        }
      }
    });

    // Capture stderr
    child.stderr?.on('data', (data: Buffer) => {
      const text = data.toString();
      addProcessLog(pid, 'stderr', text);

      // Also check stderr for port info (some frameworks log there)
      for (const pattern of PORT_PATTERNS) {
        const match = text.match(pattern);
        if (match) {
          const port = parseInt(match[1], 10);
          if (port >= 3000 && port <= 65535) {
            associatePort(pid, port);
            break;
          }
        }
      }
    });

    // Handle stream errors to prevent unhandled error events
    child.stdout?.on('error', (err) => {
      console.error(`stdout error for process ${pid}:`, err.message);
    });
    child.stderr?.on('error', (err) => {
      console.error(`stderr error for process ${pid}:`, err.message);
    });

    // Handle process exit
    child.on('exit', (code) => {
      markProcessExited(pid, code);
      spawnedProcesses.delete(pid);
    });

    child.on('error', (err) => {
      addProcessLog(pid, 'stderr', `Process error: ${err.message}`);
      markProcessExited(pid, 1);
      spawnedProcesses.delete(pid);
    });

    // Unref so parent can exit independently
    child.unref();

    // Give it a moment to start
    await new Promise(resolve => setTimeout(resolve, 1000));

    return { success: true, pid };
  } catch (err) {
    return { success: false, error: String(err) };
  }
}

/**
 * Get a spawned process by PID
 */
export function getSpawnedProcess(pid: number): ChildProcess | undefined {
  return spawnedProcesses.get(pid);
}

/**
 * Stop a process by PID (SIGTERM, then SIGKILL after timeout)
 */
export async function stopProcess(pid: number): Promise<{ success: boolean; error?: string }> {
  try {
    // Check if process exists
    process.kill(pid, 0);
  } catch {
    return { success: false, error: 'Process not found' };
  }

  try {
    // Send SIGTERM
    process.kill(pid, 'SIGTERM');

    // Wait up to 5 seconds for process to exit
    for (let i = 0; i < 10; i++) {
      await new Promise(resolve => setTimeout(resolve, 500));
      try {
        process.kill(pid, 0);
        // Still running, continue waiting
      } catch {
        // Process exited
        return { success: true };
      }
    }

    // Process still running after 5 seconds, send SIGKILL
    try {
      process.kill(pid, 'SIGKILL');
      return { success: true };
    } catch {
      return { success: true }; // Already exited
    }
  } catch (err) {
    return { success: false, error: String(err) };
  }
}
