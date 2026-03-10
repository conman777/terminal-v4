import { describe, expect, it } from 'vitest';
import { getComposerSlashCommands, getComposerSlashSuggestions } from './slashCommands';

describe('slashCommands', () => {
  it('returns the provider-specific slash command catalog', () => {
    expect(getComposerSlashCommands('claude')).toEqual([
      { cmd: '/model', desc: 'Change AI model' },
      { cmd: '/clear', desc: 'Clear conversation' },
      { cmd: '/help', desc: 'Show available commands' },
      { cmd: '/compact', desc: 'Toggle compact mode' },
      { cmd: '/cost', desc: 'Show token usage' },
    ]);
    expect(getComposerSlashCommands('codex')).toEqual([
      { cmd: '/model', desc: 'Change AI model' },
    ]);
    expect(getComposerSlashCommands('shell')).toEqual([]);
  });

  it('filters slash suggestions by the current query', () => {
    expect(getComposerSlashSuggestions('/', 'claude')).toEqual(getComposerSlashCommands('claude'));
    expect(getComposerSlashSuggestions('/cl', 'claude')).toEqual([
      { cmd: '/clear', desc: 'Clear conversation' },
    ]);
    expect(getComposerSlashSuggestions('/m', 'codex')).toEqual([
      { cmd: '/model', desc: 'Change AI model' },
    ]);
    expect(getComposerSlashSuggestions('/', 'shell')).toEqual([]);
    expect(getComposerSlashSuggestions('hello', 'claude')).toEqual([]);
  });
});
