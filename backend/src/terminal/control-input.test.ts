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

  it('detects primary and secondary device attribute replies', () => {
    expect(isTerminalControlResponseInput('\x1b[?1;2c')).toBe(true);
    expect(isTerminalControlResponseInput('\x1b[>0;276;0c')).toBe(true);
  });

  it('keeps interactive keys and commands untouched', () => {
    expect(isTerminalControlResponseInput('\x1b[A')).toBe(false);
    expect(isTerminalControlResponseInput('\r')).toBe(false);
    expect(isTerminalControlResponseInput('echo hello\r')).toBe(false);
  });
});
