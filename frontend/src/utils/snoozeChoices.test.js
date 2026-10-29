import { describe, expect, it, vi } from 'vitest';
import { nextSnoozeExpiryDelay, parseCustomSnooze, promptCustomSnoozeSeconds, settlementUnavailableReason, snoozeChoices } from './snoozeChoices';

describe('snoozeChoices', () => {
  it('offers one hour, four hours and tomorrow morning measured from the given local time', () => {
    const now = new Date(2026, 0, 5, 22, 30, 0);
    const choices = snoozeChoices(now);
    expect(choices.map(choice => [choice.label, choice.seconds])).toEqual([
      ['Snooze for one hour', 3600],
      ['Snooze for 4 hours', 14400],
      ['Snooze until tomorrow morning', 10.5 * 3600],
    ]);
  });

  it('measures tomorrow morning to 9:00 the next calendar day even early in the morning', () => {
    expect(snoozeChoices(new Date(2026, 0, 5, 7, 0, 0))[2].seconds).toBe(26 * 3600);
  });
});

describe('parseCustomSnooze', () => {
  it('reads minutes, hours and days and defaults bare numbers to hours', () => {
    expect(parseCustomSnooze('90m')).toBe(5400);
    expect(parseCustomSnooze('2h')).toBe(7200);
    expect(parseCustomSnooze('3d')).toBe(259200);
    expect(parseCustomSnooze(' 2 ')).toBe(7200);
    expect(parseCustomSnooze('1.5h')).toBe(5400);
  });

  it.each(['', 'soon', '0m', '59s', '-1h', '31d', '721h', '1e9h'])('rejects %j', value => {
    expect(() => parseCustomSnooze(value)).toThrow(/between 1 minute and 30 days/);
  });
});

describe('promptCustomSnoozeSeconds', () => {
  it('returns null when cancelled and seconds when valid', () => {
    const prompt = vi.spyOn(window, 'prompt');
    prompt.mockReturnValueOnce(null);
    expect(promptCustomSnoozeSeconds()).toBeNull();
    prompt.mockReturnValueOnce('45m');
    expect(promptCustomSnoozeSeconds()).toBe(2700);
    prompt.mockRestore();
  });
});

describe('settlementUnavailableReason', () => {
  it('explains why native and terminal sessions are never settled', () => {
    expect(settlementUnavailableReason({ id: 'ss-native', runtime: 'claude', threadLifecycle: { supported: true } })).toMatch(/Claude and Codex/);
    expect(settlementUnavailableReason({ id: 'term-1' })).toMatch(/Terminal sessions/);
  });

  it('uses the server reason for an unverifiable V4 thread and nothing for a settleable one', () => {
    expect(settlementUnavailableReason({ id: 'ss-v4', runtime: 'v4', threadLifecycle: { settlementSupported: false, settlementUnavailableReason: 'Cannot verify.' } })).toBe('Cannot verify.');
    expect(settlementUnavailableReason({ id: 'ss-v4', runtime: 'v4', threadLifecycle: { settlementSupported: true } })).toBeNull();
  });
});

describe('nextSnoozeExpiryDelay', () => {
  it('returns the smallest positive delay among snoozed threads and clamps to a safe timer', () => {
    const sessions = [
      { threadLifecycle: { snoozed: true, snoozedUntilMs: 5000 } },
      { threadLifecycle: { snoozed: true, snoozedUntilMs: 2000 } },
      { threadLifecycle: { snoozed: false, snoozedUntilMs: 1100 } },
      { threadLifecycle: { snoozed: true, snoozedUntilMs: 900 } },
    ];
    expect(nextSnoozeExpiryDelay(sessions, 1000)).toBe(1000);
    expect(nextSnoozeExpiryDelay([{ threadLifecycle: { snoozed: true, snoozedUntilMs: 1e15 } }], 0)).toBe(2147483647);
    expect(nextSnoozeExpiryDelay([], 0)).toBeNull();
  });
});
