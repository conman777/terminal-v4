import { describe, expect, it, vi } from 'vitest';
import { prepareTerminalForExternalInput } from './terminalExternalInput';

describe('prepareTerminalForExternalInput', () => {
  it('requests priority resize, focuses the terminal, and enables mobile input', () => {
    const calls = [];

    prepareTerminalForExternalInput({
      requestPriorityResize: () => calls.push('resize'),
      focusTerminal: () => calls.push('focus'),
      setMobileInputEnabled: (enabled) => calls.push(`mobile:${enabled}`),
    });

    expect(calls).toEqual(['resize', 'focus', 'mobile:true']);
  });

  it('swallows transient resize and focus errors while still enabling mobile input', () => {
    const setMobileInputEnabled = vi.fn();

    expect(() => {
      prepareTerminalForExternalInput({
        requestPriorityResize: () => {
          throw new Error('resize failed');
        },
        focusTerminal: () => {
          throw new Error('focus failed');
        },
        setMobileInputEnabled,
      });
    }).not.toThrow();

    expect(setMobileInputEnabled).toHaveBeenCalledWith(true);
  });
});
