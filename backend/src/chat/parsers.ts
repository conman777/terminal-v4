interface MaybeTextPayload {
  text?: unknown;
  delta?: { text?: unknown } | null;
  content?: unknown;
  message?: unknown;
  [key: string]: unknown;
}

export function extractTextFragment(payload: MaybeTextPayload): string {
  if (!payload || typeof payload !== 'object') {
    return '';
  }

  if (typeof payload.text === 'string') {
    return payload.text;
  }

  if (payload.delta && typeof payload.delta === 'object' && typeof payload.delta.text === 'string') {
    return payload.delta.text;
  }

  if (typeof payload.content === 'string') {
    return payload.content;
  }

  if (Array.isArray(payload.content)) {
    return payload.content
      .map((item) => {
        if (!item) {
          return '';
        }

        if (typeof item === 'string') {
          return item;
        }

        if (typeof item === 'object') {
          if (typeof (item as { text?: string }).text === 'string') {
            return (item as { text: string }).text;
          }

          if ((item as { type?: string }).type === 'text' && typeof (item as { value?: string }).value === 'string') {
            return (item as { value: string }).value;
          }
        }

        return '';
      })
      .join('');
  }

  if (typeof payload.message === 'string') {
    return payload.message;
  }

  return '';
}

const SESSION_CANDIDATE_KEYS = [
  'sessionId',
  'session_id',
  'session',
  'conversationId',
  'conversation_id',
  'claudeSessionId',
  'claude_session_id',
  'delta',
  'meta',
  'metadata'
] as const;

export function detectClaudeSessionId(payload: MaybeTextPayload): string | null {
  if (!payload || typeof payload !== 'object') {
    return null;
  }

  for (const key of SESSION_CANDIDATE_KEYS) {
    const value = (payload as Record<string, unknown>)[key];
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }

    if (value && typeof value === 'object') {
      const nestedId = detectClaudeSessionId(value as MaybeTextPayload);
      if (nestedId) {
        return nestedId;
      }
    }
  }

  return null;
}
