import { describe, expect, it } from 'vitest';
import { buildMentionThreads } from './mentionThreads';

describe('buildMentionThreads', () => {
  const sessions = [
    { id: 'ss-1', title: 'First' },
    { id: 'ss-2', title: '' },
    { id: 'ss-3', title: 'Archived', thread: { archived: true } },
    { id: 'pty-4', title: 'Terminal' },
    { title: 'No id' },
  ];

  it('lists only active structured threads other than the current one', () => {
    expect(buildMentionThreads(sessions, 'ss-1')).toEqual([{ id: 'ss-2', title: 'ss-2' }]);
  });

  it('returns every active structured thread when none is current', () => {
    expect(buildMentionThreads(sessions, null)).toEqual([
      { id: 'ss-1', title: 'First' },
      { id: 'ss-2', title: 'ss-2' },
    ]);
  });

  it('returns an empty list for a non-array input', () => {
    expect(buildMentionThreads(undefined, 'ss-1')).toEqual([]);
  });
});
