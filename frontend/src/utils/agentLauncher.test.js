import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveAgentLaunchCommand, resolveAgentSessionLaunch } from './agentLauncher';
const apiFetch = vi.hoisted(() => vi.fn());
vi.mock('./api', () => ({ apiFetch }));
describe('resolveAgentLaunchCommand', () => {
  beforeEach(() => apiFetch.mockReset());
  it('uses fresh host launcher metadata and native configured defaults', async () => {
    apiFetch.mockResolvedValue({ ok: true, json: async () => ({ agents: [{ id: 'claude', available: true, launchCommand: '"C:\\Claude\\claude.exe"', hostShell: 'cmd', models: [] }] }) });
    expect(await resolveAgentLaunchCommand('claude')).toBe('"C:\\Claude\\claude.exe"');
    expect(apiFetch).toHaveBeenCalledWith('/api/agent/catalog');
  });
  it('never launches an unavailable native or API runtime', async () => {
    apiFetch.mockResolvedValue({ ok: true, json: async () => ({ agents: [{ id: 'deepseek', available: false, models: [] }] }) });
    await expect(resolveAgentLaunchCommand('deepseek')).rejects.toThrow(/unavailable/i);
  });
  it('preserves explicitly configured custom commands without substituting a catalog runner', async () => {
    expect(await resolveAgentLaunchCommand('private-agent', null, [{ id: 'private-agent', initialCommand: 'my-agent --private' }])).toBe('my-agent --private');
    expect(apiFetch).not.toHaveBeenCalled();
  });
});

it('drops stale reasoning settings that the current V4 adapter does not support', async () => {
  apiFetch.mockResolvedValue({ok:true,json:async()=>({agents:[{id:'deepseek',available:true,models:[{id:'fixture-model',default:true}],reasoningLevels:[],launchCommand:"'/V4/terminal-v4-api' agent --owner-hex 6f776e6572"}]})});
  expect(await resolveAgentLaunchCommand('deepseek',{model:'fixture-model',reasoning:'xhigh'})).toBe("'/V4/terminal-v4-api' agent --owner-hex 6f776e6572 --provider 'deepseek' --model 'fixture-model'");
});


