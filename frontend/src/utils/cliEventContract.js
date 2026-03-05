const CANONICAL_EVENT_TYPES = new Set([
  'user_turn',
  'assistant_turn',
  'prompt_required',
  'status',
  'error',
]);

/** Structured-mode canonical event types from the structured adapter system. */
export const STRUCTURED_EVENT_TYPES = new Set([
  'session_started',
  'session_ended',
  'message_started',
  'message_delta',
  'message_completed',
  'tool_started',
  'tool_output',
  'tool_completed',
  'approval_required',
  'input_required',
  'raw_provider_event',
]);

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function normalizeTs(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : Date.now();
}

function normalizePromptActions(actions) {
  if (!Array.isArray(actions)) return [];
  return actions
    .filter((value) => typeof value === 'string')
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * Convert terminal metadata payloads into canonical CLI events.
 * Supports new { type: 'cli_event', event: ... } and legacy { type: 'turn', ... }.
 */
export function normalizeCliEventFromMeta(metaMessage) {
  if (!metaMessage || typeof metaMessage !== 'object') return null;

  if (metaMessage.type === 'cli_event' && metaMessage.event && typeof metaMessage.event === 'object') {
    const event = metaMessage.event;
    if (!CANONICAL_EVENT_TYPES.has(event.type)) return null;

    if ((event.type === 'user_turn' || event.type === 'assistant_turn') && !isNonEmptyString(event.content)) {
      return null;
    }
    if (event.type === 'prompt_required' && !isNonEmptyString(event.prompt)) {
      return null;
    }
    if (event.type === 'status' && !isNonEmptyString(event.status)) {
      return null;
    }
    if (event.type === 'error' && !isNonEmptyString(event.message)) {
      return null;
    }

    return {
      ...event,
      ts: normalizeTs(event.ts),
      source: event.source || 'pty',
      actions: event.type === 'prompt_required' ? normalizePromptActions(event.actions) : undefined
    };
  }

  if (metaMessage.type === 'turn' && (metaMessage.role === 'user' || metaMessage.role === 'assistant') && isNonEmptyString(metaMessage.content)) {
    return {
      type: metaMessage.role === 'user' ? 'user_turn' : 'assistant_turn',
      content: metaMessage.content,
      ts: normalizeTs(metaMessage.ts),
      source: 'pty'
    };
  }

  // Handle structured events from the structured adapter system
  if (metaMessage.type === 'structured_event' && metaMessage.event && typeof metaMessage.event === 'object') {
    const event = metaMessage.event;
    if (STRUCTURED_EVENT_TYPES.has(event.type)) {
      return {
        ...event,
        ts: normalizeTs(event.ts),
        source: 'structured',
      };
    }
    return null;
  }

  return null;
}

