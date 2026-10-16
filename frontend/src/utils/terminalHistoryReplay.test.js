import { describe, expect, it } from 'vitest';
import { getHistoryReplayObserverText, shouldUseSingleHistoryWrite, unseenTerminalEvents, hasTerminalHistoryGap } from './terminalHistoryReplay';

describe('terminalHistoryReplay', () => {
  it('uses a single write for typical initial history payloads', () => {
    expect(shouldUseSingleHistoryWrite(80_000, 80_000)).toBe(true);
    expect(shouldUseSingleHistoryWrite(200_000, 120_000)).toBe(true);
  });

  it('keeps chunking very large history replays', () => {
    expect(shouldUseSingleHistoryWrite(300_000, 80_000)).toBe(false);
    expect(shouldUseSingleHistoryWrite(1_000_000, 120_000)).toBe(false);
  });

  it('returns only the tail needed for preview and idle observers', () => {
    expect(getHistoryReplayObserverText('abcdef', 3)).toBe('def');
    expect(getHistoryReplayObserverText('abcdef')).toBe('abcdef');
  });

  it('returns an empty observer payload for empty or invalid history text', () => {
    expect(getHistoryReplayObserverText('')).toBe('');
    expect(getHistoryReplayObserverText(null)).toBe('');
  });
});

describe('terminal output replay reconciliation', () => {
  it('discards overlap between an HTTP history snapshot and buffered socket output without duplicating display bytes', () => {
    const snapshotLastSeq = 42;
    const buffered = [
      { seq: 41, text: 'already shown one' },
      { seq: 42, text: 'already shown two' },
      { seq: 43, text: 'new output' },
      { seq: 43, text: 'duplicate new output' },
      { seq: 44, text: 'new output two' },
    ];
    expect(unseenTerminalEvents(buffered, snapshotLastSeq)).toEqual([
      { seq: 43, text: 'new output' }, { seq: 44, text: 'new output two' },
    ]);
  });
  it('detects a truncated incremental page so the renderer rebuilds from bounded recent history', () => {
    expect([
      hasTerminalHistoryGap([{ seq: 43, text: 'next' }], 42),
      hasTerminalHistoryGap([{ seq: 100, text: 'truncated' }], 42),
      hasTerminalHistoryGap([], 42),
      hasTerminalHistoryGap([{ seq: 100 }], 0),
    ]).toEqual([false, true, false, false]);
  });
  it('preserves legacy unsequenced entries while rejecting older sequenced output', () => {
    expect(unseenTerminalEvents([{ text: 'legacy' }, { seq: 9, text: 'old' }, { seq: 11, text: 'new' }], 10))
      .toEqual([{ text: 'legacy' }, { seq: 11, text: 'new' }]);
  });
});
