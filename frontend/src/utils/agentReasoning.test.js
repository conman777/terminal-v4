import { describe, expect, it } from 'vitest';
import { getAgentReasoningLevels, resolveAgentReasoning } from './agentReasoning';
describe('model reasoning capabilities', () => {
  const agent = { runtime: 'v4', reasoningLevels: ['high', 'xhigh'], models: [
    { id: 'limited', reasoningLevels: ['low', 'high'] }, { id: 'none', reasoningLevels: [] },
  ] };
  it('gives the selected model precedence over the provider union including explicit none', () => {
    expect([getAgentReasoningLevels(agent, 'limited'), getAgentReasoningLevels(agent, 'none')]).toEqual([['low', 'high'], []]);
    expect([resolveAgentReasoning(agent, 'limited', 'xhigh'), resolveAgentReasoning(agent, 'none', 'high')]).toEqual(['', '']);
  });
  it('keeps custom V4 models conservative and legacy native provider fallback compatible', () => {
    expect(getAgentReasoningLevels(agent, 'custom/unknown')).toEqual([]);
    expect(resolveAgentReasoning(agent, 'custom/unknown', 'high')).toBe('');
    expect(getAgentReasoningLevels({ reasoningLevels: ['high'], models: [{ id: 'legacy' }] }, 'legacy')).toEqual(['high']);
    expect(resolveAgentReasoning({ models: [{ id: 'legacy' }] }, 'legacy', 'high')).toBe('high');
  });
});
