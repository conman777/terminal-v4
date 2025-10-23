import { describe, expect, it } from 'vitest';
import { detectClaudeSessionId, extractTextFragment } from '../src/chat/parsers';

describe('extractTextFragment', () => {
  it('pulls text from direct property', () => {
    expect(extractTextFragment({ text: 'hello' })).toBe('hello');
  });

  it('pulls text from array content', () => {
    expect(
      extractTextFragment({
        content: [
          { type: 'text', value: 'part1' },
          { text: ' part2' }
        ]
      })
    ).toBe('part1 part2');
  });
});

describe('detectClaudeSessionId', () => {
  it('finds top-level session id', () => {
    expect(detectClaudeSessionId({ sessionId: 'abc' })).toBe('abc');
  });

  it('finds nested session id', () => {
    expect(detectClaudeSessionId({ delta: { sessionId: 'nested' } })).toBe('nested');
  });

  it('returns null when not available', () => {
    expect(detectClaudeSessionId({})).toBeNull();
  });
});
