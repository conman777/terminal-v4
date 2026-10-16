import { describe, expect, it } from 'vitest';
import { replayTranscript, validateRecording } from './sessionReplay';
describe('replayTranscript', () => {
  it('reconstructs output at a selected time and handles terminal overwrite and backspace', () => {
    const events = [{ ts: 100, kind: 'terminal', text: 'Progress 1%' }, { ts: 200, kind: 'terminal', text: '\rDone!\x1b[K\nabc\bX' }];
    expect(replayTranscript(events, 150)).toBe('Progress 1%');
    expect(replayTranscript(events, 200)).toBe('Done!\nabX');
    expect(replayTranscript(events, 0)).toBe('');
  });
  it('reconstructs a cleared screen independently after seeking backwards', () => {
    const events = [{ ts: 1, text: 'old' }, { ts: 2, text: '\x1b[2J\x1b[Hnew' }];
    expect(replayTranscript(events, 2)).toBe('new');
    expect(replayTranscript(events, 1)).toBe('old');
  });
});
describe('validateRecording', () => {
  const record = { format: 'terminal-v4-session-recording', version: 1, events: [{ sourceSeq: 1, ts: 10, kind: 'terminal', text: 'ok' }] };
  it('accepts only bounded versioned sequenced events', () => {
    expect(validateRecording(record)).toEqual(record);
    expect(() => validateRecording({ ...record, version: 2 })).toThrow('Unsupported');
    expect(() => validateRecording({ ...record, events: [...record.events, ...record.events] })).toThrow('Invalid');
    expect(() => validateRecording({ ...record, events: [{ ...record.events[0], text: 'a'.repeat(131073) }] })).toThrow('Invalid');
  });
});
