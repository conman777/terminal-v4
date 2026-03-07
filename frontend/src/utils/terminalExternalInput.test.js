import { describe, expect, it, vi } from 'vitest';
import {
  createExternalInputFrames,
  EXTERNAL_INPUT_SETTLE_DELAY_MS,
  EXTERNAL_INPUT_STEP_DELAY_MS,
  prepareTerminalForExternalInput,
} from './terminalExternalInput';

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

describe('createExternalInputFrames', () => {
  it('chunks plain text and leaves a settle delay after the final chunk', () => {
    expect(createExternalInputFrames('playwright')).toEqual([
      { data: 'play', delayAfterMs: EXTERNAL_INPUT_STEP_DELAY_MS },
      { data: 'wrig', delayAfterMs: EXTERNAL_INPUT_STEP_DELAY_MS },
      { data: 'ht', delayAfterMs: EXTERNAL_INPUT_SETTLE_DELAY_MS },
    ]);
  });

  it('keeps slash commands atomic so interactive CLIs receive the full command at once', () => {
    expect(createExternalInputFrames('/model')).toEqual([
      { data: '/model', delayAfterMs: 0 },
    ]);
  });

  it('keeps control sequences opaque', () => {
    expect(createExternalInputFrames('\r')).toEqual([{ data: '\r', delayAfterMs: 0 }]);
    expect(createExternalInputFrames('\x1b[B')).toEqual([{ data: '\x1b[B', delayAfterMs: 0 }]);
  });
});
