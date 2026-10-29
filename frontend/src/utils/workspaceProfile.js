import { apiFetch } from './api';

export function buildWorkspaceContext(profile, selectedSkillIds = [], includeMemory = true) {
  const sections = [];
  if (includeMemory && profile?.memory?.trim()) {
    sections.push('Workspace knowledge:\n' + profile.memory.trim());
  }
  const selected = new Set(selectedSkillIds);
  for (const skill of profile?.skills || []) {
    if (selected.has(skill.id) && skill.instructions?.trim()) {
      const files = Object.entries(skill.supportFiles || {}).map(([path, content]) => '\nSupporting file: ' + path + '\n' + content).join('');
      sections.push('Skill: ' + skill.name + '\n' + skill.instructions.trim() + files);
    }
  }
  return sections.join('\n\n');
}

export function resolveWorkspaceDefaults(profile, options) {
  if (!profile?.defaultAgent || !options.some(option => option.id === profile.defaultAgent)) return null;
  const selection = profile.selection?.model?.trim() ? {
    model: profile.selection.model.trim(),
    reasoning: typeof profile.selection.reasoning === 'string' ? profile.selection.reasoning : '',
  } : null;
  return { agentId: profile.defaultAgent, selection };
}

export async function loadWorkspaceProfile(path, options = {}) {
  const response = await apiFetch('/api/workspace/profile?path=' + encodeURIComponent(path), options);
  const payload = await response.json();
  if (!response.ok) throw new Error(payload?.error || 'Unable to load workspace');
  return payload;
}

export async function saveWorkspaceProfile(path, profile) {
  const response = await apiFetch('/api/workspace/profile?path=' + encodeURIComponent(path), {
    method: 'PUT', body: profile,
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload?.error || 'Unable to save workspace');
  return payload;
}

export async function loadAccountKnowledge(options = {}) {
  const response = await apiFetch('/api/account/knowledge', options);
  const payload = await response.json();
  if (!response.ok) throw new Error(payload?.error || 'Unable to load account knowledge');
  return payload;
}

export async function saveAccountKnowledge(profile) {
  const response = await apiFetch('/api/account/knowledge', { method: 'PUT', body: profile });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload?.error || 'Unable to save account knowledge');
  return payload;
}
