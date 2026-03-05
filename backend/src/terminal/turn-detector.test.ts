import { describe, expect, it } from 'vitest';
import { buildTurnsFromHistory } from './turn-detector';

describe('buildTurnsFromHistory', () => {
  it('skips interactive Claude safety prompts', () => {
    const turns = buildTurnsFromHistory([
      {
        text: [
          'Accessing workspace: C:\\repo\\terminal-v4',
          'Quick safety check: Is this a project you created or one you trust?',
          '1. Yes, trust this folder',
          '2. No, exit',
          'Enter to confirm Esc to cancel',
          '> '
        ].join('\n'),
        ts: 1_000
      }
    ]);

    expect(turns).toEqual([]);
  });

  it('keeps normal assistant output and user input turns', () => {
    const turns = buildTurnsFromHistory([
      {
        text: [
          '> run tests',
          'All tests passed.',
          '> '
        ].join('\n'),
        ts: 2_000
      }
    ]);

    expect(turns).toEqual([
      { role: 'user', content: 'run tests', ts: 2_000 },
      { role: 'assistant', content: 'All tests passed.', ts: 2_001 }
    ]);
  });

  it('filters Claude startup/banner noise and keeps the real assistant reply', () => {
    const turns = buildTurnsFromHistory([
      {
        text: [
          '> Say hello in one sentence.',
          '(c) Microsoft Corporation. All rights reserved.',
          'C:\\Users\\conor\\OneDrive\\Personal\\Documents\\coding projects\\terminal v4>claude --dangerously-skip-permissions',
          '▐▛███▜▌ Claude Code v2.1.68',
          'Sonnet 4.6 · Claude Max',
          'Found1settingsissue·/doctorfordetails',
          '> Say hello in one sentence.',
          'Hello there.',
          '> '
        ].join('\n'),
        ts: 3_000
      }
    ]);

    expect(turns).toEqual([
      { role: 'user', content: 'Say hello in one sentence.', ts: 3_000 },
      { role: 'assistant', content: 'Hello there.', ts: 3_001 }
    ]);
  });

  it('ignores Claude bypass-permissions selector noise', () => {
    const turns = buildTurnsFromHistory([
      {
        text: [
          '▸ bypass permissions on (shift+tab to cycle)',
          '> '
        ].join('\n'),
        ts: 4_000
      }
    ]);

    expect(turns).toEqual([]);
  });
});
