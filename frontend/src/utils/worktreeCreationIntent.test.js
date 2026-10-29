import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearTokens, setUser } from './auth';
import { setActiveEnvironment, setEnvironmentIdentity } from './remoteEnvironments';
import { prepareWorktreeCreation } from './worktreeCreationIntent';

describe('prepareWorktreeCreation', () => {
  beforeEach(() => {
    localStorage.clear();
    setEnvironmentIdentity('account-a');
    setUser({ id: 'account-a' });
  });
  afterEach(() => { vi.restoreAllMocks(); setActiveEnvironment(null); setEnvironmentIdentity(''); clearTokens(true); });

  it('persists only the operation ID and scopes it to user, environment, project and surface', () => {
    const first = prepareWorktreeCreation('/project', 'start');
    expect(prepareWorktreeCreation('/project', 'start').operationId).toBe(first.operationId);
    expect(prepareWorktreeCreation('/other', 'start').operationId).not.toBe(first.operationId);
    expect(prepareWorktreeCreation('/project', 'git-panel').operationId).not.toBe(first.operationId);
    const entries = Object.entries(localStorage).filter(([key]) => key.includes('worktreeCreation:v1:'));
    expect(entries.map(([, value]) => value)).toEqual(expect.arrayContaining([first.operationId]));
    setActiveEnvironment({ id: 'remote' });
    expect(prepareWorktreeCreation('/project', 'start').operationId).not.toBe(first.operationId);
    expect(() => first.assertCurrent()).toThrow(/environment changed/i);
    setActiveEnvironment(null);
    setUser({ id: 'account-b' });
    expect(prepareWorktreeCreation('/project', 'start').operationId).not.toBe(first.operationId);
    expect(() => first.complete()).toThrow(/account or environment changed/i);
  });

  it('requires authenticated identity and reliable storage before admission', () => {
    clearTokens(true);
    expect(() => prepareWorktreeCreation('/project', 'start')).toThrow(/sign in/i);
    setUser({ id: 'account-a' });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('storage unavailable'); });
    expect(() => prepareWorktreeCreation('/project', 'start')).toThrow(/could not safely save/i);
  });

  it('clears a completed identity only in its original scope', () => {
    const first = prepareWorktreeCreation('/project', 'start');
    first.complete();
    expect(prepareWorktreeCreation('/project', 'start').operationId).not.toBe(first.operationId);
  });
});
