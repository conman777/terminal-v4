export type ChatRole = 'user' | 'assistant' | 'system';

export interface ChatMessageMeta {
  streaming?: boolean;
  exitCode?: number | null;
  signal?: string | null;
  aborted?: boolean;
  [key: string]: unknown;
}

export interface ChatMessage {
  id: string;
  role: ChatRole;
  content: string;
  createdAt: string;
  meta: ChatMessageMeta;
}

export interface ChatSession {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  preview: string;
  claudeSessionId: string | null;
  messages: ChatMessage[];
}

export interface SessionSummary {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  preview: string;
  claudeSessionId: string | null;
  messageCount: number;
}

export interface CreateSessionOptions {
  title?: string;
  firstMessage?: string;
  claudeSessionId?: string | null;
}

export interface AppendMessageOptions {
  id?: string;
  role: ChatRole;
  content?: string;
  createdAt?: string;
  meta?: ChatMessageMeta;
}

export interface SessionStore {
  has(id: string): boolean;
  createSession(options?: CreateSessionOptions): ChatSession;
  listSessions(): SessionSummary[];
  getSession(id: string): ChatSession | null;
  touch(id: string): ChatSession | null;
  appendMessage(sessionId: string, message: AppendMessageOptions): string;
  updateMessage(sessionId: string, messageId: string, updates: Partial<Omit<ChatMessage, 'id' | 'role'>> & { role?: ChatRole }): void;
  setClaudeSessionId(sessionId: string, claudeSessionId: string): void;
  deleteSession(sessionId: string): boolean;
}
