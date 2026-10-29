import { describe, expect, it } from 'vitest';
import { forkPrompt } from './conversationFork';

const messages = [
  { role: 'user', content: '[Plan] Add search', messageId: 'u1' },
  { role: 'tool', toolName: 'read' },
  { role: 'assistant', content: '1. Index', messageId: 'a1' },
  { role: 'user', content: 'Go ahead', messageId: 'u2' },
  { role: 'assistant', content: 'Done', messageId: 'a2' },
];

describe('forkPrompt', () => {
  it('carries the conversation up to the chosen reply into a new thread', () => {
    expect(forkPrompt(messages, 'a1')).toBe('Continue from this earlier conversation:\n\nUser: Add search\n\nAssistant: 1. Index\n\nPick up from here.');
  });

  it('keeps the most recent part when the conversation is long', () => {
    const long = [{ role: 'user', content: 'x'.repeat(30000), messageId: 'u' }, { role: 'assistant', content: 'end', messageId: 'a' }];
    const prompt = forkPrompt(long, 'a', 1000);
    expect([prompt.length <= 1100, prompt.includes('Assistant: end'), prompt.includes('…')]).toEqual([true, true, true]);
  });
});
