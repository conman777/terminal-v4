import { describe, it, expect } from 'vitest';
import { savedConnectionBinding, savedConnectionOptions } from './savedConnectionAgents';
import { normalizeAiType, getAiProvider, getAiLaunchCommand, getAiInitialCommand, shouldCreateStructuredSession, buildAgentLaunchCommand, buildCustomAiProvider } from './aiProviders';

const profileId = '10000000-0000-4000-8000-000000000001';
const revision = '60000000-0000-4000-8000-000000000001';
const id = `v4-profile:chat:${profileId}:${revision}`;
const agent = { id, label: 'LM Studio local · 00000001', runtime: 'v4', available: true, connectionProfile: { profileId, revision, transport: 'openai-chat' }, capabilities: { structured: true, cli: false } };

describe('saved connection agents', () => {
  it('recognizes the exact canonical profile, revision and protocol without account or endpoint data', () => {
    expect(savedConnectionBinding(id)).toEqual({ profileId, revision, transport: 'openai-chat' });
    expect(savedConnectionBinding(id.replace(':chat:', ':responses:'))).toEqual({ profileId, revision, transport: 'openai-responses' });
    for (const invalid of [null, '', id.toUpperCase(), `${id}:extra`, id.replace(':chat:', ':anthropic:'), id.replace(profileId, '../private'), id.replace(revision, '00000000-0000-0000-0000-000000000000'), `https://${id}`, id.replace(profileId, `${profileId}\n`)]) {
      expect(savedConnectionBinding(invalid)).toBeNull();
    }
  });

  it('gives saved connections a V4 conversation identity with no terminal command', () => {
    expect(normalizeAiType(id)).toBe(id);
    expect(shouldCreateStructuredSession(id)).toBe(true);
    expect(getAiProvider(id)).toMatchObject({ id, capabilities: { prefersStructuredUi: true, supportsStructuredEvents: true, supportsPromptEvents: true } });
    expect(getAiLaunchCommand(id)).toBe('');
    expect(getAiInitialCommand(id)).toBe('');
    expect(() => buildAgentLaunchCommand({ agent: id, model: 'selected' })).toThrow();
    expect(buildCustomAiProvider({ id, label: 'Masquerade', initialCommand: 'arbitrary-shell-command' })).toBeNull();
  });

  it('offers only internally consistent V4 saved connections and preserves unavailable state', () => {
    const unavailable = { ...agent, id: id.replace(':chat:', ':responses:'), label: 'Actual local', available: false, connectionProfile: { profileId, revision, transport: 'openai-responses' } };
    expect(savedConnectionOptions({ agents: [agent, unavailable, { id: 'codex', label: 'Codex' }] })).toEqual([
      { id, label: agent.label, title: agent.label, available: true },
      { id: unavailable.id, label: unavailable.label, title: unavailable.label, available: false },
    ]);
    expect(savedConnectionOptions({ agents: [{ ...agent, runtime: 'unavailable' }] })).toEqual([]);
    expect(savedConnectionOptions({ agents: [{ ...agent, connectionProfile: { ...agent.connectionProfile, revision: profileId } }] })).toEqual([]);
    expect(savedConnectionOptions({ agents: [{ ...agent, label: 'bad\nlabel' }] })).toEqual([]);
    expect(savedConnectionOptions(null)).toEqual([]);
  });

  it('rejects duplicate profile identities even when only one duplicate has valid metadata', () => {
    const malformed = { ...agent, connectionProfile: { ...agent.connectionProfile, transport: 'openai-responses' } };
    const unavailable = { ...agent, available: false };
    expect(savedConnectionOptions({ agents: [malformed, unavailable] })).toEqual([]);
    expect(savedConnectionOptions({ agents: [unavailable, malformed] })).toEqual([]);
    expect(savedConnectionOptions({ agents: [agent, agent] })).toEqual([]);
  });
});
