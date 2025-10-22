const { randomUUID } = require('crypto');

const MAX_PREVIEW_LENGTH = 120;
const MAX_TITLE_LENGTH = 48;

function timestamp() {
  return new Date().toISOString();
}

function normaliseWhitespace(text) {
  return text.replace(/\s+/g, ' ').trim();
}

function buildTitle(source) {
  if (!source || typeof source !== 'string') {
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

class SessionStore {
  constructor() {
    this.sessions = new Map();
  }

  has(id) {
    return this.sessions.has(id);
  }

  createSession(options = {}) {
    const id = randomUUID();
    const createdAt = timestamp();

    const session = {
      id,
      title: options.title ? normaliseWhitespace(options.title) : buildTitle(options.firstMessage || ''),
      createdAt,
      updatedAt: createdAt,
      preview: '',
      claudeSessionId: options.claudeSessionId ?? null,
      messages: []
    };

    this.sessions.set(id, session);
    return session;
  }

  listSessions() {
    return Array.from(this.sessions.values())
      .map((session) => ({
        id: session.id,
        title: session.title,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
        preview: session.preview,
        claudeSessionId: session.claudeSessionId,
        messageCount: session.messages.length
      }))
      .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
  }

  getSession(id) {
    const session = this.sessions.get(id);

    if (!session) {
      return null;
    }

    return {
      id: session.id,
      title: session.title,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      preview: session.preview,
      claudeSessionId: session.claudeSessionId,
      messages: session.messages.map((message) => ({ ...message }))
    };
  }

  touch(id) {
    const session = this.sessions.get(id);
    if (!session) {
      return null;
    }

    session.updatedAt = timestamp();
    return session;
  }

  appendMessage(sessionId, message) {
    const session = this.sessions.get(sessionId);

    if (!session) {
      throw new Error(`Session ${sessionId} not found`);
    }

    const entry = {
      id: message.id || randomUUID(),
      role: message.role,
      content: message.content ?? '',
      createdAt: message.createdAt || timestamp(),
      meta: message.meta ? { ...message.meta } : {}
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

  updateMessage(sessionId, messageId, updates) {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session ${sessionId} not found`);
    }

    const message = session.messages.find((entry) => entry.id === messageId);
    if (!message) {
      throw new Error(`Message ${messageId} not found in session ${sessionId}`);
    }

    if (typeof updates.content === 'string') {
      message.content = updates.content;
    }

    if (updates.meta && typeof updates.meta === 'object') {
      message.meta = { ...message.meta, ...updates.meta };
    }

    if (updates.createdAt) {
      message.createdAt = updates.createdAt;
    }

    if (updates.role) {
      message.role = updates.role;
    }

    session.updatedAt = timestamp();

    if (message.role === 'assistant' && message.content) {
      session.preview = message.content.slice(0, MAX_PREVIEW_LENGTH);
    }
  }

  setClaudeSessionId(sessionId, claudeSessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return;
    }

    session.claudeSessionId = claudeSessionId;
  }

  deleteSession(sessionId) {
    return this.sessions.delete(sessionId);
  }
}

module.exports = {
  SessionStore
};
