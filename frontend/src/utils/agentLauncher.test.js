import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveAgentLaunchCommand } from './agentLauncher';
const apiFetch = vi.hoisted(() => vi.fn());
vi.mock('./api', () => ({ apiFetch }));
describe('resolveAgentLaunchCommand', () => {
  beforeEach(() => apiFetch.mockReset());
  it('uses fresh host launcher metadata and native configured defaults', async () => {
    apiFetch.mockResolvedValue({ ok: true, json: async () => ({ agents: [{ id: 'hermes', available: true, launchCommand: '"C:\\Hermes Agent\\hermes.exe"', hostShell: 'cmd', models: [] }] }) });
    expect(await resolveAgentLaunchCommand('hermes')).toBe('"C:\\Hermes Agent\\hermes.exe"');
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
