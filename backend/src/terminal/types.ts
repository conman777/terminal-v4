import type {
  TerminalFidelityMode,
  TerminalProcess,
  TerminalShellProfile,
  TerminalStreamEvent
} from './terminal-types';
import type { PersistedSession, ThreadMetadata } from './session-store';

// Terminal dimension constants
export const DEFAULT_COLS = 120;
export const DEFAULT_ROWS = 32;
export const MAX_BUFFER_CHARS = 20_000_000;
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
  updatedAt: number;
}

// Managed terminal session
export interface ManagedTerminal {
  id: string;
  userId: string;
  title: string;
  shell: string;
  shellArgs: string[];
  shellProfile?: TerminalShellProfile | null;
  fidelityMode: TerminalFidelityMode;
  cwd: string;
  createdAt: string;
  updatedAt: string;
  process: TerminalProcess;
  buffer: TerminalStreamEvent[];
  bufferCharCount: number;
  subscribers: Set<(event: TerminalStreamEvent | null) => void>;
  inputBuffer: string;
  saveTimer?: NodeJS.Timeout;
  saveInProgress?: boolean;  // Prevent concurrent saves
  pendingSave?: boolean;     // Track if save requested while another in progress
  dataHandler?: (data: string) => void;
  exitHandler?: (code: number | null, signal: NodeJS.Signals | null) => void;
  clientDimensions: Map<string, ClientDimensions>;
  primaryClientId?: string | null;
  currentCols: number;
  currentRows: number;
  usesTmux: boolean;
  outputBatcher?: any;       // OutputBatcher instance for batching PTY output
  lastActivityAt: number;
  idleTimer?: NodeJS.Timeout;
  thread?: ThreadMetadata;   // Thread metadata for grouping/organizing sessions
}

// Re-export session store type
export type { PersistedSession };
