import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { TerminalNativeLauncher, TerminalShellProfile } from './terminal-types';

const WINDOWS_CMD = 'C:\\Windows\\System32\\cmd.exe';
const WINDOWS_POWERSHELL = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';

export interface NativeTerminalLaunchOptions {
  cwd: string;
  launcher?: TerminalNativeLauncher | null;
  shellProfile?: TerminalShellProfile | null;
}

export interface NativeTerminalLaunchResult {
  launcher: TerminalNativeLauncher;
  command: string;
  args: string[];
}

interface LaunchCandidate {
  launcher: TerminalNativeLauncher;
  command: string;
  args: string[];
  exists: () => boolean;
}

function commandExists(command: string): boolean {
  const checker = process.platform === 'win32' ? 'where' : 'which';
  const result = spawnSync(checker, [command], { stdio: 'ignore' });
  return result.status === 0;
}

function fileExists(filePath: string): boolean {
  try {
    return fs.existsSync(filePath);
  } catch {
    return false;
  }
}

function resolveLaunchCwd(cwd: string): string {
  const resolved = path.resolve(String(cwd || '').trim());
  if (!resolved || !fileExists(resolved)) {
    throw new Error('Terminal working directory does not exist');
  }
  try {
    if (!fs.statSync(resolved).isDirectory()) {
      throw new Error('Terminal working directory is not a directory');
    }
  } catch {
    throw new Error('Terminal working directory is not accessible');
  }
  return resolved;
}

function escapePowerShellSingleQuoted(value: string): string {
  return value.replace(/'/g, "''");
}

function getWindowsLauncherOrder(
  preferred: TerminalNativeLauncher,
  shellProfile: TerminalShellProfile | null | undefined
): TerminalNativeLauncher[] {
  if (preferred !== 'system') {
    return [preferred];
  }
  switch (shellProfile) {
    case 'cmd':
      return ['cmd', 'wt', 'powershell', 'pwsh'];
    case 'powershell':
      return ['powershell', 'wt', 'pwsh', 'cmd'];
    case 'pwsh':
      return ['pwsh', 'wt', 'powershell', 'cmd'];
    default:
      return ['wt', 'pwsh', 'powershell', 'cmd'];
  }
}

function buildWindowsCandidates(
  cwd: string,
  preferred: TerminalNativeLauncher,
  shellProfile: TerminalShellProfile | null | undefined
): LaunchCandidate[] {
  const order = getWindowsLauncherOrder(preferred, shellProfile);
  return order.map((launcher) => {
    if (launcher === 'wt') {
      return {
        launcher,
        command: 'wt.exe',
        args: ['-d', cwd],
        exists: () => commandExists('wt.exe')
      };
    }
    if (launcher === 'pwsh') {
      return {
        launcher,
        command: 'pwsh.exe',
        args: ['-NoLogo', '-NoExit', '-Command', `Set-Location -LiteralPath '${escapePowerShellSingleQuoted(cwd)}'`],
        exists: () => commandExists('pwsh.exe')
      };
    }
    if (launcher === 'powershell') {
      const psPath = fileExists(WINDOWS_POWERSHELL) ? WINDOWS_POWERSHELL : 'powershell.exe';
      return {
        launcher,
        command: psPath,
        args: ['-NoLogo', '-NoExit', '-Command', `Set-Location -LiteralPath '${escapePowerShellSingleQuoted(cwd)}'`],
        exists: () => fileExists(psPath) || commandExists('powershell.exe')
      };
    }
    if (launcher === 'cmd' || launcher === 'system') {
      const cmdPath = process.env.ComSpec || WINDOWS_CMD;
      return {
        launcher: 'cmd',
        command: cmdPath,
        args: ['/K', `cd /d "${cwd.replace(/"/g, '""')}"`],
        exists: () => fileExists(cmdPath)
      };
    }
    return {
      launcher,
      command: '',
      args: [],
      exists: () => false
    };
  }).filter((candidate) => candidate.command);
}

function buildPosixCandidates(cwd: string, preferred: TerminalNativeLauncher): LaunchCandidate[] {
  if (process.platform === 'darwin') {
    const launcher = preferred === 'system' ? 'terminal' : preferred;
    if (launcher !== 'terminal') {
      return [];
    }
    return [{
      launcher: 'terminal',
      command: 'open',
      args: ['-a', 'Terminal', cwd],
      exists: () => commandExists('open')
    }];
  }

  const launcher = preferred === 'system' ? 'x-terminal-emulator' : preferred;
  if (launcher !== 'x-terminal-emulator') {
    return [];
  }
  return [{
    launcher: 'x-terminal-emulator',
    command: 'x-terminal-emulator',
    args: ['--working-directory', cwd],
    exists: () => commandExists('x-terminal-emulator')
  }];
}

function spawnDetached(command: string, args: string[], cwd: string): void {
  const child = spawn(command, args, {
    cwd,
    detached: true,
    stdio: 'ignore',
    windowsHide: false
  });
  child.unref();
}

export function launchNativeTerminal(options: NativeTerminalLaunchOptions): NativeTerminalLaunchResult {
  const cwd = resolveLaunchCwd(options.cwd);
  const preferred = options.launcher || 'system';
  let candidates: LaunchCandidate[] = [];

  if (process.platform === 'win32') {
    candidates = buildWindowsCandidates(cwd, preferred, options.shellProfile);
  } else {
    candidates = buildPosixCandidates(cwd, preferred);
  }

  if (candidates.length === 0) {
    throw new Error('No supported native terminal launcher is available for this platform');
  }

  let lastError: unknown = null;
  for (const candidate of candidates) {
    if (!candidate.exists()) {
      continue;
    }
    try {
      spawnDetached(candidate.command, candidate.args, cwd);
      return {
        launcher: candidate.launcher,
        command: candidate.command,
        args: candidate.args
      };
    } catch (error) {
      lastError = error;
    }
  }

  if (lastError instanceof Error) {
    throw new Error(`Failed to open native terminal: ${lastError.message}`);
  }
  throw new Error('No native terminal launcher is installed or available');
}
