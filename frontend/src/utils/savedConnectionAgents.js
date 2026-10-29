const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const NIL = '00000000-0000-0000-0000-000000000000';
const PROTOCOLS = { chat: 'openai-chat', responses: 'openai-responses' };

export function savedConnectionBinding(id) {
  if (typeof id !== 'string') return null;
  const parts = id.split(':');
  if (parts.length !== 4 || parts[0] !== 'v4-profile' || !Object.hasOwn(PROTOCOLS, parts[1])) return null;
  const [, protocol, profileId, revision] = parts;
  if ([profileId, revision].some(value => value.length !== 36 || value === NIL || !UUID.test(value))) return null;
  return { profileId, revision, transport: PROTOCOLS[protocol] };
}

export function savedConnectionOptions(catalog) {
  if (!Array.isArray(catalog?.agents) || catalog.agents.length > 1024) return [];
  const options = [];
  const counts = new Map();
  for (const agent of catalog.agents) counts.set(agent?.id, (counts.get(agent?.id) || 0) + 1);
  for (const agent of catalog.agents) {
    const binding = savedConnectionBinding(agent?.id);
    if (!binding || counts.get(agent.id) !== 1 || agent.runtime !== 'v4' || agent.capabilities?.structured !== true) continue;
    if (Object.entries(binding).some(([key, value]) => agent.connectionProfile?.[key] !== value)) continue;
    const label = typeof agent.label === 'string' ? agent.label.trim() : '';
    if (!label || label.length > 160 || /[\x00-\x1f\x7f]/.test(label)) continue;
    options.push({ id: agent.id, label, title: label, available: agent.available === true });
    if (options.length === 128) break;
  }
  return options;
}
