export function getAgentReasoningLevels(agent, modelId) {
  const model = agent?.models?.find(candidate => candidate.id === modelId)
    || (!modelId ? agent?.models?.find(candidate => candidate.default) || agent?.models?.[0] : null);
  if (Array.isArray(model?.reasoningLevels)) return model.reasoningLevels;
  if (agent?.runtime === 'v4') return [];
  return Array.isArray(agent?.reasoningLevels) ? agent.reasoningLevels : null;
}

export function resolveAgentReasoning(agent, modelId, reasoning) {
  const levels = getAgentReasoningLevels(agent, modelId);
  return levels === null || levels.includes(reasoning) ? reasoning || '' : '';
}
