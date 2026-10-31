import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { captureAuthScope, setUser } from './auth';
import { getEnvironmentCacheScope, getEnvironmentSignal, setActiveEnvironment, setEnvironmentIdentity } from './remoteEnvironments';
import { createTransferReviewStore } from './transferReviewStore';

function store(sessionId = 'synthetic-session') {
  return createTransferReviewStore({ sessionId, auth: captureAuthScope(), environment: getEnvironmentCacheScope(), signal: getEnvironmentSignal() });
}

beforeEach(() => {
  localStorage.clear();
  setEnvironmentIdentity(null);
  setUser({ id: 'synthetic-owner' });
  setEnvironmentIdentity('synthetic-owner', window.location.origin);
});
afterEach(() => { vi.restoreAllMocks(); setActiveEnvironment(null); setEnvironmentIdentity(null); localStorage.clear(); });

describe('transfer review records', () => {
  it('survives store recreation while isolating sessions, accounts and environments', () => {
    const first = store();
    expect(first.mark()).toMatch(/^[0-9a-f-]{36}$/);
    expect(JSON.parse(store().getSnapshot())).toHaveLength(1);
    expect(JSON.parse(store('other-session').getSnapshot())).toEqual([]);
    setActiveEnvironment({ id: 'synthetic-remote' });
    expect(JSON.parse(store().getSnapshot())).toEqual([]);
    setActiveEnvironment(null);
    setUser({ id: 'other-owner' });
    setEnvironmentIdentity('other-owner', window.location.origin);
    expect(JSON.parse(store().getSnapshot())).toEqual([]);
    expect(first.mark()).toBeNull();
  });

  it('clears only displayed records and never clears a newer warning', () => {
    const first = store(), second = store();
    expect(first.mark()).toMatch(/^[0-9a-f-]{36}$/);
    const displayed = JSON.parse(second.getSnapshot());
    expect(first.clear(displayed)).toBe(true);
    expect(first.mark()).toMatch(/^[0-9a-f-]{36}$/);
    expect(second.clear(displayed)).toBe(true);
    expect(JSON.parse(first.getSnapshot())).toHaveLength(1);
  });

  it('tracks an exact in-flight record without confusing a newer record for it', () => {
    const first = store(), other = store();
    const id = first.mark();
    expect(first.status(id)).toBe('present');
    expect(other.clear([id])).toBe(true);
    expect(first.status(id)).toBe('missing');
    const newer = other.mark();
    expect(first.status(id)).toBe('missing');
    expect(first.status(newer)).toBe('present');
  });

  it('distinguishes a saved large-paste review without storing its content', () => {
    const review = store();
    const id = review.mark(undefined, 'large-paste');
    expect(review.status(id)).toBe('present');
    expect(review.kind(id)).toBe('large-paste');
    expect(localStorage.getItem(Object.keys(localStorage).find(key => key.startsWith('tv4:file-transfer-review:v1:')))).toBe('large-paste');
    expect(review.touch(id)).toBe(true);
    expect(review.status(id)).toBe('present');
    expect(review.kind(id)).toBe('large-paste');
  });

  it('notifies other same-tab subscribers and reports storage failures', () => {
    const first = store(), second = store(), changed = vi.fn();
    const unsubscribe = second.subscribe(changed);
    expect(first.mark()).toMatch(/^[0-9a-f-]{36}$/);
    expect(changed).toHaveBeenCalled();
    const ids = JSON.parse(second.getSnapshot());
    expect(second.clear(ids)).toBe(true);
    const original = Storage.prototype.setItem;
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (key, value) {
      if (key.startsWith('tv4:file-transfer-review:v1:')) throw new Error('storage unavailable');
      return original.call(this, key, value);
    });
    expect(first.mark()).toBeNull();
    expect(JSON.parse(second.getSnapshot())).toEqual([]);
    unsubscribe();
  });
});
