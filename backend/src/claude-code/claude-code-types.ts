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

export type ClaudeModel = 'sonnet' | 'opus' | 'haiku';

export interface ClaudeCodeSession {
  id: string;
  cwd: string;
  model: ClaudeModel;
  createdAt: number;
  updatedAt: number;
  events: ClaudeCodeEvent[];
  isActive: boolean;
}

export interface ManagedClaudeCodeSession {
  id: string;
  cwd: string;
  model: ClaudeModel;
  agent: any; // Changed from Agent to any
  events: ClaudeCodeEvent[];
  subscribers: Set<(event: ClaudeCodeEvent) => void>;
  createdAt: number;
  saveTimer: NodeJS.Timeout | null;
}

