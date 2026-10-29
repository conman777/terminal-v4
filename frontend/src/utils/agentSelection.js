import { serviceTierEntry } from './agentServiceTier';

const KEY = 'terminalV4AgentModels';

export function loadSavedAgentSelection(agentId) {
  try {
    const value = JSON.parse(localStorage.getItem(KEY) || '{}')?.[agentId];
    return typeof value?.model === 'string' ? { model: value.model, reasoning: typeof value.reasoning === 'string' ? value.reasoning : '', ...serviceTierEntry(value.serviceTier) } : null;
  } catch { return null; }
}

export function saveAgentSelection(agentId, selection) {
  try {
    const values = JSON.parse(localStorage.getItem(KEY) || '{}');
    localStorage.setItem(KEY, JSON.stringify({ ...values, [agentId]: { model: selection.model, reasoning: selection.reasoning || '', ...serviceTierEntry(selection.serviceTier) } }));
  } catch { /* The current choice remains usable without browser storage. */ }
}
