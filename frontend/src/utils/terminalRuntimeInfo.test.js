import { describe, expect, it } from 'vitest';
import { parseTerminalRuntimeInfo, resolveForegroundAiType } from './terminalRuntimeInfo';

describe('parseTerminalRuntimeInfo', () => {
  it('parses Claude runtime status lines', () => {
    expect(parseTerminalRuntimeInfo('Opus 4.6 | Ctx: 11% | USD 0.1051 | v2.1.71', 'claude')).toEqual({
      providerId: 'claude',
      label: 'Opus 4.6 | Ctx 11%'
    });
  });

  it('parses Codex runtime status lines', () => {
    expect(parseTerminalRuntimeInfo('gpt-5.4 high 100% left ~\\OneDrive\\Personal\\Documents\\coding', 'codex')).toEqual({
      providerId: 'codex',
      label: 'gpt-5.4 high | 100% left'
    });
  });

  it('auto-detects the active runtime when no aiType is selected', () => {
    expect(parseTerminalRuntimeInfo('gpt-5.4 high 100% left ~\\repo')).toEqual({
      providerId: 'codex',
      label: 'gpt-5.4 high | 100% left'
    });
  });

  it('auto-detects current Codex status lines without percent-left text', () => {
    expect(parseTerminalRuntimeInfo('gpt-5.5 xhigh · ~/terminal-v4 Goal achieved (2s)')).toEqual({
      providerId: 'codex',
      label: 'gpt-5.5 xhigh'
    });
  });

  it('ignores source code lines that contain Codex model regexes', () => {
    expect(parseTerminalRuntimeInfo('31 - const modelMatch = statusLine.match(/\\b(gpt-5(?:\\.\\d+)?(?:\\s+(?:xhigh|high|medium|low))?)/i);')).toBeNull();
  });

  it('returns null when no recognizable runtime info exists', () => {
    expect(parseTerminalRuntimeInfo('C:\\repo>', 'codex')).toBeNull();
  });
});

describe('resolveForegroundAiType', () => {
  it('drops a saved agent once its terminal is back at a shell prompt', () => {
    const results = [
      resolveForegroundAiType('claude', null, 'Claude Code v2\n❯ Try "fix"\n⏵⏵ auto mode on'),
      resolveForegroundAiType('claude', null, "conordart@host ~ % claude --model 'sonnet'\nconordart@host ~ %"),
      resolveForegroundAiType(null, { providerId: 'codex' }, 'OpenAI Codex'),
      resolveForegroundAiType('claude', null, ''),
    ];
    expect(results).toEqual(['claude', null, 'codex', 'claude']);
  });
});
