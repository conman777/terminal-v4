import { isStructuredSessionId } from '../../utils/structuredSessions';

export function buildMentionThreads(sessions, currentSessionId) {
  if (!Array.isArray(sessions)) return [];
  return sessions
    .filter(session => session?.id && session.id !== currentSessionId
      && isStructuredSessionId(session.id) && !session.thread?.archived)
    .map(session => ({ id: session.id, title: session.title || session.id }));
}
