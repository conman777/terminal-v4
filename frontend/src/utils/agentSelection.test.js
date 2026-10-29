import { beforeEach, describe, expect, it } from 'vitest';
import { loadSavedAgentSelection, saveAgentSelection } from './agentSelection';

const KEY = 'terminalV4AgentModels';

describe('agent selection persistence', () => {
  beforeEach(() => localStorage.clear());

  it.each([
    ['Fast', 'fast'],
    ['explicit native default', null],
  ])('round-trips a %s speed with the model and reasoning', (_, serviceTier) => {
    saveAgentSelection('codex', { model: 'gpt-5.5', reasoning: 'high', serviceTier, available: true });
    expect(loadSavedAgentSelection('codex')).toEqual({ model: 'gpt-5.5', reasoning: 'high', serviceTier });
  });

  it('keeps an old selection without speed unspecified instead of forcing a tier', () => {
    localStorage.setItem(KEY, JSON.stringify({ codex: { model: 'gpt-5.5', reasoning: 'high' } }));
    expect(loadSavedAgentSelection('codex')).toEqual({ model: 'gpt-5.5', reasoning: 'high' });
    saveAgentSelection('codex', { model: 'gpt-5.6-sol', reasoning: 'low' });
    expect(JSON.parse(localStorage.getItem(KEY))).toEqual({ codex: { model: 'gpt-5.6-sol', reasoning: 'low' } });
  });

  it('drops an invalid stored speed', () => {
    localStorage.setItem(KEY, JSON.stringify({ codex: { model: 'gpt-5.5', reasoning: 'high', serviceTier: 'turbo' } }));
    expect(loadSavedAgentSelection('codex')).toEqual({ model: 'gpt-5.5', reasoning: 'high' });
  });
});
