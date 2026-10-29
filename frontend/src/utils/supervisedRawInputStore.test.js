import { describe, expect, it } from 'vitest';
import { createSupervisedRawInputStore } from './supervisedRawInputStore';

function storageFixture() {
  const values = new Map();
  return { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key), listKeys: prefix => [...values.keys()].filter(key => key.startsWith(prefix)), transaction: callback => Promise.resolve().then(callback), values };
}

describe('supervised raw input storage', () => {
  const operation = { requestId: '018fdf56-2333-7abc-8abc-123456789abc', deliveryToken: 'fixture-token' };
  it('retains the issued identity across reload without persisting raw input', async () => {
    const storage = storageFixture();
    const first = createSupervisedRawInputStore(storage, 'session-one', () => true);
    await first.reserve(operation);
    await first.markSending(operation.requestId);
    const restored = createSupervisedRawInputStore(storage, 'session-one', () => true);
    expect(restored.read()).toEqual({ version: 2, sessionId: 'session-one', ...operation, stage: 'sending' });
    expect([...storage.values.values()].join('')).not.toContain('private raw input');
  });

  it('refuses to overwrite another outstanding operation or stale storage', async () => {
    const storage = storageFixture();
    const first = createSupervisedRawInputStore(storage, 'session-one', () => true);
    const second = createSupervisedRawInputStore(storage, 'session-one', () => true);
    await first.reserve(operation);
    await expect(second.reserve({ ...operation, requestId: '018fdf56-2333-7abc-8abc-123456789abd' })).rejects.toThrow();
    expect(first.read().requestId).toBe(operation.requestId);
  });

  it('keeps the durable identity if a scope changes or storage fails', async () => {
    const storage = storageFixture();
    let current = true;
    const store = createSupervisedRawInputStore(storage, 'session-one', () => current);
    await store.reserve(operation);
    current = false;
    await expect(store.markSending(operation.requestId)).rejects.toThrow();
    current = true;
    storage.setItem = () => { throw new Error('storage failed'); };
    await expect(store.clear(operation.requestId)).rejects.toThrow();
    expect(store.read().requestId).toBe(operation.requestId);
  });

  it('retains a final marker for the same operation without clearing another tab’s operation', async () => {
    const storage = storageFixture();
    const first = createSupervisedRawInputStore(storage, 'session-one', () => true);
    await first.reserve(operation); await first.markSending(operation.requestId);
    const otherId = '018fdf56-2333-7abc-8abc-123456789abd';
    const otherKey = `supervisedRawInput:v2:session-one:${otherId}`;
    storage.setItem(otherKey, JSON.stringify({ version: 2, sessionId: 'session-one', requestId: otherId, deliveryToken: 'other-token', stage: 'sending' }));
    const second = createSupervisedRawInputStore(storage, 'session-one', () => true);
    await second.clear(operation.requestId);
    await expect(first.clear(operation.requestId)).resolves.toBeUndefined();
    const records = [...storage.values.values()].map(value => JSON.parse(value));
    expect(records).toEqual(expect.arrayContaining([
      { version: 2, sessionId: 'session-one', requestId: operation.requestId, stage: 'settled' },
      { version: 2, sessionId: 'session-one', requestId: otherId, deliveryToken: 'other-token', stage: 'sending' },
    ]));
    expect(first.readAll().map(value => value.requestId)).toEqual([otherId]);
  });

  it('compacts more than 10,000 expired settled markers without deleting unresolved operations', async () => {
    const storage = storageFixture();
    const store = createSupervisedRawInputStore(storage, 'session-one', () => true);
    for (let index = 0; index < 10_001; index += 1) {
      const id = `018fdf56-2333-7abc-8abc-${index.toString(16).padStart(12, '0')}`;
      storage.setItem(`supervisedRawInput:v2:session-one:${id}`, JSON.stringify({ version: 2, sessionId: 'session-one', requestId: id, stage: 'settled' }));
    }
    const activeId = '018fdf56-2333-7abc-8abc-ffffffffffff';
    storage.setItem(`supervisedRawInput:v2:session-one:${activeId}`, JSON.stringify({ version: 2, sessionId: 'session-one', requestId: activeId, deliveryToken: 'token', stage: 'sending' }));
    await store.compactBefore(0x018fdf562334);
    expect(store.readAll().map(value => value.requestId)).toEqual([activeId]);
    expect(store.count()).toBe(1);
  });

  it('never lowers a verified watermark after clock rollback or lets a stale tab restore a pruned ID', async () => {
    const storage = storageFixture();
    const store = createSupervisedRawInputStore(storage, 'session-one', () => true);
    await store.reserve(operation); await store.markSending(operation.requestId); await store.clear(operation.requestId);
    await store.compactBefore(0x018fdf562334);
    await store.compactBefore(0x018fdf562330);
    await expect(store.reserve(operation)).rejects.toThrow('older than the verified server watermark');
    await expect(store.markSending(operation.requestId)).rejects.toThrow('does not match');
    expect(store.count()).toBe(0);
  });

  it('keeps every marker when the authoritative watermark cannot be saved', async () => {
    const storage = storageFixture();
    const store = createSupervisedRawInputStore(storage, 'session-one', () => true);
    await store.reserve(operation); await store.markSending(operation.requestId); await store.clear(operation.requestId);
    const setItem = storage.setItem;
    storage.setItem = (key, value) => { if (key.includes('watermark')) throw new Error('quota'); setItem(key, value); };
    await expect(store.compactBefore(0x018fdf562334)).rejects.toThrow('quota');
    expect(store.count()).toBe(1);
  });
});
