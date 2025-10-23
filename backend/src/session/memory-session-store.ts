import { randomUUID } from 'node:crypto';
import {
  AppendMessageOptions,
  ChatMessage,
  ChatSession,
  CreateSessionOptions,
  SessionStore,
  SessionSummary
} from './types';

const MAX_PREVIEW_LENGTH = 120;
const MAX_TITLE_LENGTH = 48;

function timestamp(): string {
  return new Date().toISOString();
}

function normaliseWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function buildTitle(source: string | undefined | null): string {
  if (!source) {
    return 'New Session';
  }

  const normalised = normaliseWhitespace(source);
  if (!normalised) {
    return 'New Session';
  }

  if (normalised.length <= MAX_TITLE_LENGTH) {
    return normalised;
  }

  return `${normalised.slice(0, MAX_TITLE_LENGTH - 1)}…`;
}

function cloneMessage(message: ChatMessage): ChatMessage {
  return {
    ...message,
    meta: { ...message.meta }
  };
}

export class MemorySessionStore implements SessionStore {
  #sessions = new Map<string, ChatSession>();

  has(id: string): boolean {
    return this.#sessions.has(id);
  }

  createSession(options: CreateSessionOptions = {}): ChatSession {
    const id = randomUUID();
    const createdAt = timestamp();

    const session: ChatSession = {
      id,
      title: options.title ? normaliseWhitespace(options.title) : buildTitle(options.firstMessage ?? ''),
      createdAt,
      updatedAt: createdAt,
      preview: '',
      claudeSessionId: options.claudeSessionId ?? null,
      messages: []
    };

    this.#sessions.set(id, session);
    return session;
  }

  listSessions(): SessionSummary[] {
    return Array.from(this.#sessions.values())
      .map((session) => ({
        id: session.id,
        title: session.title,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
        preview: session.preview,
        claudeSessionId: session.claudeSessionId,
        messageCount: session.messages.length
      }))
      .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
  }

  getSession(id: string): ChatSession | null {
    const session = this.#sessions.get(id);
    if (!session) {
      return null;
    }

    return {
      ...session,
      messages: session.messages.map(cloneMessage)
    };
  }

  touch(id: string): ChatSession | null {
    const session = this.#sessions.get(id);
    if (!session) {
      return null;
    }

    session.updatedAt = timestamp();
    return session;
  }

  appendMessage(sessionId: string, message: AppendMessageOptions): string {
    const session = this.#sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session ${sessionId} not found`);
    }

    const entry: ChatMessage = {
      id: message.id ?? randomUUID(),
      role: message.role,
      content: message.content ?? '',
      createdAt: message.createdAt ?? timestamp(),
      meta: { ...(message.meta ?? {}) }
    };

    session.messages.push(entry);
    session.updatedAt = entry.createdAt;

    if (entry.role === 'assistant' && entry.content) {
      session.preview = entry.content.slice(0, MAX_PREVIEW_LENGTH);
    } else if (!session.preview && entry.content) {
      session.preview = entry.content.slice(0, MAX_PREVIEW_LENGTH);
    }

    if (entry.role === 'user' && (!session.title || session.title === 'New Session')) {
      session.title = buildTitle(entry.content);
    }

    return entry.id;
  }

  updateMessage(
    sessionId: string,
    messageId: string,
    updates: Partial<Omit<ChatMessage, 'id' | 'role'>> & { role?: ChatMessage['role'] }
  ): void {
    const session = this.#sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session ${sessionId} not found`);
    }

    const entry = session.messages.find((message) => message.id === messageId);
    if (!entry) {
      throw new Error(`Message ${messageId} not found in session ${sessionId}`);
    }

    if (typeof updates.content === 'string') {
      entry.content = updates.content;
    }

    if (updates.meta && typeof updates.meta === 'object') {
      entry.meta = { ...entry.meta, ...updates.meta };
    }

    if (updates.createdAt) {
      entry.createdAt = updates.createdAt;
    }

    if (updates.role) {
      entry.role = updates.role;
    }

    session.updatedAt = timestamp();

    if (entry.role === 'assistant' && entry.content) {
      session.preview = entry.content.slice(0, MAX_PREVIEW_LENGTH);
    }
  }

  setClaudeSessionId(sessionId: string, claudeSessionId: string): void {
    const session = this.#sessions.get(sessionId);
    if (!session) {
      return;
    }

    session.claudeSessionId = claudeSessionId;
  }

  deleteSession(sessionId: string): boolean {
    return this.#sessions.delete(sessionId);
  }
}
