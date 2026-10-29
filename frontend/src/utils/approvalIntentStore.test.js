import { describe, expect, it } from 'vitest';
import { createApprovalIntentStore } from './approvalIntentStore';

function setup() {
  const values = new Map();
  const storage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) };
  const store = createApprovalIntentStore(storage, callback => Promise.resolve().then(callback), () => true, 'ss-fixture');
  return { store, values };
}

describe('approval intent recovery', () => {
  it('persists only the action identity and restores it after reload', async () => {
    const { store, values } = setup();
    await store.reserve('approval-one');
    expect(store.read()).toEqual({ version: 1, sessionId: 'ss-fixture', approvalId: 'approval-one', intentId: expect.any(String) });
    expect([...values.values()].join(' ')).not.toMatch(/approved|token/i);
    await expect(store.reserve('approval-two')).rejects.toThrow('review');
  });

  it('only clears the exact resolved identity and fails closed on invalid data', async () => {
    const { store, values } = setup();
    await store.reserve('approval-one');
    await store.clear('approval-two');
    expect(store.read().approvalId).toBe('approval-one');
    values.set([...values.keys()][0], '{invalid');
    expect(() => store.read()).toThrow('recovery');
    await expect(store.reserve('approval-two')).rejects.toThrow('recovery');
  });

  it('preserves a legacy recovery mode without storing the decision', async () => {
    const { store } = setup();
    await store.reserve('approval-legacy', 'legacy');
    expect(store.read()).toEqual({ version: 1, sessionId: 'ss-fixture', approvalId: 'approval-legacy', intentId: expect.any(String), mode: 'legacy' });
  });

  it('only removes its own undispatched identity after the scope changes', async () => {
    let current = true;
    const values = new Map();
    const storage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) };
    const store = createApprovalIntentStore(storage, callback => Promise.resolve().then(callback), () => current, 'ss-fixture');
    const own = await store.reserve('approval-one');
    current = false;
    await store.clearUndispatched('approval-one', own.intentId);
    expect(values.size).toBe(0);
    current = true;
    const old = await store.reserve('approval-one');
    const key = [...values.keys()][0];
    values.set(key, JSON.stringify({ version: 1, sessionId: 'ss-fixture', approvalId: 'approval-one', intentId: 'newer-intent' }));
    current = false;
    await store.clearUndispatched('approval-one', old.intentId);
    expect(JSON.parse(values.get(key)).intentId).toBe('newer-intent');
  });

  it('does not admit an action if persistence fails or the scope changes', async () => {
    const { store, values } = setup();
    await store.reserve('approval-one');
    const closed = createApprovalIntentStore({ getItem: () => null, setItem: () => { throw new Error('quota'); }, removeItem: () => {} }, callback => Promise.resolve().then(callback), () => true, 'ss-fixture');
    await expect(closed.reserve('approval-two')).rejects.toThrow('quota');
    const changed = createApprovalIntentStore({ getItem: key => values.get(key), setItem: () => {}, removeItem: () => {} }, callback => Promise.resolve().then(callback), () => false, 'ss-fixture');
    await expect(changed.clear('approval-one')).rejects.toThrow('changed');
    expect(store.read().approvalId).toBe('approval-one');
  });
});