describe('resolveAgentSessionLaunch', () => {
  it('opens native Codex as a conversation without constructing a terminal command', async () => {
    apiFetch.mockResolvedValue({ ok: true, json: async () => ({ agents: [{ id: 'codex', runtime: 'codex', available: true, capabilities: { structured: true }, reasoningLevels: ['high'], models: [{ id: 'local-model', reasoningLevels: ['high'] }] }] }) });
    expect(await resolveAgentSessionLaunch('codex', { model: 'local-model', reasoning: 'high' })).toEqual({ kind: 'structured', provider: 'codex', model: 'local-model', reasoning: 'high' });
  });
  it.each([['fast', { serviceTier: 'fast' }], [null, { serviceTier: null }], [undefined, {}]])('passes a Codex speed of %s through to session creation', async (serviceTier, expected) => {
    apiFetch.mockResolvedValue({ ok: true, json: async () => ({ agents: [{ id: 'codex', runtime: 'codex', available: true, capabilities: { structured: true }, reasoningLevels: ['high'], models: [{ id: 'local-model', reasoningLevels: ['high'] }] }] }) });
    const selection = { model: 'local-model', reasoning: 'high', ...(serviceTier !== undefined ? { serviceTier } : {}) };
    expect(await resolveAgentSessionLaunch('codex', selection)).toEqual({ kind: 'structured', provider: 'codex', model: 'local-model', reasoning: 'high', ...expected });
  });
  it('opens native Claude Code as a conversation with its effort level', async () => {
    apiFetch.mockResolvedValue({ ok: true, json: async () => ({ agents: [{ id: 'claude', runtime: null, available: true, capabilities: { structured: true }, reasoningLevels: ['low', 'high'], models: [{ id: 'sonnet', default: true }] }] }) });
    expect(await resolveAgentSessionLaunch('claude', { model: 'sonnet', reasoning: 'high' })).toEqual({ kind: 'structured', provider: 'claude', model: 'sonnet', reasoning: 'high' });
  });
  it('does not send a Codex speed to V4 providers', async () => {
    apiFetch.mockResolvedValue({ ok: true, json: async () => ({ agents: [{ id: 'openai-api', runtime: 'v4', available: true, capabilities: { structured: true }, reasoningLevels: [], models: [] }] }) });
    expect(await resolveAgentSessionLaunch('openai-api', { model: 'chosen-model', serviceTier: 'fast' })).toEqual({ kind: 'structured', provider: 'openai-api', model: 'chosen-model', reasoning: '' });
  });
  it('uses live V4 capability and preserves selected model and supported reasoning', async () => {
    apiFetch.mockResolvedValue({ ok: true, json: async () => ({ agents: [{ id: 'openai-api', runtime: 'v4', available: true, capabilities: { structured: true }, reasoningLevels: ['low', 'high'], models: [{ id: 'chosen-model', reasoningLevels: ['low', 'high'] }] }] }) });
    expect(await resolveAgentSessionLaunch('openai-api', { model: 'chosen-model', reasoning: 'high' })).toEqual({ kind: 'structured', provider: 'openai-api', model: 'chosen-model', reasoning: 'high' });
  });
  it('drops unsupported reasoning and uses the provider default without a shell command', async () => {
    apiFetch.mockResolvedValue({ ok: true, json: async () => ({ agents: [{ id: 'deepseek', runtime: 'v4', available: true, capabilities: { structured: true }, reasoningLevels: [], models: [] }] }) });
    expect(await resolveAgentSessionLaunch('deepseek', { reasoning: 'xhigh' })).toEqual({ kind: 'structured', provider: 'deepseek', model: '', reasoning: '' });
  });
  it('preserves optional native and explicitly configured terminal launches', async () => {
    apiFetch.mockResolvedValue({ ok: true, json: async () => ({ agents: [{ id: 'gemini', available: true, launchCommand: 'gemini', models: [], capabilities: { structured: false } }] }) });
    expect(await resolveAgentSessionLaunch('gemini')).toEqual({ kind: 'terminal', initialCommand: 'gemini' });
    expect(await resolveAgentSessionLaunch('private', null, [{ id: 'private', initialCommand: 'custom --local' }])).toEqual({ kind: 'terminal', initialCommand: 'custom --local' });
  });
  it('rejects unavailable runtime configuration before creating a session', async () => {
    apiFetch.mockResolvedValue({ ok: true, json: async () => ({ agents: [{ id: 'openai-api', runtime: 'v4', available: false, capabilities: { structured: true } }] }) });
    await expect(resolveAgentSessionLaunch('openai-api')).rejects.toThrow(/unavailable|configured/i);
  });
});


it('uses exact model reasoning limits in native commands and owned session creation', async () => {
  apiFetch.mockResolvedValue({ ok: true, json: async () => ({ agents: [{ id: 'claude', available: true, launchCommand: 'claude', reasoningLevels: ['high','xhigh'], models: [{ id: 'limited', reasoningLevels: ['high'] }] }] }) });
  expect(await resolveAgentLaunchCommand('claude', { model: 'limited', reasoning: 'xhigh' })).toBe("claude --model 'limited'");
  apiFetch.mockResolvedValue({ ok: true, json: async () => ({ agents: [{ id: 'openai-api', runtime: 'v4', available: true, capabilities: { structured: true }, reasoningLevels: ['high'], models: [{ id: 'none', reasoningLevels: [] }] }] }) });
  expect(await resolveAgentSessionLaunch('openai-api', { model: 'none', reasoning: 'high' })).toEqual({ kind: 'structured', provider: 'openai-api', model: 'none', reasoning: '' });
  expect(await resolveAgentSessionLaunch('openai-api', { model: 'custom/unknown', reasoning: 'high' })).toEqual({ kind: 'structured', provider: 'openai-api', model: 'custom/unknown', reasoning: '' });
});
