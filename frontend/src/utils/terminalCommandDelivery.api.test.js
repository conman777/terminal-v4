import { beforeEach, describe, expect, it, vi } from 'vitest';
import { apiFetch } from './api';
import { claimTerminalCommand } from './terminalCommandDelivery';

vi.mock('./auth', () => ({
  getAccessToken: () => null, clearTokens: vi.fn(), refreshTokens: vi.fn(),
  getAuthInitializing: () => false, captureAuthScope: () => 'synthetic', isAuthScopeCurrent: () => true,
}));

describe('terminal HTTP writes and command recovery', () => {
  beforeEach(() => { localStorage.clear(); global.fetch = vi.fn(async () => ({ ok: true, status: 200 })); });

  function enterRecovery(id) {
    const lease = claimTerminalCommand(id, 'echo original');
    lease.beforeSend();
    lease.acceptText();
    return lease;
  }

  it.each(['accepted', 'rejected', 'unknown'])('invalidates Enter-only recovery before an intervening %s HTTP write', async outcome => {
    enterRecovery('synthetic-terminal');
    if (outcome === 'rejected') global.fetch.mockResolvedValueOnce({ ok: false, status: 403 });
    if (outcome === 'unknown') global.fetch.mockRejectedValueOnce(new TypeError('Synthetic lost receipt'));
    await apiFetch('/api/terminal/synthetic-terminal/input', { method: 'POST', body: { command: '_edit' } }).catch(() => {});
    expect(() => claimTerminalCommand('synthetic-terminal', 'echo original')).toThrow(/replay is blocked/);
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it('invalidates an in-flight lease even when it was already uncertain', async () => {
    const lease = claimTerminalCommand('synthetic-terminal', 'echo original');
    lease.beforeSend();
    await apiFetch('/api/terminal/synthetic-terminal/input', { method: 'POST', body: { command: '\u0003' } });
    expect(() => lease.acceptText()).toThrow();
    expect(() => claimTerminalCommand('synthetic-terminal', 'echo original')).toThrow(/replay is blocked/);
  });

  it('keeps composer-owned writes on the same lease and strips lease metadata from fetch', async () => {
    const lease = claimTerminalCommand('synthetic-terminal', 'echo original');
    lease.beforeSend();
    await apiFetch('/api/terminal/synthetic-terminal/input', { method: 'POST', body: { command: 'echo original' }, terminalDelivery: lease });
    lease.acceptText();
    lease.beforeSend();
    await apiFetch('/api/terminal/synthetic-terminal/input', { method: 'POST', body: { command: '\r' }, terminalDelivery: lease });
    lease.complete();
    expect(global.fetch.mock.calls.map(([, options]) => options.terminalDelivery)).toEqual([undefined, undefined]);
  });

  it('rejects a stale lease before dispatch and isolates recovery by session', async () => {
    const lease = enterRecovery('synthetic-terminal');
    await apiFetch('/api/terminal/other-terminal/input', { method: 'POST', body: { command: 'other input' } });
    lease.beforeSend();
    await apiFetch('/api/terminal/synthetic-terminal/input', { method: 'POST', body: { command: '_edit' } });
    await expect(apiFetch('/api/terminal/synthetic-terminal/input', { method: 'POST', body: { command: '\r' }, terminalDelivery: lease })).rejects.toThrow();
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  it('sends no intervening input if its recovery invalidation cannot be saved', async () => {
    enterRecovery('synthetic-terminal');
    const save = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('Synthetic quota failure'); });
    try {
      await expect(apiFetch('/api/terminal/synthetic-terminal/input', { method: 'POST', body: { command: '_edit' } })).rejects.toThrow('No input was sent');
      expect(global.fetch).not.toHaveBeenCalled();
    } finally { save.mockRestore(); }
    expect(claimTerminalCommand('synthetic-terminal', 'echo original').phase).toBe('submit');
  });

  it('cannot use a composer lease to bypass invalidation for a different session', async () => {
    const lease = enterRecovery('synthetic-terminal');
    lease.beforeSend();
    await expect(apiFetch('/api/terminal/other-terminal/input', { method: 'POST', body: { command: '\r' }, terminalDelivery: lease })).rejects.toThrow('does not belong');
    expect(global.fetch).not.toHaveBeenCalled();
  });
});
