import type { IPty } from '@homebridge/node-pty-prebuilt-multiarch';

export interface ClaudeCodeEvent {
  id: string;
  type: 'assistant' | 'user' | 'tool_use' | 'tool_result' | 'system' | 'result';
  timestamp: number;

  // For tool_use
  tool?: string;
  toolInput?: Record<string, unknown>;

  // For tool_result
  toolResult?: string;
  isError?: boolean;

  // For assistant/user/system messages
  content?: string;
}

export interface ClaudeCodeSession {
  id: string;
  cwd: string;
  createdAt: number;
  updatedAt: number;
  events: ClaudeCodeEvent[];
  isActive: boolean;
}

export interface ManagedClaudeCodeSession {
  id: string;
  cwd: string;
  process: IPty | null;
  events: ClaudeCodeEvent[];
  subscribers: Set<(event: ClaudeCodeEvent) => void>;
  createdAt: number;
  saveTimer: NodeJS.Timeout | null;
}

