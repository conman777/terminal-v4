import { describe, expect, it } from 'vitest';
import { MemorySessionStore } from '../src/session/memory-session-store';

describe('MemorySessionStore', () => {
  it('creates and retrieves sessions with derived titles', () => {
    const store = new MemorySessionStore();
    const session = store.createSession({ firstMessage: 'List project files' });

    expect(session.title).toBe('List project files');

    const fetched = store.getSession(session.id);
    expect(fetched?.id).toBe(session.id);
    expect(fetched?.messages).toHaveLength(0);

    const listed = store.listSessions();
    expect(listed).toHaveLength(1);
    expect(listed[0].title).toBe('List project files');
  });
});
