import { afterEach, describe, expect, it } from 'vitest';
import { getActiveEnvironment, setActiveEnvironment, routeEnvironmentPath, getEnvironmentStorage, getEnvironmentSignal, setEnvironmentIdentity, restoreActiveEnvironment } from './remoteEnvironments';

afterEach(() => { setActiveEnvironment(null); setEnvironmentIdentity(null); localStorage.clear(); });
describe('paired environment routing', () => {
  it('routes runtime HTTP, preview and socket paths through the home proxy while keeping home authentication local', () => {
    setActiveEnvironment({ id: 'host-a', label: 'Build host' });
    expect(['/api/terminal', '/api/structured/sessions/x/ws', '/preview/5173/app', '/api/auth/refresh', '/api/environments', '/api/vault'].map(routeEnvironmentPath)).toEqual([
      '/api/environments/host-a/proxy/api/terminal', '/api/environments/host-a/proxy/api/structured/sessions/x/ws', '/api/environments/host-a/proxy/preview/5173/app', '/api/auth/refresh', '/api/environments', '/api/vault'
    ]);
  });
  it('isolates colliding session ids and layout storage across hosts and aborts old requests on switch', () => {
    const home = getEnvironmentStorage();
    home.setItem('lastActiveSession', 'local-session');
    const signal = getEnvironmentSignal();
    setActiveEnvironment({ id: 'host-a', label: 'Build host' });
    const remote = getEnvironmentStorage();
    remote.setItem('lastActiveSession', 'remote-session');
    expect([signal.aborted, home.getItem('lastActiveSession'), remote.getItem('lastActiveSession'), getActiveEnvironment().id]).toEqual([true, 'local-session', 'remote-session', 'host-a']);
  });
  it('does not rewrite external websites or an already proxied path', () => {
    setActiveEnvironment({ id: 'host-a' });
    expect(['https://example.com/api/a', '/api/environments/host-a/proxy/api/terminal'].map(routeEnvironmentPath)).toEqual(['https://example.com/api/a', '/api/environments/host-a/proxy/api/terminal']);
  });
});

describe('paired environment restoration', () => {
  it('restores only an authoritative device record for the same home identity', () => {
    setEnvironmentIdentity('alice', 'https://home.example');
    setActiveEnvironment({ id: 'same-device', label: 'Old label', token: 'never-persist-this' });
    const selectedStorage = getEnvironmentStorage();
    selectedStorage.setItem('lastActiveSession', 'alice-terminal');
    setEnvironmentIdentity(null, 'https://home.example');
    setEnvironmentIdentity('bob', 'https://home.example');
    expect(restoreActiveEnvironment([{ id: 'same-device', label: 'Bob device' }])).toBeNull();
    getEnvironmentStorage().setItem('lastActiveSession', 'bob-terminal');
    setEnvironmentIdentity('alice', 'https://home.example');
    const record = { id: 'same-device', label: 'Updated authoritative label' };
    expect(restoreActiveEnvironment([record])).toEqual(record);
    expect(getEnvironmentStorage().getItem('lastActiveSession')).toBe('alice-terminal');
    expect(JSON.stringify({ ...localStorage })).not.toContain('never-persist-this');
    setEnvironmentIdentity('alice', 'https://different-home.example');
    expect(restoreActiveEnvironment([record])).toBeNull();
  });
  it('returns home and forgets deleted or revoked devices instead of trusting stored metadata', () => {
    setEnvironmentIdentity('alice');
    setActiveEnvironment({ id: 'removed' });
    setEnvironmentIdentity(null);
    setEnvironmentIdentity('alice');
    expect(restoreActiveEnvironment([{ id: 'removed', revoked: true }])).toBeNull();
    expect(getActiveEnvironment()).toBeNull();
    expect(restoreActiveEnvironment([{ id: 'removed' }])).toBeNull();
  });
  it('isolates storage objects retained by old workspaces across identity changes', () => {
    setEnvironmentIdentity('alice');
    const old = getEnvironmentStorage();
    old.setItem('lastActiveSession', 'old-session');
    const signal = getEnvironmentSignal();
    setEnvironmentIdentity('bob');
    old.setItem('lastActiveSession', 'late-alice-write');
    expect([signal.aborted, getEnvironmentStorage().getItem('lastActiveSession'), old.getItem('lastActiveSession')])
      .toEqual([true, null, 'late-alice-write']);
  });
});
