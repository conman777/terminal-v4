import { apiFetch } from './api';
import { buildAgentLaunchCommand } from './aiProviders';

export async function resolveAgentLaunchCommand(agentId, selection = null, customProviders = []) {
  const custom = customProviders.find(provider => provider.id === agentId);
  if (custom) return custom.initialCommand;
  const response = await apiFetch('/api/agent/catalog');
  const catalog = await response.json();
  if (!response.ok) throw new Error(catalog.error || 'Unable to load agent launcher');
  const agent = catalog.agents?.find(candidate => candidate.id === agentId);
  if (!agent) throw new Error('This agent is unavailable on the current host');
  return buildAgentLaunchCommand({
    agent: agentId,
    model: selection?.model ?? agent.models?.find(model => model.default)?.id ?? agent.models?.[0]?.id ?? '',
    reasoning: selection?.reasoning || '',
    launchCommand: agent.launchCommand,
    hostShell: agent.hostShell,
    available: agent.available,
  });
}
