import { describe, expect, it } from 'vitest';
import { getHistoryReplayObserverText, shouldUseSingleHistoryWrite } from './terminalHistoryReplay';

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
