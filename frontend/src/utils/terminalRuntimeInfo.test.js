import { describe, expect, it } from 'vitest';
import { parseTerminalRuntimeInfo } from './terminalRuntimeInfo';

describe('parseTerminalRuntimeInfo', () => {
  it('parses Claude runtime status lines', () => {
    expect(parseTerminalRuntimeInfo('Opus 4.6 | Ctx: 11% | USD 0.1051 | v2.1.71', 'claude')).toEqual({
      label: 'Opus 4.6 · Ctx 11%'
    });
  });

  it('parses Codex runtime status lines', () => {
    expect(parseTerminalRuntimeInfo('gpt-5.4 high 100% left ~\\OneDrive\\Personal\\Documents\\coding', 'codex')).toEqual({
      label: 'gpt-5.4 high · 100% left'
    });
  });

  it('returns null when no recognizable runtime info exists', () => {
    expect(parseTerminalRuntimeInfo('C:\\repo>', 'codex')).toBeNull();
  });
});
