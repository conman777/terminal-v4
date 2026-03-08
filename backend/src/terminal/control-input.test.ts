import { describe, expect, it } from 'vitest';
import { isTerminalControlResponseInput } from './control-input';

describe('isTerminalControlResponseInput', () => {
  it('detects cursor position replies', () => {
    expect(isTerminalControlResponseInput('\x1b[12;1R')).toBe(true);
  });

  it('detects focus tracking replies', () => {
    expect(isTerminalControlResponseInput('\x1b[I')).toBe(true);
    expect(isTerminalControlResponseInput('\x1b[O')).toBe(true);
  });

  it('detects device attribute replies', () => {
    expect(isTerminalControlResponseInput('\x1b[?1;2c')).toBe(true);
  });

  it('allows arrow keys and normal input', () => {
    expect(isTerminalControlResponseInput('\x1b[A')).toBe(false);
    expect(isTerminalControlResponseInput('\r')).toBe(false);
    expect(isTerminalControlResponseInput('echo hello\r')).toBe(false);
  });

  it('allows pasted text wrapped in bracketed-paste markers', () => {
    expect(isTerminalControlResponseInput('\x1b[200~hello world\x1b[201~')).toBe(false);
  });
});
