import { describe, expect, it, vi } from 'vitest';
import { buildTurnsFromHistory, TurnDetector } from './turn-detector';

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

  it('emits prompt_required canonical event for interactive safety prompts', () => {
    vi.useFakeTimers();
    const turns = [];
    const events = [];
    const detector = new TurnDetector(
      (turn) => turns.push(turn),
      (event) => events.push(event)
    );

    detector.onPtyOutput([
      'Accessing workspace: C:\\repo\\terminal-v4',
      'Quick safety check: Is this a project you created or one you trust?',
      '1. Yes, trust this folder',
      '2. No, exit',
      'Enter to confirm Esc to cancel',
      '> '
    ].join('\n'), 10_000);

    vi.advanceTimersByTime(600);

    expect(turns).toEqual([]);
    expect(events).toEqual([
      expect.objectContaining({
        type: 'prompt_required',
        source: 'pty'
      })
    ]);

    detector.dispose();
    vi.useRealTimers();
  });

  it('emits prompt_required with labeled options for Codex update menus', () => {
    vi.useFakeTimers();
    const turns = [];
    const events = [];
    const detector = new TurnDetector(
      (turn) => turns.push(turn),
      (event) => events.push(event)
    );

    detector.onPtyOutput([
      'Update available! 0.110.0 -> 0.111.0',
      'Release notes: https://github.com/openai/codex/releases/latest',
      '› 1. Update now (runs `npm install -g @openai/codex`)',
      '2. Skip',
      '3. Skip until next version',
      'Press enter to continue'
    ].join('\n'), 12_000);

    vi.advanceTimersByTime(600);

    expect(turns).toEqual([]);
    expect(events).toEqual([
      expect.objectContaining({
        type: 'prompt_required',
        prompt: 'Update available! 0.110.0 -> 0.111.0',
        actions: ['enter'],
        options: [
          {
            label: '1. Update now (runs `npm install -g @openai/codex`)',
            payload: '\r',
            kind: 'primary'
          },
          {
            label: '2. Skip',
            payload: '\u001b[B\r',
            kind: 'secondary'
          },
          {
            label: '3. Skip until next version',
            payload: '\u001b[B\u001b[B\r',
            kind: 'secondary'
          }
        ],
        source: 'pty'
      })
    ]);

    detector.dispose();
    vi.useRealTimers();
  });

  it('buffers chunked user input until enter before emitting a user turn', () => {
    const turns = [];
    const detector = new TurnDetector((turn) => turns.push(turn));

    detector.onUserInput('/mod');
    detector.onUserInput('el');
    detector.onUserInput('\r');

    expect(turns).toEqual([
      { role: 'user', content: '/model', ts: expect.any(Number) }
    ]);

    detector.dispose();
  });

  it('filters assistant status footer noise from PTY output', () => {
    vi.useFakeTimers();
    const turns = [];
    const detector = new TurnDetector((turn) => turns.push(turn));

    detector.onPtyOutput([
      'ts\\coding projects\\uplifting | 🪟 Opus 4.6 | 💰 $0.51 session / $0.00 today / $0.00 block (3h 3m left) | 🔥 $0.00/hr | 🧠 58,776 (29%)',
      '> '
    ].join('\n'), 11_000);

    vi.advanceTimersByTime(600);

    expect(turns).toEqual([]);

    detector.dispose();
    vi.useRealTimers();
  });
});
