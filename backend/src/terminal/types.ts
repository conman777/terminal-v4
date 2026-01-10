import type { TerminalProcess, TerminalStreamEvent } from './terminal-types';
import type { PersistedSession } from './session-store';

// Terminal dimension constants
export const DEFAULT_COLS = 120;
export const DEFAULT_ROWS = 32;
export const MAX_BUFFER_CHARS = 1_000_000;
export const SAVE_DEBOUNCE_MS = 2000;
export const CWD_TIMEOUT_MS = 1000;

// Project detection types
export type ProjectType = 'node' | 'python-flask' | 'django' | 'rust' | 'go' | 'static' | 'unknown';

export interface ProjectInfo {
  cwd: string;
  projectType: ProjectType;
  projectName?: string;
  startCommand?: string;
  indexPath?: string;
}

// Client dimension tracking
export interface ClientDimensions {
  cols: number;
  rows: number;
}

// Managed terminal session
export interface ManagedTerminal {
  id: string;
  userId: string;
  title: string;
  shell: string;
  cwd: string;
  createdAt: string;
  updatedAt: string;
  process: TerminalProcess;
  buffer: TerminalStreamEvent[];
  bufferCharCount: number;
  subscribers: Set<(event: TerminalStreamEvent | null) => void>;
  saveTimer?: NodeJS.Timeout;
  dataHandler?: (data: string) => void;
  exitHandler?: (code: number | null, signal: NodeJS.Signals | null) => void;
  clientDimensions: Map<string, ClientDimensions>;
  currentCols: number;
  currentRows: number;
  usesTmux: boolean;
}

// Re-export session store type
export type { PersistedSession };
