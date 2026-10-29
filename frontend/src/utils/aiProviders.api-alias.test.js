import { describe, expect, it } from 'vitest';
import { AI_TYPE_OPTIONS, getAiLaunchCommand, resolveSlashAgentCommand, rewriteTerminalAgentInput } from './aiProviders';

describe('API slash alias rejection', () => {
  it.each(AI_TYPE_OPTIONS.filter(({ id }) => getAiLaunchCommand(id) === 'terminal-v4-api').map(({ id }) => id))('rejects /%s before generating a server command', provider => {
    for (const suffix of ['', ' --model synthetic', ' agent --provider other']) {
      expect(() => resolveSlashAgentCommand(`/${provider}${suffix}`)).toThrow(/agent picker/i);
      expect(() => rewriteTerminalAgentInput(`/${provider}${suffix}\r\n`)).toThrow(/agent picker/i);
    }
  });

  it.each([
    ['/codex\r', 'codex --yolo\r'], ['/claude\r\n', 'claude --dangerously-skip-permissions\r\n'],
    ['/gemni\n', 'gemini --yolo\n'], ['/gemini --model example', 'gemini --model example'],
    ['/copilot-acp\n', 'copilot\n'], ['/clear', '/clear'], ['/compact', '/compact'], ['/help', '/help'], ['/cost', '/cost'],
    ['/model\r', '/model\r'], ['/unknown', '/unknown'], ['echo /deepseek', 'echo /deepseek'],
    ['\x1b[200~/deepseek\x1b[201~', '\x1b[200~/deepseek\x1b[201~'],
  ])('preserves native commands and ordinary input %j', (input, expected) => {
    expect(rewriteTerminalAgentInput(input)).toBe(expected);
  });
});
