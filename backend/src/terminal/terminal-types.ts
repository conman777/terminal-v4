import type { EventEmitter } from 'node:events';
import type { ThreadMetadata } from './session-store';
import type { CwdSource } from './session-resolver';
import type { SandboxMode, TerminalSandboxInfo } from '../sandbox/sandbox-types';

export interface TerminalStreamEvent {
  text: string;
  ts: number;
  seq?: number;
}

export interface TerminalSessionSummary {
  id: string;
  title: string;
  shell: string;
  cwd: string;
  cwdSource?: CwdSource;
  groupPath?: string | null;
  createdAt: string;
  updatedAt: string;
  lastActivityAt?: string;
  messageCount: number;
  isActive: boolean;
  isBusy?: boolean;
  usesTmux: boolean;
  sandbox?: TerminalSandboxInfo;
  thread?: ThreadMetadata;
}

export interface TerminalSessionSnapshot {
  id: string;
  title: string;
  shell: string;
  createdAt: string;
  updatedAt: string;
  history: TerminalStreamEvent[];
  usesTmux: boolean;
  currentCols?: number;
  currentRows?: number;
  sandbox?: TerminalSandboxInfo;
}

export interface TerminalCreateOptions {
  id?: string;
  title?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  cols?: number;
  rows?: number;
  shell?: string;
  sandboxMode?: SandboxMode;
  workspaceRoot?: string;
  /** Command to execute immediately after terminal starts */
  initialCommand?: string;
}

export interface TerminalProcess extends EventEmitter {
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: NodeJS.Signals | number): void;
}

export interface TerminalSpawnOptions {
  shell: string;
  cols: number;
  rows: number;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

export type TerminalSpawner = (options: TerminalSpawnOptions) => TerminalProcess;
