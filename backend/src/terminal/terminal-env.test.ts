import { describe, expect, it } from 'vitest';
import { buildInteractiveTerminalEnv } from './terminal-env';

describe('buildInteractiveTerminalEnv', () => {
  it('forces TERM fallback when TERM is missing', () => {
    const env = buildInteractiveTerminalEnv({}, {});

    expect(env.TERM).toBe('xterm-256color');
  });

  it('forces TERM fallback when TERM is dumb', () => {
    const env = buildInteractiveTerminalEnv({ TERM: 'dumb' }, {});

    expect(env.TERM).toBe('xterm-256color');
  });

  it('keeps valid TERM values from overrides', () => {
    const env = buildInteractiveTerminalEnv({ TERM: 'dumb' }, { TERM: 'xterm-256color' });

    expect(env.TERM).toBe('xterm-256color');
  });

  it('adds color and terminal program defaults', () => {
    const env = buildInteractiveTerminalEnv({}, {});

    expect(env.COLORTERM).toBe('truecolor');
    expect(env.TERM_PROGRAM).toBe('terminal-v4');
  });
});
