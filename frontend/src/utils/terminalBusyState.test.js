import { describe, expect, it } from 'vitest';
import { cliEventIndicatesTerminalIdle, outputIndicatesTerminalIdle, screenShowsShellPrompt } from './terminalBusyState';

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

  it('detects the default macOS zsh prompt after bracketed-paste codes', () => {
    expect(outputIndicatesTerminalIdle('\x1b[Jconordart@host ~ % \x1b[K\x1b[?2004h')).toBe(true);
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

describe('screenShowsShellPrompt', () => {
  it('recognises shell prompts but not agent prompts or running output', () => {
    const screens = ['user@host ~ %', 'user@host:~/project$', 'PS C:\\work>', '❯ Try "create a util"', '> ', 'Compiling crate'];
    expect(screens.map(screenShowsShellPrompt)).toEqual([true, true, true, false, false, false]);
  });
});
