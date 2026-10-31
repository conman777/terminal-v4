import { afterEach, describe, expect, it, vi } from 'vitest';

const key = 'terminal-v4-strict-auth-selection-v1';
afterEach(() => { vi.unstubAllGlobals(); sessionStorage.clear(); vi.resetModules(); });

describe('strict authentication tab fence', () => {
  it('persists strict selection across module reload and a cloned marker', async () => {
    const first = await import('./strictAuthBoundary');
    expect(first.isStrictAuthSelected()).toBe(false);
    expect(first.selectStrictAuth()).toBe(true);
    expect(sessionStorage.getItem(key)).toBe('strict-v1');
    vi.resetModules();
    const reloaded = await import('./strictAuthBoundary');
    expect(reloaded.isStrictAuthSelected()).toBe(true);
    expect(reloaded.selectStrictAuth()).toBe(true);
    expect(reloaded.legacyAuthSignal().aborted).toBe(true);
  });

  it('fails closed when marker storage is unavailable or corrupt', async () => {
    vi.stubGlobal('sessionStorage', { getItem() { throw new Error('storage denied'); } });
    let boundary = await import('./strictAuthBoundary');
    expect([boundary.isStrictAuthSelected(), boundary.selectStrictAuth()]).toEqual([true, false]);
    vi.unstubAllGlobals();
    sessionStorage.setItem(key, 'unknown-value');
    vi.resetModules();
    boundary = await import('./strictAuthBoundary');
    expect([boundary.isStrictAuthSelected(), boundary.selectStrictAuth()]).toEqual([true, false]);
    expect(sessionStorage.getItem(key)).toBe('unknown-value');
  });

  it('holds strict selection when the marker cannot be verified after a write', async () => {
    vi.stubGlobal('sessionStorage', { getItem: () => null, setItem() {} });
    const boundary = await import('./strictAuthBoundary');
    expect(boundary.isStrictAuthSelected()).toBe(false);
    expect(boundary.selectStrictAuth()).toBe(false);
    expect(boundary.isStrictAuthSelected()).toBe(true);
    expect(boundary.legacyAuthSignal().aborted).toBe(true);
  });

  it('fails closed when a marker becomes corrupt after bootstrap', async () => {
    const boundary = await import('./strictAuthBoundary');
    expect(boundary.isStrictAuthSelected()).toBe(false);
    sessionStorage.setItem(key, 'synthetic-corruption');
    expect(boundary.isStrictAuthSelected()).toBe(true);
    expect(boundary.selectStrictAuth()).toBe(false);
    expect(boundary.legacyAuthSignal().aborted).toBe(true);
  });

  it('does not silently recreate a strict marker removed after selection', async () => {
    const boundary = await import('./strictAuthBoundary');
    expect(boundary.selectStrictAuth()).toBe(true);
    sessionStorage.removeItem(key);
    expect(boundary.isStrictAuthSelected()).toBe(true);
    expect(boundary.selectStrictAuth()).toBe(false);
    expect(sessionStorage.getItem(key)).toBeNull();
  });
});
