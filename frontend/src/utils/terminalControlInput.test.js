import { describe, expect, it } from 'vitest';
import { isTerminalControlResponseInput } from './terminalControlInput';

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

  it('keeps arrow keys and normal commands interactive', () => {
    expect(isTerminalControlResponseInput('\x1b[A')).toBe(false);
    expect(isTerminalControlResponseInput('\r')).toBe(false);
    expect(isTerminalControlResponseInput('echo hello\r')).toBe(false);
  });

  it('does not swallow bracketed paste payloads', () => {
    expect(isTerminalControlResponseInput('\x1b[200~hello world\x1b[201~')).toBe(false);
  });
});
