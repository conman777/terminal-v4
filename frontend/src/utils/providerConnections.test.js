import { beforeEach, describe, expect, it, vi } from 'vitest';
import { connectionBody, connectionDraft, loadConnections, loadConnectionDiscovery, mutateConnection } from './providerConnections';
const apiFetch = vi.hoisted(() => vi.fn());
vi.mock('./api', () => ({ apiFetch }));
const P = '10000000-0000-4000-8000-000000000001';
const R = '20000000-0000-4000-8000-000000000001';
const O = '60000000-0000-4000-8000-000000000001';
const J = '50000000-0000-4000-8000-000000000001';
const saved = { profileId: P, revision: R, provider: 'actual', mode: 'local', baseUrl: 'http://127.0.0.1:8080/v1', authMode: 'none', clusterId: null, activation: 'ready' };
const reply = (value, status = 200) => ({ ok: status < 300, status, json: async () => value });
beforeEach(() => apiFetch.mockReset());
describe('original provider connections client', () => {
  it('keeps explicit /v1 prefixes and accepts other literal IPv4 loopback addresses', () => {
    const value = connectionBody({ ...connectionDraft(null), kind: 'lmstudio:local', baseUrl: 'http://127.0.0.2:1234/custom/v1' }, null, O);
    expect(value.baseUrl).toBe('http://127.0.0.2:1234/custom/v1');
  });
  it('rejects an unsupported Actual relay host and requires a new key for a changed credential target', () => {
    expect(() => connectionBody({ ...connectionDraft(null), kind: 'actual:relay', baseUrl: 'https://other.example.test/v1', secret: 'synthetic' }, null, O)).toThrow('https://api.actual.inc/v1');
    const local = { ...saved, provider: 'lmstudio', authMode: 'bearer' };
    expect(() => connectionBody({ ...connectionDraft(local), baseUrl: 'http://127.0.0.1:1235/custom/v1' }, local, O)).toThrow('replacement bearer key');
  });
  it.each(['loaded', 'available', 'imageInput', 'trainedForTools'])('rejects nonboolean advertised %s instead of treating it as yes', async field => {
    apiFetch.mockResolvedValue(reply({ requestId: J, profileId: P, status: 'succeeded', cancelRequested: false, cancelConfirmed: false, cleanupPending: false,
      models: [{ id: 'own-model', label: 'Own model', [field]: 'false' }] }));
    await expect(loadConnectionDiscovery(J)).rejects.toThrow('invalid');
  });
  it('rejects cancellation confirmation while cleanup is pending', async () => {
    apiFetch.mockResolvedValue(reply({ requestId: J, profileId: P, status: 'cancelled', cancelRequested: true, cancelConfirmed: true, cleanupPending: true, models: null }));
    await expect(loadConnectionDiscovery(J)).rejects.toThrow('invalid');
  });
  it('loads only through the Home authenticated API without caching', async () => {
    apiFetch.mockResolvedValue(reply({ profiles: [saved] }));
    expect(await loadConnections()).toEqual([saved]);
    expect(apiFetch).toHaveBeenCalledWith('/api/agent/connections', { home: true, cache: 'no-store' });
  });
  it('rejects malformed and duplicate saved identities', async () => {
    apiFetch.mockResolvedValue(reply({ profiles: [saved, saved] }));
    await expect(loadConnections()).rejects.toThrow('invalid');
    apiFetch.mockResolvedValue(reply({ profiles: [{ ...saved, revision: 'bad' }] }));
    await expect(loadConnections()).rejects.toThrow('invalid');
  });
  it.each(['http://localhost:8080/v1', 'http://192.168.1.9/v1', 'http://user:secret@127.0.0.1/v1', 'http://127.0.0.1/v1?key=x', 'http://127.0.0.1/v1#x', 'file:///v1', 'http://127.0.0.1/other'])('rejects unsafe or ambiguous local endpoint %s', baseUrl => {
    expect(() => connectionBody({ ...connectionDraft(null), baseUrl }, null, O)).toThrow();
  });
  it('keeps a saved bearer key without inventing a replacement and never fills it into a draft', () => {
    const relay = { ...saved, mode: 'relay', authMode: 'bearer', baseUrl: 'https://api.actual.inc/v1' };
    const draft = connectionDraft(relay);
    expect(draft.secret).toBe('');
    expect(connectionBody(draft, relay, O).auth).toEqual({ type: 'bearer', credentialAction: 'keep' });
    expect(connectionBody({ ...draft, secret: 'synthetic-new-key' }, relay, O).auth).toEqual({ type: 'bearer', credentialAction: 'replace', secret: 'synthetic-new-key' });
  });
  it('requires relay HTTPS and an explicitly entered first key', () => {
    expect(() => connectionBody({ ...connectionDraft(null), kind: 'actual:relay', baseUrl: 'http://relay.example.test/v1', secret: 'test' }, null, O)).toThrow('HTTPS');
    expect(() => connectionBody({ ...connectionDraft(null), kind: 'actual:relay', baseUrl: 'https://api.actual.inc/v1' }, null, O)).toThrow('bearer key');
  });
  it('binds a save response to the original profile, operation and revision', async () => {
    apiFetch.mockResolvedValue(reply({ profileId: P, operationId: J, savedRevision: R, settingsSaved: true, cleanupConfirmed: true, deleted: false, profile: saved }));
    await expect(mutateConnection({ method: 'PUT', profileId: P, body: { operationId: O } })).rejects.toThrow('invalid');
  });
  it('rejects mismatched discovery IDs and does not expose arbitrary error messages', async () => {
    apiFetch.mockResolvedValue(reply({ requestId: O }));
    await expect(loadConnectionDiscovery(J)).rejects.toThrow('invalid');
    apiFetch.mockResolvedValue(reply({ error: 'synthetic-private-key-from-upstream' }, 503));
    await expect(loadConnections()).rejects.toThrow('Connection storage is unavailable');
  });
});
