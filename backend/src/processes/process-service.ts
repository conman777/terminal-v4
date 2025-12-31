import { execSync, spawn } from 'child_process';
import { existsSync, readlinkSync, readFileSync } from 'fs';
import { join, basename } from 'path';

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

      // Get command name from /proc/{pid}/comm
      let command = 'unknown';
      try {
        command = readFileSync(`/proc/${pid}/comm`, 'utf-8').trim();
      } catch {
        // Process may have exited
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

/**
 * Start a repo's application in the background
 */
export async function startRepo(repoPath: string): Promise<{ success: boolean; error?: string }> {
  const projectType = detectProjectType(repoPath);
  const startCmd = getStartCommand(repoPath, projectType);

  if (!startCmd) {
    return { success: false, error: `Cannot determine start command for ${projectType} project` };
  }

  try {
    // Spawn detached process with output redirected to /dev/null
    const child = spawn(startCmd.cmd, startCmd.args, {
      cwd: repoPath,
      detached: true,
      stdio: ['ignore', 'ignore', 'ignore'],
      env: { ...process.env, NODE_ENV: 'production' },
    });

    child.unref();

    // Give it a moment to start
    await new Promise(resolve => setTimeout(resolve, 1000));

    return { success: true };
  } catch (err) {
    return { success: false, error: String(err) };
  }
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
