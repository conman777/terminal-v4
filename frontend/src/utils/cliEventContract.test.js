import { describe, expect, it } from 'vitest';
import { normalizeCliEventFromMeta } from './cliEventContract';

describe('normalizeCliEventFromMeta', () => {
  it('normalizes canonical cli_event payloads', () => {
    const event = normalizeCliEventFromMeta({
      type: 'cli_event',
      event: {
        type: 'prompt_required',
        prompt: 'Continue anyway? [y/N]:',
        actions: ['yes', 'no', 'enter'],
        ts: 1000,
        source: 'pty'
      }
    });

    expect(event).toEqual({
      type: 'prompt_required',
      prompt: 'Continue anyway? [y/N]:',
      actions: ['yes', 'no', 'enter'],
      ts: 1000,
      source: 'pty'
    });
  });

  it('normalizes legacy turn metadata into canonical turn events', () => {
    const event = normalizeCliEventFromMeta({
      type: 'turn',
      role: 'assistant',
      content: 'Done.',
      ts: 2000
    });

    expect(event).toEqual({
      type: 'assistant_turn',
      content: 'Done.',
      ts: 2000,
      source: 'pty'
    });
  });

  it('returns null for unknown event payloads', () => {
    expect(normalizeCliEventFromMeta({ type: 'cli_event', event: { type: 'unknown' } })).toBeNull();
  });

  it('normalizes prompt option payloads on canonical prompt events', () => {
    const event = normalizeCliEventFromMeta({
      type: 'cli_event',
      event: {
        type: 'prompt_required',
        prompt: 'Update available!',
        actions: ['enter'],
        options: [
          { label: '1. Update now', payload: '\r', kind: 'primary' },
          { label: '2. Skip', payload: '\u001b[B\r', kind: 'secondary' }
        ],
        ts: 3000,
        source: 'pty'
      }
    });

    expect(event).toEqual({
      type: 'prompt_required',
      prompt: 'Update available!',
      actions: ['enter'],
      options: [
        { label: '1. Update now', payload: '\r', kind: 'primary' },
        { label: '2. Skip', payload: '\u001b[B\r', kind: 'secondary' }
      ],
      ts: 3000,
      source: 'pty'
    });
  });
});
