import { describe, expect, it } from 'vitest';
import { cliEventIndicatesTerminalIdle, outputIndicatesTerminalIdle } from './terminalBusyState';

describe('outputIndicatesTerminalIdle', () => {
  it('detects idle cmd prompts', () => {
    const output = [
      'Microsoft Windows [Version 10.0.26200.7840]',
      '(c) Microsoft Corporation. All rights reserved.',
      '',
      'C:\\Users\\conor\\OneDrive\\Personal\\Documents\\coding projects>'
    ].join('\r\n');

    expect(outputIndicatesTerminalIdle(output)).toBe(true);
  });

  it('detects prompt-only AI shells', () => {
    expect(outputIndicatesTerminalIdle('\n> \n')).toBe(true);
    expect(outputIndicatesTerminalIdle('\n❯\n')).toBe(true);
  });

  it('does not treat echoed commands as idle prompts', () => {
    expect(outputIndicatesTerminalIdle('C:\\Users\\conor>echo hello')).toBe(false);
  });
});

describe('cliEventIndicatesTerminalIdle', () => {
  it('clears busy on response boundaries and interactive prompts', () => {
    expect(cliEventIndicatesTerminalIdle({ type: 'assistant_turn' })).toBe(true);
    expect(cliEventIndicatesTerminalIdle({ type: 'prompt_required' })).toBe(true);
    expect(cliEventIndicatesTerminalIdle({ type: 'user_turn' })).toBe(false);
  });
});
