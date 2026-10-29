import { beforeEach, describe, expect, it } from 'vitest';
import { readPromptHistory, recordPrompt, stepPromptHistory } from './promptHistory';
import { setActiveEnvironment } from '../../utils/remoteEnvironments';
import { addContext, buildThreadContext } from './composerContext';

beforeEach(() => { localStorage.clear(); setActiveEnvironment(null); });

describe('stepPromptHistory', () => {
  const entries = ['one', 'two', 'three'];
  it('walks back from the newest and forward to an empty composer', () => {
    const up1 = stepPromptHistory(entries, -1, 'up');
    const up2 = stepPromptHistory(entries, up1.index, 'up');
    expect([up1, up2]).toEqual([{ index: 2, text: 'three' }, { index: 1, text: 'two' }]);
    expect(stepPromptHistory(entries, 2, 'down')).toEqual({ index: -1, text: '' });
    expect(stepPromptHistory(entries, 0, 'up')).toEqual({ index: 0, text: 'one' });
  });
  it('does nothing without entries or when not browsing downward', () => {
    expect(stepPromptHistory([], -1, 'up')).toBeNull();
    expect(stepPromptHistory(entries, -1, 'down')).toBeNull();
  });
});

describe('recordPrompt', () => {
  it('stores prompts without context blocks, skips blanks and consecutive duplicates', () => {
    const withChip = addContext('fix it', buildThreadContext({ id: 't1', title: 'T' }));
    recordPrompt('s1', withChip);
    recordPrompt('s1', 'fix it');
    recordPrompt('s1', '   ');
    recordPrompt('s1', 'next');
    expect(readPromptHistory('s1')).toEqual(['fix it', 'next']);
  });
  it('caps stored entries', () => {
    for (let i = 0; i < 80; i += 1) recordPrompt('s1', `p${i}`);
    const entries = readPromptHistory('s1');
    expect([entries.length, entries.at(-1)]).toEqual([50, 'p79']);
  });
  it('is isolated per session and per environment', () => {
    recordPrompt('s1', 'mine');
    expect(readPromptHistory('s2')).toEqual([]);
    setActiveEnvironment({ id: 'env-b' });
    expect(readPromptHistory('s1')).toEqual([]);
    setActiveEnvironment(null);
    expect(readPromptHistory('s1')).toEqual(['mine']);
  });
  it('survives unreadable storage', () => {
    localStorage.setItem('promptHistory:v1:s1', '{bad');
    expect(readPromptHistory('s1')).toEqual([]);
  });
});
