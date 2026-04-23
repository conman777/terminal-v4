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

  it('supports custom provider slash command catalogs', () => {
    const customProviders = [{
      id: 'qwen-3',
      label: 'Qwen 3',
      title: 'Qwen 3',
      initialCommand: 'qwen --fast',
      slashCommands: [
        { cmd: '/model', desc: 'Pick model' },
        { cmd: '/reset', desc: 'Reset session' },
      ]
    }];

    expect(getComposerSlashCommands('qwen-3', customProviders)).toEqual([
      { cmd: '/model', desc: 'Pick model' },
      { cmd: '/reset', desc: 'Reset session' },
    ]);
  });

  it('filters slash suggestions by the current query', () => {
    expect(getComposerSlashSuggestions('/', 'claude')).toEqual(getComposerSlashCommands('claude'));
    expect(getComposerSlashSuggestions('/cl', 'claude')).toEqual([
      { cmd: '/clear', desc: 'Clear conversation' },
    ]);
    expect(getComposerSlashSuggestions('/m', 'codex')).toEqual([
      { cmd: '/model', desc: 'Change AI model' },
    ]);
    expect(getComposerSlashSuggestions('/re', 'qwen-3', [{
      id: 'qwen-3',
      label: 'Qwen 3',
      title: 'Qwen 3',
      initialCommand: 'qwen --fast',
      slashCommands: [
        { cmd: '/model', desc: 'Pick model' },
        { cmd: '/reset', desc: 'Reset session' },
      ]
    }])).toEqual([
      { cmd: '/reset', desc: 'Reset session' },
    ]);
    expect(getComposerSlashSuggestions('/', 'shell')).toEqual([]);
    expect(getComposerSlashSuggestions('hello', 'claude')).toEqual([]);
  });
});
