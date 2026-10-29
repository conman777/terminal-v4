import { apiFetch } from './api';
import { buildAgentLaunchCommand } from './aiProviders';
import { resolveAgentReasoning } from './agentReasoning';
import { serviceTierEntry } from './agentServiceTier';

export async function resolveAgentLaunchCommand(agentId, selection = null, customProviders = []) {
  const custom = customProviders.find(provider => provider.id === agentId);
  if (custom) return custom.initialCommand;
  const response = await apiFetch('/api/agent/catalog');
  const catalog = await response.json();
  if (!response.ok) throw new Error(catalog.error || 'Unable to load agent launcher');
  const agent = catalog.agents?.find(candidate => candidate.id === agentId);
  if (!agent) throw new Error('This agent is unavailable on the current host');
  const model = selection?.model ?? agent.models?.find(model => model.default)?.id ?? agent.models?.[0]?.id ?? '';
  return buildAgentLaunchCommand({
    agent: agentId, model,
    reasoning: resolveAgentReasoning(agent, model, selection?.reasoning),
    launchCommand: agent.launchCommand,
    hostShell: agent.hostShell,
    available: agent.available,
  });
}


export function isConversationAgent(agent) {
  return agent?.capabilities?.structured === true && agent.runtime !== 'unavailable';
}

export async function resolveAgentSessionLaunch(agentId, selection = null, customProviders = []) {
  const custom = customProviders.find(provider => provider.id === agentId);
  if (custom) return { kind: 'terminal', initialCommand: custom.initialCommand };
  const response = await apiFetch('/api/agent/catalog');
  const catalog = await response.json();
  if (!response.ok) throw new Error(catalog.error || 'Unable to load agent runtime');
  const agent = catalog.agents?.find(candidate => candidate.id === agentId);
  if (!agent || agent.available !== true) throw new Error('This agent is unavailable on the current host. Check its configuration in Settings.');
  const model = selection?.model ?? agent.models?.find(model => model.default)?.id ?? agent.models?.[0]?.id ?? '';
  const reasoning = resolveAgentReasoning(agent, model, selection?.reasoning);
  if (isConversationAgent(agent)) {
    return { kind: 'structured', provider: agentId, model, reasoning, ...(agent.runtime === 'codex' ? serviceTierEntry(selection?.serviceTier) : {}) };
  }
  return { kind: 'terminal', initialCommand: buildAgentLaunchCommand({ agent: agentId, model, reasoning, launchCommand: agent.launchCommand, hostShell: agent.hostShell, available: agent.available }) };
}
